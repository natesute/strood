import { registerWidget, setWidget } from '@strudel/codemirror';
import { getFrequency, freqToMidi, midiToFreq } from '@strudel/core';
import { analysers, drawTimeScope, getAnalyzerData } from '@strudel/webaudio';

const DEFAULT_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.5);
const visibleCanvases = new WeakSet();
const observedCanvases = new WeakSet();
const graphVisibleCanvases = globalThis.__stroodGraphVisibleCanvases ||= new Set();
const visualizerRegistry = globalThis.__stroodVisualizerRegistry ||= new Map();
const VISUALIZERS_KEY = 'strood:visualizers-enabled';
const _cymaticsCache = new Map();
let registryGeneration = 0;
globalThis.__stroodVisualizersEnabled ??= localStorage.getItem(VISUALIZERS_KEY) !== 'false';
const canvasObserver = typeof IntersectionObserver === 'undefined'
  ? null
  : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visibleCanvases.add(entry.target);
        else visibleCanvases.delete(entry.target);
      }
    }, { rootMargin: '140px 0px' });

function observeCanvas(canvas) {
  if (!canvasObserver || observedCanvases.has(canvas)) return;
  observedCanvases.add(canvas);
  canvasObserver.observe(canvas);
}

function visualizersEnabled() {
  return globalThis.__stroodVisualizersEnabled !== false;
}

function setCanvasBuffer(entry, enabled) {
  if (!entry?.canvas) return;
  entry.canvas.width = enabled ? entry.pixelWidth : 1;
  entry.canvas.height = enabled ? entry.pixelHeight : 1;
  if (!enabled) entry.canvas.getContext('2d')?.clearRect(0, 0, 1, 1);
}

function releaseCanvas(entry) {
  if (!entry?.canvas) return;
  canvasObserver?.unobserve(entry.canvas);
  observedCanvases.delete(entry.canvas);
  visibleCanvases.delete(entry.canvas);
  graphVisibleCanvases.delete(entry.canvas);
  entry.canvas.width = 1;
  entry.canvas.height = 1;
}

function beginVisualizerGeneration() {
  registryGeneration += 1;
  return registryGeneration;
}

function commitVisualizerGeneration(generation) {
  if (generation !== registryGeneration) return;
  let removed = false;
  for (const [id, entry] of visualizerRegistry) {
    if (entry.generation === generation) continue;
    releaseCanvas(entry);
    visualizerRegistry.delete(id);
    removed = true;
  }
  if (removed) {
    _cymaticsCache.clear();
    document.dispatchEvent(new CustomEvent('strood:visualizer-canvas'));
  }
}

function abortVisualizerGeneration(generation) {
  if (generation !== registryGeneration) return;
  for (const [id, entry] of visualizerRegistry) {
    releaseCanvas(entry);
    visualizerRegistry.delete(id);
  }
  _cymaticsCache.clear();
  document.dispatchEvent(new CustomEvent('strood:visualizer-canvas'));
}

globalThis.__stroodBeginVisualizerGeneration = beginVisualizerGeneration;
globalThis.__stroodCommitVisualizerGeneration = commitVisualizerGeneration;
globalThis.__stroodAbortVisualizerGeneration = abortVisualizerGeneration;

document.addEventListener('strood:visualizers-enabled', (event) => {
  const enabled = Boolean(event.detail?.enabled);
  globalThis.__stroodVisualizersEnabled = enabled;
  for (const entry of visualizerRegistry.values()) setCanvasBuffer(entry, enabled);
  if (!enabled) _cymaticsCache.clear();
});

function canvasIsVisible(canvas) {
  if (!visualizersEnabled()) return false;
  if (document.hidden) return false;
  if (globalThis.__stroodGraphVisualizersActive) return graphVisibleCanvases.has(canvas);
  if (graphVisibleCanvases.has(canvas)) return true;
  if (!canvas.isConnected) return false;
  if (canvasObserver) return visibleCanvases.has(canvas);
  const rect = canvas.getBoundingClientRect();
  return rect.bottom >= -140
    && rect.top <= window.innerHeight + 140
    && rect.right >= 0
    && rect.left <= window.innerWidth;
}

function createPaintGate(canvas, fps = 24) {
  const frameLength = 1000 / Math.max(1, fps);
  let lastPaint = -Infinity;
  return () => {
    if (!canvasIsVisible(canvas)) return false;
    const now = performance.now();
    if (now - lastPaint < frameLength) return false;
    lastPaint = now;
    return true;
  };
}

/* ── Canvas helper (replicates widget.mjs:96-105, not exported) ── */
function getCanvasWidget(id, options = {}, method = '') {
  const { width = 500, height = 60, pixelRatio = DEFAULT_PIXEL_RATIO } = options;
  let canvas = document.getElementById(id) || document.createElement('canvas');
  const previous = visualizerRegistry.get(id);
  if (previous?.canvas && previous.canvas !== canvas) releaseCanvas(previous);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  setWidget(id, canvas);
  observeCanvas(canvas);
  canvas.dataset.visualizerMethod = method;
  const entry = {
    id,
    method,
    canvas,
    generation: registryGeneration,
    pixelWidth: Math.max(1, Math.round(width * pixelRatio)),
    pixelHeight: Math.max(1, Math.round(height * pixelRatio)),
  };
  visualizerRegistry.set(id, entry);
  setCanvasBuffer(entry, visualizersEnabled());
  document.dispatchEvent(new CustomEvent('strood:visualizer-canvas', { detail: { id, method } }));
  return canvas;
}

