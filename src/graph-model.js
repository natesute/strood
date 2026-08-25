import { parseTracks } from './tracks.js';

export const VISUALIZER_METHODS = [
  { method: '_scope', label: 'Waveform', call: '._scope({ width: 520, height: 112, autoScale: true })' },
  { method: '_helix', label: 'Helix', call: '._helix({ size: 190, turns: 4 })' },
  { method: '_harmonics', label: 'Harmonics', call: '._harmonics({ width: 520, height: 104 })' },
  { method: '_lissajous', label: 'Lissajous', call: '._lissajous({ size: 180 })' },
  { method: '_orbit', label: 'Orbit', call: '._orbit({ size: 165 })' },
  { method: '_tonnetz', label: 'Tonnetz', call: '._tonnetz({ size: 220 })' },
  { method: '_cymatics', label: 'Cymatics', call: '._cymatics({ size: 180 })' },
  { method: '_epicycles', label: 'Epicycles', call: '._epicycles({ size: 170, harmonicsCount: 7 })' },
  { method: '_phase', label: 'Phase portrait', call: '._phase({ size: 200 })' },
  { method: '_interference', label: 'Interference', call: '._interference({ size: 200 })' },
  { method: '_overtones', label: 'Overtones', call: '._overtones({ width: 520, height: 120 })' },
  { method: '_pendulum', label: 'Pendulum wave', call: '._pendulum({ size: 200, count: 13, span: 4 })' },
  { method: '_resonance', label: 'Resonance', call: '._resonance({ size: 200 })' },
];

export function collectGraphActivityHaps(activeHaps, visibleHaps, previousTime, time) {
  const cycleTime = Number(time);
  const continued = Number.isFinite(previousTime)
    && cycleTime >= previousTime
    && cycleTime - previousTime <= 0.5;
  const lowerBound = continued ? previousTime : cycleTime - 0.25;
  const graphHaps = new Set(activeHaps);
  for (const hap of visibleHaps) {
    const onset = Number(hap.whole?.begin);
    if (Number.isFinite(onset) && onset > lowerBound && onset <= cycleTime + 0.0001) {
      graphHaps.add(hap);
    }
  }
  return [...graphHaps];
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const CONST_START = /(^|\n)([ \t]*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=)/g;
const CONTINUATION = /^(?:\.|\?|:|\)|\]|\}|,|\+|-|\*|\/|&&|\|\|)/;

function lineEnd(code, from) {
  const index = code.indexOf('\n', from);
  return index === -1 ? code.length : index;
}

function nextNonBlankLine(code, from) {
  let cursor = from;
  while (cursor < code.length) {
    const end = lineEnd(code, cursor);
    const text = code.slice(cursor, end).trim();
    if (text) return { text, from: cursor, end };
    cursor = end + 1;
  }
  return null;
}

