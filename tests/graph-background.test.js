import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_MODES,
  createNoise,
  cycleBackgroundMode,
  resolveBackgroundMode,
} from '../src/graph-background.js';

describe('background modes', () => {
  it('declares unique ids with labels and an off mode', () => {
    const ids = BACKGROUND_MODES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('off');
    for (const mode of BACKGROUND_MODES) expect(mode.label).toBeTruthy();
  });

  it('gives every visual mode a complete palette', () => {
    for (const mode of BACKGROUND_MODES.filter(({ id }) => id !== 'off')) {
      for (const key of [
        'skyTop', 'skyBottom', 'fringeHue', 'fringeSat', 'fringeLight',
        'coreSat', 'coreLight', 'hueBase', 'hueSpread', 'hueDrift',
      ]) {
        expect(mode[key], `${mode.id}.${key}`).toBeDefined();
      }
    }
  });

  it('resolves unknown or missing ids to the default mode', () => {
    expect(resolveBackgroundMode('sky').id).toBe('sky');
    expect(resolveBackgroundMode('nope').id).toBe(BACKGROUND_MODES[0].id);
    expect(resolveBackgroundMode(undefined).id).toBe(BACKGROUND_MODES[0].id);
  });

  it('cycles through every mode and wraps around', () => {
    const seen = [];
    let id = BACKGROUND_MODES[0].id;
    for (let step = 0; step < BACKGROUND_MODES.length; step++) {
      seen.push(id);
      id = cycleBackgroundMode(id);
    }
    expect(seen).toEqual(BACKGROUND_MODES.map((mode) => mode.id));
    expect(id).toBe(BACKGROUND_MODES[0].id);
  });
});

describe('noise field', () => {
  it('is deterministic for a seed and bounded to [0, 1]', () => {
    const first = createNoise(7);
    const second = createNoise(7);
    for (let index = 0; index < 200; index++) {
      const x = index * 0.37;
      const y = index * 0.11;
      const z = index * 0.05;
      const value = first.fbm3(x, y, z, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(second.fbm3(x, y, z, 3)).toBe(value);
    }
  });

  it('varies across space rather than collapsing to a constant', () => {
    const { fbm3 } = createNoise(7);
    const samples = new Set();
    for (let index = 0; index < 50; index++) {
      samples.add(fbm3(index * 0.61, index * 0.23, 0.5, 3).toFixed(4));
    }
    expect(samples.size).toBeGreaterThan(30);
  });
});