// Register Strudel's two built-in visualisers through the same canvas registry
// as Strood's custom set, so graph nodes can mirror them as well.
registerWidget('_spiral', (id, options = {}, pat) => {
  const size = options.size || 275;
  options = { width: size, height: size, ...options, size: size / 5 };
  const canvas = getCanvasWidget(id, options, '_spiral');
  const shouldPaint = createPaintGate(canvas, options.fps || 30);
  const tagged = pat.tag(id);
  const onPaint = tagged.onPaint;
  // Strudel's spiral painter is private, but spiral() installs it through the
  // pattern instance's onPaint method. Shadow that method on this tagged copy
  // so the complete built-in painter is skipped when the canvas is off-screen.
  tagged.onPaint = function gatedOnPaint(painter) {
    return onPaint.call(this, (...args) => {
      if (shouldPaint()) painter(...args);
    });
  };
  return tagged.spiral({ ...options, ctx: canvas.getContext('2d'), id });
});

registerWidget('_scope', (id, options = {}, pat) => {
  options = {
    width: 500,
    height: 60,
    pos: 0.5,
    scale: 1,
    autoScale: true,
    maxScale: 24,
    fill: 0.38,
    ...options,
  };
  const canvas = getCanvasWidget(id, options, '_scope');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps || 30);
  let displayScale = Math.max(0.01, Number(options.scale) || 1);
  let hasSignal = false;

  return pat.tag(id).analyze(id).onPaint((_, time, haps) => {
    if (!shouldPaint()) return;
    const analyser = analysers[id];
    if (analyser && options.autoScale !== false) {
      const samples = getAnalyzerData('time', id);
      let peak = 0;
      for (let index = 0; index < samples.length; index += 1) {
        peak = Math.max(peak, Math.abs(samples[index]));
      }
      if (peak > 0.002) {
        const target = Math.max(0.5, Math.min(
          Math.max(0.5, Number(options.maxScale) || 24),
          Math.max(0.1, Math.min(0.48, Number(options.fill) || 0.38)) / peak,
        ));
        if (!hasSignal) displayScale = target;
        else displayScale += (target - displayScale) * (target < displayScale ? 0.55 : 0.16);
        hasSignal = true;
      }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const color = haps.find(hap => hap.hasTag(id) && hap.isActive(time))?.value?.color;
    drawTimeScope(analyser, {
      ...options,
      color: color || options.color || 'white',
      scale: displayScale,
      ctx,
      id,
    });
  });
});

