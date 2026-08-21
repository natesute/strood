import { describe, expect, it } from 'vitest';
import { parseTracks, routeTracksForPlayback } from '../src/tracks.js';

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
