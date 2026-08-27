import { describe, expect, it } from 'vitest';
import {
  addVisualizer,
  arrangementEntryId,
  attachVisualizer,
  buildSongGraph,
  collectGraphActivityHaps,
  findArrangementEntries,
  parseDeclarations,
  removeVisualizer,
  resolveArrangementPlayback,
  resolveGraphActivity,
  toggleTrackMute,
  toggleTrackSolo,
} from '../src/graph-model.js';
import {
  automaticLayout,
  graphRectIsVisible,
  graphViewportBounds,
  resolveNodeCollisions,
} from '../src/graph-view.js';

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

const phraseVisualizerSong = `const notes = note("c4 e4")._scope({ width: 200, height: 80 })
const voice = notes.sound("square")

// @track lead | Lead
lead$: track('lead', voice)`;

const mixedSong = `const solo = 'all'
const leadMix = { gain: .8, mute: false }
const leadNotes = note("c4 e4")
const leadVoice = leadNotes.sound("square")

// @track main-hook | Lead synth
lead$: track('main-hook', leadVoice, leadMix)`;

const twoTrackSong = `${song}

const bassNotes = note("c2 g2")
const bassVoice = bassNotes.sound("square")

// @track bass | Bass
bass$: track('bass', bassVoice)`;

const arrangedSong = `const phrase = note("c4 e4 g4")
const timeline = arrange([4, phrase], [4, silence], [1, note("c5")])
const voice = timeline.sound("square")

// @track lead | Lead synth
lead$: track('lead', voice)`;

