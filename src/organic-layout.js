/**
 * Organic force-directed graph layout.
 *
 * A spring embedder rather than a grid: edges pull their endpoints toward an
 * ideal length, every pair of nodes repels, and a weak anisotropic gravity
 * holds the cloud together while favouring landscape spreads. Clusters and
 * short edges emerge from the forces instead of being imposed as ranks or
 * rows. The result is deterministic — initial positions come from a seeded
 * generator, never Math.random — so the same song always settles into the
 * same shape.
 *
 * Hard guarantees layered on top of the physics: no node overlaps, and every
 * gap between neighbouring nodes is wide enough for the orthogonal edge
 * router's clearance, which needs 12px each side of a passage.
 */

const ITERATIONS = 420;
const FIT_MARGIN = 24;
const START_TEMPERATURE = 110;
const END_TEMPERATURE = 2;
const CORRIDOR_GAP = 28;
const SEPARATION_ROUNDS = 400;
const SNAP = 32;
const PADDING = 32;

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function hashIds(nodes) {
  let hash = 2166136261;
  for (const node of nodes) {
    for (let index = 0; index < node.id.length; index++) {
      hash ^= node.id.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

/** Breadth-first order over components so connected nodes seed near each other. */
function seedingOrder(nodes, neighbours) {
  const visited = new Set();
  const order = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const queue = [node.id];
    visited.add(node.id);
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const next of neighbours.get(id) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return order;
}

/** Adjacency, self-loop-free links, and the node pairs that share a hub. */
function buildGraph(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbours = new Map(nodes.map((node) => [node.id, new Set()]));
  const links = [];
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
    neighbours.get(edge.from).add(edge.to);
    neighbours.get(edge.to).add(edge.from);
    links.push([edge.from, edge.to]);
  }

  const siblings = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const [, hubNeighbours] of neighbours) {
    const list = [...hubNeighbours];
    for (let left = 0; left < list.length; left++) {
      for (let right = left + 1; right < list.length; right++) {
        siblings.get(list[left]).add(list[right]);
        siblings.get(list[right]).add(list[left]);
      }
    }
  }

  return { byId, neighbours, links, siblings };
}

/** Seed a golden-angle spiral in breadth-first order, jittered by the seeded RNG. */
function seedPositions(nodes, neighbours, random) {
  const position = new Map();
  const golden = Math.PI * (3 - Math.sqrt(5));
  seedingOrder(nodes, neighbours).forEach((id, index) => {
    const distance = 90 * Math.sqrt(index + 1);
    const angle = index * golden + random() * 0.35;
    position.set(id, {
      x: Math.cos(angle) * distance * 1.4,
      y: Math.sin(angle) * distance,
    });
  });
  return position;
}

function separationSweep({ ids, byId, position, random }, overshoot) {
  let moved = false;
  for (let left = 0; left < ids.length; left++) {
    for (let right = left + 1; right < ids.length; right++) {
      const nodeA = byId.get(ids[left]);
      const nodeB = byId.get(ids[right]);
      const a = position.get(ids[left]);
      const b = position.get(ids[right]);
      const overlapX = (nodeA.width + nodeB.width) / 2 + CORRIDOR_GAP - Math.abs(a.x - b.x);
      const overlapY = (nodeA.height + nodeB.height) / 2 + CORRIDOR_GAP - Math.abs(a.y - b.y);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 1) {
        dx = random() - 0.5;
        dy = random() - 0.5;
      }
      // Resolve along the axis that needs the smaller push, with a bias
      // toward horizontal pushes so crowding grows the drawing sideways
      // into the landscape viewport rather than downwards.
      if (overlapX <= overlapY * 1.45) {
        const direction = dx >= 0 ? 1 : -1;
        a.x += direction * (overlapX / 2 + overshoot);
        b.x -= direction * (overlapX / 2 + overshoot);
      } else {
        const direction = dy >= 0 ? 1 : -1;
        a.y += direction * (overlapY / 2 + overshoot);
        b.y -= direction * (overlapY / 2 + overshoot);
      }
    }
  }
  return moved;
}

