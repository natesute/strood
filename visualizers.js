import { registerWidget, setWidget } from '@strudel/codemirror';
import { getFrequency, freqToMidi, midiToFreq } from '@strudel/core';

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

