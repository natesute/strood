/*
 * Animated ASCII-art backgrounds for the song graph.
 *
 * Clouds are a fractal value-noise density field sampled on a character
 * grid; each cell picks a glyph from a density ramp and an iridescent
 * colour, then blits a cached glyph sprite. The field drifts slowly,
 * parallaxes a little with the graph camera and swells gently with the
 * master meter.
 */

const CELL_W = 11;
const CELL_H = 15;
const FONT_SIZE = 12;
const FONT_STACK = '"Fragment Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const FRAME_INTERVAL = 40;
const MAX_SPRITES = 4096;
const PARALLAX = 0.07;
const DENSITY_FREQ = 0.048;
const DRIFT_SPEED = 0.05;
const EVOLVE_SPEED = 0.095;
const CHARS = [' ', '.', ':', '+', '*', '=', '%', '&', '#', '@'];
const RAMP = [
  [1, 1, 2],
  [2, 2, 3],
  [3, 4, 3],
  [4, 5, 4],
  [5, 6, 5],
  [6, 8, 7],
  [8, 9, 6],
  [9, 8, 9],
];

export const BACKGROUND_MODES = [
  {
    id: 'sky',
    label: 'Sky',
    skyTop: '#1668cf',
    skyBottom: '#0b4a9e',
    fringeHue: 202,
    fringeSat: 85,
    fringeLight: 63,
    coreSat: 40,
    coreLight: 94,
    hueBase: 0,
    hueSpread: 360,
    hueDrift: 4,
  },
  {
    id: 'dusk',
    label: 'Dusk',
    skyTop: '#251038',
    skyBottom: '#411737',
    fringeHue: 294,
    fringeSat: 52,
    fringeLight: 44,
    coreSat: 64,
    coreLight: 82,
    hueBase: 300,
    hueSpread: 150,
    hueDrift: 3,
  },
  {
    id: 'night',
    label: 'Night',
    skyTop: '#05090f',
    skyBottom: '#0b1322',
    fringeHue: 214,
    fringeSat: 42,
    fringeLight: 28,
    coreSat: 30,
    coreLight: 62,
    hueBase: 180,
    hueSpread: 150,
    hueDrift: 2,
  },
  { id: 'off', label: 'Off' },
];

export function resolveBackgroundMode(id) {
  return BACKGROUND_MODES.find((mode) => mode.id === id) || BACKGROUND_MODES[0];
}

export function cycleBackgroundMode(id) {
  const index = BACKGROUND_MODES.findIndex((mode) => mode.id === id);
  return BACKGROUND_MODES[(index + 1) % BACKGROUND_MODES.length].id;
}

export function createNoise(seed = 11) {
  const permutation = new Uint8Array(512);
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const base = Array.from({ length: 256 }, (_, index) => index);
  for (let index = 255; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    [base[index], base[swap]] = [base[swap], base[index]];
  }
  for (let index = 0; index < 512; index++) permutation[index] = base[index & 255];

  const lattice = (x, y, z) =>
    permutation[(permutation[(permutation[x & 255] + y) & 255] + z) & 255] / 255;

  const noise3 = (x, y, z) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);
    const c000 = lattice(xi, yi, zi);
    const c100 = lattice(xi + 1, yi, zi);
    const c010 = lattice(xi, yi + 1, zi);
    const c110 = lattice(xi + 1, yi + 1, zi);
    const c001 = lattice(xi, yi, zi + 1);
    const c101 = lattice(xi + 1, yi, zi + 1);
    const c011 = lattice(xi, yi + 1, zi + 1);
    const c111 = lattice(xi + 1, yi + 1, zi + 1);
    const x00 = c000 + (c100 - c000) * u;
    const x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u;
    const x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v;
    const y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  };

  const fbm3 = (x, y, z, octaves) => {
    let amplitude = 0.5;
    let frequency = 1;
    let sum = 0;
    let normal = 0;
    for (let octave = 0; octave < octaves; octave++) {
      sum += amplitude * noise3(x * frequency, y * frequency, z * frequency);
      normal += amplitude;
      amplitude *= 0.5;
      frequency *= 2.03;
    }
    return sum / normal;
  };

  return { noise3, fbm3 };
}

