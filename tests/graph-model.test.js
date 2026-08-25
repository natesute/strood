import { describe, expect, it } from 'vitest';
import {
  addVisualizer,
  attachVisualizer,
  buildSongGraph,
  collectGraphActivityHaps,
  findArrangementEntries,
  parseDeclarations,
  removeVisualizer,
  resolveGraphActivity,
  toggleTrackMute,
  toggleTrackSolo,
} from '../src/graph-model.js';
import { automaticLayout } from '../src/graph-view.js';

const song = `const notes = note("c4 e4 g4")
const voice = notes
  .sound("sawtooth")
  .lpf(1200)
  ._helix({ size: 180 })

// @track lead | Lead synth
lead$: track(
  'lead',
  voice.orbit(1),
  { gain: .8 }
)`;

const literalSong = `const synthName = 'square'
const vocalNotes = "<[~ a4 e5] [d5@2 ~]>"
const leadVocal = note(vocalNotes).sound(synthName)

vocal$: track('vocal', leadVocal)
  ._lissajous({ size: 150 })`;

const mixedSong = `const solo = 'all'
const leadMix = { gain: .8, mute: false }
const leadNotes = note("c4 e4")
const leadVoice = leadNotes.sound("square")

// @track main-hook | Lead synth
lead$: track('main-hook', leadVoice, leadMix)`;

const arrangedSong = `const phrase = note("c4 e4 g4")
const timeline = arrange([4, phrase], [4, silence], [1, note("c5")])
const voice = timeline.sound("square")

// @track lead | Lead synth
lead$: track('lead', voice)`;

const denseSong = [3, 4, 3, 5, 3, 2, 2, 1, 10].map((noteCount, trackIndex) => {
  const noteNames = Array.from({ length: noteCount }, (_, noteIndex) => `notes${trackIndex}_${noteIndex}`);
  const notes = noteNames.map((name) => `const ${name} = note("c4 e4 g4")`).join('\n');
  return `${notes}
const voice${trackIndex} = stack(${noteNames.join(', ')})._orbit({ size: 165 })

// @track track${trackIndex} | Track ${trackIndex}
track${trackIndex}$: track('track${trackIndex}', voice${trackIndex})`;
}).join('\n\n');

