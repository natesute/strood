import {
  VISUALIZER_METHODS,
  addVisualizer,
  arrangementEntryId,
  attachVisualizer,
  buildSongGraph,
  findArrangementEntries,
  parseDeclarations,
  removeVisualizer,
  resolveArrangementPlayback,
  resolveGraphActivity,
  toggleTrackMute,
  toggleTrackSolo,
} from './graph-model.js';
import {
  createGraphBackground,
  cycleBackgroundMode,
  resolveBackgroundMode,
} from './graph-background.js';
import {
  orthogonalPath,
  planOrthogonalBridges,
  routeOrthogonalEdges,
} from './orthogonal-router.js';
import { parseSections, sectionAtCycle } from './song-metadata.js';
import { createShiftLens } from './shift-lens.js';
import { organicLayout } from './organic-layout.js';

const TRACK_WIDTH = 190;
const TRACK_HEIGHT = 140;
const NOTES_WIDTH = 330;
const NOTES_HEIGHT = 172;
const NODE_GAP = 10;
const GRAPH_PADDING_X = 18;
const GRAPH_PADDING_Y = 24;
const LAYOUT_PREFIX = 'strood:graph-layout:v9:';
const VIEW_KEY = 'strood:workspace-view';
const VISUALIZERS_KEY = 'strood:visualizers-enabled';
const BACKGROUND_KEY = 'strood:graph-background';
const MIN_GRAPH_SCALE = .18;
const MAX_GRAPH_SCALE = 2.4;
const MIN_EDGE_ROUTING_SCALE = .3;
const GRAPH_STAGE_PADDING = 12;
const GRAPH_VISUALIZER_OVERSCAN = 140;
const GRAPH_ONSET_FLASH_MS = 40;
const GRAPH_STACCATO_HOLD_MS = 180;
const GRAPH_SUSTAIN_GRACE_MS = 90;
const MUSICAL_TOKEN = /(?:^|[^A-Za-z0-9_])([a-gA-G](?:s|f|b|#)?\d+|t|bd|sd|hh|oh|cp|clap|rim|cr|rd)(?=$|[^A-Za-z0-9_])/g;
let graphViewSequence = 0;

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

export function automaticLayout(graph, viewportWidth = 1280, viewportHeight = 720) {
  const trackNames = new Set(graph.tracks
    .filter(({ declaration }) => declaration)
    .map(({ declaration }) => declaration.name));
  const nodes = graph.codeNodes.map(({ name }) => (trackNames.has(name)
    ? { id: name, width: TRACK_WIDTH, height: TRACK_HEIGHT }
    : { id: name, width: NOTES_WIDTH, height: NOTES_HEIGHT }));
  for (const visualizer of graph.visualizers) {
    nodes.push({ id: visualizer.id, ...defaultVisualizerSize(visualizer.method) });
  }
  // Graph edges run consumer -> dependency, except visualiser edges, which
  // run source -> visualiser; flip those so visualisers rank as consumers.
  const edges = graph.edges.map(({ from, to }) => (to.startsWith('visualizer:')
    ? { from: to, to: from }
    : { from, to }));
  return organicLayout({ nodes, edges, viewportWidth, viewportHeight });
}


function clampPosition(value, minimum = 8) {
  return Math.max(minimum, Math.round(value));
}

function layoutsOverlap(left, right, gap = 0) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

function nearestOpenPosition(moving, obstacles, gap, padding) {
  const candidates = [{ x: moving.x, y: moving.y }];
  let farRight = padding;
  for (const obstacle of obstacles) {
    candidates.push(
      { x: obstacle.x + obstacle.width + gap, y: moving.y },
      { x: moving.x, y: obstacle.y + obstacle.height + gap },
    );
    if (obstacle.x - gap - moving.width >= padding) {
      candidates.push({ x: obstacle.x - gap - moving.width, y: moving.y });
    }
    if (obstacle.y - gap - moving.height >= padding) {
      candidates.push({ x: moving.x, y: obstacle.y - gap - moving.height });
    }
    farRight = Math.max(farRight, obstacle.x + obstacle.width + gap);
  }
  candidates.push({ x: farRight, y: moving.y });
  candidates.sort((left, right) => (
    (left.x - moving.x) ** 2 + (left.y - moving.y) ** 2
    - (right.x - moving.x) ** 2 - (right.y - moving.y) ** 2
  ));
  return candidates.find(({ x, y }) => {
    const candidate = { ...moving, x, y };
    return !obstacles.some((obstacle) => layoutsOverlap(candidate, obstacle, gap));
  }) || { x: farRight, y: moving.y };
}

export function resolveNodeCollisions(layout, {
  fixedIds = [],
  gap = NODE_GAP,
  padding = 8,
  } = {}) {
  const nodes = Object.fromEntries(Object.entries(layout).map(([id, node]) => [id, {
    ...node,
    x: Math.max(padding, Number(node.x) || padding),
    y: Math.max(padding, Number(node.y) || padding),
    width: Math.max(1, Number(node.width) || 1),
    height: Math.max(1, Number(node.height) || 1),
  }]));
  const ids = Object.keys(nodes);
  const fixed = new Set(fixedIds);
  const orderedIds = [
    ...ids.filter((id) => fixed.has(id)),
    ...ids.filter((id) => !fixed.has(id)),
  ];
  const placed = [];
  for (const id of orderedIds) {
    const node = nodes[id];
    if (placed.some((obstacle) => layoutsOverlap(node, obstacle, gap))) {
      Object.assign(node, nearestOpenPosition(node, placed, gap, padding));
    }
    placed.push(node);
  }
  return nodes;
}

function visualizerRegistry() {
  return globalThis.__stroodVisualizerRegistry instanceof Map
    ? [...globalThis.__stroodVisualizerRegistry.values()]
    : [];
}

export function graphViewportBounds({
  cameraX = 0,
  cameraY = 0,
  scale = 1,
  viewportWidth = 0,
  viewportHeight = 0,
  overscan = GRAPH_VISUALIZER_OVERSCAN,
}) {
  const resolvedScale = Math.max(Number.EPSILON, Number(scale) || 1);
  return {
    left: (-cameraX - overscan) / resolvedScale,
    top: (-cameraY - overscan) / resolvedScale,
    right: (viewportWidth - cameraX + overscan) / resolvedScale,
    bottom: (viewportHeight - cameraY + overscan) / resolvedScale,
  };
}

export function graphRectIsVisible(rect, bounds) {
  return rect.x + rect.width >= bounds.left
    && rect.x <= bounds.right
    && rect.y + rect.height >= bounds.top
    && rect.y <= bounds.bottom;
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
  onSelectSection,
  getSelectedSectionName,
  onToggleSectionLoop,
}) {
  const edgeMaskPrefix = `graph-edge-underpass-${graphViewSequence++}`;
  const viewport = root.querySelector('.graph-viewport');
  const surface = root.querySelector('.graph-surface');
  const edgeLayer = root.querySelector('.graph-edges');
  const nodeLayer = root.querySelector('.graph-nodes');
  const empty = root.querySelector('.graph-empty');
  const sectionName = root.querySelector('.graph-section-name');
  const sectionStrip = root.querySelector('.graph-section-strip');
  const visualizersToggle = root.querySelector('.graph-visualizers-toggle');
  const backgroundToggle = root.querySelector('.graph-background-toggle');
  const backgroundLabel = backgroundToggle.querySelector('.graph-background-label');
  let graph = buildSongGraph('');
  let renderedCode = null;
  let renderedSongKey = null;
  let nodeElements = new Map();
  let currentLayout = {};
  let active = false;
  let destroyed = false;
  let refreshTimer = 0;
  let edgeFrame = 0;
  let edgeTimer = 0;
  let edgeLayoutSignature = '';
  let edgeRenderSignature = '';
  let edgeRoutes = [];
  let mirrorFrame = 0;
  let lastMirror = 0;
  let visibleVisualizerMirrors = [];
  let resizeObserver = null;
  let collisionSettleFrame = 0;
  let dragFrame = 0;
  let nodeResizeFrame = 0;
  let drag = null;
  let nodeResize = null;
  let rewire = null;
  let renderPending = false;
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
  let sectionSegments = [];
  let paintedTokens = new Map();
  let paintedEdges = new Set();
  let edgeElementsById = new Map();
  let arrangementPaintSignature = null;
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
  const background = createGraphBackground({ viewport });
  const lens = createShiftLens({
    viewport,
    surface,
    nodeLayer,
    edgeLayer,
    backgroundCanvas: background.canvas,
    getCamera: () => ({ x: cameraX, y: cameraY, scale: surfaceScale }),
    isSuppressed: () => !active
      || Boolean(drag || nodeResize || rewire)
      || Boolean(document.activeElement?.closest?.('.graph-source-wrap')),
  });
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

    const revealScrollbarWhileScrolling = (element) => {
      let hideTimer = 0;
      element.addEventListener('scroll', () => {
        element.classList.add('is-scrolling');
        window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => element.classList.remove('is-scrolling'), 700);
      }, { passive: true });
    };
    revealScrollbarWhileScrolling(wrapper);
    revealScrollbarWhileScrolling(source);

    wrapper.addEventListener('wheel', (event) => {
      if (event.ctrlKey || wrapper.classList.contains('is-editing')) return;
      const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? wrapper.clientHeight : 1);
      const deltaX = (event.deltaX || (event.shiftKey ? event.deltaY : 0)) * unit / surfaceScale;
      const deltaY = (event.shiftKey ? 0 : event.deltaY) * unit / surfaceScale;
      const previousLeft = wrapper.scrollLeft;
      const previousTop = wrapper.scrollTop;
      wrapper.scrollLeft += deltaX;
      wrapper.scrollTop += deltaY;
      if (wrapper.scrollLeft === previousLeft && wrapper.scrollTop === previousTop) return;
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });

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
      if (model.arrangementEntries?.length) {
        for (const entry of findArrangementEntries(text)) {
          ranges.push({
            ...entry,
            from: entry.highlightFrom,
            to: entry.highlightTo,
            type: 'arrangement',
            priority: 0,
          });
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
          if (range.dependency) token.dataset.dependency = range.dependency;
          const dependency = graph.codeNodes.find((node) => node.name === range.dependency);
          token.style.setProperty(
            '--arrangement-activity-color',
            dependency?.color || model.color || '#e6b450',
          );
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
      arrangementPaintSignature = null;
      paintArrangementProgress(performanceState.cycle);
    };
    renderSourceText(model.text);

    source.addEventListener('focus', () => {
      source.scrollLeft = wrapper.scrollLeft;
      source.scrollTop = wrapper.scrollTop;
      wrapper.classList.add('is-editing');
    });
    source.addEventListener('scroll', () => {
      if (!wrapper.classList.contains('is-editing')) return;
      wrapper.scrollLeft = source.scrollLeft;
      wrapper.scrollTop = source.scrollTop;
    });
    source.addEventListener('input', () => {
      commitSource(model, source, { deferPlayback: true });
      renderSourceText(source.value);
      paintActivity(lastActivations);
    });
    source.addEventListener('blur', () => {
      wrapper.classList.remove('is-editing');
      commitSource(model, source, { deferPlayback: true });
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

  function saveAllNodeLayouts() {
    for (const [id, element] of nodeElements) {
      currentLayout[id] = {
        x: clampPosition(parseFloat(element.style.left) || element.offsetLeft),
        y: clampPosition(parseFloat(element.style.top) || element.offsetTop),
        width: Math.round(element.offsetWidth),
        height: Math.round(element.offsetHeight),
      };
    }
    writeLayout(getSongKey(), currentLayout);
  }

  function readNodeLayouts() {
    return Object.fromEntries([...nodeElements].map(([id, element]) => [id, {
      x: parseFloat(element.style.left) || element.offsetLeft,
      y: parseFloat(element.style.top) || element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    }]));
  }

  function growSurfaceToLayout(layout) {
    let nextWidth = surfaceWidth;
    let nextHeight = surfaceHeight;
    for (const position of Object.values(layout)) {
      nextWidth = Math.max(nextWidth, position.x + position.width + 24);
      nextHeight = Math.max(nextHeight, position.y + position.height + 24);
    }
    if (nextWidth === surfaceWidth && nextHeight === surfaceHeight) return;
    surfaceWidth = nextWidth;
    surfaceHeight = nextHeight;
    surface.style.width = `${surfaceWidth}px`;
    surface.style.height = `${surfaceHeight}px`;
    edgeLayer.setAttribute('viewBox', `0 0 ${surfaceWidth} ${surfaceHeight}`);
  }

  function applyNodeLayouts(before, resolved) {
    let changed = false;
    for (const [id, position] of Object.entries(resolved)) {
      const element = nodeElements.get(id);
      if (!element) continue;
      const x = clampPosition(position.x);
      const y = clampPosition(position.y);
      if (x === Math.round(before[id].x) && y === Math.round(before[id].y)) continue;
      changed = true;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    }
    growSurfaceToLayout(resolved);
    if (changed && active) refreshVisualizerMirrors();
    return changed;
  }

  function settleNodeCollisions(fixedId = null) {
    const before = readNodeLayouts();
    const resolved = resolveNodeCollisions(before, {
      fixedIds: fixedId ? [fixedId] : [],
      gap: NODE_GAP,
    });
    return applyNodeLayouts(before, resolved);
  }

  function createPort(className, label) {
    const port = document.createElement('button');
    port.type = 'button';
    port.className = `graph-port ${className}`;
    port.setAttribute('aria-label', label);
    port.title = label;
    return port;
  }

  function minimumNodeSize(element) {
    const style = getComputedStyle(element);
    return {
      width: Number.parseFloat(style.minWidth) || 118,
      height: Number.parseFloat(style.minHeight) || 64,
    };
  }

  function growSurfaceToFit(element) {
    surfaceWidth = Math.max(surfaceWidth, element.offsetLeft + element.offsetWidth + 24);
    surfaceHeight = Math.max(surfaceHeight, element.offsetTop + element.offsetHeight + 24);
    surface.style.width = `${surfaceWidth}px`;
    surface.style.height = `${surfaceHeight}px`;
    edgeLayer.setAttribute('viewBox', `0 0 ${surfaceWidth} ${surfaceHeight}`);
  }

  function resizeNodeTo(element, width, height, minimum = minimumNodeSize(element)) {
    element.style.width = `${Math.round(Math.max(minimum.width, width))}px`;
    element.style.height = `${Math.round(Math.max(minimum.height, height))}px`;
    growSurfaceToFit(element);
    settleNodeCollisions(element.dataset.nodeId);
    if (active) refreshVisualizerMirrors();
    scheduleEdges();
  }

  function moveNodeResize(event) {
    if (!nodeResize || event.pointerId !== nodeResize.pointerId) return;
    nodeResize.clientX = event.clientX;
    nodeResize.clientY = event.clientY;
    if (!nodeResizeFrame) nodeResizeFrame = requestAnimationFrame(flushNodeResize);
  }

  function flushNodeResize() {
    nodeResizeFrame = 0;
    if (!nodeResize) return;
    resizeNodeTo(
      nodeResize.element,
      nodeResize.width + (nodeResize.clientX - nodeResize.startX) / surfaceScale,
      nodeResize.height + (nodeResize.clientY - nodeResize.startY) / surfaceScale,
      nodeResize.minimum,
    );
  }

  function endNodeResize(event) {
    if (!nodeResize || event.pointerId !== nodeResize.pointerId) return;
    if (event.type !== 'lostpointercapture') {
      nodeResize.clientX = event.clientX;
      nodeResize.clientY = event.clientY;
    }
    if (nodeResizeFrame) cancelAnimationFrame(nodeResizeFrame);
    flushNodeResize();
    const { element, handle, songKey } = nodeResize;
    handle.removeEventListener('pointermove', moveNodeResize);
    handle.removeEventListener('pointerup', endNodeResize);
    handle.removeEventListener('pointercancel', endNodeResize);
    handle.removeEventListener('lostpointercapture', endNodeResize);
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    element.classList.remove('is-resizing');
    nodeResize = null;
    if (songKey === getSongKey()) saveAllNodeLayouts();
    if (!flushPendingRender()) scheduleEdges();
  }

  function beginNodeResize(event, element, id, handle) {
    if (event.button !== 0 || drag || nodeResize || rewire) return;
    event.preventDefault();
    event.stopPropagation();
    closeVisualizerPalette();
    nodeResize = {
      pointerId: event.pointerId,
      element,
      handle,
      id,
      songKey: getSongKey(),
      startX: event.clientX,
      startY: event.clientY,
      width: element.offsetWidth,
      height: element.offsetHeight,
      clientX: event.clientX,
      clientY: event.clientY,
      minimum: minimumNodeSize(element),
    };
    element.classList.add('is-resizing');
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', moveNodeResize);
    handle.addEventListener('pointerup', endNodeResize);
    handle.addEventListener('pointercancel', endNodeResize);
    handle.addEventListener('lostpointercapture', endNodeResize);
  }

  function createNodeResizer(element, id) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'graph-node-resizer';
    handle.setAttribute('aria-label', `Resize ${id}`);
    handle.title = `Resize ${id}`;
    handle.innerHTML = `
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M18 8L8 18M18 13L13 18" />
      </svg>`;
    handle.addEventListener('pointerdown', (event) => beginNodeResize(event, element, id, handle));
    handle.addEventListener('keydown', (event) => {
      const direction = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[event.key];
      if (!direction) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 32 : 12;
      resizeNodeTo(
        element,
        element.offsetWidth + direction[0] * step,
        element.offsetHeight + direction[1] * step,
      );
      saveAllNodeLayouts();
    });
    return handle;
  }

  function createCodeNode(model, fallback) {
    const element = document.createElement('article');
    element.className = model.kind === 'declaration'
      ? 'graph-node graph-code-node graph-track-node graph-declaration-node'
      : `graph-node graph-code-node graph-pattern-node graph-notes-node graph-${model.role || 'phrase'}-node`;
    element.classList.toggle('has-musical-code', hasMusicalTokens(model.text));
    element.classList.toggle('graph-arrangement-node', Boolean(model.arrangementEntries?.length));
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
    header.title = `${model.name}\n${roleName}\nDrag node`;
    const identity = document.createElement('span');
    identity.className = 'graph-node-identity';
    identity.textContent = model.name;
    header.append(identity);

    if (model.kind === 'declaration') {
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
      controls.append(mute, solo, addVisualizerButton);
      header.append(controls);
    }

    element.append(header, createSourceMirror(model), createNodeResizer(element, model.name));
    header.addEventListener('pointerdown', (event) => beginNodeDrag(event, element, model.name));
    return element;
  }

  function createVisualizerNode(model, fallback, methodIndex) {
    const element = document.createElement('article');
    element.className = 'graph-node graph-visualizer-node';
    element.dataset.nodeId = model.id;
    element.dataset.method = model.method;
    element.dataset.methodIndex = String(methodIndex);
    element.dataset.visualizerTarget = model.target || '';
    const sourceNode = graph.codeNodes.find((node) => node.name === model.target);
    element.style.setProperty('--pattern-activity-color', sourceNode?.color || '#e6b450');
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
    element.append(canvas, deleteButton, port, createNodeResizer(element, model.id));
    deleteButton.addEventListener('pointerdown', (event) => event.stopPropagation());
    deleteButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      finishDeleteVisualizer(model);
    });
    port.addEventListener('pointerdown', (event) => beginRewire(event, element, model));
    element.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.graph-port, .graph-node-resizer')) return;
      beginNodeDrag(event, element, model.id);
    });
    return element;
  }

  function commitSource(model, source, options = {}) {
    const code = getCode();
    const declaration = model.sourceType === 'track'
      ? buildSongGraph(code).declarations.find((item) => item.name === model.name)
      : parseDeclarations(code).find((item) => item.name === model.name);
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
    saveAllNodeLayouts();
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

  function applyEdgeRenderingScale() {
    const edgeStyle = getComputedStyle(edgeLayer);
    const edgeStrokeWidth = Number.parseFloat(
      edgeStyle.getPropertyValue('--graph-edge-stroke-width'),
    ) || 1.4;
    const activeEdgeStrokeWidth = Number.parseFloat(
      edgeStyle.getPropertyValue('--graph-active-edge-stroke-width'),
    ) || 2.2;
    const screenLaneSeparation = Number.parseFloat(
      edgeStyle.getPropertyValue('--graph-edge-lane-separation'),
    ) || activeEdgeStrokeWidth + .6;
    const bridgeCutoutWidth = Number.parseFloat(
      edgeStyle.getPropertyValue('--graph-bridge-cutout-width'),
    ) || 5.4;
    const routingScale = Math.max(MIN_EDGE_ROUTING_SCALE, surfaceScale);
    const renderScale = Math.min(1, surfaceScale / routingScale);
    edgeLayer.style.setProperty(
      '--graph-edge-render-stroke-width',
      String(edgeStrokeWidth * renderScale),
    );
    edgeLayer.style.setProperty(
      '--graph-active-edge-render-stroke-width',
      String(activeEdgeStrokeWidth * renderScale),
    );
    edgeLayer.style.setProperty(
      '--graph-edge-render-lane-separation',
      String(screenLaneSeparation * renderScale),
    );
    edgeLayer.style.setProperty(
      '--graph-bridge-render-cutout-width',
      String(bridgeCutoutWidth * renderScale),
    );
    return {
      routingScale,
      screenLaneSeparation,
      bridgeCutoutOffset: (bridgeCutoutWidth - edgeStrokeWidth) / (2 * routingScale),
      bridgeInteractionPadding: (bridgeCutoutWidth + activeEdgeStrokeWidth)
        / (2 * routingScale),
    };
  }

  function automaticScale() {
    return Math.max(MIN_GRAPH_SCALE, Math.min(
      1,
      (viewport.clientWidth - GRAPH_STAGE_PADDING * 2) / surfaceWidth,
      (viewport.clientHeight - GRAPH_STAGE_PADDING * 2) / surfaceHeight,
    ));
  }

  function applyGraphCamera() {
    if (destroyed || !surfaceWidth || !surfaceHeight) return;
    surfaceScale = zoomTargetScale;
    applyEdgeRenderingScale();
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
    background.setCamera(cameraX, cameraY, surfaceScale);
    refreshVisualizerMirrors();
  }

  function settleGraphCamera() {
    cameraSettleTimer = 0;
    viewport.classList.remove('is-camera-moving');
    applyGraphCamera();
    scheduleEdges();
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

  function flushPendingRender() {
    if (!renderPending) return false;
    renderPending = false;
    render();
    return true;
  }

  function render() {
    // Queued render timers and retained button handlers can fire after
    // destroy(); rendering then would restart the mirror RAF loop for good.
    if (destroyed) return;
    if (drag || nodeResize || rewire) {
      renderPending = true;
      return;
    }
    renderPending = false;
    closeVisualizerPalette();
    const code = getCode();
    graph = buildSongGraph(code);
    renderedCode = code;
    renderedSongKey = getSongKey();
    const automatic = automaticLayout(graph, viewport.clientWidth, viewport.clientHeight);
    mergedLayout(automatic);
    nodeElements = new Map();
    sourceTokens = new Map();
    paintedTokens = new Map();
    paintedEdges = new Set();
    edgeElementsById = new Map();
    arrangementPaintSignature = null;
    nodeLayer.replaceChildren();
    edgeLayer.replaceChildren();
    edgeLayoutSignature = '';
    edgeRenderSignature = '';
    edgeRoutes = [];
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.nodeId;
        if (active && id && !drag && !nodeResize) saveElementLayout(id, entry.target);
      }
      if (active) {
        refreshVisualizerMirrors();
        scheduleEdges();
      }
    });

    const nodes = document.createDocumentFragment();
    for (const model of graph.codeNodes) {
      const element = createCodeNode(model, automatic[model.name]);
      nodes.appendChild(element);
      nodeElements.set(model.name, element);
      resizeObserver.observe(element);
    }
    const methodCounts = new Map();
    for (const model of graph.visualizers) {
      if (!automatic[model.id]) continue;
      const methodIndex = methodCounts.get(model.method) || 0;
      methodCounts.set(model.method, methodIndex + 1);
      const element = createVisualizerNode(model, automatic[model.id], methodIndex);
      nodes.appendChild(element);
      nodeElements.set(model.id, element);
      resizeObserver.observe(element);
    }
    nodeLayer.appendChild(nodes);

    if (settleNodeCollisions()) saveAllNodeLayouts();
    cancelAnimationFrame(collisionSettleFrame);
    collisionSettleFrame = requestAnimationFrame(() => {
      collisionSettleFrame = 0;
      if (settleNodeCollisions()) saveAllNodeLayouts();
      scheduleEdges();
    });

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
    if (active) refreshVisualizerMirrors();
    renderPerformanceState();
  }

  function paintSectionSegment(entry, { current, cycle, canStartOnDoubleClick }) {
    const { segment, section: model } = entry;
    const isCurrent = model.name === current?.name;
    const isQueued = model.name === performanceState.queuedSection;
    const isLooped = model.name === performanceState.loopedSection;
    const progress = isCurrent
      ? Math.max(0, Math.min(1, (cycle - model.start) / Math.max(1, model.end - model.start)))
      : 0;
    const progressValue = `${(progress * 100).toFixed(2)}%`;
    if (entry.progressValue !== progressValue) {
      entry.progressValue = progressValue;
      segment.style.setProperty('--section-progress', progressValue);
    }
    const stateKey = `${isCurrent}|${isQueued}|${isLooped}|${canStartOnDoubleClick}`;
    if (entry.stateKey === stateKey) return;
    entry.stateKey = stateKey;
    segment.classList.toggle('is-current', isCurrent);
    segment.classList.toggle('is-queued', isQueued);
    segment.classList.toggle('is-looped', isLooped);
    segment.setAttribute('aria-label', `${segment.dataset.section}${isCurrent ? ', current section' : ''}${isQueued ? ', queued' : ''}${isLooped ? ', looping' : ''}`);
    const jumpButton = segment.querySelector('.graph-section-jump');
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

  function renderPerformanceState() {
    const sections = performanceState.sections || [];
    const signature = sections.map(({ name, start, end }) => `${name}:${start}:${end}`).join('|');
    if (signature !== sectionSignature) {
      sectionSignature = signature;
      sectionSegments = [];
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
          if (startNow) {
            performanceState = {
              ...performanceState,
              queuedSection: null,
            };
            renderPerformanceState();
            onPlaySection(section.name);
            return;
          }
          const jumpNow = performanceState.playing
            && performanceState.queuedSection === section.name;
          if (!performanceState.playing && getSelectedSectionName?.() === section.name) {
            // Clicking the already-selected section while stopped clears the
            // selection back to the full song.
            onSelectSection('Full song');
            return;
          }
          performanceState = {
            ...performanceState,
            queuedSection: jumpNow ? null : section.name,
          };
          renderPerformanceState();
          onSelectSection(section.name, { immediate: jumpNow });
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
        sectionSegments.push({ segment, section, progressValue: '', stateKey: '' });
      }
      sectionStrip.replaceChildren(fragment);
    }

    const totalCycles = Math.max(0, ...sections.map(({ end }) => end));
    const cycle = totalCycles
      ? ((Number(performanceState.cycle) % totalCycles) + totalCycles) % totalCycles
      : 0;
    const current = performanceState.currentSection || sectionAtCycle(sections, cycle);
    const nextSectionName = current?.name || 'No arrangement';
    if (sectionName.textContent !== nextSectionName) sectionName.textContent = nextSectionName;
    const canStartOnDoubleClick = !performanceState.playing || performanceState.paused;
    // This runs on every 20Hz meter tick during playback; only the current
    // segment's progress actually changes per tick, so skip identical writes.
    for (const entry of sectionSegments) {
      paintSectionSegment(entry, { current, cycle, canStartOnDoubleClick });
    }
    paintArrangementProgress(cycle);
  }

  function appendEdgeMasks(fragment, underpassCutouts, bridgeOverlayCutouts) {
    if (underpassCutouts.some((cutouts) => cutouts.length)
      || bridgeOverlayCutouts.some((cutouts) => cutouts.length)) {
      const definitions = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const appendMask = (id, cutouts) => {
        const mask = document.createElementNS('http://www.w3.org/2000/svg', 'mask');
        mask.id = id;
        mask.setAttribute('maskUnits', 'userSpaceOnUse');
        mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
        mask.setAttribute('x', '0');
        mask.setAttribute('y', '0');
        mask.setAttribute('width', String(surfaceWidth));
        mask.setAttribute('height', String(surfaceHeight));
        const field = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        field.setAttribute('width', String(surfaceWidth));
        field.setAttribute('height', String(surfaceHeight));
        field.setAttribute('fill', 'white');
        mask.appendChild(field);
        const cutout = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        cutout.setAttribute('d', cutouts.join(' '));
        cutout.setAttribute('class', 'graph-edge-underpass-cutout');
        cutout.setAttribute('fill', 'none');
        cutout.setAttribute('stroke', 'black');
        cutout.setAttribute('stroke-linecap', 'round');
        cutout.setAttribute('vector-effect', 'non-scaling-stroke');
        mask.appendChild(cutout);
        definitions.appendChild(mask);
      };
      underpassCutouts.forEach((cutouts, edgeIndex) => {
        if (cutouts.length) appendMask(`${edgeMaskPrefix}-${edgeIndex}`, cutouts);
      });
      bridgeOverlayCutouts.forEach((cutouts, edgeIndex) => {
        if (cutouts.length) appendMask(`${edgeMaskPrefix}-bridge-${edgeIndex}`, cutouts);
      });
      fragment.appendChild(definitions);
    }
  }

  function createEdgePath(edge, route, crossings, cutouts, edgeIndex) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', orthogonalPath(route, crossings));
    path.setAttribute('class', edge.to.startsWith('visualizer:') ? 'graph-edge graph-visual-edge' : 'graph-edge');
    if (cutouts.length) {
      path.setAttribute('mask', `url(#${edgeMaskPrefix}-${edgeIndex})`);
      path.dataset.underpasses = String(cutouts.length);
    }
    path.dataset.edgeId = edge.id;
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;
    path.dataset.route = JSON.stringify(route);
    path.dataset.crossings = String(crossings.length);
    return path;
  }

  function createBridgePath(edge, bridgePaths, cutouts, edgeIndex) {
    const bridge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    bridge.setAttribute('d', bridgePaths.join(' '));
    bridge.setAttribute('class', edge.to.startsWith('visualizer:')
      ? 'graph-edge graph-visual-edge graph-edge-bridge-overlay'
      : 'graph-edge graph-edge-bridge-overlay');
    if (cutouts.length) {
      bridge.setAttribute('mask', `url(#${edgeMaskPrefix}-bridge-${edgeIndex})`);
      bridge.dataset.underpasses = String(cutouts.length);
    }
    bridge.dataset.bridgeEdgeId = edge.id;
    bridge.dataset.from = edge.from;
    bridge.dataset.to = edge.to;
    return bridge;
  }

  function appendRewirePath(fragment) {
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

  function indexEdgeElements() {
    const index = new Map();
    for (const path of edgeLayer.querySelectorAll('.graph-edge')) {
      const edgeId = path.dataset.edgeId || path.dataset.bridgeEdgeId;
      if (!edgeId) continue;
      const elements = index.get(edgeId) || [];
      elements.push(path);
      index.set(edgeId, elements);
    }
    return index;
  }

  function drawEdges() {
    edgeFrame = 0;
    if (!active && !rewire) return;
    const fragment = document.createDocumentFragment();
    const rectangles = [...nodeElements].map(([id, element]) => ({
      id,
      left: element.offsetLeft,
      right: element.offsetLeft + element.offsetWidth,
      top: element.offsetTop,
      bottom: element.offsetTop + element.offsetHeight,
    }));
    const bounds = { left: 8, right: surfaceWidth - 8, top: 8, bottom: surfaceHeight - 8 };
    const {
      routingScale,
      screenLaneSeparation,
      bridgeCutoutOffset,
      bridgeInteractionPadding,
    } = applyEdgeRenderingScale();
    const minimumLaneSeparation = screenLaneSeparation / routingScale;
    const layoutSignature = JSON.stringify({
      bounds,
      rectangles,
      edges: graph.edges.map(({ id, from, to }) => [id, from, to]),
      screenLaneSeparation,
    });
    const renderSignature = JSON.stringify({
      layoutSignature,
      bridgeCutoutOffset,
      bridgeInteractionPadding,
    });
    const layoutChanged = layoutSignature !== edgeLayoutSignature
      || edgeRoutes.length !== graph.edges.length;
    if (!rewire && !layoutChanged && renderSignature === edgeRenderSignature
      && edgeLayer.childElementCount) {
      paintActivity(lastActivations);
      paintArrangementProgress(performanceState.cycle);
      return;
    }
    if (layoutChanged) {
      edgeRoutes = routeOrthogonalEdges(rectangles, graph.edges, {
        clearance: 12,
        bounds,
        minimumLaneSeparation,
      });
    }
    const routes = edgeRoutes;
    const {
      crossingsByEdge,
      underpassCutouts,
      bridgePathsByEdge,
      bridgeOverlayCutouts,
    } = planOrthogonalBridges(routes, {
      interactionPadding: bridgeInteractionPadding,
      cutoutOffset: bridgeCutoutOffset,
    });
    appendEdgeMasks(fragment, underpassCutouts, bridgeOverlayCutouts);
    for (let edgeIndex = 0; edgeIndex < graph.edges.length; edgeIndex++) {
      fragment.appendChild(createEdgePath(
        graph.edges[edgeIndex],
        routes[edgeIndex],
        crossingsByEdge[edgeIndex],
        underpassCutouts[edgeIndex],
        edgeIndex,
      ));
    }
    for (let edgeIndex = 0; edgeIndex < graph.edges.length; edgeIndex++) {
      if (!bridgePathsByEdge[edgeIndex].length) continue;
      fragment.appendChild(createBridgePath(
        graph.edges[edgeIndex],
        bridgePathsByEdge[edgeIndex],
        bridgeOverlayCutouts[edgeIndex],
        edgeIndex,
      ));
    }
    if (rewire) appendRewirePath(fragment);
    edgeLayer.replaceChildren(fragment);
    edgeLayoutSignature = layoutSignature;
    edgeRenderSignature = renderSignature;
    arrangementPaintSignature = null;
    paintedEdges = new Set();
    edgeElementsById = indexEdgeElements();
    paintActivity(lastActivations);
    paintArrangementProgress(performanceState.cycle);
  }

  function scheduleEdges() {
    clearTimeout(edgeTimer);
    if (edgeFrame) cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
    edgeTimer = window.setTimeout(() => {
      edgeTimer = 0;
      edgeFrame = requestAnimationFrame(drawEdges);
    }, 80);
  }

  function paintSoundingNodes(state) {
    for (const [id, element] of nodeElements) {
      const sounding = state.activeNodes.has(id);
      element.classList.toggle('is-sounding', sounding);
    }
  }

  function paintSoundingEdges(state) {
    for (const [edgeId, elements] of edgeElementsById) {
      const sounding = state.activeEdges.has(edgeId);
      if (sounding === paintedEdges.has(edgeId)) continue;
      if (sounding) {
        paintedEdges.add(edgeId);
        const edge = graph.edges.find((item) => item.id === edgeId);
        const child = graph.codeNodes.find((node) => node.name === edge?.to)
          || graph.codeNodes.find((node) => node.name === edge?.from);
        for (const element of elements) {
          element.classList.add('is-sounding-edge');
          element.style.setProperty('--edge-note-color', child?.color || '#ffffff');
        }
      } else {
        paintedEdges.delete(edgeId);
        for (const element of elements) {
          element.classList.remove('is-sounding-edge');
          element.style.removeProperty('--edge-note-color');
        }
      }
    }
  }

  function collectActiveTokens(activations) {
    const nextTokens = new Map();
    for (const activation of activations) {
      for (const token of sourceTokens.get(tokenKey(activation.from, activation.to)) || []) {
        nextTokens.set(token, activation);
      }
    }
    return nextTokens;
  }

  function paintTokenActivity(nextTokens) {
    for (const token of paintedTokens.keys()) {
      if (!nextTokens.has(token)) {
        token.classList.remove('is-active-note', 'is-note-onset');
        paintedTokens.delete(token);
      }
    }
    const scrollChecks = [];
    for (const [token, activation] of nextTokens) {
      const previous = paintedTokens.get(token);
      const onset = Boolean(activation.onset);
      const color = activation.color || '#ffffff';
      if (!previous) {
        token.classList.add('is-active-note');
        paintedTokens.set(token, { onset: false, color: '' });
      }
      const painted = previous || paintedTokens.get(token);
      if (painted.onset !== onset) token.classList.toggle('is-note-onset', onset);
      if (painted.color !== color) token.style.setProperty('--note-activation-color', color);
      if (!previous || (!painted.onset && onset)) scrollChecks.push(token);
      painted.onset = onset;
      painted.color = color;
    }
    return scrollChecks;
  }

  function collectScrollWrites(scrollChecks) {
    const scrollWrites = [];
    for (const token of scrollChecks) {
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
        scrollWrites.push({
          wrapper,
          top: (tokenRect.top - wrapperRect.top - (wrapperRect.height - tokenRect.height) / 2) / surfaceScale,
          left: (tokenRect.left - wrapperRect.left - (wrapperRect.width - tokenRect.width) / 2) / surfaceScale,
        });
      }
    }
    return scrollWrites;
  }

  function paintActivity(activations) {
    const state = resolveGraphActivity(graph, activations);
    paintSoundingNodes(state);
    paintSoundingEdges(state);
    // This runs on every activity frame during playback. Diff against the
    // previously painted tokens instead of clearing every token each frame,
    // and keep rect reads ahead of scroll writes so layout flushes once.
    const nextTokens = collectActiveTokens(activations);
    const scrollChecks = paintTokenActivity(nextTokens);
    const scrollWrites = collectScrollWrites(scrollChecks);
    for (const write of scrollWrites) {
      write.wrapper.scrollTop += write.top;
      write.wrapper.scrollLeft += write.left;
    }
  }

  function paintArrangementProgress(cycle) {
    const playback = resolveArrangementPlayback(graph, cycle, performanceState.playing);
    // Active sets only change at cycle boundaries, but this is called on every
    // 20Hz meter tick; skip the DOM pass while they are unchanged. Paths that
    // rebuild the painted elements reset arrangementPaintSignature to null.
    const signature = `${[...playback.activeEdges].join(',')}|${[...playback.activeEntries].join(',')}|${[...playback.activeNodes].join(',')}`;
    if (signature === arrangementPaintSignature) return;
    arrangementPaintSignature = signature;
    const edges = [...edgeLayer.querySelectorAll('.graph-edge')];
    for (const edge of edges) {
      const edgeId = edge.dataset.edgeId || edge.dataset.bridgeEdgeId;
      const active = playback.activeEdges.has(edgeId);
      edge.classList.toggle('is-active-arrangement-edge', active);
      if (active) {
        const dependency = graph.codeNodes.find((node) => node.name === edge.dataset.to);
        edge.style.setProperty('--edge-activity-color', dependency?.color || '#e6b450');
      } else edge.style.removeProperty('--edge-activity-color');
    }
    for (const element of nodeElements.values()) {
      const nodeId = element.dataset.nodeId;
      const playbackNodeId = element.classList.contains('graph-visualizer-node')
        ? element.dataset.visualizerTarget
        : nodeId;
      const followsPlayback = element.classList.contains('graph-code-node')
        || element.classList.contains('graph-visualizer-node');
      element.classList.toggle(
        'is-arrangement-playing',
        followsPlayback && playback.activeNodes.has(playbackNodeId),
      );
      if (!element.classList.contains('graph-arrangement-node')) continue;
      let hasActiveEntry = false;
      for (const entry of element.querySelectorAll('.graph-arrangement-entry')) {
        const active = playback.activeEntries.has(arrangementEntryId(nodeId, {
          lane: entry.dataset.lane,
          start: entry.dataset.cycleStart,
          end: entry.dataset.cycleEnd,
          dependency: entry.dataset.dependency,
        }));
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
    if (event.button !== 0 || drag || nodeResize || rewire) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      element,
      id,
      songKey: getSongKey(),
      startX: event.clientX,
      startY: event.clientY,
      left: element.offsetLeft,
      top: element.offsetTop,
      clientX: event.clientX,
      clientY: event.clientY,
      layout: readNodeLayouts(),
    };
    element.classList.add('is-dragging');
    element.setPointerCapture(event.pointerId);
    element.addEventListener('pointermove', moveNode);
    element.addEventListener('pointerup', endNodeDrag, { once: true });
    element.addEventListener('pointercancel', endNodeDrag, { once: true });
    element.addEventListener('lostpointercapture', endNodeDrag, { once: true });
  }

  function moveNode(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (!dragFrame) dragFrame = requestAnimationFrame(flushNodeDrag);
  }

  function flushNodeDrag() {
    dragFrame = 0;
    if (!drag) return;
    const before = drag.layout;
    const x = clampPosition(drag.left + (drag.clientX - drag.startX) / surfaceScale);
    const y = clampPosition(drag.top + (drag.clientY - drag.startY) / surfaceScale);
    const proposed = {
      ...before,
      [drag.id]: { ...before[drag.id], x, y },
    };
    const resolved = resolveNodeCollisions(proposed, {
      fixedIds: [drag.id],
      gap: NODE_GAP,
    });
    if (applyNodeLayouts(before, resolved)) scheduleEdges();
    drag.layout = resolved;
  }

  function endNodeDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.type !== 'lostpointercapture') {
      drag.clientX = event.clientX;
      drag.clientY = event.clientY;
    }
    if (dragFrame) cancelAnimationFrame(dragFrame);
    flushNodeDrag();
    const { element, pointerId, songKey } = drag;
    element.removeEventListener('pointermove', moveNode);
    element.removeEventListener('pointerup', endNodeDrag);
    element.removeEventListener('pointercancel', endNodeDrag);
    element.removeEventListener('lostpointercapture', endNodeDrag);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    element.classList.remove('is-dragging');
    drag = null;
    if (songKey === getSongKey()) saveAllNodeLayouts();
    if (!flushPendingRender()) scheduleEdges();
  }

  function pointerInSurface(event) {
    const rect = surface.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / surfaceScale,
      y: (event.clientY - rect.top) / surfaceScale,
    };
  }

  function beginRewire(event, element, model) {
    if (event.button !== 0 || drag || nodeResize || rewire) return;
    event.preventDefault();
    event.stopPropagation();
    rewire = { model, pointerId: event.pointerId, pointer: pointerInSurface(event) };
    element.setPointerCapture(event.pointerId);
    element.addEventListener('pointermove', moveRewire);
    element.addEventListener('pointerup', endRewire, { once: true });
    element.addEventListener('pointercancel', cancelRewire, { once: true });
    element.addEventListener('lostpointercapture', cancelRewire, { once: true });
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
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.graph-track-node');
    if (target?.dataset.sourceName) finishRewire(element, target.dataset.sourceName);
    else cleanupRewire(element);
  }

  function cancelRewire(event) {
    cleanupRewire(event.currentTarget);
  }

  function cleanupRewire(element) {
    const pointerId = rewire?.pointerId;
    element.removeEventListener('pointermove', moveRewire);
    element.removeEventListener('pointerup', endRewire);
    element.removeEventListener('pointercancel', cancelRewire);
    element.removeEventListener('lostpointercapture', cancelRewire);
    if (pointerId != null && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
    rewire = null;
    root.classList.remove('is-connecting');
    if (!flushPendingRender()) scheduleEdges();
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

  function setBackgroundMode(id, { persist = true } = {}) {
    const mode = resolveBackgroundMode(id);
    background.setMode(mode.id);
    root.dataset.background = mode.id;
    backgroundLabel.textContent = mode.label;
    backgroundToggle.setAttribute('aria-label', `Graph background: ${mode.label}. Change background`);
    backgroundToggle.title = `Background: ${mode.label} (click to change)`;
    if (persist) localStorage.setItem(BACKGROUND_KEY, mode.id);
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
      refreshVisualizerMirrors();
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

  function refreshVisualizerMirrors() {
    if (destroyed) return;
    graphVisibleCanvases.clear();
    const nextMirrors = [];
    if (active && visualizersEnabled && surfaceScale > 0) {
      const bounds = graphViewportBounds({
        cameraX,
        cameraY,
        scale: surfaceScale,
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
      });
      const registryByMethod = new Map();
      for (const entry of visualizerRegistry()) {
        const entries = registryByMethod.get(entry.method) || [];
        entries.push(entry);
        registryByMethod.set(entry.method, entries);
      }
      for (const element of nodeElements.values()) {
        if (!element.classList.contains('graph-visualizer-node')) continue;
        if (!graphRectIsVisible({
          x: element.offsetLeft,
          y: element.offsetTop,
          width: element.offsetWidth,
          height: element.offsetHeight,
        }, bounds)) continue;
        const sources = registryByMethod.get(element.dataset.method);
        const source = sources?.[Number(element.dataset.methodIndex)]?.canvas;
        const target = element.querySelector('canvas');
        if (!source || !target) continue;
        graphVisibleCanvases.add(source);
        nextMirrors.push({ source, target });
      }
    }
    visibleVisualizerMirrors = nextMirrors;
    if (!nextMirrors.length) {
      if (mirrorFrame) cancelAnimationFrame(mirrorFrame);
      mirrorFrame = 0;
      return;
    }
    if (!mirrorFrame) {
      lastMirror = -Infinity;
      mirrorFrame = requestAnimationFrame(mirrorVisualizers);
    }
  }

  function mirrorVisualizers(time) {
    mirrorFrame = 0;
    if (!active || !visualizersEnabled || !visibleVisualizerMirrors.length) return;
    if (time - lastMirror < 48) {
      mirrorFrame = requestAnimationFrame(mirrorVisualizers);
      return;
    }
    lastMirror = time;
    for (const { source, target } of visibleVisualizerMirrors) {
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

  function stopMirrors() {
    if (mirrorFrame) cancelAnimationFrame(mirrorFrame);
    mirrorFrame = 0;
    visibleVisualizerMirrors = [];
    graphVisibleCanvases.clear();
  }

  function setMode(mode) {
    if (destroyed) return;
    active = mode === 'graph';
    globalThis.__stroodGraphVisualizersActive = active;
    lens.hide();
    root.hidden = !active;
    background.setActive(active);
    editors.hidden = active;
    codeButton.setAttribute('aria-pressed', String(!active));
    graphButton.setAttribute('aria-pressed', String(active));
    localStorage.setItem(VIEW_KEY, active ? 'graph' : 'code');
    closeVisualizerPalette();
    if (active) {
      if (renderedCode !== getCode() || renderedSongKey !== getSongKey()) {
        render();
      } else {
        renderPerformanceState();
        if (hasCustomScale) applyGraphCamera();
        else fitGraph();
        scheduleEdges();
      }
      refreshVisualizerMirrors();
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

  const handleCodeModeClick = () => setMode('code');
  const handleGraphModeClick = () => setMode('graph');
  codeButton.addEventListener('click', handleCodeModeClick);
  graphButton.addEventListener('click', handleGraphModeClick);
  const handleVisualizersToggle = () => setVisualizersEnabled(!visualizersEnabled);
  visualizersToggle.addEventListener('click', handleVisualizersToggle);
  const handleBackgroundToggle = () => setBackgroundMode(cycleBackgroundMode(background.mode));
  backgroundToggle.addEventListener('click', handleBackgroundToggle);
  const relayoutButton = root.querySelector('.graph-relayout');
  const handleRelayout = () => {
    writeLayout(getSongKey(), {});
    hasCustomScale = false;
    render();
  };
  relayoutButton.addEventListener('click', handleRelayout);
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
  document.addEventListener('strood:visualizer-canvas', refreshVisualizerMirrors);
  document.addEventListener('strood:note-activity', handleNoteActivity);
  const handleViewportResize = () => {
    scheduleEdges();
    if (hasCustomScale) applyGraphCamera();
    else fitGraph();
  };
  window.addEventListener('resize', handleViewportResize);

  setVisualizersEnabled(visualizersEnabled, { persist: false });
  setBackgroundMode(localStorage.getItem(BACKGROUND_KEY) || 'sky', { persist: false });
  // Boot into the lightweight editor. Restoring a large graph before the
  // first user gesture can monopolise Safari's main thread for seconds.
  setMode('code');

  return {
    setMode,
    setPerformanceState: (next) => {
      performanceState = { ...performanceState, ...next };
      if (active) renderPerformanceState();
    },
    refresh: () => active && render(),
    scheduleRefresh,
    destroy: () => {
      destroyed = true;
      globalThis.__stroodGraphVisualizersActive = false;
      lens.destroy();
      codeButton.removeEventListener('click', handleCodeModeClick);
      graphButton.removeEventListener('click', handleGraphModeClick);
      clearTimeout(refreshTimer);
      clearTimeout(edgeTimer);
      cancelAnimationFrame(edgeFrame);
      clearTimeout(cameraSettleTimer);
      cancelAnimationFrame(zoomFrame);
      cancelAnimationFrame(collisionSettleFrame);
      cancelAnimationFrame(dragFrame);
      cancelAnimationFrame(nodeResizeFrame);
      resizeObserver?.disconnect();
      clearTimeout(activityExpiryTimer);
      stopMirrors();
      closeVisualizerPalette();
      palette.remove();
      background.destroy();
      backgroundToggle.removeEventListener('click', handleBackgroundToggle);
      relayoutButton.removeEventListener('click', handleRelayout);
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
      document.removeEventListener('strood:visualizer-canvas', refreshVisualizerMirrors);
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
