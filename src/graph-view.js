import {
  VISUALIZER_METHODS,
  addVisualizer,
  attachVisualizer,
  buildSongGraph,
  findArrangementEntries,
  parseDeclarations,
  removeVisualizer,
  resolveGraphActivity,
  toggleTrackMute,
  toggleTrackSolo,
} from './graph-model.js';
import { createOrthogonalRouter, orthogonalPath } from './orthogonal-router.js';
import { parseSections, sectionAtCycle, setSelectedSongSection } from './song-metadata.js';

const TRACK_WIDTH = 190;
const TRACK_HEIGHT = 140;
const NOTES_WIDTH = 330;
const NOTES_HEIGHT = 172;
const CLUSTER_GAP = 18;
const NODE_GAP = 10;
const NOTE_COLUMN_OFFSET = TRACK_WIDTH + 10;
const GRAPH_PADDING_X = 18;
const GRAPH_PADDING_Y = 24;
const LAYOUT_PREFIX = 'strood:graph-layout:v9:';
const VIEW_KEY = 'strood:workspace-view';
const VISUALIZERS_KEY = 'strood:visualizers-enabled';
const MIN_GRAPH_SCALE = .18;
const MAX_GRAPH_SCALE = 2.4;
const GRAPH_STAGE_PADDING = 12;
const GRAPH_ONSET_FLASH_MS = 40;
const GRAPH_STACCATO_HOLD_MS = 180;
const GRAPH_SUSTAIN_GRACE_MS = 90;
const MUSICAL_TOKEN = /(?:^|[^A-Za-z0-9_])([a-gA-G](?:s|f|b|#)?\d+|t|bd|sd|hh|oh|cp|clap|rim|cr|rd)(?=$|[^A-Za-z0-9_])/g;

function storageKey(songKey) {
  return `${LAYOUT_PREFIX}${encodeURIComponent(songKey || 'Untitled')}`;
}

function readLayout(songKey) {
  try {
    return JSON.parse(localStorage.getItem(storageKey(songKey)) || '{}');
  } catch (_) {
    return {};
  }
}

function writeLayout(songKey, layout) {
  localStorage.setItem(storageKey(songKey), JSON.stringify(layout));
}

function defaultVisualizerSize(method) {
  if (method === '_scope') return { width: 196, height: 86 };
  if (method === '_harmonics') return { width: 148, height: 94 };
  if (method === '_epicycles') return { width: 148, height: 112 };
  return { width: 132, height: 112 };
}

function visualizerName(method) {
  return VISUALIZER_METHODS.find((preset) => preset.method === method)?.label.toLowerCase()
    || method.slice(1);
}

function hasMusicalTokens(source) {
  MUSICAL_TOKEN.lastIndex = 0;
  const found = MUSICAL_TOKEN.test(source);
  MUSICAL_TOKEN.lastIndex = 0;
  return found;
}

function noteColumnCount(noteCount, viewportWidth, viewportHeight) {
  if (!noteCount) return 0;
  const viewportAspect = Math.max(.65, Math.min(3, viewportWidth / Math.max(1, viewportHeight)));
  const preferred = Math.ceil(Math.sqrt(
    noteCount * viewportAspect * (NOTES_HEIGHT + NODE_GAP) / (NOTES_WIDTH + NODE_GAP),
  ));
  return Math.max(1, Math.min(4, noteCount, preferred));
}

function packRows(plans, maximumWidth) {
  const rows = [];
  const ordered = [...plans].sort((left, right) =>
    right.height - left.height || right.width - left.width || left.index - right.index);

  for (const plan of ordered) {
    let bestRow = null;
    let smallestRemainder = Infinity;
    for (const row of rows) {
      const proposedWidth = row.width + CLUSTER_GAP + plan.width;
      if (proposedWidth > maximumWidth) continue;
      const remainder = maximumWidth - proposedWidth;
      if (remainder < smallestRemainder) {
        bestRow = row;
        smallestRemainder = remainder;
      }
    }
    if (bestRow) {
      bestRow.items.push(plan);
      bestRow.width += CLUSTER_GAP + plan.width;
      bestRow.height = Math.max(bestRow.height, plan.height);
    } else {
      rows.push({ items: [plan], width: plan.width, height: plan.height });
    }
  }

  return {
    rows,
    width: Math.max(...rows.map(({ width }) => width), 0),
    height: rows.reduce((height, row, index) =>
      height + row.height + (index ? CLUSTER_GAP : 0), 0),
  };
}

function bestPacking(plans, viewportWidth, viewportHeight) {
  const minimumWidth = Math.max(...plans.map(({ width }) => width), 0);
  const maximumWidth = plans.reduce((width, plan, index) =>
    width + plan.width + (index ? CLUSTER_GAP : 0), 0);
  const range = maximumWidth - minimumWidth;
  const samples = Math.max(1, Math.min(56, Math.ceil(range / 96)));
  let best = null;

  for (let index = 0; index <= samples; index++) {
    const candidateWidth = minimumWidth + range * index / samples;
    const packed = packRows(plans, candidateWidth);
    const surfaceWidth = packed.width + GRAPH_PADDING_X + 24;
    const surfaceHeight = packed.height + GRAPH_PADDING_Y + 24;
    const scale = Math.min(
      1,
      (viewportWidth - 24) / surfaceWidth,
      (viewportHeight - 24) / surfaceHeight,
    );
    const coverage = surfaceWidth * surfaceHeight * scale * scale
      / Math.max(1, viewportWidth * viewportHeight);
    if (!best || scale > best.scale + .0001
      || (Math.abs(scale - best.scale) <= .0001 && coverage > best.coverage)) {
      best = { ...packed, scale, coverage };
    }
  }
  return best;
}

export function automaticLayout(graph, viewportWidth = 1280, viewportHeight = 720) {
  const layout = {};
  const placed = new Set();
  const plannedNotes = new Set();
  const plans = graph.tracks
    .filter(({ declaration }) => declaration)
    .map((track, index) => {
      const notes = track.notes.filter(({ name }) =>
        !plannedNotes.has(name) && graph.codeNodes.some((node) => node.name === name));
      notes.forEach(({ name }) => plannedNotes.add(name));
      const visualizers = graph.visualizers.filter(({ target }) =>
        target === track.declaration.name || notes.some(({ name }) => name === target));
      const noteColumns = noteColumnCount(notes.length, viewportWidth, viewportHeight);
      const noteRows = noteColumns ? Math.ceil(notes.length / noteColumns) : 0;
      const noteWidth = noteColumns
        ? noteColumns * NOTES_WIDTH + Math.max(0, noteColumns - 1) * NODE_GAP
        : 0;
      const noteHeight = noteRows
        ? noteRows * NOTES_HEIGHT + Math.max(0, noteRows - 1) * NODE_GAP
        : 0;
      const visualHeight = visualizers.reduce((height, visualizer) =>
        height + defaultVisualizerSize(visualizer.method).height + NODE_GAP, 0);
      const railWidth = Math.max(
        TRACK_WIDTH,
        ...visualizers.map(({ method }) => defaultVisualizerSize(method).width),
      );
      const declarationHeight = TRACK_HEIGHT;
      return {
        index,
        track,
        notes,
        visualizers,
        noteColumns,
        declarationHeight,
        width: noteColumns
          ? NOTE_COLUMN_OFFSET + noteWidth + GRAPH_PADDING_X
          : Math.max(196, railWidth + GRAPH_PADDING_X * 2),
        height: Math.max(196, noteHeight + 24, declarationHeight + visualHeight + 30),
      };
    });
  if (!plans.length) return layout;

  const packing = bestPacking(plans, viewportWidth, viewportHeight);
  let y = GRAPH_PADDING_Y;
  for (const row of packing.rows) {
    let x = GRAPH_PADDING_X;
    const rowPlans = [...row.items].sort((left, right) => left.index - right.index);
    for (const { track, notes, visualizers, noteColumns, declarationHeight, width } of rowPlans) {

      if (!placed.has(track.declaration.name)) {
        layout[track.declaration.name] = {
          x,
          y: y + 18,
          width: TRACK_WIDTH,
          height: declarationHeight,
        };
        placed.add(track.declaration.name);
      }
      notes.forEach((note, index) => {
        const column = index % noteColumns;
        const noteRow = Math.floor(index / noteColumns);
        layout[note.name] = {
          x: x + NOTE_COLUMN_OFFSET + column * (NOTES_WIDTH + NODE_GAP),
          y: y + 18 + noteRow * (NOTES_HEIGHT + NODE_GAP),
          width: NOTES_WIDTH,
          height: NOTES_HEIGHT,
        };
        placed.add(note.name);
      });
      let visualY = y + declarationHeight + 30;
      for (const visualizer of visualizers) {
        const size = defaultVisualizerSize(visualizer.method);
        layout[visualizer.id] = { x, y: visualY, ...size };
        visualY += size.height + NODE_GAP;
      }
      x += width + CLUSTER_GAP;
    }
    y += row.height + CLUSTER_GAP;
  }
  return layout;
}

function clampPosition(value, minimum = 8) {
  return Math.max(minimum, Math.round(value));
}

function visualizerRegistry() {
  return globalThis.__stroodVisualizerRegistry instanceof Map
    ? [...globalThis.__stroodVisualizerRegistry.values()]
    : [];
}

export function createGraphViewController({
  root,
  editors,
  codeButton,
  graphButton,
  getCode,
  getSongKey,
  onCodeChange,
  onPlaySection,
  onToggleSectionLoop,
}) {
  const viewport = root.querySelector('.graph-viewport');
  const surface = root.querySelector('.graph-surface');
  const edgeLayer = root.querySelector('.graph-edges');
  const nodeLayer = root.querySelector('.graph-nodes');
  const empty = root.querySelector('.graph-empty');
  const sectionName = root.querySelector('.graph-section-name');
  const sectionCycle = root.querySelector('.graph-section-cycle');
  const sectionStrip = root.querySelector('.graph-section-strip');
  const visualizersToggle = root.querySelector('.graph-visualizers-toggle');
  let graph = buildSongGraph(getCode());
  let nodeElements = new Map();
  let currentLayout = {};
  let active = false;
  let refreshTimer = 0;
  let edgeFrame = 0;
  let mirrorFrame = 0;
  let lastMirror = 0;
  let resizeObserver = null;
  let drag = null;
  let rewire = null;
  let surfaceWidth = 0;
  let surfaceHeight = 0;
  let surfaceScale = 1;
  let hasCustomScale = false;
  let gestureStartScale = 1;
  let zoomTargetScale = 1;
  let cameraX = 0;
  let cameraY = 0;
  let targetCameraX = 0;
  let targetCameraY = 0;
  let zoomViewportRect = null;
  let zoomFrame = 0;
  let cameraSettleTimer = 0;
  let nativeGestureActive = false;
  let backgroundPan = null;
  let paletteTarget = null;
  let paletteTrigger = null;
  let sourceTokens = new Map();
  let activityExpiryTimer = 0;
  let activityStates = new Map();
  let lastActivations = [];
  let sectionSignature = '';
  let visualizersEnabled = localStorage.getItem(VISUALIZERS_KEY) !== 'false';
  let performanceState = {
    playing: false,
    paused: false,
    cycle: 0,
    sections: parseSections(getCode()),
    currentSection: null,
    queuedSection: null,
    loopedSection: null,
  };

  const graphVisibleCanvases = globalThis.__stroodGraphVisibleCanvases ||= new Set();
  const palette = document.createElement('div');
  palette.className = 'graph-visualizer-palette';
  palette.setAttribute('role', 'menu');
  palette.hidden = true;
  root.appendChild(palette);

  for (const preset of VISUALIZER_METHODS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'graph-palette-item';
    button.setAttribute('role', 'menuitem');
    button.textContent = preset.label;
    button.dataset.method = preset.method;
    button.addEventListener('click', () => {
      const targetName = paletteTarget;
      closeVisualizerPalette();
      if (targetName) finishAddVisualizer(preset.method, targetName);
    });
    palette.appendChild(button);
  }

  function nodeLayout(id, fallback) {
    const saved = currentLayout[id] || {};
    return {
      x: Number.isFinite(saved.x) ? saved.x : fallback.x,
      y: Number.isFinite(saved.y) ? saved.y : fallback.y,
      width: Number.isFinite(saved.width) ? saved.width : fallback.width,
      height: Number.isFinite(saved.height) ? saved.height : fallback.height,
    };
  }

  function applyNodeLayout(element, layout) {
    element.style.left = `${layout.x}px`;
    element.style.top = `${layout.y}px`;
    element.style.width = `${layout.width}px`;
    element.style.height = `${layout.height}px`;
  }

  function tokenKey(from, to) {
    return `${from}:${to}`;
  }

  function createSourceMirror(model) {
    const wrapper = document.createElement('div');
    wrapper.className = 'graph-source-wrap';
    const rendered = document.createElement('pre');
    rendered.className = 'graph-source-render';
    rendered.setAttribute('aria-hidden', 'true');
    const source = document.createElement('textarea');
    source.className = 'graph-source';
    source.value = model.text;
    source.spellcheck = false;
    source.setAttribute('aria-label', `${model.name} source code`);

    const stableTokenKeys = [];
    const renderSourceText = (text) => {
      for (const token of rendered.querySelectorAll('.graph-source-token')) {
        const key = token.dataset.range;
        const remaining = (sourceTokens.get(key) || []).filter((item) => item !== token);
        if (remaining.length) sourceTokens.set(key, remaining);
        else sourceTokens.delete(key);
      }
      rendered.replaceChildren();
      let cursor = 0;
      let tokenIndex = 0;
      const ranges = [];
      if (model.role === 'arrangement') {
        for (const entry of findArrangementEntries(text)) {
          ranges.push({ ...entry, type: 'arrangement', priority: 0 });
        }
      }
      MUSICAL_TOKEN.lastIndex = 0;
      for (const match of text.matchAll(MUSICAL_TOKEN)) {
        const relativeFrom = match.index + match[0].indexOf(match[1]);
        const relativeTo = relativeFrom + match[1].length;
        ranges.push({
          from: relativeFrom,
          to: relativeTo,
          type: 'musical',
          priority: 1,
        });
      }
      ranges.sort((left, right) => left.from - right.from || left.priority - right.priority);
      for (const range of ranges) {
        if (range.from < cursor) continue;
        rendered.append(document.createTextNode(text.slice(cursor, range.from)));
        const token = document.createElement('span');
        token.textContent = text.slice(range.from, range.to);
        if (range.type === 'arrangement') {
          token.className = 'graph-arrangement-entry';
          token.dataset.lane = String(range.lane);
          token.dataset.cycleStart = String(range.start);
          token.dataset.cycleEnd = String(range.end);
          token.dataset.laneLength = String(range.laneLength);
          token.dataset.dependency = range.dependency;
        } else {
          token.className = 'graph-source-token';
          token.style.setProperty('--note-activation-color', model.color || '#ffffff');
          const key = stableTokenKeys[tokenIndex]
            || tokenKey(model.from + range.from, model.from + range.to);
          stableTokenKeys[tokenIndex] = key;
          token.dataset.range = key;
          const tokens = sourceTokens.get(key) || [];
          tokens.push(token);
          sourceTokens.set(key, tokens);
          tokenIndex += 1;
        }
        rendered.append(token);
        cursor = range.to;
      }
      stableTokenKeys.length = tokenIndex;
      rendered.append(document.createTextNode(text.slice(cursor)));
      paintArrangementProgress(performanceState.cycle);
    };
    renderSourceText(model.text);

    source.addEventListener('focus', () => wrapper.classList.add('is-editing'));
    source.addEventListener('input', () => {
      commitSource(model.name, source, { deferPlayback: true });
      renderSourceText(source.value);
      paintActivity(lastActivations);
    });
    source.addEventListener('blur', () => {
      wrapper.classList.remove('is-editing');
      commitSource(model.name, source, { deferPlayback: true });
      scheduleRefresh();
    });
    source.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        source.blur();
        onCodeChange(getCode());
      }
    });
    wrapper.append(rendered, source);
    return wrapper;
  }

  function saveElementLayout(id, element) {
    currentLayout[id] = {
      x: clampPosition(parseFloat(element.style.left) || element.offsetLeft),
      y: clampPosition(parseFloat(element.style.top) || element.offsetTop),
      width: Math.round(element.offsetWidth),
      height: Math.round(element.offsetHeight),
    };
    writeLayout(getSongKey(), currentLayout);
  }

  function createPort(className, label) {
    const port = document.createElement('button');
    port.type = 'button';
    port.className = `graph-port ${className}`;
    port.setAttribute('aria-label', label);
    port.title = label;
    return port;
  }

  function createCodeNode(model, fallback) {
    const element = document.createElement('article');
    element.className = model.kind === 'declaration'
      ? 'graph-node graph-code-node graph-track-node graph-declaration-node'
      : `graph-node graph-code-node graph-pattern-node graph-notes-node graph-${model.role || 'phrase'}-node`;
    element.classList.toggle('has-musical-code', hasMusicalTokens(model.text));
    element.dataset.nodeId = model.name;
    element.dataset.sourceName = model.name;
    element.dataset.trackKey = model.trackKey || '';
    element.style.setProperty('--pattern-activity-color', model.color || '#e6b450');
    const roleName = model.role === 'arrangement'
      ? 'Arrangement'
      : (model.kind === 'declaration' ? 'Track' : 'Phrase');
    element.setAttribute('aria-label', `${roleName} ${model.name}`);
    applyNodeLayout(element, nodeLayout(model.name, fallback));

    const header = document.createElement('header');
    header.className = 'graph-node-header';
    header.title = 'Drag node';
    const identity = document.createElement('span');
    identity.className = 'graph-node-identity';
    identity.textContent = model.name;
    header.append(identity);

    if (model.kind === 'notes') {
      const activity = document.createElement('span');
      activity.className = 'graph-pattern-activity';
      activity.setAttribute('aria-hidden', 'true');
      header.append(activity);
    }

    if (model.kind === 'declaration') {
      const kind = document.createElement('span');
      kind.className = 'graph-node-kind';
      kind.textContent = model.trackName;
      header.append(kind);
      const controls = document.createElement('span');
      controls.className = 'graph-track-controls';
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'graph-track-toggle graph-track-mute';
      mute.textContent = 'M';
      mute.disabled = !model.canMute;
      mute.title = model.canMute
        ? `${model.muted ? 'Unmute' : 'Mute'} ${model.trackName}`
        : `${model.trackName} has no source-backed mute control`;
      mute.setAttribute('aria-label', mute.title);
      mute.setAttribute('aria-pressed', String(Boolean(model.muted)));
      const solo = document.createElement('button');
      solo.type = 'button';
      solo.className = 'graph-track-toggle graph-track-solo';
      solo.textContent = 'S';
      solo.disabled = !model.canSolo;
      solo.title = model.canSolo
        ? `${model.soloed ? 'Clear solo for' : 'Solo'} ${model.trackName}`
        : 'Add a const solo control to enable track soloing';
      solo.setAttribute('aria-label', solo.title);
      solo.setAttribute('aria-pressed', String(Boolean(model.soloed)));
      for (const button of [mute, solo]) {
        button.addEventListener('pointerdown', (event) => event.stopPropagation());
      }
      mute.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = toggleTrackMute(getCode(), model.trackKey);
        if (next !== getCode()) onCodeChange(next, { immediate: true, trackControl: 'mute' });
      });
      solo.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = toggleTrackSolo(getCode(), model.trackKey);
        if (next !== getCode()) onCodeChange(next, { immediate: true, trackControl: 'solo' });
      });
      controls.append(mute, solo);
      header.append(controls);
    }

    const addVisualizerButton = document.createElement('button');
    addVisualizerButton.type = 'button';
    addVisualizerButton.className = 'graph-node-add-visualizer';
    addVisualizerButton.setAttribute('aria-label', `Add visualiser to ${model.name}`);
    addVisualizerButton.setAttribute('aria-expanded', 'false');
    addVisualizerButton.title = `Add visualiser to ${model.name}`;
    addVisualizerButton.innerHTML = `
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.25v9.5M3.25 8h9.5" />
      </svg>`;
    addVisualizerButton.addEventListener('pointerdown', (event) => event.stopPropagation());
    addVisualizerButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleVisualizerPalette(model.name, addVisualizerButton);
    });
    const trackControls = header.querySelector('.graph-track-controls');
    if (trackControls) header.insertBefore(addVisualizerButton, trackControls);
    else header.append(addVisualizerButton);

    element.append(header, createSourceMirror(model));
    header.addEventListener('pointerdown', (event) => beginNodeDrag(event, element, model.name));
    return element;
  }

  function createVisualizerNode(model, fallback, methodIndex) {
    const element = document.createElement('article');
    element.className = 'graph-node graph-visualizer-node';
    element.dataset.nodeId = model.id;
    element.dataset.method = model.method;
    element.dataset.methodIndex = String(methodIndex);
    const name = visualizerName(model.method);
    element.setAttribute('aria-label', `${name} visualiser connected to ${model.target || 'nothing'}`);
    applyNodeLayout(element, nodeLayout(model.id, fallback));

    const canvas = document.createElement('canvas');
    canvas.className = 'graph-visualizer-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    if (!visualizersEnabled) {
      canvas.width = 1;
      canvas.height = 1;
    }
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'graph-visualizer-delete';
    deleteButton.setAttribute('aria-label', `Delete ${name} visualiser`);
    deleteButton.title = `Delete ${name} visualiser`;
    deleteButton.innerHTML = `
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" />
      </svg>`;
    const port = createPort('graph-input-port', `Reconnect ${name} visualiser`);
    element.append(canvas, deleteButton, port);
    deleteButton.addEventListener('pointerdown', (event) => event.stopPropagation());
    deleteButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      finishDeleteVisualizer(model);
    });
    port.addEventListener('pointerdown', (event) => beginRewire(event, element, model));
    element.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.graph-port')) return;
      const rect = element.getBoundingClientRect();
      if (event.clientX > rect.right - 18 && event.clientY > rect.bottom - 18) return;
      beginNodeDrag(event, element, model.id);
    });
    return element;
  }

  function commitSource(name, source, options = {}) {
    const code = getCode();
    const declaration = parseDeclarations(code).find((item) => item.name === name);
    if (!declaration || source.value === declaration.text) return;
    const next = code.slice(0, declaration.from) + source.value.trimEnd() + code.slice(declaration.to);
    onCodeChange(next, options);
  }

  function mergedLayout(automatic) {
    const persisted = readLayout(getSongKey());
    currentLayout = {};
    for (const { name } of graph.codeNodes) {
      currentLayout[name] = { ...(automatic[name] || {}), ...(persisted[name] || {}) };
    }
    for (const model of graph.visualizers) {
      currentLayout[model.id] = {
        ...(automatic[model.id] || {}),
        ...(persisted[model.id] || persisted[model.legacyId] || {}),
      };
    }
  }

  function preserveLayoutAndCamera() {
    for (const [id, element] of nodeElements) saveElementLayout(id, element);
    hasCustomScale = true;
    zoomTargetScale = surfaceScale;
    targetCameraX = cameraX;
    targetCameraY = cameraY;
  }

  function placeAddedVisualizer(nextGraph) {
    const existingIds = new Set(graph.visualizers.map(({ id }) => id));
    const added = nextGraph.visualizers.find(({ id }) => !existingIds.has(id));
    const target = added && nodeElements.get(added.target);
    if (!added || !target) return;
    const size = defaultVisualizerSize(added.method);
    const source = {
      left: target.offsetLeft,
      right: target.offsetLeft + target.offsetWidth,
      top: target.offsetTop,
      bottom: target.offsetTop + target.offsetHeight,
    };
    const occupied = [...nodeElements.values()].map((element) => ({
      left: element.offsetLeft - NODE_GAP,
      right: element.offsetLeft + element.offsetWidth + NODE_GAP,
      top: element.offsetTop - NODE_GAP,
      bottom: element.offsetTop + element.offsetHeight + NODE_GAP,
    }));
    const isOpen = ({ x, y }) => x >= 8 && y >= 8 && occupied.every((rect) =>
      x + size.width <= rect.left || x >= rect.right
        || y + size.height <= rect.top || y >= rect.bottom);
    const candidates = [];
    for (let step = 0; step < 24; step++) {
      candidates.push(
        { x: source.left, y: source.bottom + NODE_GAP + step * (size.height + NODE_GAP) },
        { x: source.right + NODE_GAP + step * (size.width + NODE_GAP), y: source.top },
        { x: source.left, y: source.top - size.height - NODE_GAP - step * (size.height + NODE_GAP) },
        { x: source.left - size.width - NODE_GAP - step * (size.width + NODE_GAP), y: source.top },
      );
    }
    const position = candidates.find(isOpen);
    if (!position) return;
    const persisted = readLayout(getSongKey());
    persisted[added.id] = { ...position, ...size };
    writeLayout(getSongKey(), persisted);
  }

  function automaticScale() {
    return Math.max(MIN_GRAPH_SCALE, Math.min(
      1,
      (viewport.clientWidth - GRAPH_STAGE_PADDING * 2) / surfaceWidth,
      (viewport.clientHeight - GRAPH_STAGE_PADDING * 2) / surfaceHeight,
    ));
  }

  function applyGraphCamera() {
    if (!surfaceWidth || !surfaceHeight) return;
    surfaceScale = zoomTargetScale;
    cameraX = targetCameraX;
    cameraY = targetCameraY;
    const moving = viewport.classList.contains('is-camera-moving');
    const pixelRatio = devicePixelRatio || 1;
    const displayX = moving ? cameraX : Math.round(cameraX * pixelRatio) / pixelRatio;
    const displayY = moving ? cameraY : Math.round(cameraY * pixelRatio) / pixelRatio;
    surface.style.transform = moving
      ? `translate3d(${displayX}px, ${displayY}px, 0) scale(${surfaceScale})`
      : `translate(${displayX}px, ${displayY}px) scale(${surfaceScale})`;
    root.dataset.graphScale = surfaceScale.toFixed(3);
  }

  function settleGraphCamera() {
    cameraSettleTimer = 0;
    viewport.classList.remove('is-camera-moving');
    applyGraphCamera();
  }

  function markCameraMoving(delay = 90) {
    viewport.classList.add('is-camera-moving');
    clearTimeout(cameraSettleTimer);
    cameraSettleTimer = window.setTimeout(settleGraphCamera, delay);
  }

  function fitGraph() {
    hasCustomScale = false;
    zoomTargetScale = automaticScale();
    targetCameraX = (viewport.clientWidth - surfaceWidth * zoomTargetScale) / 2;
    targetCameraY = (viewport.clientHeight - surfaceHeight * zoomTargetScale) / 2;
    applyGraphCamera();
  }

  function flushGraphZoom() {
    zoomFrame = 0;
    zoomViewportRect = null;
    applyGraphCamera();
  }

  function scheduleGraphCamera() {
    markCameraMoving();
    if (!zoomFrame) zoomFrame = requestAnimationFrame(flushGraphZoom);
  }

  function queueGraphZoom(nextScale, clientX, clientY) {
    hasCustomScale = true;
    zoomViewportRect ||= viewport.getBoundingClientRect();
    const anchorX = (Number.isFinite(clientX) ? clientX : zoomViewportRect.left + zoomViewportRect.width / 2)
      - zoomViewportRect.left;
    const anchorY = (Number.isFinite(clientY) ? clientY : zoomViewportRect.top + zoomViewportRect.height / 2)
      - zoomViewportRect.top;
    const clampedScale = Math.max(MIN_GRAPH_SCALE, Math.min(MAX_GRAPH_SCALE, nextScale));
    const ratio = clampedScale / zoomTargetScale;
    targetCameraX = anchorX - (anchorX - targetCameraX) * ratio;
    targetCameraY = anchorY - (anchorY - targetCameraY) * ratio;
    zoomTargetScale = clampedScale;
    scheduleGraphCamera();
  }

  function queueGraphPan(deltaX, deltaY) {
    hasCustomScale = true;
    targetCameraX -= deltaX;
    targetCameraY -= deltaY;
    clampTargetCamera();
    scheduleGraphCamera();
  }

  function clampTargetCamera() {
    const visibleMargin = 40;
    targetCameraX = Math.max(
      visibleMargin - surfaceWidth * zoomTargetScale,
      Math.min(viewport.clientWidth - visibleMargin, targetCameraX),
    );
    targetCameraY = Math.max(
      visibleMargin - surfaceHeight * zoomTargetScale,
      Math.min(viewport.clientHeight - visibleMargin, targetCameraY),
    );
  }

  function handleGraphWheel(event) {
    if (!event.ctrlKey && event.target.closest('.graph-source-wrap')) return;
    event.preventDefault();
    if (nativeGestureActive) return;
    closeVisualizerPalette();
    const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? viewport.clientHeight : 1);
    if (event.ctrlKey) {
      const boundedDelta = Math.max(-60, Math.min(60, event.deltaY * unit));
      queueGraphZoom(zoomTargetScale * Math.exp(-boundedDelta * .004), event.clientX, event.clientY);
      return;
    }
    const deltaX = (event.deltaX || (event.shiftKey ? event.deltaY : 0)) * unit;
    const deltaY = (event.shiftKey ? 0 : event.deltaY) * unit;
    queueGraphPan(deltaX, deltaY);
  }

  function handleGestureStart(event) {
    event.preventDefault();
    cancelAnimationFrame(zoomFrame);
    zoomFrame = 0;
    zoomViewportRect = null;
    nativeGestureActive = true;
    gestureStartScale = surfaceScale;
    zoomTargetScale = surfaceScale;
    targetCameraX = cameraX;
    targetCameraY = cameraY;
    markCameraMoving();
  }

  function handleGestureChange(event) {
    event.preventDefault();
    queueGraphZoom(gestureStartScale * event.scale, event.clientX, event.clientY);
  }

  function handleGestureEnd(event) {
    event.preventDefault();
    nativeGestureActive = false;
    markCameraMoving(24);
  }

  function handleBackgroundPointerDown(event) {
    if (event.button !== 0 || !event.target.matches(
      '.graph-viewport, .graph-stage, .graph-surface, .graph-edges, .graph-nodes, .graph-empty',
    )) return;
    event.preventDefault();
    closeVisualizerPalette();
    backgroundPan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cameraX: targetCameraX,
      cameraY: targetCameraY,
    };
    hasCustomScale = true;
    viewport.classList.add('is-background-panning');
    viewport.setPointerCapture(event.pointerId);
  }

  function handleBackgroundPointerMove(event) {
    if (!backgroundPan || event.pointerId !== backgroundPan.pointerId) return;
    targetCameraX = backgroundPan.cameraX + event.clientX - backgroundPan.startX;
    targetCameraY = backgroundPan.cameraY + event.clientY - backgroundPan.startY;
    clampTargetCamera();
    scheduleGraphCamera();
  }

  function finishBackgroundPan(event) {
    if (!backgroundPan || event.pointerId !== backgroundPan.pointerId) return;
    backgroundPan = null;
    viewport.classList.remove('is-background-panning');
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    markCameraMoving(24);
  }

  function render() {
    closeVisualizerPalette();
    graph = buildSongGraph(getCode());
    const automatic = automaticLayout(graph, viewport.clientWidth, viewport.clientHeight);
    mergedLayout(automatic);
    nodeElements = new Map();
    sourceTokens = new Map();
    nodeLayer.replaceChildren();
    edgeLayer.replaceChildren();
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.nodeId;
        if (id && !drag) saveElementLayout(id, entry.target);
      }
      scheduleEdges();
    });

    for (const model of graph.codeNodes) {
      const element = createCodeNode(model, automatic[model.name]);
      nodeLayer.appendChild(element);
      nodeElements.set(model.name, element);
      resizeObserver.observe(element);
    }
    const methodCounts = new Map();
    for (const model of graph.visualizers) {
      if (!automatic[model.id]) continue;
      const methodIndex = methodCounts.get(model.method) || 0;
      methodCounts.set(model.method, methodIndex + 1);
      const element = createVisualizerNode(model, automatic[model.id], methodIndex);
      nodeLayer.appendChild(element);
      nodeElements.set(model.id, element);
      resizeObserver.observe(element);
    }

    const bounds = [...nodeElements.values()].reduce((result, element) => ({
      width: Math.max(result.width, element.offsetLeft + element.offsetWidth + 24),
      height: Math.max(result.height, element.offsetTop + element.offsetHeight + 24),
    }), { width: 560, height: 320 });
    surfaceWidth = bounds.width;
    surfaceHeight = bounds.height;
    surface.style.width = `${surfaceWidth}px`;
    surface.style.height = `${surfaceHeight}px`;
    edgeLayer.setAttribute('viewBox', `0 0 ${surfaceWidth} ${surfaceHeight}`);
    empty.hidden = graph.codeNodes.length > 0;
    scheduleEdges();
    requestAnimationFrame(() => {
      if (hasCustomScale) applyGraphCamera();
      else fitGraph();
    });
    if (active) startMirrors();
    renderPerformanceState();
  }

  function renderPerformanceState() {
    const sections = performanceState.sections || [];
    const signature = sections.map(({ name, start, end }) => `${name}:${start}:${end}`).join('|');
    if (signature !== sectionSignature) {
      sectionSignature = signature;
      const fragment = document.createDocumentFragment();
      for (const section of sections) {
        const segment = document.createElement('div');
        segment.className = 'graph-section';
        segment.setAttribute('role', 'group');
        segment.dataset.section = section.name;
        segment.style.setProperty('--section-cycles', String(section.end - section.start));

        const jumpButton = document.createElement('button');
        jumpButton.type = 'button';
        jumpButton.className = 'graph-section-jump';
        jumpButton.title = `Play ${section.name} after the current section`;
        const label = document.createElement('span');
        label.textContent = section.name;
        jumpButton.append(label);
        jumpButton.addEventListener('click', (event) => {
          const startNow = event.detail >= 2
            && (!performanceState.playing || performanceState.paused);
          const next = setSelectedSongSection(getCode(), section.name);
          if (startNow) {
            performanceState = {
              ...performanceState,
              queuedSection: null,
            };
            renderPerformanceState();
            onPlaySection(next, section.name);
            return;
          }
          const jumpNow = performanceState.playing
            && performanceState.queuedSection === section.name;
          if (!performanceState.playing && next === getCode()) return;
          performanceState = {
            ...performanceState,
            queuedSection: jumpNow ? null : section.name,
          };
          renderPerformanceState();
          onCodeChange(next, { immediate: jumpNow, section: section.name });
        });

        const loopButton = document.createElement('button');
        loopButton.type = 'button';
        loopButton.className = 'graph-section-loop';
        loopButton.setAttribute('aria-pressed', 'false');
        loopButton.innerHTML = `
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.25 5.5h7.9L9.4 3.75M12.75 10.5h-7.9l1.75 1.75" />
            <path d="M11.55 4.55A4.75 4.75 0 0 1 12.75 8M4.45 11.45A4.75 4.75 0 0 1 3.25 8" />
          </svg>`;
        loopButton.addEventListener('click', (event) => {
          event.stopPropagation();
          onToggleSectionLoop?.(section.name);
        });

        segment.append(jumpButton, loopButton);
        fragment.append(segment);
      }
      sectionStrip.replaceChildren(fragment);
    }

    const totalCycles = Math.max(0, ...sections.map(({ end }) => end));
    const cycle = totalCycles
      ? ((Number(performanceState.cycle) % totalCycles) + totalCycles) % totalCycles
      : 0;
    const current = performanceState.currentSection || sectionAtCycle(sections, cycle);
    sectionName.textContent = current?.name || 'No arrangement';
    sectionCycle.textContent = current
      ? `bar ${Math.floor(cycle - current.start) + 1}/${Math.max(1, current.end - current.start)}`
      : '';
    for (const segment of sectionStrip.querySelectorAll('.graph-section')) {
      const isCurrent = segment.dataset.section === current?.name;
      const isQueued = segment.dataset.section === performanceState.queuedSection;
      const isLooped = segment.dataset.section === performanceState.loopedSection;
      const model = sections.find(({ name }) => name === segment.dataset.section);
      const progress = isCurrent && model
        ? Math.max(0, Math.min(1, (cycle - model.start) / Math.max(1, model.end - model.start)))
        : 0;
      segment.classList.toggle('is-current', isCurrent);
      segment.classList.toggle('is-queued', isQueued);
      segment.classList.toggle('is-looped', isLooped);
      segment.style.setProperty('--section-progress', `${progress * 100}%`);
      segment.setAttribute('aria-label', `${segment.dataset.section}${isCurrent ? ', current section' : ''}${isQueued ? ', queued' : ''}${isLooped ? ', looping' : ''}`);
      const jumpButton = segment.querySelector('.graph-section-jump');
      const canStartOnDoubleClick = !performanceState.playing || performanceState.paused;
      jumpButton.setAttribute('aria-current', isCurrent ? 'true' : 'false');
      jumpButton.setAttribute('aria-label', canStartOnDoubleClick
        ? `Select ${segment.dataset.section}; double-click to play`
        : (isQueued
          ? `Jump to ${segment.dataset.section} now`
          : `Queue ${segment.dataset.section}${isCurrent ? ', current section' : ''}`));
      jumpButton.title = canStartOnDoubleClick
        ? `Click to select ${segment.dataset.section}; double-click to play it`
        : (isQueued
          ? `Jump to ${segment.dataset.section} now`
          : `Play ${segment.dataset.section} after the current section`);
      const loopButton = segment.querySelector('.graph-section-loop');
      loopButton.setAttribute('aria-pressed', String(isLooped));
      loopButton.setAttribute('aria-label', `${isLooped ? 'Stop looping' : 'Loop'} ${segment.dataset.section}`);
      loopButton.title = `${isLooped ? 'Stop looping' : 'Loop'} ${segment.dataset.section}`;
    }
    paintArrangementProgress(cycle);
  }

  function drawEdges() {
    edgeFrame = 0;
    const fragment = document.createDocumentFragment();
    const rectangles = [...nodeElements].map(([id, element]) => ({
      id,
      left: element.offsetLeft,
      right: element.offsetLeft + element.offsetWidth,
      top: element.offsetTop,
      bottom: element.offsetTop + element.offsetHeight,
    }));
    const router = createOrthogonalRouter(rectangles, {
      clearance: 5,
      bounds: { left: 8, right: surfaceWidth - 8, top: 8, bottom: surfaceHeight - 8 },
    });
    for (const edge of graph.edges) {
      const route = router.routeBetween(edge.from, edge.to);
      if (!route.length) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', orthogonalPath(route));
      path.setAttribute('class', edge.to.startsWith('visualizer:') ? 'graph-edge graph-visual-edge' : 'graph-edge');
      path.dataset.edgeId = edge.id;
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      fragment.appendChild(path);
    }
    if (rewire) {
      const targetElement = nodeElements.get(rewire.model.id);
      const target = targetElement ? {
        x: targetElement.offsetLeft,
        y: targetElement.offsetTop + targetElement.offsetHeight / 2,
      } : null;
      if (target) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', orthogonalPath([
          rewire.pointer,
          { x: rewire.pointer.x, y: target.y },
          target,
        ]));
        path.setAttribute('class', 'graph-edge graph-drag-edge');
        fragment.appendChild(path);
      }
    }
    edgeLayer.replaceChildren(fragment);
    paintActivity(lastActivations);
  }

  function scheduleEdges() {
    if (!edgeFrame) edgeFrame = requestAnimationFrame(drawEdges);
  }

  function paintActivity(activations) {
    const state = resolveGraphActivity(graph, activations);
    for (const [id, element] of nodeElements) {
      const sounding = state.activeNodes.has(id);
      element.classList.toggle('is-sounding', sounding);
    }
    for (const tokens of sourceTokens.values()) {
      for (const token of tokens) token.classList.remove('is-active-note', 'is-note-onset');
    }
    for (const activation of activations) {
      for (const token of sourceTokens.get(tokenKey(activation.from, activation.to)) || []) {
        token.classList.add('is-active-note');
        token.classList.toggle('is-note-onset', Boolean(activation.onset));
        token.style.setProperty('--note-activation-color', activation.color || '#ffffff');
        const wrapper = token.closest('.graph-source-wrap');
        const node = wrapper?.closest('.graph-node');
        const userIsInspecting = node?.matches(':hover') || node?.contains(document.activeElement);
        if (!wrapper || wrapper.classList.contains('is-editing') || userIsInspecting) continue;
        const tokenRect = token.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        const outside = tokenRect.top < wrapperRect.top
          || tokenRect.bottom > wrapperRect.bottom
          || tokenRect.left < wrapperRect.left
          || tokenRect.right > wrapperRect.right;
        if (outside) {
          wrapper.scrollTop += (tokenRect.top - wrapperRect.top - (wrapperRect.height - tokenRect.height) / 2) / surfaceScale;
          wrapper.scrollLeft += (tokenRect.left - wrapperRect.left - (wrapperRect.width - tokenRect.width) / 2) / surfaceScale;
        }
      }
    }
  }

  function paintArrangementProgress(cycle) {
    for (const element of nodeElements.values()) {
      if (!element.classList.contains('graph-arrangement-node')) continue;
      let hasActiveEntry = false;
      for (const entry of element.querySelectorAll('.graph-arrangement-entry')) {
        const length = Number(entry.dataset.laneLength);
        const start = Number(entry.dataset.cycleStart);
        const end = Number(entry.dataset.cycleEnd);
        const position = length > 0 ? ((Number(cycle) % length) + length) % length : 0;
        const active = performanceState.playing && position >= start && position < end;
        entry.classList.toggle('is-active-arrangement', active);
        hasActiveEntry ||= active;
      }
      element.classList.toggle('has-active-arrangement', hasActiveEntry);
    }
  }

  function paintBufferedActivity(now = performance.now()) {
    clearTimeout(activityExpiryTimer);
    let nextChange = Infinity;
    lastActivations = [];
    for (const [key, state] of activityStates) {
      if (state.expiresAt <= now) {
        activityStates.delete(key);
        continue;
      }
      const onset = state.onsetUntil > now;
      lastActivations.push({ ...state.activation, onset });
      nextChange = Math.min(nextChange, state.expiresAt, onset ? state.onsetUntil : Infinity);
    }
    paintActivity(lastActivations);
    if (Number.isFinite(nextChange)) {
      activityExpiryTimer = window.setTimeout(
        () => paintBufferedActivity(),
        Math.max(8, nextChange - now + 1),
      );
    }
  }

  function handleNoteActivity(event) {
    if (!active) return;
    const now = performance.now();
    const incoming = Array.isArray(event.detail?.activations) ? event.detail.activations : [];
    for (const activation of incoming) {
      const key = tokenKey(activation.from, activation.to);
      const previous = activityStates.get(key);
      const onsetUntil = activation.onset
        ? now + GRAPH_ONSET_FLASH_MS
        : previous?.onsetUntil || 0;
      const expiresAt = Math.max(
        previous?.expiresAt || 0,
        now + (activation.onset ? GRAPH_STACCATO_HOLD_MS : GRAPH_SUSTAIN_GRACE_MS),
      );
      activityStates.set(key, {
        activation: { ...activation, onset: false },
        onsetUntil,
        expiresAt,
      });
    }
    paintBufferedActivity(now);
  }

  function beginNodeDrag(event, element, id) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      element,
      id,
      startX: event.clientX,
      startY: event.clientY,
      left: element.offsetLeft,
      top: element.offsetTop,
    };
    element.classList.add('is-dragging');
    element.setPointerCapture(event.pointerId);
    element.addEventListener('pointermove', moveNode);
    element.addEventListener('pointerup', endNodeDrag, { once: true });
    element.addEventListener('pointercancel', endNodeDrag, { once: true });
  }

  function moveNode(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const x = clampPosition(drag.left + (event.clientX - drag.startX) / surfaceScale);
    const y = clampPosition(drag.top + (event.clientY - drag.startY) / surfaceScale);
    drag.element.style.left = `${x}px`;
    drag.element.style.top = `${y}px`;
    scheduleEdges();
  }

  function endNodeDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { element, id } = drag;
    element.removeEventListener('pointermove', moveNode);
    element.classList.remove('is-dragging');
    saveElementLayout(id, element);
    drag = null;
  }

  function pointerInSurface(event) {
    const rect = surface.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / surfaceScale,
      y: (event.clientY - rect.top) / surfaceScale,
    };
  }

  function beginRewire(event, element, model) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    rewire = { model, pointerId: event.pointerId, pointer: pointerInSurface(event) };
    element.setPointerCapture(event.pointerId);
    element.addEventListener('pointermove', moveRewire);
    element.addEventListener('pointerup', endRewire, { once: true });
    element.addEventListener('pointercancel', cancelRewire, { once: true });
    root.classList.add('is-connecting');
    scheduleEdges();
  }

  function moveRewire(event) {
    if (!rewire || event.pointerId !== rewire.pointerId) return;
    rewire.pointer = pointerInSurface(event);
    scheduleEdges();
  }

  function finishRewire(element, targetName) {
    const next = attachVisualizer(getCode(), rewire.model.id, targetName);
    cleanupRewire(element);
    if (next !== getCode()) {
      onCodeChange(next);
      window.setTimeout(render, 0);
    }
  }

  function endRewire(event) {
    if (!rewire || event.pointerId !== rewire.pointerId) return;
    const element = event.currentTarget;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.graph-code-node');
    if (target?.dataset.sourceName) finishRewire(element, target.dataset.sourceName);
    else cleanupRewire(element);
  }

  function cancelRewire(event) {
    cleanupRewire(event.currentTarget);
  }

  function cleanupRewire(element) {
    element.removeEventListener('pointermove', moveRewire);
    rewire = null;
    root.classList.remove('is-connecting');
    scheduleEdges();
  }

  function closeVisualizerPalette({ restoreFocus = false } = {}) {
    if (paletteTrigger) {
      paletteTrigger.setAttribute('aria-expanded', 'false');
      paletteTrigger.closest('.graph-node')?.classList.remove('has-open-menu');
      if (restoreFocus && paletteTrigger.isConnected) paletteTrigger.focus();
    }
    palette.hidden = true;
    paletteTarget = null;
    paletteTrigger = null;
  }

  function positionVisualizerPalette(trigger) {
    const triggerRect = trigger.getBoundingClientRect();
    const paletteRect = palette.getBoundingClientRect();
    const left = Math.max(8, Math.min(
      window.innerWidth - paletteRect.width - 8,
      triggerRect.right - paletteRect.width,
    ));
    const top = triggerRect.bottom + paletteRect.height + 6 <= window.innerHeight
      ? triggerRect.bottom + 4
      : Math.max(8, triggerRect.top - paletteRect.height - 4);
    palette.style.left = `${Math.round(left)}px`;
    palette.style.top = `${Math.round(top)}px`;
  }

  function toggleVisualizerPalette(targetName, trigger) {
    if (!palette.hidden && paletteTarget === targetName) {
      closeVisualizerPalette({ restoreFocus: true });
      return;
    }
    closeVisualizerPalette();
    paletteTarget = targetName;
    paletteTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.closest('.graph-node')?.classList.add('has-open-menu');
    palette.hidden = false;
    positionVisualizerPalette(trigger);
    palette.querySelector('[role="menuitem"]')?.focus();
  }

  function finishAddVisualizer(method, targetName) {
    preserveLayoutAndCamera();
    const next = addVisualizer(getCode(), method, targetName);
    if (next !== getCode()) {
      placeAddedVisualizer(buildSongGraph(next));
      onCodeChange(next, { immediate: true, visualizerControl: 'add' });
      window.setTimeout(render, 0);
    }
  }

  function finishDeleteVisualizer(model) {
    preserveLayoutAndCamera();
    const next = removeVisualizer(getCode(), model.id);
    if (next === getCode()) return;
    delete currentLayout[model.id];
    const persisted = readLayout(getSongKey());
    delete persisted[model.id];
    delete persisted[model.legacyId];
    writeLayout(getSongKey(), persisted);
    onCodeChange(next, { immediate: true, visualizerControl: 'remove' });
    window.setTimeout(render, 0);
  }

  function setVisualizersEnabled(enabled, { persist = true } = {}) {
    visualizersEnabled = Boolean(enabled);
    globalThis.__stroodVisualizersEnabled = visualizersEnabled;
    root.classList.toggle('visualizers-disabled', !visualizersEnabled);
    document.body.dataset.visualizers = visualizersEnabled ? 'on' : 'off';
    visualizersToggle.setAttribute('aria-checked', String(visualizersEnabled));
    visualizersToggle.setAttribute('aria-label', `Visualisers ${visualizersEnabled ? 'enabled' : 'disabled'}`);
    visualizersToggle.title = `Turn visualisers ${visualizersEnabled ? 'off' : 'on'}`;
    if (persist) localStorage.setItem(VISUALIZERS_KEY, String(visualizersEnabled));
    if (visualizersEnabled) {
      startMirrors();
    } else {
      stopMirrors();
      for (const canvas of nodeLayer.querySelectorAll('.graph-visualizer-canvas')) {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
    document.dispatchEvent(new CustomEvent('strood:visualizers-enabled', {
      detail: { enabled: visualizersEnabled },
    }));
  }

  function mirrorVisualizers(time) {
    mirrorFrame = 0;
    if (!active || !visualizersEnabled) return;
    if (time - lastMirror < 48) {
      mirrorFrame = requestAnimationFrame(mirrorVisualizers);
      return;
    }
    lastMirror = time;
    graphVisibleCanvases.clear();
    const registry = visualizerRegistry();
    for (const element of nodeElements.values()) {
      if (!element.classList.contains('graph-visualizer-node')) continue;
      const matches = registry.filter(({ method, canvas }) => method === element.dataset.method && canvas);
      const source = matches[Number(element.dataset.methodIndex)]?.canvas;
      const target = element.querySelector('canvas');
      if (!source || !target) continue;
      graphVisibleCanvases.add(source);
      const width = Math.max(1, Math.round(target.clientWidth * Math.min(devicePixelRatio || 1, 1.5)));
      const height = Math.max(1, Math.round(target.clientHeight * Math.min(devicePixelRatio || 1, 1.5)));
      if (target.width !== width || target.height !== height) {
        target.width = width;
        target.height = height;
      }
      const context = target.getContext('2d');
      context.clearRect(0, 0, width, height);
      const scale = Math.min(width / source.width, height / source.height);
      const drawWidth = source.width * scale;
      const drawHeight = source.height * scale;
      context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    }
    mirrorFrame = requestAnimationFrame(mirrorVisualizers);
  }

  function startMirrors() {
    if (active && visualizersEnabled && !mirrorFrame) {
      mirrorFrame = requestAnimationFrame(mirrorVisualizers);
    }
  }

  function stopMirrors() {
    if (mirrorFrame) cancelAnimationFrame(mirrorFrame);
    mirrorFrame = 0;
    graphVisibleCanvases.clear();
  }

  function setMode(mode) {
    active = mode === 'graph';
    root.hidden = !active;
    editors.hidden = active;
    codeButton.setAttribute('aria-pressed', String(!active));
    graphButton.setAttribute('aria-pressed', String(active));
    localStorage.setItem(VIEW_KEY, active ? 'graph' : 'code');
    closeVisualizerPalette();
    if (active) {
      render();
      startMirrors();
      requestAnimationFrame(() => viewport.focus({ preventScroll: true }));
    } else {
      clearTimeout(activityExpiryTimer);
      activityStates.clear();
      lastActivations = [];
      paintActivity(lastActivations);
      stopMirrors();
      editors.querySelector('.cm-editor')?.cmView?.view?.requestMeasure();
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      if (active && !document.activeElement?.matches('.graph-source')) render();
    }, 100);
  }

  codeButton.addEventListener('click', () => setMode('code'));
  graphButton.addEventListener('click', () => setMode('graph'));
  const handleVisualizersToggle = () => setVisualizersEnabled(!visualizersEnabled);
  visualizersToggle.addEventListener('click', handleVisualizersToggle);
  const handleDocumentPointerDown = (event) => {
    if (!palette.hidden && !palette.contains(event.target) && event.target !== paletteTrigger) {
      closeVisualizerPalette();
    }
  };
  const handleRootKeydown = (event) => {
    if (event.key === 'Escape' && !palette.hidden) closeVisualizerPalette({ restoreFocus: true });
  };
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  root.addEventListener('keydown', handleRootKeydown);
  viewport.addEventListener('wheel', handleGraphWheel, { passive: false });
  viewport.addEventListener('pointerdown', handleBackgroundPointerDown);
  viewport.addEventListener('pointermove', handleBackgroundPointerMove);
  viewport.addEventListener('pointerup', finishBackgroundPan);
  viewport.addEventListener('pointercancel', finishBackgroundPan);
  viewport.addEventListener('gesturestart', handleGestureStart, { passive: false });
  viewport.addEventListener('gesturechange', handleGestureChange, { passive: false });
  viewport.addEventListener('gestureend', handleGestureEnd, { passive: false });
  document.addEventListener('strood:visualizer-canvas', startMirrors);
  document.addEventListener('strood:note-activity', handleNoteActivity);
  const handleViewportResize = () => {
    scheduleEdges();
    if (hasCustomScale) applyGraphCamera();
    else fitGraph();
  };
  window.addEventListener('resize', handleViewportResize);

  setVisualizersEnabled(visualizersEnabled, { persist: false });
  const initialMode = localStorage.getItem(VIEW_KEY) === 'graph' ? 'graph' : 'code';
  setMode(initialMode);

  return {
    setMode,
    setPerformanceState: (next) => {
      performanceState = { ...performanceState, ...next };
      renderPerformanceState();
    },
    refresh: () => active && render(),
    scheduleRefresh,
    destroy: () => {
      clearTimeout(refreshTimer);
      clearTimeout(cameraSettleTimer);
      cancelAnimationFrame(zoomFrame);
      resizeObserver?.disconnect();
      clearTimeout(activityExpiryTimer);
      stopMirrors();
      closeVisualizerPalette();
      palette.remove();
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
      document.removeEventListener('strood:visualizer-canvas', startMirrors);
      root.removeEventListener('keydown', handleRootKeydown);
      visualizersToggle.removeEventListener('click', handleVisualizersToggle);
      viewport.removeEventListener('wheel', handleGraphWheel);
      viewport.removeEventListener('pointerdown', handleBackgroundPointerDown);
      viewport.removeEventListener('pointermove', handleBackgroundPointerMove);
      viewport.removeEventListener('pointerup', finishBackgroundPan);
      viewport.removeEventListener('pointercancel', finishBackgroundPan);
      viewport.removeEventListener('gesturestart', handleGestureStart);
      viewport.removeEventListener('gesturechange', handleGestureChange);
      viewport.removeEventListener('gestureend', handleGestureEnd);
      document.removeEventListener('strood:note-activity', handleNoteActivity);
      window.removeEventListener('resize', handleViewportResize);
    },
  };
}
