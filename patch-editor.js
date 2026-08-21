// Patch Editor — free-form node graph with draggable modules and visual wiring
import './patch-editor.css';
import { registerPatch, listModules, getModuleFactory } from './synth-modules/index.mjs';
import { listPatchMacros, insertPatchMacro } from './synth-modules/macros.mjs';
import { superdough, getAudioContext } from 'superdough';
import { listPatches, readPatch, writePatch } from './src/api.js';
import { showToast, trapFocus } from './src/ui.js';
import { confirmDialog, promptDialog } from './src/dialogs.js';

let overlayEl = null;
let patchDef = null;
let currentPatchName = null;
let selectedModuleId = null;
let commitTimeout = null;
let historyTimeout = null;
let patchDirty = false;
let undoStack = [];
let redoStack = [];
let previousFocus = null;

// Graph state
let graphEl, innerEl, wiresSvg, bottomBar;
let panX = 0, panY = 0;
let graphScale = 1;
let dragWire = null; // { fromId, fromType, svgPath }

const modColors = ['#56d4dd', '#c678dd', '#7ee787', '#e6b450', '#ff5370'];

// ── Helpers ──────────────────────────────────────────────
function getModuleMeta(type) {
  try { return getModuleFactory(type).meta; } catch { return {}; }
}
function getParamMeta(type, paramName) {
  return getModuleMeta(type)?.params?.[paramName] || {};
}
function fmt(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 10 ? 2 : 1);
}
function snapshotPatch() {
  return patchDef ? JSON.stringify(patchDef) : '';
}
function setPatchDirty(value) {
  patchDirty = value;
  const indicator = overlayEl?.querySelector('.pe-dirty');
  if (indicator) {
    indicator.textContent = value ? 'Unsaved' : 'Saved';
    indicator.classList.toggle('unsaved', value);
  }
}
function resetHistory() {
  undoStack = patchDef ? [snapshotPatch()] : [];
  redoStack = [];
  updateHistoryButtons();
}
function recordHistory() {
  if (!patchDef) return;
  const snapshot = snapshotPatch();
  if (undoStack.at(-1) !== snapshot) undoStack.push(snapshot);
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}
function restoreSnapshot(snapshot) {
  patchDef = JSON.parse(snapshot);
  selectedModuleId = null;
  registerPatch(currentPatchName, patchDef);
  setPatchDirty(true);
  renderAll();
  updateHistoryButtons();
}
function undoPatch() {
  if (undoStack.length < 2) return;
  const current = undoStack.pop();
  redoStack.push(current);
  restoreSnapshot(undoStack.at(-1));
}
function redoPatch() {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(next);
  restoreSnapshot(next);
}
function updateHistoryButtons() {
  const undo = overlayEl?.querySelector('[data-action="undo"]');
  const redo = overlayEl?.querySelector('[data-action="redo"]');
  if (undo) undo.disabled = undoStack.length < 2;
  if (redo) redo.disabled = redoStack.length === 0;
}
function commitPatch() {
  if (!patchDef || !currentPatchName) return;
  setPatchDirty(true);
  clearTimeout(commitTimeout);
  clearTimeout(historyTimeout);
  commitTimeout = setTimeout(() => registerPatch(currentPatchName, patchDef), 50);
  historyTimeout = setTimeout(recordHistory, 140);
}
function applyGraphTransform() {
  if (innerEl) innerEl.style.transform = `translate(${panX}px, ${panY}px) scale(${graphScale})`;
}
function setGraphScale(nextScale, anchorX = graphEl?.clientWidth / 2, anchorY = graphEl?.clientHeight / 2) {
  const previous = graphScale;
  graphScale = Math.max(0.45, Math.min(1.8, nextScale));
  if (graphEl && previous !== graphScale) {
    panX = anchorX - ((anchorX - panX) / previous) * graphScale;
    panY = anchorY - ((anchorY - panY) / previous) * graphScale;
  }
  applyGraphTransform();
  requestAnimationFrame(drawWires);
  const readout = overlayEl?.querySelector('.pe-zoom-readout');
  if (readout) readout.textContent = `${Math.round(graphScale * 100)}%`;
}
function fitGraph() {
  if (!graphEl || !patchDef) return;
  const positions = Object.values(patchDef.positions || {});
  if (!positions.length) return;
  const minX = Math.min(...positions.map((position) => position.x));
  const minY = Math.min(...positions.map((position) => position.y));
  const maxX = Math.max(...positions.map((position) => position.x + 180));
  const maxY = Math.max(...positions.map((position) => position.y + 190));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  graphScale = Math.max(0.45, Math.min(1.35, Math.min((graphEl.clientWidth - 100) / width, (graphEl.clientHeight - 80) / height)));
  panX = (graphEl.clientWidth - width * graphScale) / 2 - minX * graphScale;
  panY = (graphEl.clientHeight - height * graphScale) / 2 - minY * graphScale;
  applyGraphTransform();
  requestAnimationFrame(drawWires);
  const readout = overlayEl?.querySelector('.pe-zoom-readout');
  if (readout) readout.textContent = `${Math.round(graphScale * 100)}%`;
}
function nextId(type) {
  const meta = getModuleMeta(type);
  const cat = meta?.category || 'mod';
  const prefixes = { source: 'osc', filter: 'filter', modulator: type, utility: type };
  const prefix = prefixes[cat] || type;
  let n = 1;
  while (patchDef.modules[`${prefix}${n}`]) n++;
  return `${prefix}${n}`;
}