const nestedArrangedSong = `const groove = note("c4 e4")
const fill = note("g4 a4")
const other = note("d4 f4")
const nested = arrange([2, groove], [2, fill])
const timeline = arrange([4, nested], [4, other])

// @track lead | Lead synth
lead$: track('lead', timeline)`;

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

  it('connects visualisers declared on phrases to their owning track node', () => {
    const graph = buildSongGraph(phraseVisualizerSong);
    expect(graph.visualizers[0]).toMatchObject({
      method: '_scope',
      sourceTarget: 'notes',
      target: 'voice',
      trackKey: 'lead',
    });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      from: 'voice',
      to: graph.visualizers[0].id,
    }));
    expect(graph.edges.some(({ from, to }) => from === 'notes' && to === graph.visualizers[0].id))
      .toBe(false);
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
    const timelineSource = graph.codeNodes.find(({ name }) => name === 'timeline').text;
    const inlineEntry = findArrangementEntries(timelineSource)[2];
    expect(timelineSource.slice(inlineEntry.highlightFrom, inlineEntry.highlightTo)).toBe('[1, note');
  });

  it('only activates nested arrangements selected by their parent', () => {
    const graph = buildSongGraph(nestedArrangedSong);
    const nested = graph.codeNodes.find(({ name }) => name === 'nested');
    const timeline = graph.codeNodes.find(({ name }) => name === 'timeline');
    const track = graph.codeNodes.find(({ name }) => name === 'lead$');
    const opening = resolveArrangementPlayback(graph, 1, true);
    expect(track).toMatchObject({ kind: 'declaration', role: 'track', sourceType: 'track' });
    expect(track.text).toBe("lead$: track('lead', timeline)");
    expect(timeline.role).toBe('arrangement');
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'lead$', to: 'timeline' }));
    expect(opening.activeNodes).toEqual(new Set(['lead$', 'timeline', 'nested', 'groove']));
    expect(opening.activeEntries).toContain(arrangementEntryId('timeline', timeline.arrangementEntries[0]));
    expect(opening.activeEntries).toContain(arrangementEntryId('nested', nested.arrangementEntries[0]));
    expect(opening.activeEdges).toContain('edge:nested:groove');

    const later = resolveArrangementPlayback(graph, 5, true);
    expect(later.activeNodes).toEqual(new Set(['lead$', 'timeline', 'other']));
    expect(later.activeNodes.has('nested')).toBe(false);
    expect(later.activeNodes.has('groove')).toBe(false);
    expect(later.activeEdges.has('edge:nested:groove')).toBe(false);
  });

  it('rewires a visualiser only between track nodes', () => {
    const graph = buildSongGraph(twoTrackSong);
    expect(attachVisualizer(twoTrackSong, graph.visualizers[0].id, 'notes')).toBe(twoTrackSong);
    const next = attachVisualizer(twoTrackSong, graph.visualizers[0].id, 'bassVoice');
    const moved = buildSongGraph(next).visualizers[0];
    expect(moved.target).toBe('bassVoice');
    expect(parseDeclarations(next).find(({ name }) => name === 'voice').text).not.toContain('._helix');
    expect(parseDeclarations(next).find(({ name }) => name === 'bassVoice').text).toContain('._helix');
  });

  it('adds a chosen visualiser only to a track declaration', () => {
    expect(addVisualizer(song, '_orbit', 'notes')).toBe(song);
    const next = addVisualizer(song, '_orbit', 'voice');
    expect(parseDeclarations(next).find(({ name }) => name === 'voice').text)
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
    const next = addVisualizer(song, '_orbit', 'voice');
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

  it('maps the graph camera to overscanned world bounds for visualiser culling', () => {
    const bounds = graphViewportBounds({
      cameraX: -200,
      cameraY: -100,
      scale: 2,
      viewportWidth: 800,
      viewportHeight: 600,
      overscan: 140,
    });

    expect(bounds).toEqual({ left: 30, top: -20, right: 570, bottom: 420 });
    expect(graphRectIsVisible({ x: 20, y: 10, width: 10, height: 10 }, bounds)).toBe(true);
    expect(graphRectIsVisible({ x: 570, y: 420, width: 20, height: 20 }, bounds)).toBe(true);
    expect(graphRectIsVisible({ x: 571, y: 20, width: 20, height: 20 }, bounds)).toBe(false);
    expect(graphRectIsVisible({ x: 40, y: 421, width: 20, height: 20 }, bounds)).toBe(false);
    expect(graphRectIsVisible({ x: 10, y: 20, width: 19, height: 20 }, bounds)).toBe(false);
    expect(graphRectIsVisible({ x: 40, y: -40, width: 20, height: 19 }, bounds)).toBe(false);
  });

  it('pushes neighbouring nodes away from a dragged node without moving the dragged node', () => {
    const layout = {
      dragged: { x: 80, y: 40, width: 120, height: 90 },
      neighbour: { x: 150, y: 52, width: 120, height: 90 },
      chained: { x: 260, y: 52, width: 120, height: 90 },
      lower: { x: 160, y: 132, width: 120, height: 90 },
    };
    const resolved = resolveNodeCollisions(layout, { fixedIds: ['dragged'], gap: 10 });
    const nodes = Object.values(resolved);

    expect(resolved.dragged).toEqual(layout.dragged);
    for (const node of nodes) {
      expect(node.x).toBeGreaterThanOrEqual(8);
      expect(node.y).toBeGreaterThanOrEqual(8);
    }
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left];
        const b = nodes[right];
        const overlaps = a.x < b.x + b.width + 10 && a.x + a.width + 10 > b.x
          && a.y < b.y + b.height + 10 && a.y + a.height + 10 > b.y;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('repairs overlapping saved layouts while leaving clear layouts alone', () => {
    const overlapping = {
      first: { x: 8, y: 8, width: 100, height: 80 },
      second: { x: 40, y: 30, width: 100, height: 80 },
      third: { x: 55, y: 45, width: 100, height: 80 },
    };
    const clear = {
      first: { x: 8, y: 8, width: 100, height: 80 },
      second: { x: 130, y: 8, width: 100, height: 80 },
    };
    const repaired = Object.values(resolveNodeCollisions(overlapping, { gap: 10 }));

    for (let left = 0; left < repaired.length; left += 1) {
      for (let right = left + 1; right < repaired.length; right += 1) {
        const a = repaired[left];
        const b = repaired[right];
        const overlaps = a.x < b.x + b.width + 10 && a.x + a.width + 10 > b.x
          && a.y < b.y + b.height + 10 && a.y + a.height + 10 > b.y;
        expect(overlaps).toBe(false);
      }
    }
    expect(resolveNodeCollisions(clear, { gap: 10 })).toEqual(clear);
  });
});

describe('comment-aware source parsing', () => {
  it('removes only the visualizer call when its options contain an apostrophe comment', () => {
    const commented = `const voice = sound("bd sd")
  ._pulse({
    // don't autoscale
    size: 120,
  })

const bass = sound("jvbass");
`;
    const graph = buildSongGraph(commented);
    expect(graph.visualizers).toHaveLength(1);
    expect(removeVisualizer(commented, graph.visualizers[0].id))
      .toBe('const voice = sound("bd sd")\n\nconst bass = sound("jvbass");\n');
  });

  it('ignores declarations inside block comments', () => {
    const commented = `/*
const voice = notes.sound("square")
*/
const notes = note("c4 e4")`;
    expect(parseDeclarations(commented).map(({ name }) => name)).toEqual(['notes']);
  });

  it('keeps a chain that resumes after a comment line inside its declaration', () => {
    const commented = `const voice = note("c4")
  // gentle filter
  .lpf(1200)

const other = note("e4")`;
    const [voice] = parseDeclarations(commented);
    expect(voice.text).toContain('.lpf(1200)');
  });

  it('skips commented-out arrangement entries', () => {
    const arrangement = `arrange(
  [4, phrase],
  // [4, oldFill] retired verse
  [4, chorus],
)`;
    const entries = findArrangementEntries(arrangement);
    expect(entries.map(({ dependency }) => dependency)).toEqual(['phrase', 'chorus']);
    expect(entries.map(({ start, end }) => [start, end])).toEqual([[0, 4], [4, 8]]);
  });

  it('ignores visualizer calls inside comments', () => {
    const commented = `const voice = note("c4")
// voice._pulse({ size: 120 })`;
    expect(buildSongGraph(commented).visualizers).toHaveLength(0);
  });

  it('splices a new visualizer before a trailing semicolon', () => {
    const arranged = `const phrase = note("c4 e4 g4")
const voice = phrase.sound("square");

// @track lead | Lead
lead$: track('lead', voice)`;
    const added = addVisualizer(arranged, '_orbit', 'voice');
    expect(added).toContain('.sound("square")\n  ._orbit({ size: 165 });');
  });
});
