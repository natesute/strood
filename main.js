import { StrudelMirror, initEditor, compartments, extensions, addWidget, setSliderWidgets, updateMiniLocations, registerWidget, setWidget } from '@strudel/codemirror';
import {
  getAudioContext,
  webaudioOutput,
  initAudioOnFirstClick,
  registerSynthSounds,
  samples,
} from '@strudel/webaudio';
import { transpiler } from '@strudel/transpiler';
import { evalScope, getFrequency, freqToMidi, midiToFreq } from '@strudel/core';
import { toggleLineComment } from '@codemirror/commands';
import { Prec, StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/* ── Canvas helper (replicates widget.mjs:96-105, not exported) ── */
function getCanvasWidget(id, options = {}) {
  const { width = 500, height = 60, pixelRatio = window.devicePixelRatio } = options;
  let canvas = document.getElementById(id) || document.createElement('canvas');
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  setWidget(id, canvas);
  return canvas;
}

/* ── Widget 1: _lissajous — Interval Geometry ──────────── */
// Consonant intervals draw clean closed curves (3:2 = fifth, 5:4 = third).
// Dissonance → chaotic open curves. This IS consonance, seen in 2D.
registerWidget('_lissajous', (id, options = {}, pat) => {
  const size = options.size || 200;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options);
  const ctx = canvas.getContext('2d');

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
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
  const canvas = getCanvasWidget(id, options);
  const ctx = canvas.getContext('2d');

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
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
  const canvas = getCanvasWidget(id, options);
  const ctx = canvas.getContext('2d');

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
    for (const p of lattice) {
      const px = ox + p.gx * spacingX;
      const py = oy - p.gy * spacingY;
      if (p.gx < 3) {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(ox + (p.gx + 1) * spacingX, py);
        ctx.stroke();
      }
      if (p.gy < 2) {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, oy - (p.gy + 1) * spacingY);
        ctx.stroke();
      }
      if (p.gx < 3 && p.gy > -2) {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(ox + (p.gx + 1) * spacingX, oy - (p.gy - 1) * spacingY);
        ctx.stroke();
      }
    }

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
      const isActive = activePCs.has(p.pc);

      if (isActive) {
        ctx.fillStyle = 'rgba(180, 120, 255, 0.3)';
        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = isActive ? '#bb88ff' : 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.arc(px, py, isActive ? 8 : 4, 0, Math.PI * 2);
      ctx.fill();

      if (isActive) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.font = `${Math.round(w / 25)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(noteNames[p.pc], px, py - 12);
      }
    }
  });
});

/* ── Widget 4: _cymatics — Chladni Vibration Patterns ──── */
// Physical vibrating surfaces produce geometric nodal patterns.
// Z(x,y) = cos(nπx)cos(mπy) - cos(mπx)cos(nπy), nodal lines where Z≈0.
const _cymaticsCache = new Map();

registerWidget('_cymatics', (id, options = {}, pat) => {
  const size = options.size || 200;
  options = { width: size, height: size, ...options };
  const canvas = getCanvasWidget(id, options);
  const ctx = canvas.getContext('2d');

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
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
    }

    ctx.putImageData(cached.imageData, 0, 0);
  });
});

/* ── Widget 5: _harmonics — Standing Waves ─────────────── */
// Musical intervals ARE string divisions. Octave = halved. Fifth = 3:2.
// y(x) = (A/√n) * sin(nπx) * cos(ωt) — fixed endpoints enforced by sin.
registerWidget('_harmonics', (id, options = {}, pat) => {
  options = { width: 500, height: 100, ...options };
  const canvas = getCanvasWidget(id, options);
  const ctx = canvas.getContext('2d');

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
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
  const canvas = getCanvasWidget(id, options);
  const ctx = canvas.getContext('2d');
  const rootFreq = 130.81; // C3

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
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
  const canvas = getCanvasWidget(id, options);
  const ctx = canvas.getContext('2d');
  const trail = new Float32Array(200);
  let trailIdx = 0;
  let lastTrailTime = 0;

  return pat.tag(id).onPaint((_, time, haps, drawTime) => {
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

const songCode = `setcpm(95/4)
//all(x => x.scope({ color: '#ffffff22', thickness: 1, scale: 0.05 }))
// VOCAL
$: note("<[~ ~ ~ a4 e5 d5 d5 d5 ~ e5 ~ ~ a5@4] [e5 ~ e5 ~ e5 ~ g5@3 f5 e5 ~ ~ ~ ~ ~] [d5 ~ e5 ~ d5 ~ e5 ~ d5 ~ e5 d5 ~ e5 a4 ~] [a4 ~ e5 ~ d5 ~ e5 ~ d5 ~ e5 d5 ~ e5 a4 ~]>")
  .sound("sawtooth").gain(.8).clip(.7).release(.5).lpf(2100).room(.2).size(2).color("#ff8844").delay(.3)
  ._spiral({ stretch: 0.5, size: 200, thickness: 30, steady: 0, fade: 0.001, colorizeInactive: 0 })
// BASS
$: stack(
   note("<[f2 ~ ~ ~ ~ ~ f2 ~ ~ ~ f1 f2 ~ ~ ~ ~] [f2 ~ ~ ~ ~ ~ f2 ~ ~ ~ f2 g2 ~ ~ g2 ~] [a2 ~ ~ ~ ~ ~ a2 ~ ~ ~ a1 a2 ~ ~ a2 ~] [g2 ~ ~ ~ ~ ~ g2 ~ ~ ~ g1 g2 ~ ~ g2 ~]>")
     .sound("sine").gain(.2).lpf(150).clip(.9).release(0.1),
   note("<[f2 ~ ~ ~ ~ ~ f2 ~ ~ ~ f1 f2 ~ ~ ~ ~] [f2 ~ ~ ~ ~ ~ f2 ~ ~ ~ f2 g2 ~ ~ g2 ~] [a2 ~ ~ ~ ~ ~ a2 ~ ~ ~ a1 a2 ~ ~ a1 ~] [g2 ~ ~ ~ ~ ~ g2 ~ ~ ~ g1 g2 ~ ~ g2 ~]>")
     .sound("square").gain(.2).lpf(sine.range(180,350).slow(8)).lpq(4).clip(.5).release(.1).shape(0.9).postgain(0.3)
 ).color("dodgerblue")._scope()
// ORGAN
$: stack(
  note("<[f4,a4,c5] [[f4,a4,c5]@5 [g4,b4,d5]@3] [a4,c5,e5] [g4,b4,d5]>")
    .sound("sawtooth").release(0.1).gain(.3).lpf(perlin.range(1000,1100)).lpq(2).vib("5:.12").room(.4).size(4)
    .superimpose(x => x.add(note(.08))),
  note("<[f4,a4,c5] [[f4,a4,c5]@5 [g4,b4,d5]@3] [a4,c5,e5] [g4,b4,d5]>")
    .sound("sawtooth").release(0.1).gain(.3).lpf(perlin.range(1100,1200).slow(4)).lpq(2).vib("4.5:.1").shape(.15).postgain(.5).room(0.8).size(5)
    .superimpose(x => x.add(note(-.12)).delay(".3:.12:.5"))
).color("magenta")._lissajous({ size: 200 })

// STABS
$: stack(
  note("<[[f4,a4,c5] ~@15] ~ [[a4,c5,e5] ~ ~ ~ [a4,c5,e5] ~ ~ [a4,c5,e5] [a4,c5,e5] ~@7] [[g4,b4,d5] ~ ~ ~ [g4,b4,d5] ~ ~ [g4,b4,d5] [g4,b4,d5] ~@7]>"),
  note("<[[f5,a5,c6] ~@15] ~ [[a5,c6,e6] ~ ~ ~ [a5,c6,e6] ~ ~ [a5,c6,e6] [a5,c6,e6] ~@7] [[g5,b5,d6] ~ ~ ~ [g5,b5,d6] ~ ~ [g5,b5,d6] [g5,b5,d6] ~@7]>")
).sound("piano").gain(.8).clip(.5).release(.7).room(.8).size(7).color("cyan")

// RUNS
$: stack(
  note("<[d5 ~@11] ~ ~ [~@6 c6 b5 a5 g5 f5 e5]>").gain(.9),

  note("<[d6 ~@11] ~ ~ [~@6 c7 b6 a6 g6 f6 e6]>").gain(.7)
).sound("piano").clip(.5).release(.4).delay(".2:.15:.4").room(.3).size(5).color("white")

// DRUMS
$: s("bd").struct("t ~ ~ ~ ~ ~ ~ ~ ~ ~ t ~ ~ ~ ~ ~").bank("RolandTR909").gain(0.2).shape(0.4).release(1).room(.1).color("red")._orbit({ size: 150 })
$: s("sd").struct("~ ~ ~ ~ t ~ ~ ~ ~ ~ ~ ~ t ~ ~ ~").bank("RolandTR909").gain(0.5).room(.2).size(2).color("yellow")
$: s("hh*8").gain("[.25 .35]*4").clip(sine.range(.04,.06).fast(2)).shape(.1).color("lime")`;

/* ── Shared state ────────────────────────────────────────── */
const editorsContainer = document.getElementById('editors-container');
const secondaryEditors = [];
let chunkOffsets = [0]; // character offset of each chunk in combined code
let lastEvalCode = ''; // last evaluated combined code, for location analysis

/* ── Live file sync ─────────────────────────────────────── */
let syncEnabled = false;
let saveTimeout = null;
let suppressNextUpdate = false;

function debouncedSave() {
  // Only save to localStorage for session recovery, not to disk
  localStorage.setItem('strudel_code', getAllCode());
}

/* ── Secondary editor highlight decorations ────────────── */
const setSecHighlights = StateEffect.define();
const secHighlightField = StateField.define({
  create() { return Decoration.none; },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setSecHighlights)) return e.value;
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ── Dirty-line tracking ────────────────────────────────── */
const clearDirtyLines = StateEffect.define();
const dirtyLineDeco = Decoration.line({ class: 'cm-dirty-line' });

const dirtyLineField = StateField.define({
  create() { return Decoration.none; },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(clearDirtyLines)) return Decoration.none;
    }
    decos = decos.map(tr.changes);
    if (tr.docChanged) {
      const builder = [];
      tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        const startLine = tr.state.doc.lineAt(fromB).number;
        const endLine = tr.state.doc.lineAt(toB).number;
        for (let ln = startLine; ln <= endLine; ln++) {
          builder.push(dirtyLineDeco.range(tr.state.doc.line(ln).from));
        }
      });
      if (builder.length) {
        decos = decos.update({ add: builder, sort: true });
      }
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ── Statusline ─────────────────────────────────────────── */
const modeEl = document.getElementById('mode');
const infoEl = document.getElementById('info');
const dirtyCountEl = document.getElementById('dirty-count');
let isPlaying = false;
let currentCols = 1;

function updateMode() {
  modeEl.textContent = isPlaying ? 'PLAYING' : 'STOPPED';
  modeEl.className = isPlaying ? 'playing' : 'stopped';
}

function updateDirtyCount() {
  let count = 0;
  try {
    const field = editor.editor.state.field(dirtyLineField, false);
    if (field) {
      const iter = field.iter();
      while (iter.value) { count++; iter.next(); }
    }
  } catch (_) {}
  secondaryEditors.forEach((e) => {
    try {
      const field = e.view.state.field(dirtyLineField, false);
      if (field) {
        const iter = field.iter();
        while (iter.value) { count++; iter.next(); }
      }
    } catch (_) {}
  });
  dirtyCountEl.textContent = count > 0 ? `${count} dirty` : '';
}

// Update dirty count on editor changes
const dirtyCountInterval = setInterval(updateDirtyCount, 500);

/* ── Prebake ────────────────────────────────────────────── */
const CDN = 'https://strudel.b-cdn.net';

async function prebake() {
  initAudioOnFirstClick();
  const modulesLoading = evalScope(
    evalScope,
    import('@strudel/core'),
    import('@strudel/draw'),
    import('@strudel/mini'),
    import('@strudel/tonal'),
    import('@strudel/webaudio'),
  );
  await Promise.all([
    modulesLoading,
    registerSynthSounds(),
    samples(`${CDN}/piano.json`, `${CDN}/piano/`, { prebake: true }),
    samples(`${CDN}/tidal-drum-machines.json`, `${CDN}/tidal-drum-machines/machines/`, { prebake: true }),
    samples('github:tidalcycles/dirt-samples'),
  ]);
}

/* ── StrudelMirror ──────────────────────────────────────── */
const editor = new StrudelMirror({
  root: document.getElementById('editor'),
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  initialCode: localStorage.getItem('strudel_code') ?? songCode,
  drawTime: [-2, 2],
  prebake,
  onUpdateState: (state) => {
    isPlaying = state.started;
    updateMode();
    if (!state.started) clearAllDirtyLines();
  },
  onError: (err) => console.error(err),
});

/* ── Custom theme (max color variety for Strudel code) ── */
const customThemeColors = EditorView.theme({
  '&': { color: '#bfbdb6', backgroundColor: 'transparent' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#3d4455' },
  '.cm-content': { caretColor: '#e6b450' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#e6b450' },
  '.cm-activeLine': { backgroundColor: '#00000050' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#6c7380' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
    background: 'rgba(230, 180, 80, 0.18) !important',
  },
  '.cm-selectionMatch': { backgroundColor: '#1a1f29' },
}, { dark: true });

const customHighlight = HighlightStyle.define([
  // Labels ($:) — bright coral pink, the section markers
  { tag: t.labelName,                          color: '#f07178' },
  // Keywords (const, let, import, =>, return)
  { tag: t.keyword,                            color: '#c792ea' },
  { tag: t.operatorKeyword,                    color: '#c792ea' },
  // Function calls (note, stack, setcpm, superimpose)
  { tag: t.function(t.variableName),           color: '#ffcb6b' },
  // Property names (.sound, .gain, .lpf, .room, .color)
  { tag: t.propertyName,                       color: '#89ddff' },
  // Strings ("sawtooth", "<[f2 ~ ...]>")
  { tag: t.string,                             color: '#c3e88d' },
  { tag: t.special(t.string),                  color: '#95e6cb' },
  // Numbers (.8, 150, 0.1, 2100)
  { tag: t.number,                             color: '#ff9e64' },
  // Comments (// VOCAL, // BASS)
  { tag: t.comment,                            color: '#546e7a', fontStyle: 'italic' },
  // Operators (+, -, *, /, =, =>)
  { tag: t.operator,                           color: '#f29668' },
  // Brackets and punctuation
  { tag: t.bracket,                            color: '#636d83' },
  { tag: t.paren,                              color: '#636d83' },
  { tag: t.squareBracket,                      color: '#636d83' },
  { tag: t.brace,                              color: '#636d83' },
  { tag: t.punctuation,                        color: '#636d83' },
  // Variables
  { tag: t.variableName,                       color: '#b3b1ad' },
  { tag: t.definition(t.variableName),         color: '#82aaff' },
  // Booleans & atoms
  { tag: [t.atom, t.bool],                     color: '#c792ea' },
  { tag: t.special(t.variableName),            color: '#e6b450' },
  // Types & classes
  { tag: t.typeName,                           color: '#39bae6' },
  { tag: t.className,                          color: '#ffcb6b' },
  // Meta & attributes
  { tag: t.meta,                               color: '#ffcb6b' },
  { tag: t.attributeName,                      color: '#c792ea' },
  // Invalid
  { tag: t.invalid,                            color: '#ff3333' },
]);

editor.editor.dispatch({
  effects: StateEffect.appendConfig.of([
    customThemeColors,
    Prec.highest(syntaxHighlighting(customHighlight)),
  ]),
});

/* ── Guard dispatch against position errors in multi-column mode ── */
const _origDispatch = editor.editor.dispatch.bind(editor.editor);
editor.editor.dispatch = function (...args) {
  if (currentCols > 1) {
    const docLen = editor.editor.state.doc.length;
    for (const spec of args) {
      if (!spec?.effects) continue;
      const effects = Array.isArray(spec.effects) ? spec.effects : [spec.effects];
      for (const eff of effects) {
        // Filter out-of-range widgets so valid ones in this panel still render
        if (eff.is(addWidget)) {
          eff.value = eff.value.filter((w) => w.from <= docLen && w.to <= docLen);
        }
        if (eff.is(setSliderWidgets)) {
          eff.value = eff.value.filter((w) => w.from <= docLen && w.to <= docLen);
        }
      }
    }
  }
  try {
    return _origDispatch(...args);
  } catch (e) {
    if (currentCols > 1 && e.message?.includes('out of range')) {
      return; // suppress any remaining position errors
    }
    throw e;
  }
};

editor.editor.dispatch({
  effects: StateEffect.appendConfig.of(dirtyLineField),
});

// Track cursor position for statusline
editor.editor.dispatch({
  effects: StateEffect.appendConfig.of(
    EditorView.updateListener.of((v) => {
      const pos = v.state.selection.main.head;
      const line = v.state.doc.lineAt(pos);
      const col = pos - line.from + 1;
      infoEl.textContent = `${line.number}:${col}`;
    })
  ),
});

// Auto-save to localStorage + live sync on changes
editor.editor.dispatch({
  effects: StateEffect.appendConfig.of(
    EditorView.updateListener.of((v) => {
      if (v.docChanged) {
        localStorage.setItem('strudel_code', v.state.doc.toString());
        debouncedSave();
      }
    })
  ),
});

/* ── HMR: receive external file changes ────────────────── */
if (import.meta.hot) {
  import.meta.hot.on('strudel:update', ({ code }) => {
    if (code === getAllCode()) return;
    suppressNextUpdate = true;
    editor.setCode(code);
    if (currentCols > 1) setColumnCount(currentCols); // re-split
    localStorage.setItem('strudel_code', code);
    queueMicrotask(() => { suppressNextUpdate = false; });
  });
}

/* ── Word Wrap (Ctrl+W) ────────────────────────────────── */
let wrapEnabled = true;

function setWrap(enabled) {
  wrapEnabled = enabled;
  editor.editor.dispatch({
    effects: compartments.isLineWrappingEnabled.reconfigure(
      extensions.isLineWrappingEnabled(enabled)
    ),
  });
  secondaryEditors.forEach((e) => {
    e.view.dispatch({
      effects: compartments.isLineWrappingEnabled.reconfigure(
        extensions.isLineWrappingEnabled(enabled)
      ),
    });
  });
}

setWrap(true);

/* ── Multi-column (auto-distribute code across panels) ── */
function clearAllDirtyLines() {
  editor.editor.dispatch({ effects: clearDirtyLines.of(null) });
  secondaryEditors.forEach((e) => {
    e.view.dispatch({ effects: clearDirtyLines.of(null) });
  });
}

function evaluateAll(autostart = true) {
  const parts = [editor.code, ...secondaryEditors.map((e) => e.view.state.doc.toString())];
  const allCode = parts.join('\n');
  // Track where each chunk starts in the combined code
  chunkOffsets = [];
  let offset = 0;
  for (const part of parts) {
    chunkOffsets.push(offset);
    offset += part.length + 1; // +1 for the \n separator
  }
  lastEvalCode = allCode;
  editor.flash();
  editor.repl.evaluate(allCode, autostart);
  clearAllDirtyLines();
}

const _origEvaluate = editor.evaluate.bind(editor);
editor.evaluate = function (autostart = true) {
  evaluateAll(autostart);
};

function createSecondaryEditor(initialCode = '') {
  const panel = document.createElement('div');
  panel.className = 'editor-panel';
  editorsContainer.appendChild(panel);

  const view = initEditor({
    root: panel,
    initialCode,
    onEvaluate: () => evaluateAll(),
    onStop: () => editor.stop(),
    onChange: () => { debouncedSave(); },
  });

  view.dispatch({ effects: StateEffect.appendConfig.of([dirtyLineField, secHighlightField]) });
  view.dispatch({
    effects: StateEffect.appendConfig.of([
      customThemeColors,
      Prec.highest(syntaxHighlighting(customHighlight)),
    ]),
  });
  view.dispatch({
    effects: compartments.isLineWrappingEnabled.reconfigure(
      extensions.isLineWrappingEnabled(wrapEnabled)
    ),
  });

  view.dom.addEventListener('keydown', onEditorKeydown);
  const entry = { view, root: panel };
  secondaryEditors.push(entry);
  return entry;
}

/** Collect all code, split into N roughly-equal chunks at section
 *  boundaries (lines starting with $: or // SECTION), then distribute
 *  across N editor panels. */
function setColumnCount(n) {
  // Gather all code from every panel
  const allCode = [
    editor.code,
    ...secondaryEditors.map((e) => e.view.state.doc.toString()),
  ].join('\n');

  // Tear down existing secondary editors
  while (secondaryEditors.length) {
    const removed = secondaryEditors.pop();
    removed.root.remove();
  }

  currentCols = n;
  if (n === 1) {
    // Single column — put everything back in primary
    editor.setCode(allCode);
    return;
  }

  // Split into sections at $: or // boundaries, then merge comment-only
  // sections with the following code block so headers stay with their code
  const lines = allCode.split('\n');
  const rawSections = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if ((trimmed.startsWith('$:') || trimmed.startsWith('//')) && current.length > 0) {
      rawSections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length) rawSections.push(current.join('\n'));

  // Merge comment/blank-only sections forward into the next code section
  const sections = [];
  for (let i = 0; i < rawSections.length; i++) {
    const sLines = rawSections[i].split('\n');
    const isCommentOnly = sLines.every((l) => {
      const t = l.trimStart();
      return t === '' || t.startsWith('//');
    });
    if (isCommentOnly && i + 1 < rawSections.length) {
      rawSections[i + 1] = rawSections[i] + '\n' + rawSections[i + 1];
    } else {
      sections.push(rawSections[i]);
    }
  }

  // Distribute sections sequentially (preserving order), balancing by line count
  const totalLines = sections.reduce((sum, s) => sum + s.split('\n').length, 0);
  const targetPerChunk = Math.ceil(totalLines / n);
  const chunks = [[]];
  let currentChunkLines = 0;
  for (const section of sections) {
    const sectionLines = section.split('\n').length;
    if (currentChunkLines > 0 && currentChunkLines + sectionLines > targetPerChunk && chunks.length < n) {
      chunks.push([]);
      currentChunkLines = 0;
    }
    chunks[chunks.length - 1].push(section);
    currentChunkLines += sectionLines;
  }
  while (chunks.length < n) chunks.push([]);

  // Primary editor gets chunk 0
  editor.setCode(chunks[0].join('\n'));

  // Create secondary editors for the rest
  for (let i = 1; i < n; i++) {
    createSecondaryEditor(chunks[i].join('\n'));
  }
}

/* ── Ripples (inside .cm-scroller, scroll naturally with text) ──── */

function spawnRipple(scroller, x, y, color, gain) {
  const g = Math.max(0.1, Math.min(gain, 1.5));
  const size = 30 + g * 80;
  const border = 4 + g * 4;

  const ring = document.createElement('div');
  ring.className = 'ripple';
  ring.style.left = (x - size / 2) + 'px';
  ring.style.top = (y - size / 2) + 'px';
  ring.style.width = size + 'px';
  ring.style.height = size + 'px';
  ring.style.borderWidth = border + 'px';
  ring.style.color = color;
  scroller.appendChild(ring);
  ring.addEventListener('animationend', () => ring.remove());
}

/** Convert viewport coords to scroller-relative coords */
function viewportToScroller(scroller, vx, vy) {
  const rect = scroller.getBoundingClientRect();
  return {
    x: vx - rect.left + scroller.scrollLeft,
    y: vy - rect.top + scroller.scrollTop,
  };
}

/** Resolve scroller + scroller-relative center of a token */
function resolveHapPosition(loc) {
  try {
    const start = editor.editor.coordsAtPos(loc.start);
    const end = editor.editor.coordsAtPos(loc.end);
    if (start && end) {
      const scroller = editor.editor.dom.querySelector('.cm-scroller');
      const cx = (start.left + end.left) / 2;
      const cy = (start.top + start.bottom) / 2;
      const pos = viewportToScroller(scroller, cx, cy);
      return { scroller, x: pos.x, y: pos.y };
    }
  } catch (_) {}
  for (let i = 0; i < secondaryEditors.length; i++) {
    const off = chunkOffsets[i + 1] ?? Infinity;
    const adjStart = loc.start - off;
    const adjEnd = loc.end - off;
    if (adjStart < 0) continue;
    try {
      const start = secondaryEditors[i].view.coordsAtPos(adjStart);
      const end = secondaryEditors[i].view.coordsAtPos(adjEnd);
      if (start && end) {
        const scroller = secondaryEditors[i].view.dom.querySelector('.cm-scroller');
        const cx = (start.left + end.left) / 2;
        const cy = (start.top + start.bottom) / 2;
        const pos = viewportToScroller(scroller, cx, cy);
        return { scroller, x: pos.x, y: pos.y };
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Find the location in a hap that represents the actual note/beat/trigger,
 * not parameter atoms from .color("magenta"), .sound("sawtooth"), etc.
 *
 * Every string arg in the chain gets mini-parsed, so locations include atoms
 * like "magenta", "sawtooth", "#ff8844", ".25" etc. We only want locations
 * that are musical notes (a4, f2, gs5…) or triggers (t) or sample names (bd, hh…).
 */
const NOTE_RE = /^[a-gA-G][sfb#]?\d+$/;

function findNoteLocation(hap) {
  if (!hap.context?.locations || !lastEvalCode) return null;

  // Pass 1: find a musical note name or trigger 't'
  for (const loc of hap.context.locations) {
    if (loc.start < 0 || loc.end > lastEvalCode.length) continue;
    const text = lastEvalCode.slice(loc.start, loc.end);
    if (NOTE_RE.test(text)) return loc;
    if (text === 't') return loc;
  }

  // Pass 2: match the hap's sample/sound name (bd, sd, hh, etc.)
  const sValue = hap.value?.s;
  if (sValue) {
    for (const loc of hap.context.locations) {
      if (loc.start < 0 || loc.end > lastEvalCode.length) continue;
      const text = lastEvalCode.slice(loc.start, loc.end);
      if (text === sValue) return loc;
    }
  }

  return null;
}

/**
 * Ripple tracking. No setInterval, no grouping, no frequency math.
 * Each hap gets its own entry keyed by time span + source position.
 * Ripples emit on the highlight frame at a fixed rate.
 */
const liveHaps = new Map(); // uid -> { scroller, x, y, color, gain, lastEmit }
const RIPPLE_INTERVAL = 150; // ms between ripples for held notes

const _origHighlight = editor.highlight.bind(editor);
editor.highlight = function (haps, time) {
  _origHighlight(haps, time);

  // Distribute highlights to secondary editors
  if (currentCols > 1 && secondaryEditors.length > 0) {
    for (let i = 0; i < secondaryEditors.length; i++) {
      const sec = secondaryEditors[i];
      const off = chunkOffsets[i + 1] ?? Infinity;
      const docLen = sec.view.state.doc.length;
      const marks = [];
      for (const hap of haps) {
        if (!hap.context?.locations || !hap.whole) continue;
        const color = hap.value?.color ?? 'var(--foreground)';
        const style = hap.value?.markcss || `outline: solid 2px ${color}`;
        for (const loc of hap.context.locations) {
          const from = loc.start - off;
          const to = loc.end - off;
          if (from >= 0 && to <= docLen && from < to) {
            marks.push(Decoration.mark({ attributes: { style } }).range(from, to));
          }
        }
      }
      try {
        sec.view.dispatch({ effects: setSecHighlights.of(Decoration.set(marks, true)) });
      } catch (_) {}
    }
  }

  // Ripples — one per hap, keyed by time span + source location
  const now = performance.now();
  const currentIds = new Set();

  for (const hap of haps) {
    if (!hap.context?.locations || !hap.whole) continue;
    const noteLoc = findNoteLocation(hap);
    if (!noteLoc) continue;

    const uid = `${hap.whole.begin}:${hap.whole.end}:${noteLoc.start}`;
    currentIds.add(uid);

    if (!liveHaps.has(uid)) {
      liveHaps.set(uid, {
        loc: noteLoc,
        color: hap.value?.color ?? 'white',
        gain: hap.value?.gain ?? 0.5,
        lastEmit: 0,
      });
    }

    const e = liveHaps.get(uid);
    if (now - e.lastEmit >= RIPPLE_INTERVAL) {
      const pos = resolveHapPosition(e.loc);
      if (pos) spawnRipple(pos.scroller, pos.x, pos.y, e.color, e.gain);
      e.lastEmit = now;
    }
  }

  for (const [uid] of liveHaps) {
    if (!currentIds.has(uid)) liveHaps.delete(uid);
  }
};

/* ── Keyboard handler (all shortcuts) ───────────────────── */
async function onEditorKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;

  const view = e.currentTarget.cmView?.view || editor.editor;

  // Ctrl+M — mute (toggle line comment)
  if (ctrl && e.key === 'm') {
    e.preventDefault();
    toggleLineComment(view);
    return;
  }

  // Ctrl+W — toggle word wrap
  if (ctrl && e.key === 'w') {
    e.preventDefault();
    setWrap(!wrapEnabled);
    return;
  }

  // Ctrl+1/2/3 — column count
  if (ctrl && e.key >= '1' && e.key <= '3') {
    e.preventDefault();
    setColumnCount(parseInt(e.key));
    return;
  }

  // Ctrl+U — update live
  if (ctrl && e.key === 'u') {
    e.preventDefault();
    evaluateAll(true);
    return;
  }

  // Ctrl+. — stop
  if (ctrl && e.key === '.') {
    e.preventDefault();
    editor.stop();
    return;
  }

  // Ctrl+S — save song
  if (ctrl && e.key === 's') {
    e.preventDefault();
    saveSong();
    return;
  }

  // Ctrl+O — open/load song
  if (ctrl && e.key === 'o') {
    e.preventDefault();
    showSongBrowser();
    return;
  }

  // Ctrl+N — new song
  if (ctrl && e.key === 'n') {
    e.preventDefault();
    const code = getAllCode();
    if (code.trim()) {
      const choice = confirm('Save current song before creating a new one?');
      if (choice) await saveSong();
    }
    loadSong('');
    return;
  }
}

/* ── Save / Load songs (file-backed via /api/songs) ──── */
let currentSongName = null;

function getAllCode() {
  return [editor.code, ...secondaryEditors.map(e => e.view.state.doc.toString())].join('\n');
}

async function saveSong() {
  const name = currentSongName || prompt('Song name:');
  if (!name) return;
  currentSongName = name;
  localStorage.setItem('strudel_song_name', name);
  await fetch(`/api/songs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: getAllCode(),
  });
  // Activate sync for this file
  syncEnabled = true;
  import.meta.hot?.send('strudel:open', { name, code: getAllCode() });
  infoEl.textContent = `saved "${name}"`;
}

