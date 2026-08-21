import { describe, expect, it } from 'vitest';
import { effectiveTrackGains } from '../src/mixer-state.js';
import { parseSections, sectionAtCycle, nextCycleTiming } from '../src/song-metadata.js';
import { requiredSamplePacks } from '../src/sample-loader.js';
import { insertPatchMacro, listPatchMacros } from '../synth-modules/macros.mjs';

describe('performance metadata', () => {
  it('parses a looping section map and resolves its current section', () => {
    const sections = parseSections('// @section Intro | 0-4\n// @section Hook | 4-8');
    expect(sectionAtCycle(sections, 5).name).toBe('Hook');
    expect(sectionAtCycle(sections, 9).name).toBe('Intro');
  });

  it('calculates the next cycle boundary', () => {
    expect(nextCycleTiming(2.25, 0.5, 0)).toEqual({ targetCycle: 3, milliseconds: 1500 });
  });
});

describe('runtime mixer', () => {
  const tracks = [{ key: 'lead' }, { key: 'bass' }];

  it('applies gain, mute, and solo without source transformations', () => {
    expect(effectiveTrackGains(tracks, { lead: { gain: 0.8 }, bass: { gain: 0.6, muted: true } }))
      .toEqual({ lead: 0.8, bass: 0 });
    expect(effectiveTrackGains(tracks, { lead: { gain: 0.8 }, bass: { gain: 0.6, solo: true } }))
      .toEqual({ lead: 0, bass: 0.6 });
  });
});

describe('lazy assets and reusable patch subgraphs', () => {
  it('loads only packs referenced by the song', () => {
    expect(requiredSamplePacks('note("c4").sound("sawtooth")')).toEqual([]);
    expect(requiredSamplePacks('s("bd").bank("RolandTR909")\nnote("c4").sound("piano")')).toEqual(['piano', 'drums']);
  });

  it('inserts a complete, uniquely named patch subgraph', () => {
    const patch = { modules: {}, routing: [], matrix: [], positions: {} };
    const nextId = (type) => {
      let index = 1;
      while (patch.modules[`${type}${index}`]) index += 1;
      return `${type}${index}`;
    };
    const macro = listPatchMacros().find(({ id }) => id === 'vocal-voice');
    const group = insertPatchMacro(patch, macro.id, { x: 40, y: 80 }, nextId);
    expect(group.modules).toHaveLength(7);
    expect(new Set(group.modules).size).toBe(7);
    expect(patch.routing).toHaveLength(3);
    expect(patch.matrix).toHaveLength(4);
  });
});
