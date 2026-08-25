import { describe, expect, it } from 'vitest';
import {
  cycleWithinSection,
  nextCycleTiming,
  parseSections,
  sectionEndTiming,
  sectionAtCycle,
  setSelectedSongSection,
  selectedSongSection,
} from '../src/song-metadata.js';
import { requiredLocalSampleUrls, requiredSamplePacks } from '../src/sample-loader.js';
import { needsCustomVisualizers, needsModularSynth, referencedPatchSounds } from '../src/optional-systems.js';
import {
  findInlineControls,
  findMethodHelp,
  formatContextualValue,
  formatInlineNumber,
} from '../src/inline-controls.js';
import { patchSoundRanges } from '../src/score-visuals.js';
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

  it('resolves a live song-part selection to its arrangement cycle', () => {
    const code = `const songPart = 'Verse one'
const arrangement = [
  { section: 'Opening hook', cycles: 8 },
  { section: 'Verse one', cycles: 16 },
]`;
    expect(selectedSongSection(code)).toEqual({ name: 'Verse one', start: 8 });
    expect(selectedSongSection(code.replace('Verse one\'\n', 'Full song\'\n')))
      .toEqual({ name: 'Full song', start: 0 });
    expect(setSelectedSongSection(code, 'Opening hook'))
      .toContain("const songPart = 'Opening hook'");
  });

  it('calculates the next cycle boundary', () => {
    expect(nextCycleTiming(2.25, 0.5, 0)).toEqual({ targetCycle: 3, milliseconds: 1500 });
  });

  it('queues a section action for the natural end of the current section', () => {
    const section = { name: 'Opening hook', start: 0, end: 8 };
    expect(sectionEndTiming(12.25, 0.5, section, 2.5, 0)).toEqual({
      targetCycle: 17.75,
      milliseconds: 11000,
    });
  });

  it('wraps the playhead inside a looped section', () => {
    const section = { name: 'Final hit', start: 148, end: 149 };
    expect(cycleWithinSection(section, 0.4)).toBeCloseTo(148.4);
    expect(cycleWithinSection(section, 2.4)).toBeCloseTo(148.4);
  });
});

describe('lazy assets and reusable patch subgraphs', () => {
  it('loads only the modular patches referenced by a song', () => {
    const code = 'note("c4").sound("vox")\nnote("c2").sound("acid")\nnote("e4").sound("vox")';
    expect(referencedPatchSounds(code)).toEqual(['vox', 'acid']);
    expect(referencedPatchSounds("const vocalSynth = 'vox'\nnote('c4').sound(vocalSynth)"))
      .toEqual(['vox']);
    expect(needsModularSynth('note("c4").sound("sine")')).toBe(false);
  });

  it('loads the visualizer module for every registered widget method', () => {
    for (const method of ['_phase', '_interference', '_overtones', '_pendulum', '_resonance']) {
      expect(needsCustomVisualizers(`note("c4").sound("sine").${method}({ size: 200 })`)).toBe(true);
    }
    expect(needsCustomVisualizers('note("c4").sound("sine")')).toBe(false);
  });

  it('loads only packs referenced by the song', () => {
    expect(requiredSamplePacks('note("c4").sound("sawtooth")')).toEqual([]);
    expect(requiredSamplePacks('s("bd").bank("RolandTR909")\nnote("c4").sound("piano")')).toEqual(['piano', 'drums']);
    expect(requiredLocalSampleUrls(`
      samples({ vocal: '/audio/kids-vocals.mp3' })
      samples({ duplicate: '/audio/kids-vocals.mp3' })
    `)).toEqual(['/audio/kids-vocals.mp3']);
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

  it('turns the selected song part into a section dropdown', () => {
    const code = `const songPart = 'Verse one'
const arrangement = [
  { section: 'Opening hook', cycles: 8 },
  { section: 'Verse one', cycles: 16 },
]`;
    expect(findInlineControls(code)).toContainEqual(expect.objectContaining({
      type: 'choice',
      name: 'songPart',
      value: 'Verse one',
      options: ['Full song', 'Opening hook', 'Verse one'],
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

  it('describes control values in musical terms', () => {
    expect(formatContextualValue('lpf', 4280)).toBe('4280 Hz');
    expect(formatContextualValue('pan', 0.5)).toBe('centre');
    expect(formatContextualValue('room', 0.38)).toBe('38% room');
    expect(formatContextualValue('orbit', 2)).toBe('orbit 2');
    expect(formatContextualValue('release', 0.28)).toBe('280 ms');
  });

  it('adds concise help to recognised signal-chain methods', () => {
    const methods = findMethodHelp('note("c4").lpf(4280).room(.38)._scope()');
    expect(methods.map(({ name }) => name)).toEqual(['lpf', 'room', '_scope']);
    expect(methods[0].description).toContain('frequencies above');
  });

  it('finds exact patch sounds without highlighting similar names', () => {
    const code = `const voice = 'vox'\nnote('c4').sound('vox')\nnote('c3').sound('vox-pad')`;
    expect(patchSoundRanges(code, 'vox')).toHaveLength(2);
    expect(patchSoundRanges(code, 'acid')).toEqual([]);
  });
});
