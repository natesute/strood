import { StrudelMirror, initEditor, compartments, extensions } from '@strudel/codemirror';
import {
  getAudioContext,
  webaudioOutput,
  initAudio,
  registerSynthSounds,
  samples,
} from '@strudel/webaudio';
import { transpiler } from '@strudel/transpiler';
import { evalScope } from '@strudel/core';
import { toggleLineComment } from '@codemirror/commands';
import { Prec, StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import {
  ApiError,
  listSongs,
  readSong,
  writeSong,
  removeSong,
  renameSong,
  listSongHistory,
  readSongHistory,
} from './src/api.js';
import { saveRecoverySnapshot, listRecoverySnapshots, clearRecoverySnapshots } from './src/recovery.js';
import { parseTracks, routeTracksForPlayback } from './src/tracks.js';
import { ensureMasterEngine, readMasterMeter } from './src/audio-engine.js';
import { inlineControlExtensions } from './src/inline-controls.js';
import { parseSections, sectionAtCycle, nextCycleTiming } from './src/song-metadata.js';
import { loadSamplePacks } from './src/sample-loader.js';
import { choiceDialog, confirmDialog, promptDialog } from './src/dialogs.js';
import { createVisualizerModeController } from './src/visualizer-modes.js';
import { openPatchEditor, prepareOptionalSystems } from './src/optional-systems.js';
import { describeError, inferErrorLine, showToast, trapFocus } from './src/ui.js';
import initialSongCode from './songs/ms jackson.strudel?raw';

const editorsContainer = document.getElementById('editors-container');
const secondaryEditors = [];
let lastEvalCode = ''; // last evaluated combined code, for location analysis
let syncingEditors = false;

/* ── Live file sync ─────────────────────────────────────── */
let currentSongName = null;
let currentSongVersion = null;
let lastSavedCode = '';
let documentDirty = false;
let pendingExternalUpdate = null;
let recoveryTimer = 0;
let currentSections = [];
let queuedUpdateTimer = 0;
let queuedTargetCycle = null;
let audioReadyPromise = null;
let activeAudioContext = null;
let audioStateListener = null;

function audioIsRunning() {
  return activeAudioContext?.state === 'running';
}

function bindAudioContext(context) {
  if (activeAudioContext === context) return;
  if (activeAudioContext && audioStateListener) {
    activeAudioContext.removeEventListener('statechange', audioStateListener);
  }
  activeAudioContext = context;
  audioStateListener = () => {
    updateMode();
    if (isPlaying && !document.hidden && ['suspended', 'interrupted'].includes(context.state)) {
      context.resume().then(updateMode).catch(() => {});
    }
  };
  context.addEventListener('statechange', audioStateListener);
}

async function ensureAudioReady() {
  if (!audioReadyPromise) {
    audioReadyPromise = initAudio().catch((error) => {
      audioReadyPromise = null;
      throw error;
    });
  }
  await audioReadyPromise;
  const context = getAudioContext();
  bindAudioContext(context);
  if (context.state !== 'running') await context.resume();
  if (context.state !== 'running') {
    throw new Error(`Audio could not resume (${context.state}). Click Resume to try again.`);
  }
  return context;
}

let _saveTimer = 0;
function debouncedSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = 0;
    localStorage.setItem('strudel_code', getAllCode());
    updateDocumentState();
    clearTimeout(recoveryTimer);
    recoveryTimer = window.setTimeout(() => {
      if (documentDirty) saveRecoverySnapshot(currentSongName, getAllCode(), 'autosave');
    }, 8000);
  }, 300);
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

/* ── Note onset flash (white outline on first frame) ────── */
const activeHapIds = new Set();
const onsetTimestamps = new Map(); // uid -> performance.now() when onset detected
const currentHapIds = new Set();
const currentRippleIds = new Set();
const ONSET_FLASH_MS = 50;

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

const setErrorLine = StateEffect.define();
const errorLineField = StateField.define({
  create() { return Decoration.none; },
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorLine)) continue;
      if (effect.value == null) return Decoration.none;
      const position = Math.min(effect.value, transaction.state.doc.length);
      return Decoration.set([
        Decoration.line({ class: 'cm-error-line' }).range(transaction.state.doc.lineAt(position).from),
      ]);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/* ── Statusline ─────────────────────────────────────────── */
const modeEl = document.getElementById('mode');
const infoEl = document.getElementById('info');
const dirtyCountEl = document.getElementById('dirty-count');
const songNameEl = document.getElementById('song-name');
const saveStateEl = document.getElementById('save-state');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const bootStatusEl = document.getElementById('boot-status');
const diagnosticsEl = document.getElementById('diagnostics');
const diagnosticMessageEl = document.getElementById('diagnostic-message');
const masterLevelEl = document.getElementById('master-level');
const masterPeakEl = document.getElementById('master-peak');
const limiterStateEl = document.getElementById('limiter-state');
const cycleStatusEl = document.getElementById('cycle-status');
const sectionStatusEl = document.getElementById('section-status');
const queueStatusEl = document.getElementById('queue-status');
let isPlaying = false;
let currentCols = 1;

function updateMode() {
  const audioPaused = isPlaying && !audioIsRunning();
  modeEl.textContent = audioPaused ? 'AUDIO PAUSED' : (isPlaying ? 'PLAYING' : 'STOPPED');
  modeEl.className = isPlaying && !audioPaused ? 'playing' : 'stopped';
  runBtn.classList.toggle('playing', isPlaying && !audioPaused);
  runBtn.querySelector('span').textContent = audioPaused ? 'Resume' : (isPlaying ? 'Update' : 'Run');
  if (!isPlaying) clearQueuedUpdate();
}