function declarationEnd(code, expressionStart) {
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let cursor = expressionStart; cursor < code.length; cursor++) {
    const char = code[cursor];
    const next = code[cursor + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      else continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        cursor++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      cursor++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      cursor++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') round++;
    else if (char === ')') round = Math.max(0, round - 1);
    else if (char === '[') square++;
    else if (char === ']') square = Math.max(0, square - 1);
    else if (char === '{') curly++;
    else if (char === '}') curly = Math.max(0, curly - 1);

    if (char !== '\n' || round || square || curly) continue;
    const previous = code.slice(expressionStart, cursor).trimEnd();
    const following = nextNonBlankLine(code, cursor + 1);
    if (!following) return cursor;
    if (following.text.startsWith('//') || following.text.startsWith('/*')) return cursor;
    if (CONTINUATION.test(following.text)) continue;
    if (/[=>([{,:+\-*/]$/.test(previous)) continue;
    return cursor;
  }
  return code.length;
}

export function parseDeclarations(code) {
  const declarations = [];
  for (const match of code.matchAll(CONST_START)) {
    const from = match.index + match[1].length;
    const expressionStart = from + match[2].length;
    const to = declarationEnd(code, expressionStart);
    declarations.push({
      id: `declaration:${match[3]}`,
      name: match[3],
      from,
      to,
      text: code.slice(from, to).trimEnd(),
    });
  }
  const names = new Set(declarations.map(({ name }) => name));
  for (const declaration of declarations) {
    declaration.dependencies = [...declaration.text.matchAll(IDENTIFIER)]
      .map(([name]) => name)
      .filter((name, index, list) => name !== declaration.name && names.has(name) && list.indexOf(name) === index);
  }
  return declarations;
}

function matchingParen(code, open) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let cursor = open; cursor < code.length; cursor++) {
    const char = code[cursor];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return cursor + 1;
  }
  return code.length;
}

export function findVisualizerCalls(code, declarations = parseDeclarations(code)) {
  const calls = [];
  const matcher = /\.(_[A-Za-z][A-Za-z0-9_]*)\s*\(/g;
  for (const match of code.matchAll(matcher)) {
    const from = match.index;
    const to = matchingParen(code, code.indexOf('(', from));
    const declaration = declarations.find((item) => from >= item.from && to <= item.to);
    calls.push({
      id: `visualizer:${match[1]}:${calls.length}`,
      legacyId: `visualizer:${match[1]}:${calls.length}`,
      method: match[1],
      from,
      to,
      text: code.slice(from, to),
      target: declaration?.name || null,
    });
  }
  return calls;
}

function primaryDeclarationName(code, track) {
  const block = code.slice(track.start, track.end);
  const wrapped = block.match(/\btrack\s*\(\s*(['"])[\s\S]*?\1\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (wrapped) return wrapped[2];
  const direct = block.match(/^\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\$|\$):\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
  return direct?.[1] || null;
}

function trackMixDeclaration(code, track, byName) {
  const block = code.slice(track.start, track.end);
  const trackCall = block.search(/\btrack\s*\(/);
  if (trackCall < 0) return null;
  const open = block.indexOf('(', trackCall);
  const call = block.slice(trackCall, matchingParen(block, open));
  const wrapped = call.match(/,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)$/);
  const declaration = byName.get(wrapped?.[1]);
  return declaration && /\bmute\s*:\s*(?:true|false)\b/.test(declaration.text)
    ? declaration
    : null;
}

function reachableDeclarations(primary, byName) {
  const result = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const declaration = byName.get(name);
    if (!declaration) return;
    result.push(declaration);
    declaration.dependencies.forEach(visit);
  };
  visit(primary);
  return result;
}

function isNotesDeclaration(declaration, primary) {
  if (declaration.name === primary) return false;
  const literal = declaration.text.match(/^const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(["'`])([\s\S]*)\1\s*$/);
  const isPatternLiteral = literal && /[\s\[\]<>~*@]/.test(literal[2]);
  return (isPatternLiteral || /\b(?:note|s|sound|silence|stack|arrange)\s*\(/.test(declaration.text))
    && !/^const\s+\w+Voice\b/.test(declaration.text);
}

function patternRole(declaration) {
  return /\barrange\s*\(/.test(declaration.text) ? 'arrangement' : 'phrase';
}

export function findArrangementEntries(source) {
  const entries = [];
  const matcher = /\barrange\s*\(/g;
  let lane = 0;
  for (const match of source.matchAll(matcher)) {
    const open = source.indexOf('(', match.index);
    const close = matchingParen(source, open);
    const bodyStart = open + 1;
    const body = source.slice(bodyStart, Math.max(bodyStart, close - 1));
    const laneEntries = [];
    let cursor = 0;
    let quote = '';
    let escaped = false;
    let round = 0;
    let curly = 0;
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        continue;
      }
      if (char === '(') round += 1;
      else if (char === ')') round = Math.max(0, round - 1);
      else if (char === '{') curly += 1;
      else if (char === '}') curly = Math.max(0, curly - 1);
      if (char !== '[' || round || curly) continue;

      let depth = 1;
      let innerQuote = '';
      let innerEscaped = false;
      let end = index + 1;
      for (; end < body.length && depth; end += 1) {
        const inner = body[end];
        if (innerQuote) {
          if (innerEscaped) innerEscaped = false;
          else if (inner === '\\') innerEscaped = true;
          else if (inner === innerQuote) innerQuote = '';
          continue;
        }
        if (inner === '"' || inner === "'" || inner === '`') innerQuote = inner;
        else if (inner === '[') depth += 1;
        else if (inner === ']') depth -= 1;
      }
      const text = body.slice(index, end);
      const entry = text.match(/^\[\s*(\d+(?:\.\d+)?)\s*,([\s\S]*)\]$/);
      const duration = Number(entry?.[1]);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      const dependency = entry[2].trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/)?.[1] || null;
      laneEntries.push({
        lane,
        from: bodyStart + index,
        to: bodyStart + end,
        start: cursor,
        end: cursor + duration,
        dependency,
      });
      cursor += duration;
      index = end - 1;
    }
    for (const entry of laneEntries) entries.push({ ...entry, laneLength: cursor });
    lane += 1;
  }
  return entries;
}

export function buildSongGraph(code) {
  const declarations = parseDeclarations(code);
  const byName = new Map(declarations.map((item) => [item.name, item]));
  const visualizers = findVisualizerCalls(code, declarations);
  const soloKey = code.match(/\bconst\s+solo\s*=\s*(['"])([A-Za-z0-9_-]+)\1/)?.[2] || null;
  const tracks = parseTracks(code).map((track) => {
    const primary = primaryDeclarationName(code, track);
    const reachable = reachableDeclarations(primary, byName);
    const mixDeclaration = trackMixDeclaration(code, track, byName);
    return {
      ...track,
      primary,
      declaration: byName.get(primary) || null,
      notes: reachable.filter((item) => isNotesDeclaration(item, primary)),
      mixDeclaration,
      muted: mixDeclaration?.text.match(/\bmute\s*:\s*(true|false)\b/)?.[1] === 'true',
    };
  });

  for (const visualizer of visualizers) {
    if (visualizer.target) continue;
    const owner = tracks.find((track) => visualizer.from >= track.start && visualizer.to <= track.end);
    if (owner?.primary) visualizer.target = owner.primary;
  }

  // Source-order IDs made every later visualiser look like a different node
  // whenever a new call was inserted earlier in the song. Scope identity to
  // the connected declaration and method so unrelated node layouts stay put.
  const visualizerCounts = new Map();
  for (const visualizer of visualizers) {
    const key = `${visualizer.target || 'unattached'}:${visualizer.method}`;
    const index = visualizerCounts.get(key) || 0;
    visualizerCounts.set(key, index + 1);
    visualizer.id = `visualizer:${key}:${index}`;
  }

  const codeNodes = new Map();
  for (const track of tracks) {
    if (track.declaration) {
      codeNodes.set(track.declaration.name, {
        ...track.declaration,
        kind: 'declaration',
        role: 'track',
        trackKey: track.key,
        trackName: track.name,
        color: track.color,
        canMute: Boolean(track.mixDeclaration),
        muted: track.muted,
        canSolo: soloKey !== null,
        soloed: soloKey === track.key,
      });
    }
    for (const note of track.notes) {
      if (!codeNodes.has(note.name)) {
        const role = patternRole(note);
        codeNodes.set(note.name, {
          ...note,
          kind: 'notes',
          role,
          arrangementEntries: role === 'arrangement' ? findArrangementEntries(note.text) : [],
          trackKey: track.key,
          trackName: track.name,
          color: track.color,
        });
      }
    }
  }

  const edges = [];
  const edgeIds = new Set();
  for (const track of tracks) {
    if (!track.declaration) continue;
    const patternNames = new Set(track.notes.map(({ name }) => name));
    for (const parent of [track.declaration, ...track.notes]) {
      for (const child of parent.dependencies || []) {
        if (!patternNames.has(child)) continue;
        const id = `edge:${parent.name}:${child}`;
        if (edgeIds.has(id)) continue;
        edgeIds.add(id);
        edges.push({ id, from: parent.name, to: child });
      }
    }
  }
  for (const visualizer of visualizers) {
    if (visualizer.target && codeNodes.has(visualizer.target)) {
      edges.push({ id: `edge:${visualizer.target}:${visualizer.id}`, from: visualizer.target, to: visualizer.id });
    }
  }

  return { tracks, declarations, codeNodes: [...codeNodes.values()], visualizers, edges, soloKey };
}

export function toggleTrackMute(code, trackKey) {
  const graph = buildSongGraph(code);
  const track = graph.tracks.find(({ key }) => key === trackKey);
  const declaration = track?.mixDeclaration;
  if (!declaration) return code;
  const nextText = declaration.text.replace(
    /\bmute\s*:\s*(true|false)\b/,
    (_, value) => `mute: ${value === 'true' ? 'false' : 'true'}`,
  );
  return code.slice(0, declaration.from) + nextText + code.slice(declaration.to);
}

export function toggleTrackSolo(code, trackKey) {
  if (!trackKey || !/\bconst\s+solo\s*=/.test(code)) return code;
  return code.replace(
    /\bconst\s+solo\s*=\s*(['"])([A-Za-z0-9_-]+)\1/,
    (_, quote, selected) => `const solo = ${quote}${selected === trackKey ? 'all' : trackKey}${quote}`,
  );
}

export function resolveGraphActivity(graph, activations) {
  const activeNodes = new Set();
  const activeEdges = new Set();
  const labelsByNode = new Map();
  const activeDependenciesByNode = new Map();

  const addLabel = (nodeId, label) => {
    if (!label) return;
    const labels = labelsByNode.get(nodeId) || new Set();
    labels.add(label);
    labelsByNode.set(nodeId, labels);
  };

  for (const activation of activations) {
    for (const node of graph.codeNodes) {
      if (activation.from < node.from || activation.to > node.to) continue;
      activeNodes.add(node.name);
      addLabel(node.name, activation.label);
    }
  }

  // Activity flows backwards through phrase -> arrangement -> track. Repeat
  // until the full dependency chain is active, regardless of source order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (edge.to.startsWith('visualizer:') || !activeNodes.has(edge.to)) continue;
      if (!activeNodes.has(edge.from)) changed = true;
      activeNodes.add(edge.from);
      activeEdges.add(edge.id);
      const activeDependencies = activeDependenciesByNode.get(edge.from) || new Set();
      activeDependencies.add(edge.to);
      activeDependenciesByNode.set(edge.from, activeDependencies);
      for (const label of labelsByNode.get(edge.to) || []) addLabel(edge.from, label);
    }
  }
  for (const edge of graph.edges) {
    if (!edge.to.startsWith('visualizer:') || !activeNodes.has(edge.from)) continue;
    activeNodes.add(edge.to);
    activeEdges.add(edge.id);
    for (const label of labelsByNode.get(edge.from) || []) addLabel(edge.to, label);
  }

  return { activeNodes, activeEdges, labelsByNode, activeDependenciesByNode };
}

function callRemovalRange(code, call) {
  const lineFrom = code.lastIndexOf('\n', call.from - 1) + 1;
  const lineToIndex = code.indexOf('\n', call.to);
  const lineTo = lineToIndex === -1 ? code.length : lineToIndex + 1;
  if (!code.slice(lineFrom, call.from).trim() && !code.slice(call.to, lineTo).trim()) {
    return { from: lineFrom, to: lineTo };
  }
  return { from: call.from, to: call.to };
}

export function attachVisualizer(code, visualizerId, targetName) {
  const graph = buildSongGraph(code);
  const call = graph.visualizers.find(({ id }) => id === visualizerId);
  const target = graph.declarations.find(({ name }) => name === targetName);
  if (!call || !target || call.target === targetName) return code;
  const removal = callRemovalRange(code, call);
  const without = code.slice(0, removal.from) + code.slice(removal.to);
  const reparsedTarget = parseDeclarations(without).find(({ name }) => name === targetName);
  if (!reparsedTarget) return code;
  const separator = '\n  ';
  return without.slice(0, reparsedTarget.to) + separator + call.text + without.slice(reparsedTarget.to);
}

export function addVisualizer(code, method, targetName) {
  const preset = VISUALIZER_METHODS.find((item) => item.method === method);
  const target = parseDeclarations(code).find(({ name }) => name === targetName);
  if (!preset || !target) return code;
  return code.slice(0, target.to) + `\n  ${preset.call}` + code.slice(target.to);
}

export function removeVisualizer(code, visualizerId) {
  const call = buildSongGraph(code).visualizers.find(({ id }) => id === visualizerId);
  if (!call) return code;
  const removal = callRemovalRange(code, call);
  return code.slice(0, removal.from) + code.slice(removal.to);
}
