const CDN = 'https://strudel.b-cdn.net';
const loaded = new Map();

export function requiredSamplePacks(code) {
  const packs = [];
  if (/\b(?:piano|gm_piano)\b/i.test(code)) packs.push('piano');
  if (/\.bank\s*\(/.test(code)) packs.push('drums');
  const usesUnbankedSamples = /\b(?:s|sound)\s*\(/.test(code)
    && !/\.bank\s*\(/.test(code)
    && !/\.sound\s*\(\s*["'](?:sine|square|sawtooth|triangle|white|pink|brown|z_sawtooth|supersaw|vox|acid|lush|glitch|init)["']/.test(code);
  if (usesUnbankedSamples) packs.push('dirt');
  return [...new Set(packs)];
}

function loadPack(name, samples) {
  if (loaded.has(name)) return loaded.get(name);
  const promise = name === 'piano'
    ? samples(`${CDN}/piano.json`, `${CDN}/piano/`, { prebake: true })
    : name === 'drums'
      ? samples(`${CDN}/tidal-drum-machines.json`, `${CDN}/tidal-drum-machines/machines/`, { prebake: true })
      : samples('github:tidalcycles/dirt-samples');
  loaded.set(name, promise);
  return promise;
}

export async function loadSamplePacks(code, samples) {
  const names = requiredSamplePacks(code);
  const results = await Promise.allSettled(names.map((name) => loadPack(name, samples)));
  return { names, results, failed: results.filter((result) => result.status === 'rejected').length };
}