function loadSong(code, name) {
  while (secondaryEditors.length) secondaryEditors.pop().root.remove();
  currentCols = 1;
  editor.setCode(code);
  localStorage.setItem('strudel_code', code);
  if (name) {
    currentSongName = name;
    localStorage.setItem('strudel_song_name', name);
    syncEnabled = true;
    import.meta.hot?.send('strudel:open', { name, code });
  } else {
    currentSongName = null;
    localStorage.removeItem('strudel_song_name');
    syncEnabled = false;
  }
  closeSongBrowser();
}

async function deleteSong(name) {
  await fetch(`/api/songs/${encodeURIComponent(name)}`, { method: 'DELETE' });
  showSongBrowser();
}

let songBrowserEl = null;

async function showSongBrowser() {
  closeSongBrowser();
  const songs = await fetch('/api/songs').then(r => r.json());

  const overlay = document.createElement('div');
  overlay.id = 'song-browser';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSongBrowser(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSongBrowser(); });

  const panel = document.createElement('div');
  panel.className = 'song-panel';

  const title = document.createElement('div');
  title.className = 'song-title';
  title.textContent = songs.length ? 'saved songs' : 'no saved songs';
  panel.appendChild(title);

  for (const song of songs) {
    const row = document.createElement('div');
    row.className = 'song-row';

    const label = document.createElement('span');
    label.className = 'song-name';
    label.textContent = song.name;
    label.addEventListener('click', async () => {
      const code = await fetch(`/api/songs/${encodeURIComponent(song.name)}`).then(r => r.text());
      loadSong(code, song.name);
    });

    const date = document.createElement('span');
    date.className = 'song-date';
    date.textContent = new Date(song.mtime).toLocaleDateString();

    const del = document.createElement('span');
    del.className = 'song-delete';
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteSong(song.name); });

    row.append(label, date, del);
    panel.appendChild(row);
  }

  const newBtn = document.createElement('div');
  newBtn.className = 'song-row song-new';
  newBtn.textContent = '+ new';
  newBtn.addEventListener('click', () => { loadSong(''); });
  panel.appendChild(newBtn);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  songBrowserEl = overlay;
  overlay.focus();
}

function closeSongBrowser() {
  if (songBrowserEl) { songBrowserEl.remove(); songBrowserEl = null; }
  editor.editor.focus();
}

editor.editor.dom.addEventListener('keydown', onEditorKeydown);
updateMode();

/* ── Startup: restore last synced song from disk ────────── */
(async () => {
  const songName = localStorage.getItem('strudel_song_name') || 'ms jackson';
  try {
    const res = await fetch(`/api/songs/${encodeURIComponent(songName)}`);
    if (res.ok) {
      const code = await res.text();
      currentSongName = songName;
      localStorage.setItem('strudel_song_name', songName);
      editor.setCode(code);
      localStorage.setItem('strudel_code', code);
      syncEnabled = true;
      import.meta.hot?.send('strudel:open', { name: songName, code });
    }
  } catch (_) {}
})();