import { describe, expect, it } from 'vitest';
import { parseTracks, routeTracksForPlayback, setTrackGain } from '../src/tracks.js';

const song = `setcpm(120/4)
// BASS
$: note("c2 e2").sound("sawtooth")

// DRUMS
$: s("bd sd")
$: s("hh*4")`;

describe('track parsing', () => {
  it('finds each live pattern and keeps section labels with the following track', () => {
    const tracks = parseTracks(song);
    expect(tracks).toHaveLength(3);
    expect(tracks.map((track) => track.name)).toEqual(['BASS', 'DRUMS', 'Track 3']);
    expect(song.slice(tracks[0].start, tracks[0].end)).not.toContain('// DRUMS');
  });

  it('adds and updates a visible master gain without swallowing the next section header', () => {
    const lowered = setTrackGain(song, 0, 0.65);
    expect(lowered).toContain('$: (note("c2 e2").sound("sawtooth")).gain(0.65) // strood-track-gain');
    expect(lowered).toContain('\n\n// DRUMS\n$: s("bd sd")');
    expect(parseTracks(lowered)[0].gain).toBe(0.65);

    const muted = setTrackGain(lowered, 0, 0);
    expect(parseTracks(muted)[0].muted).toBe(true);
    expect(muted.match(/strood-track-gain/g)).toHaveLength(1);
  });

  it('uses named pattern labels, explicit track metadata, and stable playback orbits', () => {
    const named = `// @track lead | Lead voice\nlead$: note("c4")\n\nbass$: note("c2").orbit(7)`;
    const tracks = parseTracks(named);
    expect(tracks.map(({ key, name, orbit }) => ({ key, name, orbit }))).toEqual([
      { key: 'lead', name: 'Lead voice', orbit: 1 },
      { key: 'bass', name: 'bass', orbit: 7 },
    ]);
    const routed = routeTracksForPlayback(named);
    expect(routed).toContain('lead$: note("c4").orbit(1)');
    expect(routed.match(/\.orbit\(7\)/g)).toHaveLength(1);
  });
});