function cellHash(x, y) {
  let hash = (x * 374761393 + y * 668265263) | 0;
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mixAngle(from, to, amount) {
  const difference = ((to - from + 540) % 360) - 180;
  return (from + difference * amount + 360) % 360;
}

export function createGraphBackground({ viewport }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'graph-background-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  viewport.prepend(canvas);
  const context = canvas.getContext('2d', { alpha: false });
  const { fbm3 } = createNoise();
  const sprites = new Map();

  let mode = BACKGROUND_MODES[0];
  let active = false;
  let rafId = 0;
  let lastFrame = 0;
  let clock = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let cameraX = 0;
  let cameraY = 0;
  let audioTarget = 0;
  let audioSmooth = 0;

  function shouldAnimate() {
    return active && mode.id !== 'off' && !document.hidden;
  }

  function sprite(charIndex, hue, sat, light) {
    const hueStep = Math.round(hue / 10) % 36;
    const satStep = Math.round(sat / 8);
    const lightStep = Math.round(light / 4);
    const key = ((charIndex * 36 + hueStep) * 16 + satStep) * 32 + lightStep;
    let cached = sprites.get(key);
    if (!cached) {
      if (sprites.size >= MAX_SPRITES) sprites.clear();
      cached = document.createElement('canvas');
      cached.width = Math.max(1, Math.round(CELL_W * dpr));
      cached.height = Math.max(1, Math.round(CELL_H * dpr));
      const glyph = cached.getContext('2d');
      glyph.font = `${FONT_SIZE * dpr}px ${FONT_STACK}`;
      glyph.textAlign = 'center';
      glyph.textBaseline = 'middle';
      glyph.fillStyle = `hsl(${hueStep * 10} ${satStep * 8}% ${lightStep * 4}%)`;
      glyph.fillText(CHARS[charIndex], cached.width / 2, cached.height / 2 + dpr * 0.5);
      sprites.set(key, cached);
    }
    return cached;
  }

  function paint() {
    if (!width || !height || mode.id === 'off') return;
    const columns = Math.ceil(width / CELL_W);
    const rows = Math.ceil(height / CELL_H);
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, mode.skyTop);
    gradient.addColorStop(1, mode.skyBottom);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    const aspect = CELL_H / CELL_W;
    const drift = clock * (DRIFT_SPEED / DENSITY_FREQ);
    const evolve = clock * EVOLVE_SPEED;
    const parallaxX = -cameraX * PARALLAX / CELL_W;
    const parallaxY = -cameraY * PARALLAX / CELL_H;
    const threshold = 0.47 - audioSmooth * 0.03;
    const glow = audioSmooth * 6;

    for (let row = 0; row < rows; row++) {
      const profile = smoothstep(0.06, 0.52, (row + 0.5) / rows);
      if (profile * 1.4 < threshold) continue;
      const sampleY = (row + parallaxY) * DENSITY_FREQ * aspect;
      for (let column = 0; column < columns; column++) {
        const sampleX = (column + parallaxX + drift) * DENSITY_FREQ;
        const coverNoise = fbm3(sampleX * 0.32 + 37.2, sampleY * 0.32, evolve * 0.7, 1);
        const cover = smoothstep(0.35, 0.65, coverNoise);
        const shape = fbm3(sampleX, sampleY, evolve, 3);
        const density = shape * (0.15 + 1.2 * cover) * profile;
        if (density <= threshold) continue;
        const amount = smoothstep(threshold, threshold + 0.16, density);
        const level = Math.min(RAMP.length, 1 + Math.floor(amount * RAMP.length));
        const hash = cellHash(column, row);
        const charIndex = RAMP[level - 1][hash % 3];
        const hueNoise = fbm3(sampleX * 0.7 + 91.7, sampleY * 0.7, evolve * 0.8, 2);
        const iridescence = Math.min(1, Math.max(0, (hueNoise - 0.5) * 2.4 + 0.5));
        const iridescent = (mode.hueBase + iridescence * mode.hueSpread + clock * mode.hueDrift) % 360;
        const hue = mixAngle(mode.fringeHue, iridescent, smoothstep(0.32, 0.78, amount));
        const dither = ((hash >>> 8) % 7) - 3;
        const shading = (shape - 0.6) * 26 * amount;
        const sat = Math.min(
          90,
          mode.fringeSat + (mode.coreSat - mode.fringeSat) * amount + Math.max(0, -shading) * 2.2,
        );
        const light = Math.min(
          96,
          mode.fringeLight + (mode.coreLight - mode.fringeLight) * amount
            + dither + shading + glow * amount,
        );
        context.drawImage(
          sprite(charIndex, hue, sat, light),
          column * CELL_W,
          row * CELL_H,
          CELL_W,
          CELL_H,
        );
      }
    }
  }

  function frame(now) {
    rafId = 0;
    if (!shouldAnimate()) return;
    rafId = requestAnimationFrame(frame);
    if (now - lastFrame < FRAME_INTERVAL) return;
    const delta = Math.min(0.25, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    audioSmooth += (audioTarget - audioSmooth) * Math.min(1, delta * 3);
    clock += delta * (1 + audioSmooth * 1.1);
    paint();
  }

  function start() {
    if (shouldAnimate()) {
      if (!rafId) {
        lastFrame = performance.now() - FRAME_INTERVAL;
        rafId = requestAnimationFrame(frame);
      }
    } else if (active && mode.id !== 'off') {
      paint();
    }
  }

  function resize() {
    const nextDpr = Math.min(devicePixelRatio || 1, 1.5);
    width = viewport.clientWidth;
    height = viewport.clientHeight;
    if (nextDpr !== dpr) {
      dpr = nextDpr;
      sprites.clear();
    }
    canvas.width = Math.max(1, Math.round(width * nextDpr));
    canvas.height = Math.max(1, Math.round(height * nextDpr));
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (active && mode.id !== 'off') paint();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);

  const handleMeter = (event) => {
    const level = Number(event.detail?.level) || 0;
    audioTarget = Math.min(1, Math.max(0, (level - 0.35) / 0.5));
  };
  const handleVisibility = () => start();
  document.addEventListener('strood:master-meter', handleMeter);
  document.addEventListener('visibilitychange', handleVisibility);
  document.fonts?.ready.then(() => {
    sprites.clear();
    if (active && mode.id !== 'off') paint();
  }).catch(() => {});

  return {
    canvas,
    get mode() {
      return mode.id;
    },
    setMode(id) {
      mode = resolveBackgroundMode(id);
      canvas.hidden = mode.id === 'off';
      sprites.clear();
      if (mode.id === 'off') return;
      paint();
      start();
    },
    setActive(next) {
      active = Boolean(next);
      if (active) start();
    },
    setCamera(x, y) {
      cameraX = x;
      cameraY = y;
    },
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      resizeObserver.disconnect();
      document.removeEventListener('strood:master-meter', handleMeter);
      document.removeEventListener('visibilitychange', handleVisibility);
      canvas.remove();
    },
  };
}
