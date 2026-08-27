import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_TIMING,
  BACKGROUND_MODES,
  BACKGROUND_SPRITE_LIMIT,
  CLOUD_DYNAMICS,
  CLOUD_OPACITY,
  cloudFlowAt,
  createGraphBackground,
  createNoise,
  cycleBackgroundMode,
  resolveBackgroundMode,
} from '../src/graph-background.js';

afterEach(() => vi.unstubAllGlobals());

describe('background modes', () => {
  it('composes the cached background immediately when the graph camera moves', () => {
    const contexts = [];
    const createContext = () => ({
      clearRect: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      setTransform: vi.fn(),
    });
    const createCanvas = () => {
      const context = createContext();
      contexts.push(context);
      return {
        getContext: () => context,
        setAttribute: vi.fn(),
        remove: vi.fn(),
        width: 0,
        height: 0,
        hidden: false,
        className: '',
      };
    };
    vi.stubGlobal('document', {
      hidden: false,
      createElement: createCanvas,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      fonts: { ready: new Promise(() => {}) },
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('devicePixelRatio', 1);
    const viewport = { clientWidth: 80, clientHeight: 60, prepend: vi.fn() };
    const background = createGraphBackground({ viewport });
    background.setMode('sky');
    background.setActive(true);
    const drawsBeforeMove = contexts[0].drawImage.mock.calls.length;
    const tilePaintsBeforeMove = contexts[1].clearRect.mock.calls.length;

    background.setCamera(8, 6, 1);

    expect(contexts[0].drawImage).toHaveBeenCalledTimes(drawsBeforeMove + 1);
    expect(contexts[1].clearRect).toHaveBeenCalledTimes(tilePaintsBeforeMove);
    background.destroy();
  });

  it('composes smooth cached drift between infrequent tile regenerations', () => {
    const contexts = [];
    const createContext = () => ({
      clearRect: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      setTransform: vi.fn(),
    });
    const createCanvas = () => {
      const context = createContext();
      contexts.push(context);
      return {
        getContext: () => context,
        setAttribute: vi.fn(),
        remove: vi.fn(),
        width: 0,
        height: 0,
        hidden: false,
        className: '',
      };
    };
    let nextFrame = null;
    let frameId = 0;
    vi.stubGlobal('document', {
      hidden: false,
      createElement: createCanvas,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      fonts: { ready: new Promise(() => {}) },
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
      nextFrame = callback;
      frameId += 1;
      return frameId;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal('performance', { now: () => 0 });
    const viewport = { clientWidth: 80, clientHeight: 60, prepend: vi.fn() };
    const background = createGraphBackground({ viewport });
    background.setMode('sky');
    const tilePaints = contexts[1].clearRect.mock.calls.length;
    const composites = contexts[0].fillRect.mock.calls.length;
    background.setActive(true);

    nextFrame(33);
    const firstDriftX = contexts[0].drawImage.mock.calls.at(-1)[1];
    nextFrame(66);
    const secondDriftX = contexts[0].drawImage.mock.calls.at(-1)[1];
    for (let now = 99; now < BACKGROUND_TIMING.tileInterval; now += 33) nextFrame(now);

    expect(contexts[0].fillRect.mock.calls.length).toBeGreaterThan(composites);
    expect(secondDriftX).toBeLessThan(firstDriftX);
    expect(contexts[1].clearRect).toHaveBeenCalledTimes(tilePaints);

    nextFrame(429);
    expect(contexts[1].clearRect).toHaveBeenCalledTimes(tilePaints + 1);
    background.destroy();
  });

  it('does not repaint after destruction when fonts finish loading', async () => {
    const contexts = [];
    const createContext = () => ({
      clearRect: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      setTransform: vi.fn(),
    });
    const createCanvas = () => {
      const context = createContext();
      contexts.push(context);
      return {
        getContext: () => context,
        setAttribute: vi.fn(),
        remove: vi.fn(),
        width: 0,
        height: 0,
        hidden: false,
        className: '',
      };
    };
    let resolveFonts;
    const fontsReady = new Promise((resolve) => { resolveFonts = resolve; });
    vi.stubGlobal('document', {
      hidden: false,
      createElement: createCanvas,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      fonts: { ready: fontsReady },
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('devicePixelRatio', 1);
    const viewport = { clientWidth: 80, clientHeight: 60, prepend: vi.fn() };
    const background = createGraphBackground({ viewport });
    background.setMode('sky');
    background.setActive(true);
    const drawsBeforeDestroy = contexts[0].drawImage.mock.calls.length;

    background.destroy();
    resolveFonts();
    await fontsReady;
    await Promise.resolve();

    expect(contexts[0].drawImage).toHaveBeenCalledTimes(drawsBeforeDestroy);
  });

  it('renders fluidly without changing the slow time-based cloud speed', () => {
    expect(BACKGROUND_TIMING).toEqual({
      composeInterval: 33,
      tileInterval: 400,
      heavyTileInterval: 800,
    });
    expect(CLOUD_OPACITY).toBe(0.8);
    expect(BACKGROUND_SPRITE_LIMIT).toBe(1536);
  });

  it('advects cloud layers with shear, lift and slow billowing evolution', () => {
    expect(CLOUD_DYNAMICS).toEqual({
      windSpeed: 7,
      windShear: 2.2,
      verticalLift: 0.0035,
      evolutionSpeed: 0.01,
      billowStrength: 0.22,
    });
    const lower = cloudFlowAt(0, 12);
    const upper = cloudFlowAt(4, 12);
    expect(lower.windPx).not.toBe(upper.windPx);
    expect(lower.lift).toBeCloseTo(0.042);
    expect(upper.lift).toBe(lower.lift);
  });

  it('declares unique ids with labels and an off mode', () => {
    const ids = BACKGROUND_MODES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('off');
    for (const mode of BACKGROUND_MODES) expect(mode.label).toBeTruthy();
  });

  it('gives every procedural mode a complete palette', () => {
    for (const mode of BACKGROUND_MODES.filter(({ id, image }) => id !== 'off' && !image)) {
      for (const key of [
        'skyTop', 'skyBottom', 'fringeHue', 'fringeSat', 'fringeLight',
        'coreSat', 'coreLight', 'hueBase', 'hueSpread', 'hueDrift',
      ]) {
        expect(mode[key], `${mode.id}.${key}`).toBeDefined();
      }
    }
  });

  it('gives image modes a served asset path and no animation palette', () => {
    const imageModes = BACKGROUND_MODES.filter((mode) => mode.image);
    expect(imageModes.length).toBeGreaterThan(0);
    for (const mode of imageModes) {
      expect(mode.image).toMatch(/^\//);
      expect(mode.hueDrift).toBeUndefined();
    }
  });

  it('resolves unknown or missing ids to the default mode', () => {
    expect(resolveBackgroundMode('sky').id).toBe('sky');
    expect(resolveBackgroundMode('nope').id).toBe(BACKGROUND_MODES[0].id);
    expect(resolveBackgroundMode(undefined).id).toBe(BACKGROUND_MODES[0].id);
  });

  it('cycles through every mode and wraps around', () => {
    const seen = [];
    let id = BACKGROUND_MODES[0].id;
    for (let step = 0; step < BACKGROUND_MODES.length; step++) {
      seen.push(id);
      id = cycleBackgroundMode(id);
    }
    expect(seen).toEqual(BACKGROUND_MODES.map((mode) => mode.id));
    expect(id).toBe(BACKGROUND_MODES[0].id);
  });
});

describe('noise field', () => {
  it('is deterministic for a seed and bounded to [0, 1]', () => {
    const first = createNoise(7);
    const second = createNoise(7);
    for (let index = 0; index < 200; index++) {
      const x = index * 0.37;
      const y = index * 0.11;
      const z = index * 0.05;
      const value = first.fbm3(x, y, z, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(second.fbm3(x, y, z, 3)).toBe(value);
    }
  });

  it('varies across space rather than collapsing to a constant', () => {
    const { fbm3 } = createNoise(7);
    const samples = new Set();
    for (let index = 0; index < 50; index++) {
      samples.add(fbm3(index * 0.61, index * 0.23, 0.5, 3).toFixed(4));
    }
    expect(samples.size).toBeGreaterThan(30);
  });
});