function applyRepulsion({ ids, position, random }, physics, force) {
  const { radius, siblings, repulsionScale, repulsionCutoff } = physics;
  for (let left = 0; left < ids.length; left++) {
    for (let right = left + 1; right < ids.length; right++) {
      const a = position.get(ids[left]);
      const b = position.get(ids[right]);
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 1) {
        dx = random() - 0.5;
        dy = random() - 0.5;
        distance = 1;
      }
      const reachSum = radius.get(ids[left]) + radius.get(ids[right]);
      // Short-range repulsion: it sets neighbour spacing, while the springs
      // set cluster structure and weak gravity binds loose components.
      if (distance > reachSum * repulsionCutoff) continue;
      const reach = reachSum * repulsionScale;
      let push = reach * reach / distance;
      // Siblings around a shared hub may pack tighter, so fan-outs settle
      // into snug rings instead of wide halos.
      if (siblings.get(ids[left])?.has(ids[right])) push *= 0.45;
      const forceA = force.get(ids[left]);
      const forceB = force.get(ids[right]);
      forceA.x += (dx / distance) * push;
      forceA.y += (dy / distance) * push;
      forceB.x -= (dx / distance) * push;
      forceB.y -= (dy / distance) * push;
    }
  }
}

function applySprings({ position }, physics, force) {
  const { links, radius, springStrength, edgeSlack } = physics;
  for (const [from, to] of links) {
    const a = position.get(from);
    const b = position.get(to);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ideal = radius.get(from) + radius.get(to) + edgeSlack;
    const pull = springStrength * (distance - ideal);
    const forceA = force.get(from);
    const forceB = force.get(to);
    forceA.x -= (dx / distance) * pull;
    forceA.y -= (dy / distance) * pull;
    forceB.x += (dx / distance) * pull;
    forceB.y += (dy / distance) * pull;
  }
}

// Gravity tapers to zero so the simulation ends in a corridor-clean
// state: pressure that persists into the final iterations leaves
// violations for the convergence rounds, whose pushes then balloon the
// drawing with nothing left to pull it back.
function integrate({ ids, position }, physics, force, temperature, gravityDecay) {
  const { gravityX, gravityY } = physics;
  for (const id of ids) {
    const point = position.get(id);
    const nudge = force.get(id);
    nudge.x -= point.x * gravityX * gravityDecay;
    nudge.y -= point.y * gravityY * gravityDecay;
    const magnitude = Math.hypot(nudge.x, nudge.y);
    const step = Math.min(magnitude, temperature);
    if (magnitude > 0.01) {
      point.x += (nudge.x / magnitude) * step;
      point.y += (nudge.y / magnitude) * step;
    }
  }
}

function simulate(state, physics) {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const progress = iteration / (ITERATIONS - 1);
    const temperature = START_TEMPERATURE
      * (END_TEMPERATURE / START_TEMPERATURE) ** progress;
    const force = new Map(state.ids.map((id) => [id, { x: 0, y: 0 }]));

    applyRepulsion(state, physics, force);
    applySprings(state, physics, force);
    integrate(state, physics, force, temperature, 1 - progress);
    // Resolving overlaps inside the loop lets the springs keep re-asserting
    // cluster structure against every push; a lone pass at the end would
    // shuffle a crowded region without any regard for the edges. In-sim
    // resolution is exact — any overshoot here acts as an expansion pump
    // against gravity, inflating the whole drawing.
    separationSweep(state, 0);
  }

  // Convergence rounds guarantee the router-sized corridor between every
  // pair once the springs have had their final say.
  for (let round = 0; round < SEPARATION_ROUNDS; round++) {
    if (!separationSweep(state, 1)) break;
  }
}