function setSaveState(label, state = '') {
  saveStateEl.textContent = label;
  saveStateEl.className = `save-state ${state}`.trim();
}

function updateDocumentState() {
  const code = getAllCode();
  documentDirty = code !== lastSavedCode;
  songNameEl.textContent = currentSongName || 'Untitled';
  setSaveState(documentDirty ? 'Unsaved' : (currentSongName ? 'Saved' : 'Ready'), documentDirty ? 'unsaved' : (currentSongName ? 'saved' : ''));
  window.onbeforeunload = documentDirty ? () => true : null;
}

function clearDiagnostic() {
  diagnosticsEl.hidden = true;
  diagnosticMessageEl.textContent = '';
  [editor.editor, ...secondaryEditors.map((entry) => entry.view)].forEach((view) => {
    view.dispatch({ effects: setErrorLine.of(null) });
  });
}

function showDiagnostic(error) {
  const location = inferErrorLine(error);
  diagnosticMessageEl.textContent = describeError(error);
  diagnosticsEl.hidden = false;
  if (location) {
    const line = Math.max(1, Math.min(location.line, editor.editor.state.doc.lines));
    const position = editor.editor.state.doc.line(line).from;
    [editor.editor, ...secondaryEditors.map((entry) => entry.view)].forEach((view) => {
      view.dispatch({ effects: setErrorLine.of(position) });
    });
    editor.editor.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
  }
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
  dirtyCountEl.textContent = count > 0 ? `${count} changed` : '';
}

// Dirty count updated on change via listener (see below), not polled

/* ── Prebake ────────────────────────────────────────────── */
async function prebake() {
  bootStatusEl.textContent = 'Preparing audio engine…';
  await evalScope(
    evalScope,
    import('@strudel/core'),
    import('@strudel/draw'),
    import('@strudel/mini'),
    import('@strudel/tonal'),
    import('@strudel/webaudio'),
  );
  await registerSynthSounds();
  ensureMasterEngine();
  bootStatusEl.textContent = 'Synths ready · loading required samples…';
  const [, result] = await Promise.all([
    prepareOptionalSystems(getAllCode()),
    loadSamplePacks(getAllCode(), samples),
  ]);
  bootStatusEl.textContent = result.failed
    ? `Audio ready · ${result.failed} sample pack${result.failed === 1 ? '' : 's'} unavailable`
    : 'Audio ready';
  if (result.failed) showToast('Some remote samples are unavailable. Built-in synths still work.');
}

