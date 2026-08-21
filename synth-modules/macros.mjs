const PATCH_MACROS = [
  {
    id: 'subtractive-voice',
    name: 'subtractive voice',
    modules: [
      { key: 'osc', type: 'supersaw', x: 0, y: 0, params: { voices: 5, detune: 0.16 } },
      { key: 'filter', type: 'ladder', x: 210, y: 0, params: { frequency: 1100, resonance: 0.42, drive: 0.8 } },
      { key: 'amp', type: 'vca', x: 420, y: 0, params: { gain: 0 } },
      { key: 'ampEnv', type: 'env', x: 210, y: 210, params: { a: 0.02, d: 0.22, s: 0.62, r: 0.45 } },
      { key: 'filterEnv', type: 'env', x: 420, y: 210, params: { a: 0.01, d: 0.32, s: 0.15, r: 0.5 } },
      { key: 'tone', type: 'macro', x: 0, y: 210, params: { value: 0.5 } },
    ],
    routing: [['osc', 'filter'], ['filter', 'amp']],
    matrix: [
      { src: 'ampEnv', dst: 'amp.gain', depth: 0.8 },
      { src: 'filterEnv', dst: 'filter.frequency', depth: 2200 },
      { src: 'tone', dst: 'filter.frequency', depth: 3200 },
    ],
  },
  {
    id: 'vocal-voice',
    name: 'vocal voice',
    modules: [
      { key: 'osc', type: 'supersaw', x: 0, y: 0, params: { voices: 5, detune: 0.12 } },
      { key: 'vowel', type: 'formant', x: 210, y: 0, params: { morph: 0.1, gain: 1.3 } },
      { key: 'filter', type: 'svf', x: 420, y: 0, params: { frequency: 3800, resonance: 0.25, mode: 0 } },
      { key: 'amp', type: 'vca', x: 630, y: 0, params: { gain: 0 } },
      { key: 'ampEnv', type: 'env', x: 420, y: 210, params: { a: 0.18, d: 0.3, s: 0.7, r: 0.8 } },
      { key: 'motion', type: 'lfo', x: 210, y: 210, params: { rate: 0.1, shape: 'sine' } },
      { key: 'character', type: 'macro', x: 0, y: 210, params: { value: 0.45 } },
    ],
    routing: [['osc', 'vowel'], ['vowel', 'filter'], ['filter', 'amp']],
    matrix: [
      { src: 'ampEnv', dst: 'amp.gain', depth: 0.7 },
      { src: 'motion', dst: 'vowel.morph', depth: 0.32 },
      { src: 'character', dst: 'vowel.morph', depth: 0.55 },
      { src: 'character', dst: 'filter.frequency', depth: 1800 },
    ],
  },
  {
    id: 'plucked-voice',
    name: 'plucked voice',
    modules: [
      { key: 'osc', type: 'sawtooth', x: 0, y: 0, params: {} },
      { key: 'comb', type: 'comb', x: 210, y: 0, params: { frequency: 220, feedback: 0.68, damping: 0.42 } },
      { key: 'amp', type: 'vca', x: 420, y: 0, params: { gain: 0 } },
      { key: 'env', type: 'env', x: 210, y: 210, params: { a: 0.002, d: 0.18, s: 0.05, r: 0.28 } },
      { key: 'space', type: 'macro', x: 0, y: 210, params: { value: 0.35 } },
    ],
    routing: [['osc', 'comb'], ['comb', 'amp']],
    matrix: [
      { src: 'env', dst: 'amp.gain', depth: 0.82 },
      { src: 'space', dst: 'comb.feedback', depth: 0.24 },
      { src: 'space', dst: 'comb.damping', depth: -0.2 },
    ],
  },
];

export function listPatchMacros() {
  return PATCH_MACROS.map(({ id, name }) => ({ id, name }));
}

export function insertPatchMacro(patch, macroId, origin, nextId) {
  const macro = PATCH_MACROS.find((entry) => entry.id === macroId);
  if (!macro) throw new Error(`Unknown patch macro: ${macroId}`);
  patch.positions ||= {};
  patch.routing ||= [];
  patch.matrix ||= [];
  patch.groups ||= [];

  const ids = {};
  for (const module of macro.modules) {
    const id = nextId(module.type);
    ids[module.key] = id;
    patch.modules[id] = { type: module.type, params: { ...module.params } };
    patch.positions[id] = { x: origin.x + module.x, y: origin.y + module.y };
  }
  patch.routing.push(...macro.routing.map(([source, target]) => [ids[source], ids[target]]));
  patch.matrix.push(...macro.matrix.map((entry) => ({
    ...entry,
    src: ids[entry.src],
    dst: `${ids[entry.dst.split('.')[0]]}.${entry.dst.split('.').slice(1).join('.')}`,
  })));
  const group = { id: `group-${Date.now()}-${patch.groups.length + 1}`, name: macro.name, modules: Object.values(ids) };
  patch.groups.push(group);
  return group;
}