describe('source-backed graph model', () => {
  it('includes short onsets crossed between graph frames', () => {
    const active = { whole: { begin: 2, end: 2.2 } };
    const endedStaccato = { whole: { begin: 2.02, end: 2.025 } };
    const future = { whole: { begin: 2.08, end: 2.1 } };

    expect(collectGraphActivityHaps(
      [active],
      [active, endedStaccato, future],
      2,
      2.05,
    )).toEqual([active, endedStaccato]);
  });

  it('finds instrument, notes and visualiser nodes from the executable source', () => {
    const graph = buildSongGraph(song);
    expect(graph.codeNodes.map(({ name, kind, role }) => [name, kind, role])).toEqual([
      ['voice', 'declaration', 'track'],
      ['notes', 'notes', 'phrase'],
    ]);
    expect(graph.visualizers).toEqual([
      expect.objectContaining({ method: '_helix', target: 'voice' }),
    ]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'voice', to: 'notes' }),
      expect.objectContaining({ from: 'voice', to: graph.visualizers[0].id }),
    ]));
  });

  it('treats dependent pattern strings as notes without mistaking synth names for notes', () => {
    const graph = buildSongGraph(literalSong);
    expect(graph.codeNodes.map(({ name, kind, role }) => [name, kind, role])).toEqual([
      ['leadVocal', 'declaration', 'track'],
      ['vocalNotes', 'notes', 'phrase'],
    ]);
    expect(graph.visualizers[0]).toEqual(expect.objectContaining({
      method: '_lissajous',
      target: 'leadVocal',
    }));
  });

  it('keeps complete multiline declaration ranges editable', () => {
    const voice = parseDeclarations(song).find(({ name }) => name === 'voice');
    expect(voice.text).toContain('.sound("sawtooth")');
    expect(voice.text).toContain('._helix({ size: 180 })');
    expect(song.slice(voice.from, voice.to)).toBe(voice.text);
  });

  it('routes phrases through an arrangement node before their track', () => {
    const graph = buildSongGraph(arrangedSong);
    expect(graph.codeNodes.map(({ name, role }) => [name, role])).toEqual([
      ['voice', 'track'],
      ['timeline', 'arrangement'],
      ['phrase', 'phrase'],
    ]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'voice', to: 'timeline' }),
      expect.objectContaining({ from: 'timeline', to: 'phrase' }),
    ]));

    const from = arrangedSong.indexOf('c4');
    const activity = resolveGraphActivity(graph, [{ from, to: from + 2, label: 'c4' }]);
    expect(activity.activeNodes).toEqual(new Set(['phrase', 'timeline', 'voice']));
    expect(activity.activeDependenciesByNode.get('timeline')).toEqual(new Set(['phrase']));
    expect(findArrangementEntries(graph.codeNodes.find(({ name }) => name === 'timeline').text))
      .toEqual([
        expect.objectContaining({ start: 0, end: 4, dependency: 'phrase' }),
        expect.objectContaining({ start: 4, end: 8, dependency: 'silence' }),
        expect.objectContaining({ start: 8, end: 9, dependency: null, laneLength: 9 }),
      ]);
  });

  it('rewires a visualiser by moving its source method to the selected node', () => {
    const graph = buildSongGraph(song);
    const next = attachVisualizer(song, graph.visualizers[0].id, 'notes');
    const moved = buildSongGraph(next).visualizers[0];
    expect(moved.target).toBe('notes');
    expect(parseDeclarations(next).find(({ name }) => name === 'voice').text).not.toContain('._helix');
    expect(parseDeclarations(next).find(({ name }) => name === 'notes').text).toContain('._helix');
  });

  it('adds a chosen visualiser directly to declaration source', () => {
    const next = addVisualizer(song, '_orbit', 'notes');
    expect(parseDeclarations(next).find(({ name }) => name === 'notes').text)
      .toContain('._orbit({ size: 165 })');
  });

  it('offers a wide waveform visualiser for recorded audio', () => {
    const next = addVisualizer(song, '_scope', 'voice');
    expect(parseDeclarations(next).find(({ name }) => name === 'voice').text)
      .toContain('._scope({ width: 520, height: 112, autoScale: true })');
  });

  it('removes a visualiser from its declaration source', () => {
    const visualizer = buildSongGraph(song).visualizers[0];
    const next = removeVisualizer(song, visualizer.id);

    expect(buildSongGraph(next).visualizers).toHaveLength(0);
    expect(parseDeclarations(next).find(({ name }) => name === 'voice').text)
      .not.toContain('._helix');
  });

  it('keeps existing visualiser identities stable when another is added earlier', () => {
    const before = buildSongGraph(song).visualizers[0];
    const next = addVisualizer(song, '_orbit', 'notes');
    const after = buildSongGraph(next).visualizers.find(({ method }) => method === '_helix');

    expect(after.id).toBe(before.id);
  });

  it('routes a sounding note through its declaration and visualiser', () => {
    const graph = buildSongGraph(song);
    const from = song.indexOf('c4');
    const activity = resolveGraphActivity(graph, [{ from, to: from + 2, label: 'c4' }]);
    const visualizer = graph.visualizers[0];

    expect(activity.activeNodes).toEqual(new Set(['notes', 'voice', visualizer.id]));
    expect(activity.activeEdges).toEqual(new Set([
      'edge:voice:notes',
      `edge:voice:${visualizer.id}`,
    ]));
    expect(activity.labelsByNode.get('voice')).toEqual(new Set(['c4']));
  });

  it('edits source-backed mute and solo controls for declaration nodes', () => {
    const graph = buildSongGraph(mixedSong);
    expect(graph.tracks[0]).toMatchObject({ key: 'main-hook', muted: false });
    expect(graph.tracks[0].mixDeclaration.name).toBe('leadMix');

    const muted = toggleTrackMute(mixedSong, 'main-hook');
    expect(muted).toContain('const leadMix = { gain: .8, mute: true }');
    expect(buildSongGraph(muted).tracks[0].muted).toBe(true);

    const soloed = toggleTrackSolo(muted, 'main-hook');
    expect(soloed).toContain("const solo = 'main-hook'");
    expect(toggleTrackSolo(soloed, 'main-hook')).toContain("const solo = 'all'");
  });

  it('packs dense songs to the viewport aspect without overlapping nodes', () => {
    const viewport = { width: 1280, height: 602 };
    const layout = automaticLayout(buildSongGraph(denseSong), viewport.width, viewport.height);
    const nodes = Object.values(layout);
    const bounds = nodes.reduce((result, node) => ({
      width: Math.max(result.width, node.x + node.width + 24),
      height: Math.max(result.height, node.y + node.height + 24),
    }), { width: 0, height: 0 });
    const scale = Math.min(1, (viewport.width - 24) / bounds.width, (viewport.height - 24) / bounds.height);

    for (let left = 0; left < nodes.length; left++) {
      for (let right = left + 1; right < nodes.length; right++) {
        const a = nodes[left];
        const b = nodes[right];
        const overlaps = a.x < b.x + b.width && a.x + a.width > b.x
          && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlaps).toBe(false);
      }
    }
    expect(bounds.width / bounds.height).toBeGreaterThan(1.7);
    expect(scale).toBeGreaterThan(.38);
    expect(bounds.width * scale).toBeGreaterThan(viewport.width * .8);
    expect(bounds.height * scale).toBeGreaterThan(viewport.height * .8);
  });
});