// ── Auto-layout (for patches without positions) ──────────
function autoLayout() {
  if (!patchDef.positions) patchDef.positions = {};
  const ids = Object.keys(patchDef.modules);
  const hasPositions = ids.some(id => patchDef.positions[id]);
  if (hasPositions) return;

  const sources = [], filters = [], modulators = [];
  ids.forEach(id => {
    const cat = getModuleMeta(patchDef.modules[id].type)?.category;
    if (cat === 'source') sources.push(id);
    else if (cat === 'filter' || cat === 'utility') filters.push(id);
    else modulators.push(id);
  });

  const colGap = 200, rowGap = 140;
  const startX = 60, startY = 60;

  sources.forEach((id, i) => { patchDef.positions[id] = { x: startX + i * colGap, y: startY }; });
  filters.forEach((id, i) => { patchDef.positions[id] = { x: startX + i * colGap, y: startY + rowGap }; });
  modulators.forEach((id, i) => { patchDef.positions[id] = { x: startX + i * colGap, y: startY + rowGap * 2 }; });
}

// ── Waveform path ────────────────────────────────────────
function waveformPath(type, w, h) {
  const pts = 60, mid = h / 2, amp = mid * 0.8;
  let d = '';
  for (let i = 0; i <= pts; i++) {
    const x = (i / pts) * w, t = (i / pts) * Math.PI * 2;
    let y;
    switch (type) {
      case 'sine': y = mid - Math.sin(t) * amp; break;
      case 'triangle': y = mid - (2 * Math.abs(2 * (t / (2 * Math.PI)) - 1) - 1) * amp; break;
      case 'square': y = mid - (t < Math.PI ? 1 : -1) * amp; break;
      case 'sawtooth': y = mid - (1 - 2 * (t / (2 * Math.PI))) * amp; break;
      case 'supersaw': y = mid - (Math.sin(t) * 0.5 + Math.sin(t * 1.01) * 0.25 + Math.sin(t * 0.99) * 0.25) * amp; break;
      case 'noise': y = mid - (Math.random() * 2 - 1) * amp; break;
      default: y = mid - Math.sin(t) * amp;
    }
    d += (i === 0 ? 'M' : 'L') + `${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

// ── Envelope display ─────────────────────────────────────
function createEnvelopeDisplay(moduleId, def) {
  const w = 150, h = 52, pad = 6, iw = w - pad * 2, ih = h - pad * 2;
  const a = def.params.a ?? 0.01, d = def.params.d ?? 0.1;
  const s = def.params.s ?? 0.5, r = def.params.r ?? 0.3;
  const total = a + d + 0.3 + r;
  const ax = pad + (a / total) * iw;
  const dx = ax + (d / total) * iw;
  const sx = dx + (0.3 / total) * iw;
  const rx = sx + (r / total) * iw;
  const top = pad, bot = h - pad;
  const sy = top + (1 - s) * ih;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'pe-env-svg');

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', w); bg.setAttribute('height', h);
  bg.setAttribute('fill', '#161b22'); bg.setAttribute('rx', 3);
  svg.appendChild(bg);

  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `M${pad},${bot} L${ax},${top} L${dx},${sy} L${sx},${sy} L${rx},${bot} Z`);
  area.setAttribute('fill', '#e6b450'); area.setAttribute('opacity', '0.08');
  svg.appendChild(area);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', `M${pad},${bot} L${ax},${top} L${dx},${sy} L${sx},${sy} L${rx},${bot}`);
  line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#e6b450');
  line.setAttribute('stroke-width', '1.5'); line.setAttribute('opacity', '0.7');
  svg.appendChild(line);

  ['A', 'D', 'S', 'R'].forEach((txt, i) => {
    const xs = [(pad + ax) / 2, (ax + dx) / 2, (dx + sx) / 2, (sx + rx) / 2];
    const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lbl.setAttribute('x', xs[i]); lbl.setAttribute('y', bot + 1);
    lbl.setAttribute('text-anchor', 'middle'); lbl.setAttribute('fill', '#3d4455');
    lbl.setAttribute('font-size', '7'); lbl.setAttribute('font-family', 'Fragment Mono, monospace');
    lbl.textContent = txt;
    svg.appendChild(lbl);
  });

  // Draggable handles
  const handles = [
    { x: ax, y: top },
    { x: dx, y: sy },
    { x: rx, y: bot },
  ];
  handles.forEach((pt, idx) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y); c.setAttribute('r', 4);
    c.setAttribute('fill', '#e6b450'); c.setAttribute('stroke', '#0a0e14');
    c.setAttribute('stroke-width', '1'); c.setAttribute('cursor', 'pointer');
    c.setAttribute('class', 'pe-env-handle');
    c.setAttribute('tabindex', '0');
    c.setAttribute('role', 'slider');
    c.setAttribute('aria-label', ['Attack', 'Decay and sustain', 'Release'][idx]);
    c.setAttribute('aria-valuemin', idx === 1 ? '0' : '0.001');
    c.setAttribute('aria-valuemax', idx === 1 ? '10' : '10');
    c.setAttribute('aria-valuenow', String([a, d, r][idx]));
    if (idx === 1) c.setAttribute('aria-valuetext', `Decay ${d.toFixed(2)}, sustain ${s.toFixed(2)}`);
    svg.appendChild(c);

    c.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 0.1 : 0.01;
      const direction = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1;
      if (idx === 0) def.params.a = Math.max(0.001, a + direction * step);
      else if (idx === 2) def.params.r = Math.max(0.01, r + direction * step);
      else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) def.params.d = Math.max(0.001, d + direction * step);
      else def.params.s = Math.max(0, Math.min(1, s + direction * step));
      commitPatch();
      renderAll();
    });

    c.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const svgRect = svg.getBoundingClientRect();
      const scaleX = w / svgRect.width, scaleY = h / svgRect.height;
      const startMX = e.clientX, startMY = e.clientY;
      const onMove = (ev) => {
        const ddx = (ev.clientX - startMX) * scaleX;
        const ddy = (ev.clientY - startMY) * scaleY;
        if (idx === 0) {
          def.params.a = Math.max(0.001, a + (ddx / iw) * total);
        } else if (idx === 1) {
          def.params.d = Math.max(0.001, d + (ddx / iw) * total);
          def.params.s = Math.max(0, Math.min(1, s - (ddy / ih)));
        } else {
          def.params.r = Math.max(0.01, r + (ddx / iw) * total);
        }
        commitPatch(); renderAll();
      };
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });

  return svg;
}

// ── LFO display ──────────────────────────────────────────
function createLfoDisplay(def) {
  const w = 150, h = 44, pad = 6;
  const shape = def.params.shape ?? 'sine';
  const rate = def.params.rate ?? 1;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'pe-lfo-svg');

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', w); bg.setAttribute('height', h);
  bg.setAttribute('fill', '#161b22'); bg.setAttribute('rx', 3);
  svg.appendChild(bg);

  const centerLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  centerLine.setAttribute('x1', pad); centerLine.setAttribute('y1', h / 2);
  centerLine.setAttribute('x2', w - pad); centerLine.setAttribute('y2', h / 2);
  centerLine.setAttribute('stroke', '#1a1f29'); centerLine.setAttribute('stroke-width', '1');
  svg.appendChild(centerLine);

  const shapeMap = { tri: 'triangle', triangle: 'triangle', sine: 'sine', ramp: 'ramp', saw: 'saw', square: 'square' };
  const sName = typeof shape === 'string' ? (shapeMap[shape] || shape) : ['triangle', 'sine', 'ramp', 'saw', 'square'][shape] || 'sine';

  const pts = 100, mid = h / 2, amp = (h - pad * 2) / 2 * 0.85;
  let d = '';
  for (let i = 0; i <= pts; i++) {
    const x = pad + (i / pts) * (w - pad * 2);
    const t = ((i / pts) * 2) % 1;
    let y;
    switch (sName) {
      case 'sine': y = mid - Math.sin(t * Math.PI * 2) * amp; break;
      case 'triangle': y = mid - (1 - 4 * Math.abs(t - 0.5)) * amp; break;
      case 'saw': y = mid - (1 - 2 * t) * amp; break;
      case 'ramp': y = mid - (2 * t - 1) * amp; break;
      case 'square': y = mid - (t < 0.5 ? 1 : -1) * amp; break;
      default: y = mid - Math.sin(t * Math.PI * 2) * amp;
    }
    d += (i === 0 ? 'M' : 'L') + `${x.toFixed(1)},${y.toFixed(1)}`;
  }

  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', d + ` L${w - pad},${mid} L${pad},${mid} Z`);
  area.setAttribute('fill', '#56d4dd'); area.setAttribute('opacity', '0.06');
  svg.appendChild(area);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', d); line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#56d4dd'); line.setAttribute('stroke-width', '1.5');
  line.setAttribute('opacity', '0.7');
  svg.appendChild(line);

  const rateLbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  rateLbl.setAttribute('x', w - pad); rateLbl.setAttribute('y', pad + 6);
  rateLbl.setAttribute('text-anchor', 'end'); rateLbl.setAttribute('fill', '#3d4455');
  rateLbl.setAttribute('font-size', '7'); rateLbl.setAttribute('font-family', 'Fragment Mono, monospace');
  rateLbl.textContent = `${fmt(rate)} Hz`;
  svg.appendChild(rateLbl);

  return svg;
}

// ── SVG Knob ─────────────────────────────────────────────
function createKnob(moduleId, paramName, value, min, max, onInput) {
  const size = 34, cx = size / 2, cy = size / 2, r = 12;
  const startA = 135, endA = 405, range = endA - startA;
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));

  const polar = (deg) => {
    const rad = (deg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };
  const arc = (s, e) => {
    const sp = polar(s), ep = polar(e);
    return `M${sp.x},${sp.y} A${r},${r} 0 ${e - s > 180 ? 1 : 0} 1 ${ep.x},${ep.y}`;
  };

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'pe-knob-svg');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('role', 'slider');
  svg.setAttribute('aria-label', `${moduleId} ${paramName}`);
  svg.setAttribute('aria-valuemin', String(min));
  svg.setAttribute('aria-valuemax', String(max));
  svg.setAttribute('aria-valuenow', String(value));

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  track.setAttribute('d', arc(startA, endA));
  track.setAttribute('class', 'pe-knob-track');
  svg.appendChild(track);

  // Mod arcs
  const mods = (patchDef.matrix || []).filter(m => m.dst === `${moduleId}.${paramName}`);
  mods.forEach((mod, i) => {
    const depthPct = Math.abs(mod.depth) / (max - min);
    const ms = startA + pct * range;
    const me = Math.min(endA, ms + depthPct * range);
    if (me > ms) {
      const ma = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      ma.setAttribute('d', arc(ms, me));
      ma.setAttribute('class', 'pe-knob-mod-arc');
      ma.setAttribute('stroke', modColors[i % modColors.length]);
      svg.appendChild(ma);
    }
  });

  const valA = startA + pct * range;
  if (pct > 0.005) {
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    fill.setAttribute('d', arc(startA, valA));
    fill.setAttribute('class', 'pe-knob-fill');
    svg.appendChild(fill);
  }

  const dp = polar(valA);
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', dp.x); dot.setAttribute('cy', dp.y);
  dot.setAttribute('class', 'pe-knob-dot');
  svg.appendChild(dot);

  // Drag interaction
  svg.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    let startY = e.clientY, startVal = value;
    const onMove = (ev) => {
      const dy = startY - ev.clientY;
      value = Math.max(min, Math.min(max, startVal + dy * ((max - min) / 150)));
      svg.setAttribute('aria-valuenow', String(value));
      onInput(value);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  svg.addEventListener('keydown', (event) => {
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const step = (max - min) / (event.shiftKey ? 20 : 100);
    value = Math.max(min, Math.min(max, value + direction * step));
    svg.setAttribute('aria-valuenow', String(value));
    onInput(value);
    renderAll();
  });

  return svg;
}

// ── Create module node ───────────────────────────────────
function createNode(id) {
  const def = patchDef.modules[id];
  const meta = getModuleMeta(def.type);
  const cat = meta?.category || 'other';
  const pos = patchDef.positions?.[id] || { x: 100, y: 100 };

  const node = document.createElement('div');
  node.className = 'pe-node' + (id === selectedModuleId ? ' selected' : '');
  node.dataset.moduleId = id;
  node.style.left = pos.x + 'px';
  node.style.top = pos.y + 'px';
  node.tabIndex = 0;
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', `${def.type} module ${id}`);

  // Header (drag handle)
  const header = document.createElement('div');
  header.className = 'pe-node-header';

  const typeEl = document.createElement('span');
  typeEl.className = 'pe-node-type';
  typeEl.textContent = def.type;

  const idEl = document.createElement('span');
  idEl.className = 'pe-node-id';
  idEl.textContent = id;

  const removeEl = document.createElement('button');
  removeEl.type = 'button';
  removeEl.className = 'pe-node-remove';
  removeEl.textContent = '×';
  removeEl.setAttribute('aria-label', `Remove ${id}`);
  removeEl.onclick = (e) => {
    e.stopPropagation();
    delete patchDef.modules[id];
    delete patchDef.positions?.[id];
    patchDef.routing = patchDef.routing.filter(([s, d]) => s !== id && d !== id);
    patchDef.matrix = (patchDef.matrix || []).filter(m => m.src !== id && !m.dst.startsWith(id + '.'));
    if (selectedModuleId === id) selectedModuleId = null;
    commitPatch(); renderAll();
  };

  header.append(typeEl, idEl, removeEl);
  node.appendChild(header);

  // Drag to move
  header.addEventListener('mousedown', (e) => {
    if (e.target === removeEl) return;
    e.preventDefault(); e.stopPropagation();
    selectedModuleId = id;
    const startMX = e.clientX, startMY = e.clientY;
    const startX = pos.x, startY = pos.y;
    const onMove = (ev) => {
      pos.x = startX + (ev.clientX - startMX) / graphScale;
      pos.y = startY + (ev.clientY - startMY) / graphScale;
      node.style.left = pos.x + 'px';
      node.style.top = pos.y + 'px';
      patchDef.positions[id] = { x: pos.x, y: pos.y };
      drawWires();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      commitPatch();
      renderAll();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // Body
  const body = document.createElement('div');
  body.className = 'pe-node-body';

  // Visualizations
  if (def.type === 'env') body.appendChild(createEnvelopeDisplay(id, def));
  if (def.type === 'lfo') body.appendChild(createLfoDisplay(def));
  if (cat === 'source' && ['sine', 'triangle', 'square', 'sawtooth', 'supersaw', 'noise'].includes(def.type)) {
    const wfSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wfSvg.setAttribute('viewBox', '0 0 140 28');
    wfSvg.setAttribute('class', 'pe-waveform');
    wfSvg.setAttribute('preserveAspectRatio', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', waveformPath(def.type, 140, 28));
    path.setAttribute('class', 'pe-waveform-path');
    wfSvg.appendChild(path);
    body.appendChild(wfSvg);
  }

  // Knobs
  if (meta?.params) {
    const knobs = document.createElement('div');
    knobs.className = 'pe-knobs';
    for (const [paramName, paramMeta] of Object.entries(meta.params)) {
      if (paramMeta.values) {
        const enumWrap = document.createElement('div');
        enumWrap.className = 'pe-enum';
        const label = document.createElement('span');
        label.className = 'pe-enum-label';
        label.textContent = paramName;
        const select = document.createElement('select');
        select.className = 'pe-enum-select';
        select.setAttribute('aria-label', `${id} ${paramName}`);
        paramMeta.values.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v; opt.textContent = v;
          if (def.params[paramName] === v) opt.selected = true;
          select.appendChild(opt);
        });
        select.onchange = () => { def.params[paramName] = select.value; commitPatch(); };
        select.addEventListener('mousedown', (e) => e.stopPropagation());
        enumWrap.append(label, select);
        body.appendChild(enumWrap);
      } else {
        const min = paramMeta.min ?? 0, max = paramMeta.max ?? 1;
        const val = def.params[paramName] ?? paramMeta.default ?? min;
        const wrap = document.createElement('div');
        wrap.className = 'pe-knob-wrap';
        wrap.dataset.target = `${id}.${paramName}`;

        const label = document.createElement('div');
        label.className = 'pe-knob-label';
        label.textContent = paramName;
        const valueEl = document.createElement('div');
        valueEl.className = 'pe-knob-value';
        valueEl.textContent = fmt(val);

        const svg = createKnob(id, paramName, val, min, max, (newVal) => {
          def.params[paramName] = newVal;
          valueEl.textContent = fmt(newVal);
          commitPatch();
        });

        // Param port (modulation target)
        const paramPort = document.createElement('div');
        paramPort.className = 'pe-port-param';
        paramPort.dataset.paramTarget = `${id}.${paramName}`;
        paramPort.tabIndex = 0;
        paramPort.setAttribute('role', 'button');
        paramPort.setAttribute('aria-label', `${id} ${paramName} modulation input`);
        paramPort.addEventListener('mousedown', (e) => e.stopPropagation());
        paramPort.addEventListener('mouseup', (e) => {
          e.stopPropagation();
          if (dragWire) {
            finishModConnection(`${id}.${paramName}`);
          }
        });

        wrap.append(svg, paramPort, label, valueEl);
        knobs.appendChild(wrap);
      }
    }
    body.appendChild(knobs);
  }

  node.appendChild(body);

  // Ports
  // Audio input (top) — for filters and utility
  if (cat === 'filter' || cat === 'utility') {
    const portIn = document.createElement('div');
    portIn.className = 'pe-port pe-port-in';
    portIn.dataset.portType = 'audio-in';
    portIn.dataset.portModuleId = id;
    portIn.tabIndex = 0;
    portIn.setAttribute('role', 'button');
    portIn.setAttribute('aria-label', `${id} audio input`);
    portIn.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      if (dragWire && dragWire.fromType === 'audio-out') {
        finishSignalConnection(id);
      }
    });
    node.appendChild(portIn);
  }

  // Audio output (bottom) — for sources, filters, utility
  if (cat === 'source' || cat === 'filter' || cat === 'utility') {
    const portOut = document.createElement('div');
    portOut.className = 'pe-port pe-port-out';
    portOut.dataset.portType = 'audio-out';
    portOut.dataset.portModuleId = id;
    portOut.tabIndex = 0;
    portOut.setAttribute('role', 'button');
    portOut.setAttribute('aria-label', `${id} audio output`);
    portOut.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      startDragWire(id, 'audio-out', e);
    });
    node.appendChild(portOut);
  }

  // Mod output (bottom) — for modulators
  if (cat === 'modulator') {
    const portMod = document.createElement('div');
    portMod.className = 'pe-port pe-port-mod-out';
    portMod.dataset.portType = 'mod-out';
    portMod.dataset.portModuleId = id;
    portMod.tabIndex = 0;
    portMod.setAttribute('role', 'button');
    portMod.setAttribute('aria-label', `${id} modulation output`);
    portMod.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      startDragWire(id, 'mod-out', e);
    });
    node.appendChild(portMod);
  }

  node.onclick = () => { selectedModuleId = id; renderAll(); };
  return node;
}

// ── Wire dragging ────────────────────────────────────────
function startDragWire(fromId, fromType, e) {
  graphEl.classList.add('pe-connecting');
  const svgPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svgPath.setAttribute('class', 'pe-wire-drag');
  wiresSvg.appendChild(svgPath);

  const fromNode = innerEl.querySelector(`[data-module-id="${fromId}"]`);
  const fromPort = fromNode.querySelector(fromType === 'audio-out' ? '.pe-port-out' : '.pe-port-mod-out');
  const fromRect = fromPort.getBoundingClientRect();
  const innerRect = innerEl.getBoundingClientRect();
  const x1 = (fromRect.left + fromRect.width / 2 - innerRect.left) / graphScale;
  const y1 = (fromRect.top + fromRect.height / 2 - innerRect.top) / graphScale;

  dragWire = { fromId, fromType, svgPath, x1, y1 };

  const onMove = (ev) => {
    const x2 = (ev.clientX - innerRect.left) / graphScale;
    const y2 = (ev.clientY - innerRect.top) / graphScale;
    const midY = (y1 + y2) / 2;
    svgPath.setAttribute('d', `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`);
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    svgPath.remove();
    graphEl.classList.remove('pe-connecting');
    dragWire = null;
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function finishSignalConnection(toId) {
  if (!dragWire || dragWire.fromType !== 'audio-out') return;
  if (dragWire.fromId === toId) return;
  // Avoid duplicate
  const exists = patchDef.routing.some(([s, d]) => s === dragWire.fromId && d === toId);
  if (!exists) {
    patchDef.routing.push([dragWire.fromId, toId]);
    commitPatch();
    renderAll();
  }
}

function finishModConnection(targetDst) {
  if (!dragWire || dragWire.fromType !== 'mod-out') return;
  if (!patchDef.matrix) patchDef.matrix = [];
  const exists = patchDef.matrix.some(m => m.src === dragWire.fromId && m.dst === targetDst);
  if (!exists) {
    const dotIdx = targetDst.indexOf('.');
    const tId = targetDst.slice(0, dotIdx);
    const tParam = targetDst.slice(dotIdx + 1);
    const tDef = patchDef.modules[tId];
    const tMeta = tDef ? getParamMeta(tDef.type, tParam) : {};
    const defaultDepth = ((tMeta.max ?? 1) - (tMeta.min ?? 0)) * 0.3;
    patchDef.matrix.push({ src: dragWire.fromId, dst: targetDst, depth: defaultDepth });
    commitPatch();
    renderAll();
  }
}

// ── Draw wires ───────────────────────────────────────────
function drawWires() {
  if (!wiresSvg || !innerEl) return;
  wiresSvg.innerHTML = '';

  const getPortCenter = (moduleId, portClass) => {
    const node = innerEl.querySelector(`[data-module-id="${moduleId}"]`);
    if (!node) return null;
    const port = node.querySelector(portClass);
    if (!port) return null;
    const nr = node.getBoundingClientRect();
    const pr = port.getBoundingClientRect();
    const ir = innerEl.getBoundingClientRect();
    return { x: (pr.left + pr.width / 2 - ir.left) / graphScale, y: (pr.top + pr.height / 2 - ir.top) / graphScale };
  };

  // Signal wires
  for (const [srcId, dstId] of patchDef.routing) {
    const from = getPortCenter(srcId, '.pe-port-out');
    const to = getPortCenter(dstId, '.pe-port-in');
    if (!from || !to) continue;
    const midY = (from.y + to.y) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${from.x},${from.y} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y}`);
    path.setAttribute('class', 'pe-wire-signal');
    wiresSvg.appendChild(path);
  }

  // Mod wires
  (patchDef.matrix || []).forEach((mod, i) => {
    const from = getPortCenter(mod.src, '.pe-port-mod-out');
    const knobEl = innerEl.querySelector(`[data-target="${mod.dst}"]`);
    if (!from || !knobEl) return;
    const kr = knobEl.getBoundingClientRect();
    const ir = innerEl.getBoundingClientRect();
    const to = { x: (kr.left + kr.width / 2 - ir.left) / graphScale, y: (kr.top + kr.height / 2 - ir.top) / graphScale };
    const midX = (from.x + to.x) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${from.x},${from.y} C${midX},${from.y} ${midX},${to.y} ${to.x},${to.y}`);
    path.setAttribute('class', 'pe-wire-mod');
    path.setAttribute('stroke', modColors[i % modColors.length]);
    wiresSvg.appendChild(path);
  });
}

// ── Bottom bar (mod depth controls) ──────────────────────
function renderBottomBar() {
  if (!bottomBar) return;
  bottomBar.innerHTML = '';

  if (!(patchDef.matrix?.length > 0)) return;

  const label = document.createElement('span');
  label.className = 'pe-bar-label';
  label.textContent = 'mod';
  bottomBar.appendChild(label);

  patchDef.matrix.forEach((mod, idx) => {
    const chip = document.createElement('div');
    chip.className = 'pe-mod-chip';

    const src = document.createElement('span');
    src.className = 'pe-mod-src'; src.textContent = mod.src;
    const arrow = document.createElement('span');
    arrow.className = 'pe-mod-arrow'; arrow.textContent = '→';
    const dst = document.createElement('span');
    dst.className = 'pe-mod-dst'; dst.textContent = mod.dst;

    const dotIdx = mod.dst.indexOf('.');
    const tId = mod.dst.slice(0, dotIdx);
    const tParam = mod.dst.slice(dotIdx + 1);
    const tDef = patchDef.modules[tId];
    const tMeta = tDef ? getParamMeta(tDef.type, tParam) : {};
    const depthMax = tMeta.max ?? 10000;

    const depthBar = document.createElement('div');
    depthBar.className = 'pe-mod-depth';
    const depthFill = document.createElement('div');
    depthFill.className = 'pe-mod-depth-fill';
    depthFill.style.width = `${(Math.abs(mod.depth) / depthMax) * 100}%`;
    depthBar.appendChild(depthFill);

    const depthVal = document.createElement('span');
    depthVal.className = 'pe-mod-depth-val';
    depthVal.textContent = fmt(mod.depth);

    depthBar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX, startD = mod.depth;
      const onMove = (ev) => {
        mod.depth = Math.max(0, Math.min(depthMax, startD + (ev.clientX - startX) * (depthMax / 200)));
        depthFill.style.width = `${(mod.depth / depthMax) * 100}%`;
        depthVal.textContent = fmt(mod.depth);
        commitPatch();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        renderAll();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'pe-mod-remove'; removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', `Remove modulation from ${mod.src} to ${mod.dst}`);
    removeBtn.onclick = () => { patchDef.matrix.splice(idx, 1); commitPatch(); renderAll(); };

    chip.append(src, arrow, dst, depthBar, depthVal, removeBtn);
    bottomBar.appendChild(chip);
  });
}

// ── Render all ───────────────────────────────────────────
function renderAll() {
  if (!innerEl) return;
  innerEl.innerHTML = '';

  // Wires SVG
  wiresSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wiresSvg.setAttribute('class', 'pe-wires');
  wiresSvg.style.overflow = 'visible';
  innerEl.appendChild(wiresSvg);

  // Module nodes
  for (const id of Object.keys(patchDef.modules)) {
    innerEl.appendChild(createNode(id));
  }

  renderBottomBar();

  // Draw wires after DOM layout
  requestAnimationFrame(() => drawWires());
}

// ── Module palette ────────────────────────────────────────
function addModule(module, graphX, graphY) {
  const id = nextId(module.type);
  const defaults = {};
  if (module.params) {
    for (const [key, value] of Object.entries(module.params)) {
      if (value.default != null) defaults[key] = value.default;
    }
  }
  patchDef.modules[id] = { type: module.type, params: defaults };
  if (!patchDef.positions) patchDef.positions = {};
  patchDef.positions[id] = { x: graphX, y: graphY };
  commitPatch();
  renderAll();
  closeContextMenu();
}

function addMacro(macro, graphX, graphY) {
  insertPatchMacro(patchDef, macro.id, { x: graphX, y: graphY }, nextId);
  commitPatch();
  renderAll();
  closeContextMenu();
  showToast(`Added ${macro.name} subgraph`);
}

function showContextMenu(x, y, graphX, graphY) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'pe-context-menu';
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Add synth module');

  const modules = listModules();
  const macros = listPatchMacros();
  const search = document.createElement('input');
  search.className = 'pe-menu-search';
  search.type = 'search';
  search.placeholder = 'Find a module';
  search.setAttribute('aria-label', 'Find a synth module');
  const results = document.createElement('div');
  menu.append(search, results);

  const renderModules = (query = '') => {
    results.replaceChildren();
    const matchingMacros = macros.filter((macro) => macro.name.includes(query.toLowerCase()));
    if (matchingMacros.length) {
      const macroHeading = document.createElement('div');
      macroHeading.className = 'pe-menu-cat'; macroHeading.textContent = 'subgraphs';
      results.appendChild(macroHeading);
      matchingMacros.forEach((macro) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'pe-menu-item pe-menu-macro';
        item.textContent = macro.name;
        item.onclick = () => addMacro(macro, graphX, graphY);
        results.appendChild(item);
      });
    }
    const filtered = modules.filter((module) => module.type.toLowerCase().includes(query.toLowerCase()));
    const cats = {};
    filtered.forEach((module) => (cats[module.category || 'other'] = cats[module.category || 'other'] || []).push(module));
    for (const [cat, items] of Object.entries(cats)) {
      const catEl = document.createElement('div');
      catEl.className = 'pe-menu-cat'; catEl.textContent = cat;
      results.appendChild(catEl);
      items.forEach((module) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'pe-menu-item'; item.textContent = module.type;
        item.onclick = () => addModule(module, graphX, graphY);
        results.appendChild(item);
      });
    }
  };
  search.addEventListener('input', () => renderModules(search.value));
  renderModules();

  document.body.appendChild(menu);
  const close = (e) => { if (!menu.contains(e.target)) { closeContextMenu(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
  menu._closeListener = close;
  search.focus();
}

function closeContextMenu() {
  document.querySelectorAll('.pe-context-menu').forEach(el => {
    if (el._closeListener) document.removeEventListener('mousedown', el._closeListener);
    el.remove();
  });
}

// ── Build overlay ────────────────────────────────────────
function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'patch-editor';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Patch studio');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePatchEditor(); });

  const panel = document.createElement('div');
  panel.className = 'pe-panel';

  // Header
  const header = document.createElement('div');
  header.className = 'pe-header';
  const patchSelect = document.createElement('select');
  patchSelect.className = 'pe-select';
  patchSelect.setAttribute('aria-label', 'Current synth patch');
  const dirty = document.createElement('span');
  dirty.className = 'pe-dirty';
  dirty.textContent = 'Saved';
  const addBtn = document.createElement('button');
  addBtn.className = 'pe-btn pe-btn-accent'; addBtn.textContent = 'add module';
  addBtn.onclick = () => {
    const rect = addBtn.getBoundingClientRect();
    const graphRect = graphEl.getBoundingClientRect();
    const graphX = (graphEl.clientWidth / 2 - panX) / graphScale;
    const graphY = (graphEl.clientHeight / 2 - panY) / graphScale;
    showContextMenu(rect.left, Math.min(rect.bottom + 6, graphRect.bottom - 320), graphX, graphY);
  };
  const undoBtn = document.createElement('button');
  undoBtn.className = 'pe-btn'; undoBtn.textContent = 'undo'; undoBtn.dataset.action = 'undo'; undoBtn.onclick = undoPatch;
  const redoBtn = document.createElement('button');
  redoBtn.className = 'pe-btn'; redoBtn.textContent = 'redo'; redoBtn.dataset.action = 'redo'; redoBtn.onclick = redoPatch;
  const spacer = document.createElement('div');
  spacer.className = 'pe-spacer';
  const zoomOut = document.createElement('button');
  zoomOut.className = 'pe-btn pe-btn-square'; zoomOut.textContent = '−'; zoomOut.setAttribute('aria-label', 'Zoom out'); zoomOut.onclick = () => setGraphScale(graphScale - 0.1);
  const zoomReadout = document.createElement('span');
  zoomReadout.className = 'pe-zoom-readout'; zoomReadout.textContent = `${Math.round(graphScale * 100)}%`;
  const zoomIn = document.createElement('button');
  zoomIn.className = 'pe-btn pe-btn-square'; zoomIn.textContent = '+'; zoomIn.setAttribute('aria-label', 'Zoom in'); zoomIn.onclick = () => setGraphScale(graphScale + 0.1);
  const fitBtn = document.createElement('button');
  fitBtn.className = 'pe-btn'; fitBtn.textContent = 'fit'; fitBtn.onclick = fitGraph;
  const saveBtn = document.createElement('button');
  saveBtn.className = 'pe-btn'; saveBtn.textContent = 'save';
  saveBtn.onclick = savePatch;
  const saveAsBtn = document.createElement('button');
  saveAsBtn.className = 'pe-btn'; saveAsBtn.textContent = 'save as';
  saveAsBtn.onclick = saveAsPatch;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'pe-btn pe-btn-close'; closeBtn.textContent = '×';
  closeBtn.onclick = closePatchEditor;
  header.append(patchSelect, dirty, addBtn, undoBtn, redoBtn, spacer, zoomOut, zoomReadout, zoomIn, fitBtn, saveBtn, saveAsBtn, closeBtn);

  // Graph area
  graphEl = document.createElement('div');
  graphEl.className = 'pe-graph';

  innerEl = document.createElement('div');
  innerEl.className = 'pe-graph-inner';
  applyGraphTransform();
  graphEl.appendChild(innerEl);

  // Pan by dragging background
  graphEl.addEventListener('mousedown', (e) => {
    if (e.target !== graphEl) return;
    e.preventDefault();
    graphEl.classList.add('panning');
    const startX = e.clientX - panX, startY = e.clientY - panY;
    const onMove = (ev) => {
      panX = ev.clientX - startX; panY = ev.clientY - startY;
      applyGraphTransform();
    };
    const onUp = () => {
      graphEl.classList.remove('panning');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  graphEl.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = graphEl.getBoundingClientRect();
    setGraphScale(graphScale + (event.deltaY < 0 ? 0.1 : -0.1), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  // Right-click to add module
  graphEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const ir = innerEl.getBoundingClientRect();
    showContextMenu(e.clientX, e.clientY, (e.clientX - ir.left) / graphScale, (e.clientY - ir.top) / graphScale);
  });

  // Hint
  const hint = document.createElement('div');
  hint.className = 'pe-hint';
  hint.textContent = 'add module or right-click · drag ports to connect · ctrl-scroll to zoom';
  graphEl.appendChild(hint);

  // Bottom bar
  bottomBar = document.createElement('div');
  bottomBar.className = 'pe-bottom-bar';

  // Mini keyboard
  const keyboard = createKeyboard();

  panel.append(header, graphEl, bottomBar, keyboard);
  overlay.appendChild(panel);

  overlay.tabIndex = 0;
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePatchEditor();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redoPatch() : undoPatch();
      return;
    }
    trapFocus(overlay, e);
    if (e.target.closest('input, select, button, [contenteditable="true"]')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedModuleId && patchDef.modules[selectedModuleId]) {
        delete patchDef.modules[selectedModuleId];
        delete patchDef.positions?.[selectedModuleId];
        patchDef.routing = patchDef.routing.filter(([s, d]) => s !== selectedModuleId && d !== selectedModuleId);
        patchDef.matrix = (patchDef.matrix || []).filter(m => m.src !== selectedModuleId && !m.dst.startsWith(selectedModuleId + '.'));
        selectedModuleId = null;
        commitPatch(); renderAll();
      }
    }
  });

  loadPatchList(patchSelect);
  updateHistoryButtons();
  return overlay;
}

// ── Patch load/save ──────────────────────────────────────
async function loadPatchList(selectEl) {
  try {
    const patches = await listPatches();
    selectEl.innerHTML = patches.map(p =>
      `<option value="${p.name}"${p.name === currentPatchName ? ' selected' : ''}>${p.name}</option>`
    ).join('');
    selectEl.onchange = () => loadPatch(selectEl.value);
    if (!currentPatchName && patches.length > 0) loadPatch(patches[0].name);
    else if (currentPatchName) loadPatch(currentPatchName);
  } catch { selectEl.innerHTML = '<option>no patches</option>'; }
}

async function loadPatch(name) {
  if (patchDirty && currentPatchName && name !== currentPatchName && !(await confirmDialog({
    title: 'Discard patch changes?',
    message: `Discard unsaved changes to “${currentPatchName}”?`,
    confirmLabel: 'Discard',
    danger: true,
  }))) {
    const select = overlayEl?.querySelector('.pe-select');
    if (select) select.value = currentPatchName;
    return;
  }
  try {
    const data = await readPatch(name);
    patchDef = data;
    currentPatchName = name;
    selectedModuleId = null;
    // Register under filename so the keyboard can play it
    registerPatch(name, patchDef);
    autoLayout();
    resetHistory();
    setPatchDirty(false);
    renderAll();
    requestAnimationFrame(fitGraph);
  } catch (e) { console.warn('[patch-editor] Failed to load:', name, e); }
}

async function savePatch() {
  if (!patchDef || !currentPatchName) return;
  try {
    await writePatch(currentPatchName, patchDef);
    setPatchDirty(false);
    showToast(`Saved patch ${currentPatchName}`);
  } catch (error) {
    setPatchDirty(true);
    showToast(`Patch save failed: ${error.message}`);
  }
}

async function saveAsPatch() {
  const name = await promptDialog({ title: 'Save patch as', label: 'Patch name', confirmLabel: 'Save' });
  if (!name) return;
  patchDef.name = name; currentPatchName = name;
  await savePatch();
  registerPatch(name, patchDef);
  const sel = overlayEl?.querySelector('.pe-select');
  if (sel) loadPatchList(sel);
}

// ── Mini keyboard ────────────────────────────────────────
function createKeyboard() {
  const kb = document.createElement('div');
  kb.className = 'pe-keyboard';

  // 2 octaves: C3-B4
  const notes = [
    { note: 48, name: 'C', black: false },
    { note: 49, name: 'C#', black: true },
    { note: 50, name: 'D', black: false },
    { note: 51, name: 'D#', black: true },
    { note: 52, name: 'E', black: false },
    { note: 53, name: 'F', black: false },
    { note: 54, name: 'F#', black: true },
    { note: 55, name: 'G', black: false },
    { note: 56, name: 'G#', black: true },
    { note: 57, name: 'A', black: false },
    { note: 58, name: 'A#', black: true },
    { note: 59, name: 'B', black: false },
    { note: 60, name: 'C', black: false },
    { note: 61, name: 'C#', black: true },
    { note: 62, name: 'D', black: false },
    { note: 63, name: 'D#', black: true },
    { note: 64, name: 'E', black: false },
    { note: 65, name: 'F', black: false },
    { note: 66, name: 'F#', black: true },
    { note: 67, name: 'G', black: false },
    { note: 68, name: 'G#', black: true },
    { note: 69, name: 'A', black: false },
    { note: 70, name: 'A#', black: true },
    { note: 71, name: 'B', black: false },
  ];

  notes.forEach(({ note, name, black }) => {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = black ? 'pe-key pe-key-black' : 'pe-key pe-key-white';
    key.setAttribute('aria-label', `Play ${name}${note < 60 ? '3' : '4'}`);

    const playNote = () => {
      if (!currentPatchName) return;
      const ac = getAudioContext();
      const t = ac.currentTime + 0.01;
      superdough({ s: currentPatchName, note, gain: 0.7 }, t, 0.3);
      key.classList.add('active');
      setTimeout(() => key.classList.remove('active'), 200);
    };

    key.addEventListener('mousedown', (e) => { e.preventDefault(); playNote(); });
    key.addEventListener('mouseenter', (e) => { if (e.buttons === 1) playNote(); });
    kb.appendChild(key);
  });

  // Computer keyboard mapping (bottom two rows)
  const keyMap = {
    'a': 48, 'w': 49, 's': 50, 'e': 51, 'd': 52, 'f': 53,
    't': 54, 'g': 55, 'y': 56, 'h': 57, 'u': 58, 'j': 59,
    'k': 60, 'o': 61, 'l': 62, 'p': 63, ';': 64,
  };
  const activeKeys = new Set();

  kb.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const note = keyMap[e.key.toLowerCase()];
    if (note && !activeKeys.has(e.key)) {
      activeKeys.add(e.key);
      const ac = getAudioContext();
      superdough({ s: currentPatchName, note, gain: 0.7 }, ac.currentTime + 0.01, 0.3);
    }
  });

  kb.addEventListener('keyup', (e) => {
    activeKeys.delete(e.key);
  });

  kb.tabIndex = 0;
  return kb;
}

// ── Public API ───────────────────────────────────────────
export async function showPatchEditor() {
  if (overlayEl && !(await closePatchEditor())) return;
  previousFocus = document.activeElement;
  overlayEl = buildOverlay();
  document.body.appendChild(overlayEl);
  overlayEl.focus();
}

export async function closePatchEditor() {
  if (overlayEl) {
    if (patchDirty) {
      if (!(await confirmDialog({
        title: 'Discard patch changes?',
        message: `Discard unsaved changes to “${currentPatchName || 'this patch'}”?`,
        confirmLabel: 'Discard',
        danger: true,
      }))) return false;
      clearTimeout(commitTimeout);
      clearTimeout(historyTimeout);
      try {
        patchDef = await readPatch(currentPatchName);
        registerPatch(currentPatchName, patchDef);
      } catch {}
      setPatchDirty(false);
    }
    closeContextMenu();
    overlayEl.remove();
    overlayEl = null;
    graphEl = innerEl = wiresSvg = bottomBar = null;
    if (previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
  }
  return true;
}

export async function togglePatchEditor() {
  if (overlayEl) return closePatchEditor();
  return showPatchEditor();
}
