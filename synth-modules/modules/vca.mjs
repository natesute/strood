// VCA (Voltage Controlled Amplifier) module — a gain stage for the modular chain
import { gainNode, releaseAudioNode } from 'superdough';
import { registerModule } from '../registry.mjs';

registerModule(
  'vca',
  (ac, params, ctx) => {
    const node = gainNode(params.gain ?? 1);

    return {
      node,
      inputNode: node,
      params: {
        gain: node.gain,
      },
      nodes: { gain: [node] },
      stop: () => {},
      cleanup: () => releaseAudioNode(node),
    };
  },
  {
    category: 'utility',
    inputs: 1,
    outputs: 1,
    params: {
      gain: { min: 0, max: 2, default: 1 },
    },
  },
);