/* ── StrudelMirror ──────────────────────────────────────── */
const editor = new StrudelMirror({
  root: document.getElementById('editor'),
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  initialCode: localStorage.getItem('strudel_code') ?? initialSongCode,
  drawTime: [-2, 2],
  prebake,
  onUpdateState: (state) => {
    isPlaying = state.started;
    updateMode();
  },
  onError: (error) => {
    console.error(error);
    showDiagnostic(error);
    setSaveState('Run failed', 'failed');
  },
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

let wrapEnabled = true;
const cursorStatusListener = EditorView.updateListener.of((viewUpdate) => {
  const position = viewUpdate.state.selection.main.head;
  const line = viewUpdate.state.doc.lineAt(position);
  infoEl.textContent = `${line.number}:${position - line.from + 1}`;
});
const documentChangeListener = EditorView.updateListener.of((viewUpdate) => {
  if (!viewUpdate.docChanged) return;
  syncDocumentChanges(editor.editor, viewUpdate.transactions);
  debouncedSave();
  updateDirtyCount();
});

editor.editor.dispatch({
  effects: [
    StateEffect.appendConfig.of([
      customThemeColors,
      Prec.highest(syntaxHighlighting(customHighlight)),
      dirtyLineField,
      errorLineField,
      ...inlineControlExtensions,
      cursorStatusListener,
      documentChangeListener,
    ]),
    compartments.isLineWrappingEnabled.reconfigure(extensions.isLineWrappingEnabled(true)),
  ],
});

/* ── HMR: receive external file changes ────────────────── */
if (import.meta.hot) {
  import.meta.hot.on('strudel:update', ({ code, version }) => {
    if (code === getAllCode()) return;
    if (documentDirty) {
      pendingExternalUpdate = { code, version };
      setSaveState('File changed on disk', 'failed');
      showToast('The song changed on disk. Save to resolve the conflict or reopen it.');
      return;
    }
    replaceAllCode(code);
    lastSavedCode = code;
    currentSongVersion = version || currentSongVersion;
    localStorage.setItem('strudel_code', code);
    updateDocumentState();
    showToast('Updated from disk');
  });
}

/* ── Word Wrap (Ctrl+W) ────────────────────────────────── */

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

/* ── Multi-column (auto-distribute code across panels) ── */
function clearAllDirtyLines() {
  editor.editor.dispatch({ effects: clearDirtyLines.of(null) });
  secondaryEditors.forEach((e) => {
    e.view.dispatch({ effects: clearDirtyLines.of(null) });
  });
}

function clearQueuedUpdate() {
  if (queuedUpdateTimer) window.clearTimeout(queuedUpdateTimer);
  queuedUpdateTimer = 0;
  queuedTargetCycle = null;
  queueStatusEl.textContent = '';
}

async function performEvaluation(allCode, autostart) {
  lastEvalCode = allCode;
  clearDiagnostic();
  editor.flash();
  try {
    const tracks = parseTracks(allCode);
    ensureMasterEngine();
    await Promise.all([
      ensureAudioReady(),
      prepareOptionalSystems(allCode),
      loadSamplePacks(allCode, samples),
    ]);
    const performanceCode = routeTracksForPlayback(allCode, tracks);
    await editor.repl.evaluate(performanceCode, autostart);
    currentSections = parseSections(allCode);
    clearAllDirtyLines();
    updateDocumentState();
  } catch (error) {
    showDiagnostic(error);
    throw error;
  }
}

async function evaluateAll(autostart = true, { immediate = false } = {}) {
  const allCode = getAllCode();
  saveRecoverySnapshot(currentSongName, allCode, 'run');
  if (isPlaying && !immediate) {
    const scheduler = editor.repl.scheduler;
    const now = Number(scheduler.now());
    const cps = Number(scheduler.cps) || 1;
    const timing = nextCycleTiming(now, cps, -12);
    clearQueuedUpdate();
    queuedTargetCycle = timing.targetCycle;
    queueStatusEl.textContent = `queued · cycle ${queuedTargetCycle + 1}`;
    queuedUpdateTimer = window.setTimeout(() => {
      queuedUpdateTimer = 0;
      queuedTargetCycle = null;
      queueStatusEl.textContent = '';
      performEvaluation(allCode, autostart).catch(() => {});
    }, timing.milliseconds);
    return;
  }
  clearQueuedUpdate();
  await performEvaluation(allCode, autostart);
}

function allEditorViews() {
  return [editor.editor, ...secondaryEditors.map((entry) => entry.view)];
}

function syncDocumentChanges(sourceView, transactions) {
  if (syncingEditors) return;
  const changed = transactions.filter((transaction) => transaction.docChanged);
  if (!changed.length) return;
  syncingEditors = true;
  try {
    for (const transaction of changed) {
      for (const target of allEditorViews()) {
        if (target === sourceView) continue;
        target.dispatch({ changes: transaction.changes });
      }
    }
  } finally {
    syncingEditors = false;
  }
}

function replaceAllCode(code) {
  const current = editor.editor.state.doc.toString();
  if (current === code) return;
  editor.editor.dispatch({
    changes: { from: 0, to: current.length, insert: code },
    selection: { anchor: 0 },
  });
}

function createSecondaryEditor(initialCode = editor.code, columnIndex = 1) {
  const panel = document.createElement('div');
  panel.className = 'editor-panel';
  panel.setAttribute('aria-label', `Song code editor, column ${columnIndex + 1}`);
  editorsContainer.appendChild(panel);

  const view = initEditor({
    root: panel,
    initialCode,
    onEvaluate: () => evaluateAll(),
    onStop: () => editor.stop(),
    onChange: (update) => {
      if (update.docChanged) syncDocumentChanges(view, update.transactions);
    },
  });

  view.dispatch({
    effects: [
      StateEffect.appendConfig.of([
        dirtyLineField,
        errorLineField,
        secHighlightField,
        ...inlineControlExtensions,
        customThemeColors,
        Prec.highest(syntaxHighlighting(customHighlight)),
      ]),
      compartments.isLineWrappingEnabled.reconfigure(extensions.isLineWrappingEnabled(wrapEnabled)),
    ],
  });

  view.dom.addEventListener('keydown', onEditorKeydown, { capture: true });
  view.contentDOM.setAttribute('aria-label', `Song code, column ${columnIndex + 1}`);
  view.scrollDOM.tabIndex = 0;
  const entry = { view, root: panel };
  secondaryEditors.push(entry);
  return entry;
}

function setColumnCount(n) {
  const code = getAllCode();
  while (secondaryEditors.length) {
    const removed = secondaryEditors.pop();
    removed.view.destroy();
    removed.root.remove();
  }

  currentCols = n;
  _primaryScroller = null;
  for (let i = 1; i < n; i++) createSecondaryEditor(code, i);

  requestAnimationFrame(() => {
    const views = allEditorViews();
    views.forEach((view, index) => {
      const lineNumber = Math.max(1, Math.ceil((view.state.doc.lines * index) / n));
      const position = view.state.doc.line(lineNumber).from;
      view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'start' }) });
    });
  });
}

createVisualizerModeController(document.getElementById('visualizer-mode'));

let meterFrame = 0;
let masterLevel = -1;
let masterPeak = -1;
let limiterLabel = '';
let transportCycle = '';
let transportSection = '';

function setMeterScale(element, next, previous) {
  const rounded = Math.round(next * 100) / 100;
  if (rounded !== previous) element.style.transform = `scaleX(${rounded})`;
  return rounded;
}

function scheduleMeterUpdate() {
  meterFrame = window.setTimeout(updateMasterMeter, isPlaying ? 50 : 250);
}