/* ── Widget 1: _lissajous — Interval Geometry ──────────── */
// Consonant intervals draw clean closed curves (3:2 = fifth, 5:4 = third).
// Dissonance → chaotic open curves. This IS consonance, seen in 2D.
registerWidget('_lissajous', (id, options = {}, pat) => {
  const size = options.size || 200;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_lissajous');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps);

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
    if (!shouldPaint()) return;
    const active = haps.filter(h => h.hasTag(id) && h.isActive(time));
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const freqs = [];
    for (const hap of active) {
      try { freqs.push(getFrequency(hap)); } catch (_) {}
    }

    if (freqs.length < 2) {
      if (freqs.length === 1) {
        ctx.strokeStyle = 'rgba(255, 0, 255, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const r = w * 0.35;
        const phi = time * 0.3;
        for (let i = 0; i <= 500; i++) {
          const t = (i / 500) * Math.PI * 2;
          const x = w / 2 + r * Math.sin(t + phi);
          const y = h / 2 + r * Math.sin(t);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      return;
    }

    freqs.sort((a, b) => a - b);
    const base = freqs[0];
    const phi = time * 0.3;
    const r = w * 0.35;
    const cx = w / 2, cy = h / 2;

    for (let fi = 1; fi < freqs.length; fi++) {
      const ratio = freqs[fi] / base;
      const alpha = 0.4 + 0.5 / freqs.length;
      const hue = (fi * 60 + 300) % 360;
      ctx.strokeStyle = `hsla(${hue}, 80%, 65%, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 500; i++) {
        const t = (i / 500) * Math.PI * 2;
        const x = cx + r * Math.sin(t + phi);
        const y = cy + r * Math.sin(ratio * t);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
});

/* ── Widget 2: _orbit — Rhythm Circle ──────────────────── */
// Rhythm as geometry on a circle. Symmetric rhythms form regular polygons.
// Asymmetric patterns show groove as geometric irregularity.
registerWidget('_orbit', (id, options = {}, pat) => {
  const size = options.size || 150;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_orbit');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps);

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
    if (!shouldPaint()) return;
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) * 0.4;
    ctx.clearRect(0, 0, w, h);

    // Outer ring
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating cursor
    const cursorAngle = (time % 1) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + radius * Math.cos(cursorAngle), cy + radius * Math.sin(cursorAngle));
    ctx.stroke();

    // Cursor tip
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(cx + radius * Math.cos(cursorAngle), cy + radius * Math.sin(cursorAngle), 4, 0, Math.PI * 2);
    ctx.fill();

    // Beat dots
    const tagged = haps.filter(h => h.hasTag(id));
    for (const hap of tagged) {
      if (!hap.whole) continue;
      const onset = hap.whole.begin % 1;
      const angle = onset * Math.PI * 2 - Math.PI / 2;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      const isActive = hap.isActive(time);

      if (isActive) {
        ctx.fillStyle = 'rgba(255, 80, 80, 0.3)';
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = isActive ? '#ff4444' : 'rgba(255, 80, 80, 0.6)';
      ctx.beginPath();
      ctx.arc(x, y, isActive ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
});

/* ── Widget 3: _tonnetz — Harmonic Lattice ─────────────── */
// x-axis = fifths (7 semitones), y-axis = major thirds (4 semitones).
// Major triads = upward triangles, minor = downward. This is the topology of harmony.
registerWidget('_tonnetz', (id, options = {}, pat) => {
  const size = options.size || 250;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_tonnetz');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps);

  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const lattice = [];
  const pcToPositions = new Map();

  for (let gx = -3; gx <= 3; gx++) {
    for (let gy = -2; gy <= 2; gy++) {
      const pc = ((7 * gx + 4 * gy) % 12 + 12) % 12;
      const node = { gx, gy, pc };
      lattice.push(node);
      if (!pcToPositions.has(pc)) pcToPositions.set(pc, []);
      pcToPositions.get(pc).push(node);
    }
  }

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
    if (!shouldPaint()) return;
    const active = haps.filter(h => h.hasTag(id) && h.isActive(time));
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const activePCs = new Set();
    for (const hap of active) {
      try {
        const freq = getFrequency(hap);
        const midi = Math.round(freqToMidi(freq));
        activePCs.add(((midi % 12) + 12) % 12);
      } catch (_) {}
    }

    const spacingX = w / 8;
    const spacingY = h / 6;
    const ox = w / 2, oy = h / 2;

    // Grid connections (fifths horizontal, thirds vertical, diagonal)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const p of lattice) {
      const px = ox + p.gx * spacingX;
      const py = oy - p.gy * spacingY;
      if (p.gx < 3) {
        ctx.moveTo(px, py);
        ctx.lineTo(ox + (p.gx + 1) * spacingX, py);
      }
      if (p.gy < 2) {
        ctx.moveTo(px, py);
        ctx.lineTo(px, oy - (p.gy + 1) * spacingY);
      }
      if (p.gx < 3 && p.gy > -2) {
        ctx.moveTo(px, py);
        ctx.lineTo(ox + (p.gx + 1) * spacingX, oy - (p.gy - 1) * spacingY);
      }
    }
    ctx.stroke();

    // Draw triangles for active triads
    if (activePCs.size >= 3) {
      const pcArray = [...activePCs];
      for (let i = 0; i < pcArray.length - 2; i++) {
        for (let j = i + 1; j < pcArray.length - 1; j++) {
          for (let k = j + 1; k < pcArray.length; k++) {
            const trio = [pcArray[i], pcArray[j], pcArray[k]];
            const sets = trio.map(pc => pcToPositions.get(pc) || []);
            for (const a of sets[0]) {
              for (const b of sets[1]) {
                for (const c of sets[2]) {
                  const maxDist = Math.max(
                    Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy),
                    Math.abs(b.gx - c.gx) + Math.abs(b.gy - c.gy),
                    Math.abs(a.gx - c.gx) + Math.abs(a.gy - c.gy)
                  );
                  if (maxDist <= 2) {
                    ctx.fillStyle = 'rgba(180, 120, 255, 0.12)';
                    ctx.beginPath();
                    ctx.moveTo(ox + a.gx * spacingX, oy - a.gy * spacingY);
                    ctx.lineTo(ox + b.gx * spacingX, oy - b.gy * spacingY);
                    ctx.lineTo(ox + c.gx * spacingX, oy - c.gy * spacingY);
                    ctx.closePath();
                    ctx.fill();
                  }
                }
              }
            }
          }
        }
      }
    }

    // Lattice dots
    for (const p of lattice) {
      const px = ox + p.gx * spacingX;
      const py = oy - p.gy * spacingY;
    }

    // Lattice dots — batched by style to reduce state changes
    // 1) Inactive dots
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.beginPath();
    for (const p of lattice) {
      if (activePCs.has(p.pc)) continue;
      const px = ox + p.gx * spacingX;
      const py = oy - p.gy * spacingY;
      ctx.moveTo(px + 4, py);
      ctx.arc(px, py, 4, 0, Math.PI * 2);
    }
    ctx.fill();

    // 2) Active glow
    ctx.fillStyle = 'rgba(180, 120, 255, 0.3)';
    ctx.beginPath();
    for (const p of lattice) {
      if (!activePCs.has(p.pc)) continue;
      const px = ox + p.gx * spacingX;
      const py = oy - p.gy * spacingY;
      ctx.moveTo(px + 14, py);
      ctx.arc(px, py, 14, 0, Math.PI * 2);
    }
    ctx.fill();

    // 3) Active dots
    ctx.fillStyle = '#bb88ff';
    ctx.beginPath();
    for (const p of lattice) {
      if (!activePCs.has(p.pc)) continue;
      const px = ox + p.gx * spacingX;
      const py = oy - p.gy * spacingY;
      ctx.moveTo(px + 8, py);
      ctx.arc(px, py, 8, 0, Math.PI * 2);
    }
    ctx.fill();

    // 4) Active labels
    if (activePCs.size > 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.font = `${Math.round(w / 25)}px monospace`;
      ctx.textAlign = 'center';
      for (const p of lattice) {
        if (!activePCs.has(p.pc)) continue;
        const px = ox + p.gx * spacingX;
        const py = oy - p.gy * spacingY;
        ctx.fillText(noteNames[p.pc], px, py - 12);
      }
    }
  });
});

/* ── Widget 4: _cymatics — Chladni Vibration Patterns ──── */
// Physical vibrating surfaces produce geometric nodal patterns.
// Z(x,y) = cos(nπx)cos(mπy) - cos(mπx)cos(nπy), nodal lines where Z≈0.
registerWidget('_cymatics', (id, options = {}, pat) => {
  const size = options.size || 200;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_cymatics');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps);

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
    if (!shouldPaint()) return;
    const active = haps.filter(h => h.hasTag(id) && h.isActive(time));
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (active.length === 0) return;

    let midi = 60;
    try {
      const freq = getFrequency(active[0]);
      midi = Math.round(freqToMidi(freq));
    } catch (_) {}

    const cacheKey = `${id}:${midi}`;
    let cached = _cymaticsCache.get(cacheKey);

    if (!cached || cached.w !== w || cached.h !== h) {
      const n = Math.max(1, Math.min(8, 1 + (midi - 30) / 60 * 7));
      const m = n + 1;
      const imageData = ctx.createImageData(w, h);
      const data = imageData.data;

      for (let py = 0; py < h; py++) {
        const yNorm = py / h;
        const cosNY = Math.cos(n * Math.PI * yNorm);
        const cosMY = Math.cos(m * Math.PI * yNorm);
        for (let px = 0; px < w; px++) {
          const xNorm = px / w;
          const z = Math.cos(n * Math.PI * xNorm) * cosMY
                  - Math.cos(m * Math.PI * xNorm) * cosNY;
          const intensity = 1 - Math.min(1, Math.abs(z) * 4);
          const brightness = intensity * intensity * intensity;
          const idx = (py * w + px) * 4;
          data[idx]     = (brightness * 100) | 0;
          data[idx + 1] = (brightness * 200) | 0;
          data[idx + 2] = (brightness * 255) | 0;
          data[idx + 3] = (brightness * 255) | 0;
        }
      }

      cached = { imageData, w, h };
      _cymaticsCache.set(cacheKey, cached);
      if (_cymaticsCache.size > 24) {
        _cymaticsCache.delete(_cymaticsCache.keys().next().value);
      }
    }

    ctx.putImageData(cached.imageData, 0, 0);
  });
});

/* ── Widget 5: _harmonics — Standing Waves ─────────────── */
// Musical intervals ARE string divisions. Octave = halved. Fifth = 3:2.
// y(x) = (A/√n) * sin(nπx) * cos(ωt) — fixed endpoints enforced by sin.
registerWidget('_harmonics', (id, options = {}, pat) => {
  options = { width: 500, height: 100, ...options };
  const canvas = getCanvasWidget(id, options, '_harmonics');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps);

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
    if (!shouldPaint()) return;
    const active = haps.filter(h => h.hasTag(id) && h.isActive(time));
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const baseline = h / 2;

    // Baseline string
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseline);
    ctx.lineTo(w, baseline);
    ctx.stroke();

    // Fixed endpoints
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(0, baseline, 3, 0, Math.PI * 2);
    ctx.arc(w, baseline, 3, 0, Math.PI * 2);
    ctx.fill();

    if (active.length === 0) return;

    const omega = time * 4;

    for (let hi = 0; hi < active.length; hi++) {
      let midi = 60;
      try {
        const freq = getFrequency(active[hi]);
        midi = freqToMidi(freq);
      } catch (_) {}

      const n = Math.max(1, Math.pow(2, (midi - 36) / 12));
      const amplitude = (h * 0.35) / Math.sqrt(n);
      const hue = (hi * 50 + 180) % 360;
      ctx.strokeStyle = `hsla(${hue}, 70%, 60%, 0.7)`;
      ctx.lineWidth = 2;
      ctx.beginPath();

      for (let px = 0; px <= w; px++) {
        const x = px / w;
        const y = baseline + amplitude * Math.sin(n * Math.PI * x) * Math.cos(omega);
        px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
      }
      ctx.stroke();
    }
  });
});

/* ── Widget 6: _helix — Pitch Helix ───────────────────── */
// Pitch has two dimensions: height (frequency) and chroma (octave equivalence).
// The true topology is a helix — notes an octave apart are vertically aligned.
registerWidget('_helix', (id, options = {}, pat) => {
  const size = options.size || 200;
  const turns = options.turns || 5;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_helix');
  const ctx = canvas.getContext('2d');
  const rootFreq = 130.81; // C3
  const shouldPaint = createPaintGate(canvas, options.fps);

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
    if (!shouldPaint()) return;
    const active = haps.filter(h => h.hasTag(id) && h.isActive(time));
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const radiusX = w * 0.3;
    const totalHeight = h * 0.85;
    const topMargin = h * 0.075;
    const steps = turns * 60;

    // Back half of helix (behind)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const angle = frac * turns * Math.PI * 2;
      if (Math.sin(angle) > 0) { started = false; continue; }
      const x = cx + radiusX * Math.cos(angle);
      const y = topMargin + frac * totalHeight;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Front half of helix
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    started = false;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const angle = frac * turns * Math.PI * 2;
      if (Math.sin(angle) <= 0) { started = false; continue; }
      const x = cx + radiusX * Math.cos(angle);
      const y = topMargin + frac * totalHeight;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Plot active notes
    for (const hap of active) {
      try {
        const freq = getFrequency(hap);
        const octave = Math.log2(freq / rootFreq);
        const frac = octave / turns;
        if (frac < 0 || frac > 1) continue;

        const angle = octave * Math.PI * 2;
        const x = cx + radiusX * Math.cos(angle);
        const y = topMargin + frac * totalHeight;

        // Glow
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, 16);
        gradient.addColorStop(0, 'rgba(100, 200, 255, 0.6)');
        gradient.addColorStop(1, 'rgba(100, 200, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#66ccff';
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      } catch (_) {}
    }
  });
});

/* ── Widget 7: _epicycles — Fourier Spinning Circles ───── */
// ALL sound is a sum of rotating circles (e^(iωt)). Each harmonic is a circle
// spinning at its frequency. The tip traces the waveform. Same math as Ptolemy.
registerWidget('_epicycles', (id, options = {}, pat) => {
  const size = options.size || 200;
  const harmonicsCount = options.harmonicsCount || 8;
  options = { width: size * 2, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_epicycles');
  const ctx = canvas.getContext('2d');
  const trail = new Float32Array(200);
  let trailIdx = 0;
  let lastTrailTime = 0;
  const shouldPaint = createPaintGate(canvas, options.fps);

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
    if (!shouldPaint()) return;
    const active = haps.filter(h => h.hasTag(id) && h.isActive(time));
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const circleArea = w / 2;
    const epicenterX = circleArea * 0.45;
    const epicenterY = h / 2;
    const baseR = Math.min(circleArea, h) * 0.25;

    let speed = 1;
    if (active.length > 0) {
      try {
        const freq = getFrequency(active[0]);
        const midi = freqToMidi(freq);
        speed = 0.5 + (midi - 36) / 60;
      } catch (_) {}
    }

    // Compute epicycle chain
    let x = epicenterX, y = epicenterY;

    for (let n = 1; n <= harmonicsCount; n++) {
      const prevX = x, prevY = y;
      const r = baseR * 2 / (n * Math.PI);
      const sign = (n % 2 === 0) ? -1 : 1;
      const angle = n * speed * time * Math.PI * 2;

      x += r * Math.cos(sign * angle);
      y += r * Math.sin(sign * angle);

      // Circle
      ctx.strokeStyle = `rgba(255, 180, 60, ${0.12 + 0.08 / n})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(prevX, prevY, r, 0, Math.PI * 2);
      ctx.stroke();

      // Radius
      ctx.strokeStyle = `rgba(255, 200, 100, ${0.25 + 0.15 / n})`;
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(x, y);
      ctx.stroke();
    }

    // Tip dot
    ctx.fillStyle = '#ffcc44';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();

    // Update trail
    if (time - lastTrailTime > 0.016) {
      trail[trailIdx % trail.length] = y;
      trailIdx++;
      lastTrailTime = time;
    }

    // Connecting line from tip to waveform
    const waveStartX = circleArea;
    ctx.strokeStyle = 'rgba(255, 200, 100, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(waveStartX, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform trail
    const trailLen = trail.length;
    const waveWidth = w - circleArea;
    ctx.strokeStyle = 'rgba(255, 200, 100, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let waveStarted = false;
    for (let i = 0; i < trailLen; i++) {
      const idx = ((trailIdx - 1 - i) % trailLen + trailLen) % trailLen;
      const wy = trail[idx];
      if (wy === 0 && !waveStarted) continue;
      const wx = waveStartX + (i / trailLen) * waveWidth;
      if (!waveStarted) { ctx.moveTo(wx, wy); waveStarted = true; }
      else ctx.lineTo(wx, wy);
    }
    ctx.stroke();
  });
});