function boundsOf({ ids, byId, position }) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const node = byId.get(id);
    const point = position.get(id);
    minX = Math.min(minX, point.x - node.width / 2);
    maxX = Math.max(maxX, point.x + node.width / 2);
    minY = Math.min(minY, point.y - node.height / 2);
    maxY = Math.max(maxY, point.y + node.height / 2);
  }
  return { minX, minY, maxX, maxY };
}

function fitOf(state, viewport) {
  const { minX, minY, maxX, maxY } = boundsOf(state);
  return Math.min(
    1,
    (viewport.width - FIT_MARGIN) / (maxX - minX + PADDING * 2),
    (viewport.height - FIT_MARGIN) / (maxY - minY + PADDING * 2),
  );
}

// Compaction: repeatedly shrink the whole drawing toward its centroid and
// let the corridor separation push it back apart. The arrangement (and so
// the organic look) is preserved; only the slack between clusters goes.
function compact(state, viewport) {
  const { ids, position } = state;
  let bestFit = fitOf(state, viewport);
  let bestPositions = new Map([...position].map(([id, point]) => [id, { ...point }]));
  for (let pass = 0; pass < 20; pass++) {
    let centroidX = 0;
    let centroidY = 0;
    for (const point of position.values()) {
      centroidX += point.x;
      centroidY += point.y;
    }
    centroidX /= ids.length;
    centroidY /= ids.length;
    for (const point of position.values()) {
      point.x = centroidX + (point.x - centroidX) * 0.92;
      point.y = centroidY + (point.y - centroidY) * 0.92;
    }
    for (let round = 0; round < SEPARATION_ROUNDS; round++) {
      if (!separationSweep(state, 1)) break;
    }
    const fit = fitOf(state, viewport);
    if (fit > bestFit + 0.0005) {
      bestFit = fit;
      bestPositions = new Map([...position].map(([id, point]) => [id, { ...point }]));
    }
  }
  for (const [id, point] of bestPositions) {
    const live = position.get(id);
    live.x = point.x;
    live.y = point.y;
  }
}

// Expand-only normalisation toward the viewport aspect, so the fitted zoom
// fills the screen. Expansion can only widen gaps, never close them.
function normaliseAspect(state, viewport) {
  const { ids, position } = state;
  const { minX, minY, maxX, maxY } = boundsOf(state);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  // The app fits with extra stage padding beyond this module's margin
  // model, so large graphs aim slightly wider than the raw viewport aspect
  // to actually fill the screen once fitted.
  const targetAspect = (viewport.width / Math.max(1, viewport.height)) * 1.1;
  const aspect = spanX / spanY;
  let scaleX = 1;
  let scaleY = 1;
  if (aspect < targetAspect) scaleX = Math.min(1.8, targetAspect / aspect);
  else scaleY = Math.min(1.8, aspect / targetAspect);
  // Small and mid-sized graphs must stay readable at the fitted zoom:
  // graphs that fit above SCALE_FLOOR may expand down to it, graphs in the
  // readable band below it give up screen-filling rather than zoom, and
  // only genuinely large graphs trade zoom for fill.
  const SCALE_FLOOR = 0.62;
  const READABLE_BAND = 0.45;
  const baseFit = Math.min(
    1,
    (viewport.width - FIT_MARGIN) / (spanX + PADDING * 2),
    (viewport.height - FIT_MARGIN) / (spanY + PADDING * 2),
  );
  const fitLimit = baseFit > SCALE_FLOOR ? SCALE_FLOOR : (baseFit > READABLE_BAND ? baseFit : 0);
  if (fitLimit) {
    const maxWidth = (viewport.width - FIT_MARGIN) / fitLimit - PADDING * 2;
    const maxHeight = (viewport.height - FIT_MARGIN) / fitLimit - PADDING * 2;
    scaleX = Math.min(scaleX, Math.max(1, maxWidth / spanX));
    scaleY = Math.min(scaleY, Math.max(1, maxHeight / spanY));
  }
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  for (const id of ids) {
    const point = position.get(id);
    point.x = centreX + (point.x - centreX) * scaleX;
    point.y = centreY + (point.y - centreY) * scaleY;
  }
}