function updateMasterMeter() {
  if (document.hidden) {
    meterFrame = 0;
    return;
  }
  let meter = { rmsDb: -Infinity, peakDb: -Infinity, compressionDb: 0, limiterDb: 0 };
  if (audioIsRunning()) {
    try {
      meter = readMasterMeter();
    } catch (_) {}
  }
  const level = Math.max(0, Math.min(1, (meter.rmsDb + 60) / 60));
  const peak = Math.max(0, Math.min(1, (meter.peakDb + 60) / 60));
  masterLevel = setMeterScale(masterLevelEl, level, masterLevel);
  const peakPercent = Math.round(peak * 100);
  if (peakPercent !== masterPeak) {
    masterPeak = peakPercent;
    masterPeakEl.style.left = `${peakPercent}%`;
  }
  const hot = meter.peakDb > -1.1 || meter.limiterDb < -0.2;
  const nextLimiterLabel = hot ? `lim ${meter.limiterDb.toFixed(1)} dB` : 'safe';
  if (nextLimiterLabel !== limiterLabel) {
    limiterLabel = nextLimiterLabel;
    limiterStateEl.textContent = limiterLabel;
    limiterStateEl.classList.toggle('hot', hot);
  }
  let nextCycle = isPlaying ? (transportCycle || 'cycle 1') : 'cycle 1';
  let nextSection = currentSections[0]?.name || 'loop';
  if (isPlaying && audioIsRunning()) {
    try {
      const cycle = Number(editor.repl.scheduler.now());
      const cycleInSong = currentSections.length
        ? ((Math.floor(cycle) % currentSections.at(-1).end) + currentSections.at(-1).end) % currentSections.at(-1).end
        : Math.floor(cycle);
      const section = sectionAtCycle(currentSections, cycle);
      nextCycle = `cycle ${cycleInSong + 1}`;
      nextSection = section?.name || 'loop';
    } catch (_) {}
  }
  if (nextCycle !== transportCycle) {
    transportCycle = nextCycle;
    cycleStatusEl.textContent = transportCycle;
  }
  if (nextSection !== transportSection) {
    transportSection = nextSection;
    sectionStatusEl.textContent = transportSection;
  }
  scheduleMeterUpdate();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && meterFrame) {
    window.clearTimeout(meterFrame);
    meterFrame = 0;
  } else if (!document.hidden && !meterFrame) {
    updateMasterMeter();
  }
  if (!document.hidden && isPlaying && !audioIsRunning()) {
    ensureAudioReady().then(updateMode).catch(() => updateMode());
  }
});

/* ── Ripples (canvas-based, one canvas per scroller) ──────── */

const RIPPLE_DURATION = 400; // ms per ripple animation
const rippleCanvases = new Map(); // scroller -> { canvas, ctx, w, h }
const activeRipples = []; // { scroller, x, y, color, gain, startTime }
let rippleRAF = 0; // 0 = not running
const _byScroller = new Map(); // reused each frame to avoid alloc

function getOrCreateRippleCanvas(scroller) {
  let entry = rippleCanvases.get(scroller);
  if (entry) return entry;
  const canvas = document.createElement('canvas');
  canvas.className = 'ripple-canvas';
  scroller.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  entry = { canvas, ctx, w: 0, h: 0 };
  rippleCanvases.set(scroller, entry);
  return entry;
}

/** Sync canvas size to scroller's full scroll extent (only when changed) */
function syncCanvasSize(scroller, entry) {
  const w = scroller.scrollWidth;
  const h = scroller.scrollHeight;
  if (w !== entry.w || h !== entry.h) {
    entry.canvas.width = w;
    entry.canvas.height = h;
    entry.canvas.style.width = w + 'px';
    entry.canvas.style.height = h + 'px';
    entry.w = w;
    entry.h = h;
  }
}

function spawnRipple(scroller, x, y, color, gain) {
  getOrCreateRippleCanvas(scroller);
  activeRipples.push({ scroller, x, y, color, gain, startTime: performance.now() });
  // Start draw loop if not already running
  if (!rippleRAF) rippleRAF = requestAnimationFrame(drawRipples);
}

