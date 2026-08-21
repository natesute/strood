// Source modules — wrap superdough's existing oscillators as composable modules
import {
  getFrequencyFromValue,
  releaseAudioNode,
  getWorklet,
  getAudioContext,
} from 'superdough';
import { getNoiseOscillator } from 'superdough/noise.mjs';
import { registerModule } from '../registry.mjs';

// Basic waveform oscillator (sine, triangle, square, sawtooth)
function oscFactory(waveform) {
  return (ac, params, ctx) => {
    const osc = ac.createOscillator();
    osc.type = waveform;
    osc.frequency.value = params.frequency ?? ctx.frequency;
    if (params.detune) osc.detune.value = params.detune;
    osc.start(ctx.t);

    return {
      node: osc,
      inputNode: null,
      params: {
        frequency: osc.frequency,
        detune: osc.detune,
      },
      nodes: { source: [osc] },
      stop: (time) => osc.stop(time),
      cleanup: () => releaseAudioNode(osc),
    };
  };
}

registerModule('sine', oscFactory('sine'), {
  category: 'source',
  inputs: 0,
  outputs: 1,
  params: {
    frequency: { min: 20, max: 20000, default: 440, unit: 'Hz' },
    detune: { min: -1200, max: 1200, default: 0, unit: 'cents' },
  },
});

registerModule('triangle', oscFactory('triangle'), {
  category: 'source',
  inputs: 0,
  outputs: 1,
  params: {
    frequency: { min: 20, max: 20000, default: 440, unit: 'Hz' },
    detune: { min: -1200, max: 1200, default: 0, unit: 'cents' },
  },
});

registerModule('square', oscFactory('square'), {
  category: 'source',
  inputs: 0,
  outputs: 1,
  params: {
    frequency: { min: 20, max: 20000, default: 440, unit: 'Hz' },
    detune: { min: -1200, max: 1200, default: 0, unit: 'cents' },
  },
});

registerModule('sawtooth', oscFactory('sawtooth'), {
  category: 'source',
  inputs: 0,
  outputs: 1,
  params: {
    frequency: { min: 20, max: 20000, default: 440, unit: 'Hz' },
    detune: { min: -1200, max: 1200, default: 0, unit: 'cents' },
  },
});

// Supersaw — uses existing supersaw-oscillator worklet
registerModule(
  'supersaw',
  (ac, params, ctx) => {
    const frequency = params.frequency ?? ctx.frequency;
    const source = getWorklet(ac, 'supersaw-oscillator', {
      frequency,
      voices: params.voices ?? 5,
      detune: params.detune ?? 0.18,
    });

    return {
      node: source,
      inputNode: null,
      params: {
        frequency: source.parameters.get('frequency'),
        voices: source.parameters.get('voices'),
        detune: source.parameters.get('detune'),
      },
      nodes: { source: [source] },
      stop: () => releaseAudioNode(source),
      cleanup: () => releaseAudioNode(source),
    };
  },
  {
    category: 'source',
    inputs: 0,
    outputs: 1,
    params: {
      frequency: { min: 20, max: 20000, default: 440, unit: 'Hz' },
      voices: { min: 1, max: 16, default: 5 },
      detune: { min: 0, max: 1, default: 0.18 },
    },
  },
);

// Noise source
registerModule(
  'noise',
  (ac, params, ctx) => {
    const type = params.type ?? 'white';
    const noiseHandle = getNoiseOscillator(type, ctx.t, params.density ?? 0.02);

    return {
      node: noiseHandle.node,
      inputNode: null,
      params: {},
      nodes: { source: [noiseHandle.node] },
      stop: (time) => noiseHandle.stop?.(time),
      cleanup: () => releaseAudioNode(noiseHandle.node),
    };
  },
  {
    category: 'source',
    inputs: 0,
    outputs: 1,
    params: {
      type: { values: ['white', 'pink', 'brown', 'crackle'], default: 'white' },
    },
  },
);