function latticeSweep({ ids, byId, position }) {
  let moved = false;
  for (let left = 0; left < ids.length; left++) {
    for (let right = left + 1; right < ids.length; right++) {
      const nodeA = byId.get(ids[left]);
      const nodeB = byId.get(ids[right]);
      const a = position.get(ids[left]);
      const b = position.get(ids[right]);
      const overlapX = (nodeA.width + nodeB.width) / 2 + CORRIDOR_GAP - Math.abs(a.x - b.x);
      const overlapY = (nodeA.height + nodeB.height) / 2 + CORRIDOR_GAP - Math.abs(a.y - b.y);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      // Push in lattice steps so snapping survives the resolution.
      if (overlapX <= overlapY * 1.45) {
        const push = Math.ceil(overlapX / 2 / SNAP) * SNAP;
        const direction = a.x >= b.x ? 1 : -1;
        a.x += direction * push;
        b.x -= direction * push;
      } else {
        const push = Math.ceil(overlapY / 2 / SNAP) * SNAP;
        const direction = a.y >= b.y ? 1 : -1;
        a.y += direction * push;
        b.y -= direction * push;
      }
    }
  }
  return moved;
}

// Snap to a coarse lattice: the orthogonal router builds its search grid
// from every distinct rectangle coordinate, so fully free-form positions
// make routing explode from under a second to several seconds. A 16px
// lattice is invisible at graph zoom but collapses the router's grid.
function snapToLattice(state) {
  for (const point of state.position.values()) {
    point.x = Math.round(point.x / SNAP) * SNAP;
    point.y = Math.round(point.y / SNAP) * SNAP;
  }
  for (let round = 0; round < SEPARATION_ROUNDS; round++) {
    if (!latticeSweep(state)) break;
  }
}

function toBoxes(state) {
  const { ids, byId, position } = state;
  const { minX, minY } = boundsOf(state);
  const offsetX = Math.ceil((PADDING - minX) / SNAP) * SNAP;
  const offsetY = Math.ceil((PADDING - minY) / SNAP) * SNAP;
  return Object.fromEntries(ids.map((id) => {
    const node = byId.get(id);
    const point = position.get(id);
    return [id, {
      x: Math.round(point.x - node.width / 2 + offsetX),
      y: Math.round(point.y - node.height / 2 + offsetY),
      width: node.width,
      height: node.height,
    }];
  }));
}

export function organicLayout({
  nodes,
  edges,
  viewportWidth = 1280,
  viewportHeight = 720,
  // Defaults come from a parameter sweep balancing fitted zoom against
  // cluster quality (own-hub distance vs nearest foreign hub).
  springStrength = 0.36,
  repulsionScale = 0.2,
  repulsionCutoff = 2.4,
  gravityX = 0.1,
  gravityY = 0.25,
  edgeSlack = 44,
}) {
  if (!nodes.length) return {};
  const { byId, neighbours, links, siblings } = buildGraph(nodes, edges);
  const radius = new Map(nodes.map((node) => [
    node.id,
    Math.hypot(node.width, node.height) / 2,
  ]));
  const random = seededRandom(hashIds(nodes));
  const position = seedPositions(nodes, neighbours, random);
  const state = { ids: nodes.map((node) => node.id), byId, position, random };
  const viewport = { width: viewportWidth, height: viewportHeight };

  simulate(state, {
    links,
    radius,
    siblings,
    springStrength,
    repulsionScale,
    repulsionCutoff,
    gravityX,
    gravityY,
    edgeSlack,
  });
  compact(state, viewport);
  normaliseAspect(state, viewport);
  snapToLattice(state);
  return toBoxes(state);
}