function drawRipples() {
  rippleRAF = 0;
  const now = performance.now();

  // Group ripples by scroller, prune expired (swap-remove: O(1) per removal)
  _byScroller.clear();
  let i = 0;
  while (i < activeRipples.length) {
    const r = activeRipples[i];
    if (now - r.startTime >= RIPPLE_DURATION) {
      activeRipples[i] = activeRipples[activeRipples.length - 1];
      activeRipples.pop();
      continue;
    }
    if (!_byScroller.has(r.scroller)) _byScroller.set(r.scroller, []);
    _byScroller.get(r.scroller).push(r);
    i++;
  }

  // Draw ripples — canvas covers full scroll extent, only draw near viewport
  for (const [scroller, ripples] of _byScroller) {
    const entry = rippleCanvases.get(scroller);
    if (!entry) continue;
    syncCanvasSize(scroller, entry);
    const ctx = entry.ctx;

    // Visible region for culling
    const vx0 = scroller.scrollLeft - 150;
    const vy0 = scroller.scrollTop - 150;
    const vx1 = vx0 + scroller.clientWidth + 300;
    const vy1 = vy0 + scroller.clientHeight + 300;

    ctx.clearRect(vx0, vy0, vx1 - vx0, vy1 - vy0);

    // Batch ripples by color+lineWidth to minimise state changes
    // Sort by color key so same-color ripples are grouped
    const colorGroups = new Map(); // "color|lineWidth" -> [{x,y,radius,opacity}]
    for (const r of ripples) {
      if (r.x < vx0 || r.x > vx1 || r.y < vy0 || r.y > vy1) continue;

      const t = (now - r.startTime) / RIPPLE_DURATION; // 0→1
      const opacity = 0.4 * (1 - t);
      if (opacity < 0.02) continue; // skip near-invisible ripples

      const g = Math.max(0.1, Math.min(r.gain, 1.5));
      const maxSize = 30 + g * 80;
      const scale = 0.3 + t * 1.2; // 0.3→1.5
      const radius = (maxSize / 2) * scale;
      const border = (4 + g * 4) * (1 - t * 0.5);
      const lw = border | 0; // quantise lineWidth to int for better batching
      const key = r.color + '|' + lw;

      let group = colorGroups.get(key);
      if (!group) { group = { color: r.color, lw, items: [] }; colorGroups.set(key, group); }
      group.items.push({ x: r.x, y: r.y, radius, opacity });
    }

    // Draw each batch: one beginPath + multiple arcs per stroke call
    for (const { color, lw, items } of colorGroups.values()) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;

      // Sub-batch by similar opacity (quantised to 0.05 steps)
      const opacityBuckets = new Map(); // quantised opacity -> [items]
      for (const item of items) {
        const qo = Math.round(item.opacity * 20) / 20;
        let bucket = opacityBuckets.get(qo);
        if (!bucket) { bucket = []; opacityBuckets.set(qo, bucket); }
        bucket.push(item);
      }

      for (const [qo, bucket] of opacityBuckets) {
        ctx.globalAlpha = qo;
        ctx.beginPath();
        for (const item of bucket) {
          ctx.moveTo(item.x + item.radius, item.y);
          ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // Clear canvases that had ripples last frame but don't now
  for (const [scroller, entry] of rippleCanvases) {
    if (!_byScroller.has(scroller)) {
      const ctx = entry.ctx;
      ctx.clearRect(0, 0, entry.w, entry.h);
    }
  }

  // Keep loop alive only while there are active ripples
  if (activeRipples.length > 0) {
    rippleRAF = requestAnimationFrame(drawRipples);
  }
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
let _primaryScroller = null;
const _secScrollerCache = new WeakMap();
const _resolveResult = { scroller: null, x: 0, y: 0 }; // reused object

function resolveHapPosition(loc) {
  try {
    const start = editor.editor.coordsAtPos(loc.start);
    const end = editor.editor.coordsAtPos(loc.end);
    if (start && end) {
      if (!_primaryScroller) _primaryScroller = editor.editor.dom.querySelector('.cm-scroller');
      const cx = (start.left + end.left) / 2;
      const cy = (start.top + start.bottom) / 2;
      const pos = viewportToScroller(_primaryScroller, cx, cy);
      _resolveResult.scroller = _primaryScroller;
      _resolveResult.x = pos.x;
      _resolveResult.y = pos.y;
      return _resolveResult;
    }
  } catch (_) {}
  for (let i = 0; i < secondaryEditors.length; i++) {
    try {
      const secView = secondaryEditors[i].view;
      const start = secView.coordsAtPos(loc.start);
      const end = secView.coordsAtPos(loc.end);
      if (start && end) {
        let scroller = _secScrollerCache.get(secView);
        if (!scroller) { scroller = secView.dom.querySelector('.cm-scroller'); _secScrollerCache.set(secView, scroller); }
        const cx = (start.left + end.left) / 2;
        const cy = (start.top + start.bottom) / 2;
        const pos = viewportToScroller(scroller, cx, cy);
        _resolveResult.scroller = scroller;
        _resolveResult.x = pos.x;
        _resolveResult.y = pos.y;
        return _resolveResult;
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

/** Return true if a location text represents a note or drum trigger */
function isMusicalLocation(text) {
  if (NOTE_RE.test(text)) return true;
  if (text === 't') return true;
  return false;
}

// Cache: location start→end → isMusical result. Invalidated on eval.
let locationClassCache = new Map(); // key: "start:end" → boolean
let locationCacheCode = ''; // tracks which eval the cache belongs to

/** Filter a hap's locations to only musical ones (notes, triggers, sample names) */
function filterMusicalLocations(hap) {
  if (!hap.context?.locations || !lastEvalCode) return hap;

  // Invalidate cache when code changes
  if (lastEvalCode !== locationCacheCode) {
    locationClassCache = new Map();
    locationCacheCode = lastEvalCode;
  }

  // Classify each location (cached)
  const noteLocs = [];
  const sampleLocs = [];
  const sValue = hap.value?.s;

  for (const loc of hap.context.locations) {
    if (loc.start < 0 || loc.end > lastEvalCode.length) continue;
    const key = `${loc.start}:${loc.end}`;
    let cached = locationClassCache.get(key);
    if (cached === undefined) {
      const text = lastEvalCode.slice(loc.start, loc.end);
      cached = { text, isMusical: isMusicalLocation(text) };
      locationClassCache.set(key, cached);
    }
    if (cached.isMusical) {
      noteLocs.push(loc);
    } else if (sValue && cached.text === sValue) {
      sampleLocs.push(loc);
    }
  }

  // If we found notes/triggers, use those (ignore sample name like "sawtooth", "piano")
  // If we found NO notes, the sample name IS the trigger (e.g. "bd", "hh", "sd")
  const filtered = noteLocs.length > 0 ? noteLocs : sampleLocs;
  if (filtered.length === hap.context.locations.length) return hap;
  return { ...hap, context: { ...hap.context, locations: filtered } };
}

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
const liveHaps = new Map(); // uid -> { loc, color, gain, lastEmit }
const RIPPLE_SUSTAIN_INTERVAL = 250; // ms between ripples for held notes

const _origHighlight = editor.highlight.bind(editor);
const HIGHLIGHT_INTERVAL = 33; // ~30fps throttle for highlights
let lastHighlightTime = 0;

/** Stable UID for a hap — avoid per-frame string concat */
function hapUid(hap) {
  return hap.whole.begin * 1e6 + hap.whole.end; // numeric key, no string alloc
}

editor.highlight = function (haps, time) {
  const nowMs = performance.now();

  // Throttle to ~30fps, but always run if there's a new onset
  if (nowMs - lastHighlightTime < HIGHLIGHT_INTERVAL) {
    let hasNewOnset = false;
    for (let i = 0; i < haps.length; i++) {
      const h = haps[i];
      if (h.context?.locations && h.whole && !activeHapIds.has(hapUid(h))) {
        hasNewOnset = true;
        break;
      }
    }
    if (!hasNewOnset) return;
  }
  lastHighlightTime = nowMs;

  // Track onsets — record timestamp when a hap first appears
  currentHapIds.clear();
  for (const hap of haps) {
    if (!hap.context?.locations || !hap.whole) continue;
    const uid = hapUid(hap);
    currentHapIds.add(uid);
    if (!activeHapIds.has(uid)) {
      activeHapIds.add(uid);
      onsetTimestamps.set(uid, nowMs);
    }
  }
  for (const uid of activeHapIds) {
    if (!currentHapIds.has(uid)) {
      activeHapIds.delete(uid);
      onsetTimestamps.delete(uid);
    }
  }

  // Filter to musical locations only, then apply white flash for onsets
  // Reuse the array when possible — only allocate new hap objects for flashing onsets
  let hasFlash = false;
  for (const [uid, ts] of onsetTimestamps) {
    if (nowMs - ts < ONSET_FLASH_MS) { hasFlash = true; break; }
  }

  let mixedHaps;
  if (hasFlash) {
    mixedHaps = haps.map(h => {
      const filtered = filterMusicalLocations(h);
      if (!filtered.whole) return filtered;
      const uid = hapUid(filtered);
      const onsetTime = onsetTimestamps.get(uid);
      if (onsetTime !== undefined && nowMs - onsetTime < ONSET_FLASH_MS) {
        return { ...filtered, value: { ...filtered.value, color: '#ffffff', markcss: 'outline: solid 4px #ffffff' } };
      }
      return filtered;
    });
  } else {
    // No flashes active — avoid allocating a new array if filterMusicalLocations is a no-op for all
    let anyFiltered = false;
    for (let i = 0; i < haps.length; i++) {
      if (filterMusicalLocations(haps[i]) !== haps[i]) { anyFiltered = true; break; }
    }
    if (anyFiltered) {
      mixedHaps = new Array(haps.length);
      for (let i = 0; i < haps.length; i++) mixedHaps[i] = filterMusicalLocations(haps[i]);
    } else {
      mixedHaps = haps; // zero-alloc path: pass through unchanged
    }
  }
  _origHighlight(mixedHaps, time);

  // Distribute highlights to secondary editors
  if (currentCols > 1 && secondaryEditors.length > 0) {
    for (let i = 0; i < secondaryEditors.length; i++) {
      const sec = secondaryEditors[i];
      const docLen = sec.view.state.doc.length;
      const marks = [];
      for (const hap of haps) {
        if (!hap.context?.locations || !hap.whole) continue;
        const color = hap.value?.color ?? 'var(--foreground)';
        const style = hap.value?.markcss || `outline: solid 2px ${color}`;
        for (const loc of hap.context.locations) {
          const from = loc.start;
          const to = loc.end;
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

  // Ripples — onset fires immediately, held notes pulse at slow sustain rate
  const now = performance.now();
  currentRippleIds.clear();

  for (const hap of haps) {
    if (!hap.context?.locations || !hap.whole) continue;
    const noteLoc = findNoteLocation(hap);
    if (!noteLoc) continue;

    const uid = hap.whole.begin * 1e9 + hap.whole.end * 1e3 + noteLoc.start;
    currentRippleIds.add(uid);

    const isNew = !liveHaps.has(uid);
    if (isNew) {
      liveHaps.set(uid, {
        loc: noteLoc,
        color: hap.value?.color ?? 'white',
        gain: hap.value?.gain ?? 0.5,
        lastEmit: 0,
      });
    }

    const e = liveHaps.get(uid);
    // Emit immediately on onset, then at slow sustain rate
    if (isNew || now - e.lastEmit >= RIPPLE_SUSTAIN_INTERVAL) {
      const pos = resolveHapPosition(e.loc);
      if (pos) spawnRipple(pos.scroller, pos.x, pos.y, e.color, e.gain);
      e.lastEmit = now;
    }
  }

  for (const [uid] of liveHaps) {
    if (!currentRippleIds.has(uid)) liveHaps.delete(uid);
  }
};

/* ── Keyboard handler (all shortcuts) ───────────────────── */
async function onEditorKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const handledKeys = ['Enter', 'm', 'w', '1', '2', '3', 'u', '.', 's', 'p', 'o', 'n'];
  if (ctrl && handledKeys.includes(e.key)) e.stopPropagation();

  const view = e.currentTarget.cmView?.view || editor.editor;

  // Ctrl+Enter — evaluate
  if (ctrl && e.key === 'Enter') {
    e.preventDefault();
    evaluateAll().catch(() => {});
    return;
  }

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
    evaluateAll(true, { immediate: true }).catch(() => {});
    return;
  }

  // Ctrl+. — stop
  if (ctrl && e.key === '.') {
    e.preventDefault();
    clearQueuedUpdate();
    editor.stop();
    return;
  }

  // Ctrl+S — save song
  if (ctrl && e.key === 's') {
    e.preventDefault();
    saveSong();
    return;
  }

  // Ctrl+P — toggle patch editor
  if (ctrl && e.key === 'p') {
    e.preventDefault();
    openPatchEditor().catch(showDiagnostic);
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
    await newSong();
    return;
  }
}

/* ── Save / Load songs (file-backed via /api/songs) ──── */
function getAllCode() {
  return editor.editor.state.doc.toString();
}

async function saveSong() {
  const name = currentSongName || await promptDialog({
    title: 'Save song',
    label: 'Song name',
    confirmLabel: 'Save',
  });
  if (!name) return;
  const code = getAllCode();
  setSaveState('Saving…');
  saveRecoverySnapshot(currentSongName || name, code, 'before save');
  try {
    let result;
    try {
      result = await writeSong(name, code, currentSongName === name ? currentSongVersion : null);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'version_conflict') throw error;
      const overwrite = await confirmDialog({
        title: 'Song changed on disk',
        message: 'Save your version over the disk copy? The disk copy will remain in recovery history.',
        confirmLabel: 'Save my version',
        danger: true,
      });
      if (!overwrite) {
        pendingExternalUpdate = { name };
        setSaveState('Conflict unresolved', 'failed');
        return false;
      }
      result = await writeSong(name, code, null);
    }
    currentSongName = name;
    currentSongVersion = result.version;
    lastSavedCode = code;
    pendingExternalUpdate = null;
    localStorage.setItem('strudel_song_name', name);
    localStorage.setItem('strudel_code', code);
    clearRecoverySnapshots(name);
    import.meta.hot?.send('strudel:open', { name, code });
    updateDocumentState();
    showToast(`Saved ${name}`);
    return true;
  } catch (error) {
    setSaveState('Save failed', 'failed');
    showDiagnostic(error);
    return false;
  }
}

function loadSong(code, name = null, version = null, savedCode = code) {
  replaceAllCode(code);
  localStorage.setItem('strudel_code', code);
  if (name) {
    currentSongName = name;
    currentSongVersion = version;
    lastSavedCode = savedCode;
    localStorage.setItem('strudel_song_name', name);
    import.meta.hot?.send('strudel:open', { name, code });
  } else {
    currentSongName = null;
    currentSongVersion = null;
    lastSavedCode = savedCode;
    localStorage.removeItem('strudel_song_name');
  }
  pendingExternalUpdate = null;
  currentSections = parseSections(code);
  clearDiagnostic();
  updateDocumentState();
  closeSongBrowser();
}

async function deleteSong(name) {
  if (!(await confirmDialog({
    title: 'Delete song',
    message: `Move “${name}” to Strood’s recoverable trash?`,
    confirmLabel: 'Move to trash',
    danger: true,
  }))) return;
  try {
    await removeSong(name);
    if (currentSongName === name) loadSong('', null, null, '');
    await showSongBrowser();
    showToast(`${name} moved to trash`);
  } catch (error) { showDiagnostic(error); }
}

let songBrowserEl = null;
let songBrowserPreviousFocus = null;

async function prepareToReplaceCurrent(action) {
  if (!documentDirty) return true;
  const choice = await choiceDialog({
    title: 'Unsaved changes',
    message: `What should Strood do with changes to “${currentSongName || 'Untitled'}” before ${action}?`,
    choices: [
      { value: null, label: 'Cancel' },
      { value: 'save', label: 'Save changes', primary: true },
      { value: 'discard', label: 'Discard', danger: true },
    ],
  });
  if (choice === 'save') return Boolean(await saveSong());
  return choice === 'discard';
}

async function newSong() {
  if (!(await prepareToReplaceCurrent('creating a new song'))) return;
  saveRecoverySnapshot(currentSongName, getAllCode(), 'before new song');
  loadSong('', null, null, '');
  editor.editor.focus();
}

async function openNamedSong(name) {
  if (!(await prepareToReplaceCurrent(`opening “${name}”`))) return;
  try {
    const song = await readSong(name);
    loadSong(song.code, name, song.version, song.code);
  } catch (error) { showDiagnostic(error); }
}

async function restoreSongVersion(name, code) {
  try {
    const current = await readSong(name);
    loadSong(code, name, current.version, current.code);
    setSaveState('Recovered, unsaved', 'unsaved');
    showToast('Recovery opened. Save to make it current.');
  } catch (error) { showDiagnostic(error); }
}

function songAction(label, onClick, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `song-action ${className}`.trim();
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

async function showHistory(panel, name, showList) {
  panel.replaceChildren();
  const header = document.createElement('div');
  header.className = 'song-browser-header';
  const title = document.createElement('div');
  title.className = 'song-title';
  title.textContent = `Recovery · ${name}`;
  const back = songAction('Back', showList);
  header.append(title, back);
  panel.appendChild(header);

  try {
    const [diskHistory, localHistory] = await Promise.all([
      listSongHistory(name),
      Promise.resolve(listRecoverySnapshots(name)),
    ]);
    const versions = [
      ...diskHistory.map((item) => ({ ...item, source: 'disk' })),
      ...localHistory.map((item) => ({ id: item.id, createdAt: item.createdAt, source: 'local', code: item.code })),
    ].sort((a, b) => b.createdAt - a.createdAt);
    if (!versions.length) {
      const empty = document.createElement('p');
      empty.className = 'rail-empty';
      empty.textContent = 'No recovery versions yet.';
      panel.appendChild(empty);
      return;
    }
    versions.forEach((version) => {
      const row = document.createElement('div');
      row.className = 'song-row';
      const label = document.createElement('span');
      label.className = 'song-name';
      label.textContent = new Date(version.createdAt).toLocaleString();
      const source = document.createElement('span');
      source.className = 'song-date';
      source.textContent = version.source === 'disk' ? 'saved version' : 'local recovery';
      const restore = songAction('Open', async () => {
        const code = version.source === 'disk' ? await readSongHistory(name, version.id) : version.code;
        await restoreSongVersion(name, code);
      });
      row.append(label, source, restore);
      panel.appendChild(row);
    });
  } catch (error) { showDiagnostic(error); }
}

async function showSongBrowser() {
  closeSongBrowser();
  const overlay = document.createElement('div');
  overlay.id = 'song-browser';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Saved songs');
  overlay.tabIndex = -1;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSongBrowser(); });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSongBrowser();
    trapFocus(overlay, event);
  });

  const panel = document.createElement('div');
  panel.className = 'song-panel';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  songBrowserEl = overlay;
  songBrowserPreviousFocus = document.activeElement;

  const showList = async () => {
    panel.replaceChildren();
    let songs = [];
    try { songs = await listSongs(); }
    catch (error) { showDiagnostic(error); closeSongBrowser(); return; }

    const header = document.createElement('div');
    header.className = 'song-browser-header';
    const title = document.createElement('div');
    title.className = 'song-title';
    title.textContent = songs.length ? 'Saved songs' : 'No saved songs';
    const search = document.createElement('input');
    search.className = 'song-search';
    search.type = 'search';
    search.placeholder = 'Filter songs';
    search.setAttribute('aria-label', 'Filter saved songs');
    const close = songAction('Close', closeSongBrowser);
    header.append(title, search, close);
    panel.appendChild(header);

    const rows = document.createElement('div');
    panel.appendChild(rows);
    const renderRows = (query = '') => {
      rows.replaceChildren();
      songs.filter((song) => song.name.toLowerCase().includes(query.toLowerCase())).forEach((song) => {
        const row = document.createElement('div');
        row.className = 'song-row';
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'song-name';
        label.textContent = song.name;
        label.addEventListener('click', () => openNamedSong(song.name));
        const date = document.createElement('span');
        date.className = 'song-date';
        date.textContent = new Date(song.mtime).toLocaleDateString();
        const actions = document.createElement('span');
        actions.className = 'song-actions';
        actions.append(
          songAction('History', () => showHistory(panel, song.name, showList)),
          songAction('Duplicate', async () => {
            const copyName = await promptDialog({
              title: 'Duplicate song',
              label: 'New song name',
              value: `${song.name} copy`,
              confirmLabel: 'Duplicate',
            });
            if (!copyName) return;
            try { const source = await readSong(song.name); await writeSong(copyName, source.code); await showList(); }
            catch (error) { showDiagnostic(error); }
          }),
          songAction('Rename', async () => {
            const nextName = await promptDialog({
              title: 'Rename song',
              label: 'Song name',
              value: song.name,
              confirmLabel: 'Rename',
            });
            if (!nextName || nextName === song.name) return;
            try {
              await renameSong(song.name, nextName);
              if (currentSongName === song.name) {
                currentSongName = nextName;
                localStorage.setItem('strudel_song_name', nextName);
                updateDocumentState();
              }
              await showList();
            } catch (error) { showDiagnostic(error); }
          }),
          songAction('Delete', () => deleteSong(song.name), 'danger'),
        );
        row.append(label, date, actions);
        rows.appendChild(row);
      });
    };
    search.addEventListener('input', () => renderRows(search.value));
    renderRows();

    const footer = document.createElement('div');
    footer.className = 'song-new';
    const newButton = document.createElement('button');
    newButton.type = 'button';
    newButton.className = 'control control-primary';
    newButton.textContent = 'New song';
    newButton.addEventListener('click', newSong);
    footer.appendChild(newButton);
    panel.appendChild(footer);
    search.focus();
  };

  await showList();
}

function closeSongBrowser() {
  if (songBrowserEl) { songBrowserEl.remove(); songBrowserEl = null; }
  if (songBrowserPreviousFocus?.isConnected) songBrowserPreviousFocus.focus();
  else editor.editor.focus();
  songBrowserPreviousFocus = null;
}

editor.editor.dom.addEventListener('keydown', onEditorKeydown, { capture: true });
editor.editor.contentDOM.setAttribute('aria-label', 'Song code');
editor.editor.scrollDOM.tabIndex = 0;
editorsContainer.addEventListener('strood:inline-control-commit', () => {
  if (isPlaying) evaluateAll().catch(() => {});
});
document.getElementById('diagnostic-close').addEventListener('click', clearDiagnostic);
runBtn.addEventListener('click', () => {
  if (isPlaying && !audioIsRunning()) {
    ensureAudioReady().then(updateMode).catch(showDiagnostic);
    return;
  }
  evaluateAll().catch(() => {});
});
stopBtn.addEventListener('click', () => { clearQueuedUpdate(); editor.stop(); });
document.getElementById('save-btn').addEventListener('click', saveSong);
document.getElementById('open-btn').addEventListener('click', showSongBrowser);
document.getElementById('new-btn').addEventListener('click', newSong);
document.getElementById('patch-btn').addEventListener('click', () => openPatchEditor().catch(showDiagnostic));
songNameEl.addEventListener('click', showSongBrowser);
updateMode();
updateMasterMeter();

/* ── Startup: restore last synced song from disk ────────── */
(async () => {
  const songName = localStorage.getItem('strudel_song_name') || 'ms jackson';
  try {
    const song = await readSong(songName);
    loadSong(song.code, songName, song.version, song.code);
  } catch (error) {
    lastSavedCode = '';
    currentSongName = null;
    currentSongVersion = null;
    updateDocumentState();
    if (!(error instanceof ApiError) || error.status !== 404) showDiagnostic(error);
  }
})();
