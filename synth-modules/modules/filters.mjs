// Filter modules — wrap superdough's existing filters + new custom worklet filters
import { getWorklet, releaseAudioNode } from 'superdough';
import { registerModule } from '../registry.mjs';

// Helper to create an AudioWorkletNode for our custom processors
function customWorklet(ac, processor, params) {
  const node = new AudioWorkletNode(ac, processor);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && node.parameters.has(key)) {
      node.parameters.get(key).value = value;
    }
  }
  return node;
}

// Standard biquad filter
registerModule(
  'biquad',
  (ac, params, ctx) => {
    const filter = ac.createBiquadFilter();
    filter.type = params.type ?? 'lowpass';
    filter.frequency.value = params.frequency ?? 1000;
    filter.Q.value = params.resonance ?? 1;
    if (params.gain != null) filter.gain.value = params.gain;

    return {
      node: filter,
      inputNode: filter,
      params: {
        frequency: filter.frequency,
        resonance: filter.Q,
        gain: filter.gain,
      },
      nodes: { lpf: [filter] },
      stop: () => {},
      cleanup: () => releaseAudioNode(filter),
    };
  },
  {
    category: 'filter',
    inputs: 1,
    outputs: 1,
    params: {
      type: { values: ['lowpass', 'highpass', 'bandpass', 'notch', 'allpass', 'peaking', 'lowshelf', 'highshelf'], default: 'lowpass' },
      frequency: { min: 20, max: 20000, default: 1000, unit: 'Hz' },
      resonance: { min: 0, max: 30, default: 1 },
      gain: { min: -40, max: 40, default: 0, unit: 'dB' },
    },
  },
);

// Ladder filter — uses existing ladder-processor worklet
registerModule(
  'ladder',
  (ac, params, ctx) => {
    const node = getWorklet(ac, 'ladder-processor', {
      frequency: params.frequency ?? 1000,
      q: params.resonance ?? 0.5,
      drive: params.drive ?? 0.69,
    });

    return {
      node,
      inputNode: node,
      params: {
        frequency: node.parameters.get('frequency'),
        resonance: node.parameters.get('q'),
        drive: node.parameters.get('drive'),
      },
      nodes: { lpf: [node] },
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'filter',
    inputs: 1,
    outputs: 1,
    params: {
      frequency: { min: 20, max: 20000, default: 1000, unit: 'Hz' },
      resonance: { min: 0, max: 1, default: 0.5 },
      drive: { min: 0, max: 4, default: 0.69 },
    },
  },
);

// SVF (State Variable Filter) — continuous LP/BP/HP/Notch morphing
// mode: 0=LP, 1=BP, 2=HP, 3=Notch (fractional values morph between)
registerModule(
  'svf',
  (ac, params, ctx) => {
    const node = customWorklet(ac, 'svf-processor', {
      frequency: params.frequency ?? 1000,
      resonance: params.resonance ?? 0.5,
      mode: params.mode ?? 0,
    });

    return {
      node,
      inputNode: node,
      params: {
        frequency: node.parameters.get('frequency'),
        resonance: node.parameters.get('resonance'),
        mode: node.parameters.get('mode'),
      },
      nodes: { lpf: [node] },
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'filter',
    inputs: 1,
    outputs: 1,
    params: {
      frequency: { min: 20, max: 20000, default: 1000, unit: 'Hz' },
      resonance: { min: 0, max: 1, default: 0.5 },
      mode: { min: 0, max: 3, default: 0, note: '0=LP, 1=BP, 2=HP, 3=Notch' },
    },
  },
);

// Comb filter — metallic, resonant, karplus-strong textures
registerModule(
  'comb',
  (ac, params, ctx) => {
    const node = customWorklet(ac, 'comb-processor', {
      frequency: params.frequency ?? 200,
      feedback: params.feedback ?? 0.7,
      damping: params.damping ?? 0.3,
    });

    return {
      node,
      inputNode: node,
      params: {
        frequency: node.parameters.get('frequency'),
        feedback: node.parameters.get('feedback'),
        damping: node.parameters.get('damping'),
      },
      nodes: {},
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'filter',
    inputs: 1,
    outputs: 1,
    params: {
      frequency: { min: 20, max: 10000, default: 200, unit: 'Hz' },
      feedback: { min: -0.99, max: 0.99, default: 0.7 },
      damping: { min: 0, max: 1, default: 0.3 },
    },
  },
);

// Formant filter — smooth vowel morphing
// morph: 0=a, 0.25=e, 0.5=i, 0.75=o, 1.0=u
registerModule(
  'formant',
  (ac, params, ctx) => {
    const node = customWorklet(ac, 'formant-processor', {
      morph: params.morph ?? 0,
      gain: params.gain ?? 1,
    });

    return {
      node,
      inputNode: node,
      params: {
        morph: node.parameters.get('morph'),
        gain: node.parameters.get('gain'),
      },
      nodes: { vowel: [node] },
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'filter',
    inputs: 1,
    outputs: 1,
    params: {
      morph: { min: 0, max: 1, default: 0, note: '0=a, 0.25=e, 0.5=i, 0.75=o, 1=u' },
      gain: { min: 0, max: 4, default: 1 },
    },
  },
);
