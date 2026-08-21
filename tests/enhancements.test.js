import { describe, expect, it } from 'vitest';
import { parseSections, sectionAtCycle, nextCycleTiming } from '../src/song-metadata.js';
import { requiredSamplePacks } from '../src/sample-loader.js';
import { needsModularSynth, referencedPatchSounds } from '../src/optional-systems.js';
import { findInlineControls, formatInlineNumber } from '../src/inline-controls.js';
import { insertPatchMacro, listPatchMacros } from '../synth-modules/macros.mjs';

describe('performance metadata', () => {
  it('turns an arrangement into a looping section map', () => {
    const sections = parseSections(`const arrangement = [
      { section: 'Intro', cycles: 4 },
      { section: 'Hook', cycles: 4 },
    ]`);
    expect(sections).toEqual([
      { name: 'Intro', start: 0, end: 4 },
      { name: 'Hook', start: 4, end: 8 },
    ]);
    expect(sectionAtCycle(sections, 5).name).toBe('Hook');
    expect(sectionAtCycle(sections, 9).name).toBe('Intro');
  });

  it('still opens songs that use legacy section comments', () => {
    expect(parseSections('// @section Intro | 0-4')).toEqual([
      { name: 'Intro', start: 0, end: 4 },
    ]);
  });

  it('calculates the next cycle boundary', () => {
    expect(nextCycleTiming(2.25, 0.5, 0)).toEqual({ targetCycle: 3, milliseconds: 1500 });
  });
});

describe('lazy assets and reusable patch subgraphs', () => {
  it('loads only the modular patches referenced by a song', () => {
    const code = 'note("c4").sound("vox")\nnote("c2").sound("acid")\nnote("e4").sound("vox")';
    expect(referencedPatchSounds(code)).toEqual(['vox', 'acid']);
    expect(needsModularSynth('note("c4").sound("sine")')).toBe(false);
  });

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

describe('source-backed inline controls', () => {
  it('finds mastering numbers, booleans, sounds, colours and track solo choices', () => {
    const code = `const master = .9
const solo = 'all'
// @track lead | Lead
lead$: note("c4").sound("sine").color("cyan").orbit(1)
  .gain(.8)
const settings = { gain: 1.05, pan: .4, mute: false }`;
    const controls = findInlineControls(code);
    expect(controls.filter(({ type }) => type === 'number').map(({ name }) => name))
      .toEqual(['master', 'orbit', 'gain', 'gain', 'pan']);
    expect(controls.filter(({ type }) => type === 'choice').map(({ name }) => name))
      .toEqual(['solo', 'sound', 'color']);
    expect(controls.find(({ name }) => name === 'solo').options).toEqual(['all', 'lead']);
    expect(controls.find(({ type }) => type === 'boolean')).toMatchObject({ name: 'mute', value: 'false' });
  });

  it('makes arrangement durations draggable', () => {
    const controls = findInlineControls("const arrangement = [{ section: 'Intro', cycles: 8 }]");
    expect(controls).toContainEqual(expect.objectContaining({
      type: 'number', name: 'cycles', value: '8', min: 1, max: 64, step: 1,
    }));
  });

  it('finds a named synth choice in ordinary source code', () => {
    const controls = findInlineControls("const vocalSynth = 'vox'\nnote('c4').sound(vocalSynth)");
    expect(controls).toContainEqual(expect.objectContaining({
      type: 'choice', name: 'vocalSynth', value: 'vox', options: expect.arrayContaining(['vox', 'sine']),
    }));
  });

  it('preserves compact decimal style while scrubbing', () => {
    expect(formatInlineNumber(0.75, 0.01, '.8')).toBe('.75');
    expect(formatInlineNumber(1, 0.01, '.8')).toBe('1');
    expect(formatInlineNumber(640, 10, '650')).toBe('640');
  });
});