/* ── Widget 8: _phase — Audio Phase Portrait ───────────── */
// The track's real waveform x(t) plotted against a delayed copy x(t−τ),
// a Takens embedding. Periodic signals close into orbits: pure tones are
// ellipses, rich timbres are knots, noise is a cloud. τ tracks a quarter
// period of the sounding pitch, so a held note settles into a stable loop.
registerWidget('_phase', (id, options = {}, pat) => {
  const size = options.size || 200;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_phase');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps || 30);
  let displayScale = 0;

  return pat.tag(id).analyze(id).onPaint((_, time, haps) => {
    if (!shouldPaint()) return;
    const w = canvas.width, h = canvas.height;

    // Persistence: fade the standing trace instead of clearing it.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    const analyser = analysers[id];
    if (!analyser) return;
    const samples = getAnalyzerData('time', id);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const magnitude = Math.abs(samples[i]);
      if (magnitude > peak) peak = magnitude;
    }
    if (peak < 0.004) return;

    const target = 0.44 / peak;
    displayScale = displayScale === 0 ? target : displayScale + (target - displayScale) * 0.15;

    const active = haps.filter(hap => hap.hasTag(id) && hap.isActive(time));
    let tau = 0;
    for (const hap of active) {
      try {
        tau = Math.round(analyser.context.sampleRate / (4 * getFrequency(hap)));
        break;
      } catch (_) {}
    }
    if (!tau) tau = 96;
    tau = Math.max(2, Math.min(tau, samples.length >> 2));

    const cx = w / 2, cy = h / 2;
    const amp = Math.min(w, h) * 0.5 * displayScale;
    ctx.strokeStyle = active[0]?.value?.color || options.color || '#7dffb0';
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i + tau < samples.length; i += 2) {
      const x = cx + samples[i] * amp;
      const y = cy - samples[i + tau] * amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  });
});

