// Modulator modules — envelope, LFO, macro, random, follower
// These output control signals (not audio) that get routed to params via the modulation matrix
import { getLfo, getEnvelope, releaseAudioNode } from 'superdough';
import { registerModule } from '../registry.mjs';

// Helper to create custom worklet nodes
function customWorklet(ac, processor, params) {
  const node = new AudioWorkletNode(ac, processor);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && node.parameters.has(key)) {
      node.parameters.get(key).value = value;
    }
  }
  return node;
}

// ADSR Envelope modulator
// Outputs a signal from 0→1→sustain→0 over the note's lifetime
registerModule(
  'env',
  (ac, params, ctx) => {
    const attack = params.a ?? params.attack ?? 0.01;
    const decay = params.d ?? params.decay ?? 0.1;
    const sustain = params.s ?? params.sustain ?? 0.5;
    const release = params.r ?? params.release ?? 0.3;

    const node = getEnvelope(ac, {
      attack,
      decay,
      sustain,
      release,
      begin: ctx.t,
      end: ctx.t + ctx.duration,
    });

    return {
      node,
      inputNode: null,
      params: {
        attack: node.parameters.get('attack'),
        decay: node.parameters.get('decay'),
        sustain: node.parameters.get('sustain'),
        release: node.parameters.get('release'),
      },
      nodes: { env: [node] },
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'modulator',
    inputs: 0,
    outputs: 1,
    params: {
      a: { min: 0.001, max: 10, default: 0.01, unit: 's' },
      d: { min: 0.001, max: 10, default: 0.1, unit: 's' },
      s: { min: 0, max: 1, default: 0.5 },
      r: { min: 0.01, max: 30, default: 0.3, unit: 's' },
    },
  },
);

// LFO modulator
// Outputs a shaped oscillation — connects to params via matrix depth nodes
registerModule(
  'lfo',
  (ac, params, ctx) => {
    const shapeMap = { tri: 0, triangle: 0, sine: 1, ramp: 2, saw: 3, square: 4 };
    const shape =
      typeof params.shape === 'string'
        ? shapeMap[params.shape] ?? 0
        : params.shape ?? 1;

    const node = getLfo(ac, {
      frequency: params.rate ?? params.frequency ?? 1,
      shape,
      depth: 1, // depth is applied by the matrix gain node, so output full range
      dcoffset: 0,
      skew: params.skew ?? 0.5,
      phaseoffset: params.phase ?? 0,
      begin: ctx.t,
      end: ctx.t + ctx.duration + 10, // keep LFO alive well past note end
    });

    return {
      node,
      inputNode: null,
      params: {
        rate: node.parameters.get('frequency'),
        depth: node.parameters.get('depth'),
        skew: node.parameters.get('skew'),
      },
      nodes: { lfo: [node] },
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'modulator',
    inputs: 0,
    outputs: 1,
    params: {
      rate: { min: 0.01, max: 100, default: 1, unit: 'Hz' },
      shape: { values: ['triangle', 'sine', 'ramp', 'saw', 'square'], default: 'sine' },
      skew: { min: 0, max: 1, default: 0.5 },
      phase: { min: 0, max: 1, default: 0 },
    },
  },
);

// Macro — a ConstantSourceNode that fans out to multiple targets via the matrix
// Like Serum's macro knobs: one value, many destinations
registerModule(
  'macro',
  (ac, params, ctx) => {
    const node = new ConstantSourceNode(ac, { offset: params.value ?? 0.5 });
    node.start(ctx.t);

    return {
      node,
      inputNode: null,
      params: {
        value: node.offset,
      },
      nodes: { macro: [node] },
      stop: (time) => node.stop(time),
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'modulator',
    inputs: 0,
    outputs: 1,
    params: {
      value: { min: 0, max: 1, default: 0.5 },
    },
  },
);

// Random — sample-and-hold or smoothed random modulation
// Great for generative, evolving textures
registerModule(
  'random',
  (ac, params, ctx) => {
    const node = customWorklet(ac, 'random-processor', {
      rate: params.rate ?? 4,
      smooth: params.smooth ?? 0,
      min: params.min ?? 0,
      max: params.max ?? 1,
    });

    return {
      node,
      inputNode: null,
      params: {
        rate: node.parameters.get('rate'),
        smooth: node.parameters.get('smooth'),
        min: node.parameters.get('min'),
        max: node.parameters.get('max'),
      },
      nodes: { random: [node] },
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'modulator',
    inputs: 0,
    outputs: 1,
    params: {
      rate: { min: 0.01, max: 100, default: 4, unit: 'Hz' },
      smooth: { min: 0, max: 1, default: 0, note: '0=S&H, 1=fully smoothed' },
      min: { min: -10, max: 10, default: 0 },
      max: { min: -10, max: 10, default: 1 },
    },
  },
);

// Follower — envelope follower, tracks amplitude of an audio signal
// Use in routing: audio source → follower, then matrix: follower → any param
registerModule(
  'follower',
  (ac, params, ctx) => {
    const node = customWorklet(ac, 'follower-processor', {
      attack: params.attack ?? 0.01,
      release: params.release ?? 0.1,
      gain: params.gain ?? 1,
    });

    return {
      node,
      inputNode: node, // accepts audio input
      params: {
        attack: node.parameters.get('attack'),
        release: node.parameters.get('release'),
        gain: node.parameters.get('gain'),
      },
      nodes: { follower: [node] },
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'modulator',
    inputs: 1,
    outputs: 1,
    params: {
      attack: { min: 0.001, max: 1, default: 0.01, unit: 's' },
      release: { min: 0.001, max: 2, default: 0.1, unit: 's' },
      gain: { min: 0, max: 10, default: 1 },
    },
  },
);
