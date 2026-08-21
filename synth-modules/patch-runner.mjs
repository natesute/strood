// Core patch compiler — turns a patch JSON definition into a superdough onTrigger function
import {
  getAudioContext,
  gainNode,
  getADSRValues,
  getFrequencyFromValue,
  getParamADSR,
  releaseAudioNode,
  webAudioTimeout,
} from 'superdough';
import { getModuleFactory } from './registry.mjs';

// Topological sort of module IDs based on routing edges
function topoSort(moduleIds, routing) {
  const graph = new Map();
  const inDegree = new Map();

  for (const id of moduleIds) {
    graph.set(id, []);
    inDegree.set(id, 0);
  }

  for (const [src, dst] of routing) {
    if (!graph.has(src) || !graph.has(dst)) continue;
    graph.get(src).push(dst);
    inDegree.set(dst, (inDegree.get(dst) || 0) + 1);
  }

  // Start with nodes that have no incoming edges (sources)
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length > 0) {
    const id = queue.shift();
    sorted.push(id);
    for (const neighbor of graph.get(id)) {
      const newDeg = inDegree.get(neighbor) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== moduleIds.length) {
    console.warn('[synth-modules] Routing graph has a cycle — some modules were skipped');
  }

  return sorted;
}

// Separate module IDs into signal modules (in routing) and modulator-only modules
function classifyModules(patchDef) {
  const routedIds = new Set();
  for (const [src, dst] of patchDef.routing) {
    routedIds.add(src);
    routedIds.add(dst);
  }

  const allIds = Object.keys(patchDef.modules);
  const signalIds = allIds.filter((id) => routedIds.has(id));
  const modulatorIds = allIds.filter((id) => !routedIds.has(id));

  return { signalIds, modulatorIds };
}

// Merge pattern-level overrides (p_moduleId_paramName) into module params
function resolveParams(moduleDefs, value) {
  const resolved = {};
  for (const [id, def] of Object.entries(moduleDefs)) {
    const params = { ...def.params };
    // Look for p_<id>_<param> keys in the pattern value
    const prefix = `p_${id}_`;
    for (const [key, val] of Object.entries(value)) {
      if (key.startsWith(prefix)) {
        const paramName = key.slice(prefix.length);
        params[paramName] = val;
      }
    }
    resolved[id] = { ...def, params };
  }
  return resolved;
}

export function compilePatch(patchDef) {
  // Returns an onTrigger function compatible with superdough's registerSound
  return (t, value, onended) => {
    const ac = getAudioContext();
    const { duration } = value;
    const frequency = getFrequencyFromValue(value);

    // Build trigger context passed to each module factory
    const ctx = {
      t,
      duration,
      frequency,
      value,
    };

    // Merge pattern overrides into module params
    const resolvedModules = resolveParams(patchDef.modules, value);

    // Classify modules
    const { signalIds, modulatorIds } = classifyModules(patchDef);

    // Topological sort of signal chain
    const sortedSignalIds = topoSort(signalIds, patchDef.routing);

    // Instantiate all modules
    const instances = new Map();
    const allNodes = {}; // superdough-compatible nodes map
    const cleanups = [];

    // Instantiate signal modules in topo order
    for (const id of sortedSignalIds) {
      const def = resolvedModules[id];
      if (!def) continue;
      const { factory } = getModuleFactory(def.type);
      const instance = factory(ac, def.params, ctx);
      instances.set(id, instance);

      // Merge into superdough-compatible nodes map
      if (instance.nodes) {
        for (const [k, v] of Object.entries(instance.nodes)) {
          allNodes[`${id}_${k}`] = v; // namespaced
          if (!allNodes[k]) allNodes[k] = v; // first-come unnamespaced
        }
      }
      if (instance.cleanup) cleanups.push(instance.cleanup);
    }

    // Instantiate modulator modules (not in signal chain)
    for (const id of modulatorIds) {
      const def = resolvedModules[id];
      if (!def) continue;
      const { factory } = getModuleFactory(def.type);
      const instance = factory(ac, def.params, ctx);
      instances.set(id, instance);

      if (instance.nodes) {
        for (const [k, v] of Object.entries(instance.nodes)) {
          allNodes[`${id}_${k}`] = v;
          if (!allNodes[k]) allNodes[k] = v;
        }
      }
      if (instance.cleanup) cleanups.push(instance.cleanup);
    }

    // Wire signal routing
    for (const [srcId, dstId] of patchDef.routing) {
      const src = instances.get(srcId);
      const dst = instances.get(dstId);
      if (src && dst && dst.inputNode) {
        src.node.connect(dst.inputNode);
      }
    }

    // Apply modulation matrix
    if (patchDef.matrix) {
      for (const mod of patchDef.matrix) {
        const modInstance = instances.get(mod.src);
        // Parse "moduleId.paramName" from dst
        const dotIdx = mod.dst.indexOf('.');
        if (dotIdx === -1) continue;
        const targetId = mod.dst.slice(0, dotIdx);
        const paramName = mod.dst.slice(dotIdx + 1);

        const targetInstance = instances.get(targetId);
        if (!modInstance || !targetInstance) continue;

        const targetParam = targetInstance.params?.[paramName];
        if (!targetParam) {
          console.warn(
            `[synth-modules] Matrix target "${mod.dst}" not found — skipping`,
          );
          continue;
        }

        // Create a depth-scaling gain node between modulator output and target param
        const depth = mod.depth ?? 1;
        const depthNode = ac.createGain();
        depthNode.gain.value = depth;
        modInstance.node.connect(depthNode);
        depthNode.connect(targetParam);
        cleanups.push(() => releaseAudioNode(depthNode));
      }
    }

    // Find terminal node (last in topo sort = output end of signal chain)
    const terminalId = sortedSignalIds[sortedSignalIds.length - 1];
    const terminalNode = instances.get(terminalId)?.node;

    if (!terminalNode) {
      console.warn('[synth-modules] No terminal node found in patch');
      onended();
      return { node: ac.createGain(), nodes: { main: {} }, stop: () => {} };
    }

    // Apply master amplitude envelope
    const [attack, decay, sustain, release] = getADSRValues(
      [value.attack, value.decay, value.sustain, value.release],
      'linear',
      [0.001, 0.05, 0.6, 0.01],
    );
    const envGain = gainNode(0);
    terminalNode.connect(envGain);

    const holdEnd = t + duration;
    getParamADSR(envGain.gain, attack, decay, sustain, release, 0, 1, t, holdEnd, 'linear');

    const endTime = holdEnd + release + 0.01;

    // Schedule cleanup
    webAudioTimeout(
      ac,
      () => {
        for (const fn of cleanups) fn?.();
        onended();
      },
      t,
      endTime,
    );

    // Stop all modules at end time
    const stopAll = (time) => {
      for (const inst of instances.values()) {
        inst.stop?.(time);
      }
    };
    stopAll(endTime);

    return {
      node: envGain,
      nodes: { main: allNodes },
      stop: stopAll,
    };
  };
}
