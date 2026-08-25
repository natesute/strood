import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const input = process.argv[2];
const output = process.argv[3] || 'public/audio/kids-vocals.mp3';

if (!input) {
  console.error('Usage: node scripts/build-kids-vocals.mjs <input audio> [output mp3]');
  process.exit(1);
}

const bpm = 123;
const bars = 149;
const duration = bars * 4 * 60 / bpm;

// The two identical vocal pickups at bars 25 and 117 occur at 54.370 and
// 233.860 seconds in the supplied recording. Both resolve to this bar-one
// downbeat on a 123 BPM grid (within the source MP3's transient resolution).
const trimStart = 6.554;

const outputPath = resolve(output);
mkdirSync(dirname(outputPath), { recursive: true });
const result = spawnSync('ffmpeg', [
  '-y',
  '-hide_banner',
  '-i', resolve(input),
  '-af', `atrim=start=${trimStart}:duration=${duration},asetpts=PTS-STARTPTS`,
  '-map', '0:a:0',
  '-ar', '48000',
  '-ac', '2',
  '-codec:a', 'libmp3lame',
  '-q:a', '2',
  outputPath,
], { stdio: 'inherit' });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