/* ── Widget 9: _interference — Chord Ripple Field ──────── */
// Every sounding note is a wave source on the chroma circle (angle = pitch
// class, radius = octave) radiating with wavelength ∝ 1/frequency. The
// summed field is drawn directly: intervals become moiré ratios, detuning
// becomes drifting spatial beats, held chords become standing patterns.
registerWidget('_interference', (id, options = {}, pat) => {
  const size = options.size || 200;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_interference');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps || 20);
  let field = null;

  return pat.tag(id).onPaint((_, time, haps) => {
    if (!shouldPaint()) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const active = haps.filter(hap => hap.hasTag(id) && hap.isActive(time));
    const sources = [];
    for (const hap of active) {
      if (sources.length >= 6) break;
      try {
        const freq = getFrequency(hap);
        const midi = freqToMidi(freq);
        const chroma = ((midi % 12) + 12) % 12;
        const octave = Math.max(1, Math.min(7, Math.floor(midi / 12) - 1));
        const angle = (chroma / 12) * Math.PI * 2 - Math.PI / 2;
        const radius = (0.08 + (octave - 1) * 0.06) * Math.min(w, h);
        sources.push({
          x: w / 2 + radius * Math.cos(angle),
          y: h / 2 + radius * Math.sin(angle),
          freq,
        });
      } catch (_) {}
    }
    if (!sources.length) return;

    // The field is summed on a half-resolution grid and scaled up smoothly.
    const fw = Math.max(2, Math.round(w / 2));
    const fh = Math.max(2, Math.round(h / 2));
    if (!field || field.w !== fw || field.h !== fh) {
      const buffer = document.createElement('canvas');
      buffer.width = fw;
      buffer.height = fh;
      const bufferCtx = buffer.getContext('2d');
      // Radial falloff so the pool dissolves at the edge instead of
      // stopping at the canvas boundary.
      const vignette = new Float32Array(fw * fh);
      const vcx = fw / 2, vcy = fh / 2;
      const vmax = Math.min(fw, fh) / 2;
      for (let py = 0; py < fh; py++) {
        for (let px = 0; px < fw; px++) {
          const distance = Math.hypot(px - vcx, py - vcy) / vmax;
          vignette[py * fw + px] = Math.max(0, Math.min(1, 1.9 - 1.9 * distance * distance));
        }
      }
      field = { canvas: buffer, ctx: bufferCtx, image: bufferCtx.createImageData(fw, fh), vignette, w: fw, h: fh };
    }

    const fmin = Math.min(...sources.map(source => source.freq));
    const sx = fw / w, sy = fh / h;
    for (const source of sources) {
      source.fx = source.x * sx;
      source.fy = source.y * sy;
      // Wavelength scales with the true period, so a fifth above the root
      // ripples at exactly 2/3 the root's spacing.
      const lambda = Math.max(4, (Math.min(fw, fh) / 4.4) * (fmin / source.freq));
      source.k = (Math.PI * 2) / lambda;
      source.phase = Math.PI * 2 * (source.freq / fmin) * time * 1.25;
    }

    const data = field.image.data;
    const vignette = field.vignette;
    const norm = 1 / sources.length;
    let index = 0;
    for (let py = 0; py < fh; py++) {
      for (let px = 0; px < fw; px++) {
        let sum = 0;
        for (const source of sources) {
          const dx = px - source.fx;
          const dy = py - source.fy;
          sum += Math.cos(Math.sqrt(dx * dx + dy * dy) * source.k - source.phase);
        }
        const value = sum * norm;
        const g = Math.abs(value) ** 0.8;
        const fade = vignette[index >> 2];
        if (value > 0) {
          data[index] = 40 + 215 * g;
          data[index + 1] = 150 + 105 * g;
          data[index + 2] = 255;
          data[index + 3] = 235 * g * fade;
        } else {
          data[index] = 10;
          data[index + 1] = 40 + 60 * g;
          data[index + 2] = 130 + 125 * g;
          data[index + 3] = 210 * g * fade;
        }
        index += 4;
      }
    }
    field.ctx.putImageData(field.image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(field.canvas, 0, 0, w, h);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    for (const source of sources) {
      ctx.moveTo(source.x + 2.5, source.y);
      ctx.arc(source.x, source.y, 2.5, 0, Math.PI * 2);
    }
    ctx.fill();
  });
});

/* ── Widget 10: _overtones — Harmonic Coincidence Comb ─── */
// Helmholtz's explanation of consonance, drawn live. Each note lays its
// overtone series on a shared log-frequency axis (hue = pitch class).
// Aligned partials fuse into a steady white column — that alignment IS the
// consonance. Near misses pulse at their true beat rate |f₁−f₂| in Hz.
registerWidget('_overtones', (id, options = {}, pat) => {
  options = { width: 500, height: 110, ...options };
  const canvas = getCanvasWidget(id, options, '_overtones');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps || 30);
  const fLow = 55;
  const octaves = 6;

  return pat.tag(id).onPaint((_, time, haps) => {
    if (!shouldPaint()) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const baseline = h - 5;

    // Octave gridlines (A1..A7) and baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let o = 0; o <= octaves; o++) {
      const x = (o / octaves) * w;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, baseline);
    }
    ctx.moveTo(0, baseline);
    ctx.lineTo(w, baseline);
    ctx.stroke();

    const active = haps.filter(hap => hap.hasTag(id) && hap.isActive(time));
    if (!active.length) return;

    const partials = [];
    let noteIndex = 0;
    for (const hap of active) {
      if (noteIndex >= 6) break;
      let f0;
      try { f0 = getFrequency(hap); } catch (_) { continue; }
      const chroma = ((Math.round(freqToMidi(f0)) % 12) + 12) % 12;
      const hue = (chroma / 12) * 360;
      for (let n = 1; n <= 16; n++) {
        const freq = f0 * n;
        const position = Math.log2(freq / fLow) / octaves;
        if (position < 0 || position > 1) continue;
        partials.push({ freq, x: position * w, n, hue, note: noteIndex });
      }
      noteIndex++;
    }

    for (const partial of partials) {
      const height = (baseline - 8) * 0.9 / Math.sqrt(partial.n);
      ctx.strokeStyle = `hsla(${partial.hue}, 85%, 62%, ${partial.n === 1 ? 0.9 : 0.5})`;
      ctx.lineWidth = partial.n === 1 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(partial.x, baseline);
      ctx.lineTo(partial.x, baseline - height);
      ctx.stroke();
    }

    // Coincidences and beats between partials of different notes. Beat
    // pulsing runs on wall-clock seconds because beat rates are real Hz.
    partials.sort((a, b) => a.freq - b.freq);
    const seconds = performance.now() / 1000;
    for (let i = 0; i < partials.length - 1; i++) {
      for (let j = i + 1; j < partials.length; j++) {
        const a = partials[i], b = partials[j];
        const delta = b.freq - a.freq;
        if (delta > (a.freq + b.freq) * 0.02) break;
        if (a.note === b.note) continue;
        const x = (a.x + b.x) / 2;
        const height = (baseline - 8) * 0.95 / Math.sqrt(Math.min(a.n, b.n));
        if (delta < 1.5) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.lineWidth = 2.5;
        } else {
          const pulse = 0.5 + 0.5 * Math.sin(seconds * delta * Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 210, 120, ${0.15 + 0.6 * pulse})`;
          ctx.lineWidth = 2;
        }
        ctx.beginPath();
        ctx.moveTo(x, baseline);
        ctx.lineTo(x, baseline - height);
        ctx.stroke();
      }
    }
  });
});

/* ── Widget 11: _pendulum — Pendulum Wave ──────────────── */
// A column of pendulums whose periods divide the cycle: pendulum k swings
// base+k times per span, so the row weaves through travelling waves and
// polyrhythmic shear, snapping back into line exactly on the bar. Note
// onsets pump the swing energy, so the rhythm's density drives the arc.
registerWidget('_pendulum', (id, options = {}, pat) => {
  const size = options.size || 200;
  const count = options.count || 13;
  const span = options.span || 4;
  const base = options.base || 6;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_pendulum');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps || 30);
  let energy = 0;
  let previousTime = null;

  return pat.tag(id).onPaint((_, time, haps) => {
    if (!shouldPaint()) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Every onset since the previous frame pumps the swing; rests let it settle.
    const cycleTime = Number(time);
    const continued = previousTime !== null && cycleTime >= previousTime && cycleTime - previousTime < 0.5;
    let hits = 0;
    if (continued) {
      for (const hap of haps) {
        if (!hap.hasTag(id)) continue;
        const onset = Number(hap.whole?.begin);
        if (Number.isFinite(onset) && onset > previousTime && onset <= cycleTime) hits++;
      }
      energy *= Math.exp(-(cycleTime - previousTime) * 1.6);
    }
    previousTime = cycleTime;
    energy = Math.min(1, energy + hits * 0.3);

    const swing = w * 0.42 * (0.25 + 0.75 * energy);
    const cx = w / 2;
    const top = h * 0.08;
    const spacing = (h * 0.86) / (count - 1);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx, top + spacing * (count - 1));
    ctx.stroke();

    const phase = (cycleTime / span) * Math.PI * 2;
    const positions = [];
    for (let k = 0; k < count; k++) {
      positions.push(cx + swing * Math.cos(phase * (base + k)));
    }

    // The wave the column is currently weaving
    const color = haps.find(hap => hap.hasTag(id) && hap.isActive(time))?.value?.color;
    ctx.strokeStyle = color || 'rgba(160, 210, 255, 0.5)';
    ctx.globalAlpha = color ? 0.5 : 1;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k < count; k++) {
      const y = top + spacing * k;
      k === 0 ? ctx.moveTo(positions[k], y) : ctx.lineTo(positions[k], y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    for (let k = 0; k < count; k++) {
      const y = top + spacing * k;
      const speed = Math.abs(Math.sin(phase * (base + k)));
      ctx.fillStyle = `rgba(255, 255, 255, ${0.35 + 0.55 * speed})`;
      ctx.beginPath();
      ctx.arc(positions[k], y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
});

/* ── Widget 12: _resonance — Interval Orbit Envelopes ──── */
// Each sounding note orbits the same circle at a rate proportional to its
// true frequency. Chords are drawn between the notes each frame and left
// to fade, so the envelope of an interval accumulates: an octave sweeps a
// cardioid, a fifth its own curve. The figure IS the frequency ratio.
registerWidget('_resonance', (id, options = {}, pat) => {
  const size = options.size || 200;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options, '_resonance');
  const ctx = canvas.getContext('2d');
  const shouldPaint = createPaintGate(canvas, options.fps || 30);
  let previousTime = null;

  return pat.tag(id).onPaint((_, time, haps) => {
    if (!shouldPaint()) return;
    const w = canvas.width, h = canvas.height;

    // Fade instead of clear: the persistence IS the envelope.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.02)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) * 0.44;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    const cycleTime = Number(time);
    const continued = previousTime !== null && cycleTime > previousTime && cycleTime - previousTime < 0.25;
    const startTime = continued ? previousTime : cycleTime;
    previousTime = cycleTime;

    const active = haps.filter(hap => hap.hasTag(id) && hap.isActive(time));
    const freqs = [];
    for (const hap of active) {
      if (freqs.length >= 4) break;
      try { freqs.push(getFrequency(hap)); } catch (_) {}
    }
    if (!freqs.length) return;
    freqs.sort((a, b) => a - b);
    const fmin = freqs[0];

    // Lowest note: one revolution per cycle; everything else orbits at its
    // exact ratio above that. Sub-steps between frames keep the art dense.
    const pointsAt = (t) => freqs.map((freq) => {
      const angle = Math.PI * 2 * (freq / fmin) * t - Math.PI / 2;
      return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), freq };
    });

    const steps = continued ? 4 : 1;
    ctx.lineWidth = 1;
    for (let s = 1; s <= steps; s++) {
      const points = pointsAt(startTime + (cycleTime - startTime) * (s / steps));
      if (points.length === 1) {
        ctx.strokeStyle = 'hsla(320, 90%, 70%, 0.2)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(points[0].x, points[0].y);
        ctx.stroke();
        continue;
      }
      for (let i = 0; i < points.length - 1; i++) {
        for (let j = i + 1; j < points.length; j++) {
          // Hue from the interval class, so the figure names the interval:
          // octaves and unisons share a colour, a fifth has its own.
          const hue = ((Math.log2(points[j].freq / points[i].freq) % 1) * 360 + 360) % 360;
          ctx.strokeStyle = `hsla(${hue}, 85%, 66%, 0.3)`;
          ctx.beginPath();
          ctx.moveTo(points[i].x, points[i].y);
          ctx.lineTo(points[j].x, points[j].y);
          ctx.stroke();
        }
      }
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    for (const point of pointsAt(cycleTime)) {
      ctx.moveTo(point.x + 3, point.y);
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
    }
    ctx.fill();
  });
});
