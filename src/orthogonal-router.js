const EPSILON = 0.001;

function uniqueSorted(values) {
  return [...new Set(values.map((value) => Math.round(value * 1000) / 1000))]
    .sort((a, b) => a - b);
}

function inside(rect, point) {
  return point.x > rect.left + EPSILON
    && point.x < rect.right - EPSILON
    && point.y > rect.top + EPSILON
    && point.y < rect.bottom - EPSILON;
}

function segmentCrosses(rect, from, to) {
  if (Math.abs(from.y - to.y) < EPSILON) {
    if (from.y <= rect.top + EPSILON || from.y >= rect.bottom - EPSILON) return false;
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x, to.x);
    return Math.max(left, rect.left) < Math.min(right, rect.right) - EPSILON;
  }
  if (Math.abs(from.x - to.x) < EPSILON) {
    if (from.x <= rect.left + EPSILON || from.x >= rect.right - EPSILON) return false;
    const top = Math.min(from.y, to.y);
    const bottom = Math.max(from.y, to.y);
    return Math.max(top, rect.top) < Math.min(bottom, rect.bottom) - EPSILON;
  }
  return true;
}

function simplify(points) {
  const result = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    const before = result[result.length - 2];
    if (before && previous
      && ((before.x === previous.x && previous.x === point.x)
        || (before.y === previous.y && previous.y === point.y))) {
      result[result.length - 1] = point;
    } else {
      result.push(point);
    }
  }
  return result;
}

function routeScore(points, bendPenalty) {
  let score = 0;
  let previousDirection = null;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const direction = from.x === to.x ? 'vertical' : 'horizontal';
    score += Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
    if (previousDirection && previousDirection !== direction) score += bendPenalty;
    previousDirection = direction;
  }
  return score;
}

function portsFor(rect, clearance) {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  return [
    {
      side: 'top',
      point: { x: centerX, y: rect.top },
      anchor: { x: centerX, y: rect.top - clearance },
    },
    {
      side: 'right',
      point: { x: rect.right, y: centerY },
      anchor: { x: rect.right + clearance, y: centerY },
    },
    {
      side: 'bottom',
      point: { x: centerX, y: rect.bottom },
      anchor: { x: centerX, y: rect.bottom + clearance },
    },
    {
      side: 'left',
      point: { x: rect.left, y: centerY },
      anchor: { x: rect.left - clearance, y: centerY },
    },
  ];
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= item.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length
          && this.items[right].priority < this.items[left].priority ? right : left;
        if (this.items[child].priority >= last.priority) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function shortestRoute(start, end, points, pointByKey, adjacency, bendPenalty) {
  const startIndex = pointByKey.get(`${start.x}:${start.y}`);
  const endIndex = pointByKey.get(`${end.x}:${end.y}`);
  if (startIndex === undefined || endIndex === undefined) return null;

  const heap = new MinHeap();
  const distances = new Map();
  const previous = new Map();
  const startState = `${startIndex}:none`;
  distances.set(startState, 0);
  heap.push({ state: startState, index: startIndex, direction: 'none', priority: 0 });
  let finalState = null;

  while (heap.items.length) {
    const current = heap.pop();
    const currentDistance = distances.get(current.state);
    if (currentDistance === undefined) continue;
    if (current.index === endIndex) {
      finalState = current.state;
      break;
    }
    for (const edge of adjacency[current.index]) {
      const turn = current.direction !== 'none' && current.direction !== edge.direction ? bendPenalty : 0;
      const distance = currentDistance + edge.distance + turn;
      const state = `${edge.index}:${edge.direction}`;
      if (distance >= (distances.get(state) ?? Infinity)) continue;
      distances.set(state, distance);
      previous.set(state, current.state);
      const point = points[edge.index];
      const heuristic = Math.abs(point.x - end.x) + Math.abs(point.y - end.y);
      heap.push({ state, index: edge.index, direction: edge.direction, priority: distance + heuristic });
    }
  }

  if (!finalState) return null;
  const route = [];
  for (let state = finalState; state; state = previous.get(state)) {
    route.push(points[Number(state.split(':')[0])]);
  }
  return simplify(route.reverse());
}

export function createOrthogonalRouter(rectangles, {
  clearance = 5,
  bendPenalty = 18,
  bounds,
} = {}) {
  const byId = new Map(rectangles.map((rect) => [rect.id, rect]));
  const obstacles = rectangles.map((rect) => ({
    ...rect,
    left: rect.left - clearance,
    right: rect.right + clearance,
    top: rect.top - clearance,
    bottom: rect.bottom + clearance,
  }));
  const xValues = [];
  const yValues = [];
  for (const rect of obstacles) {
    xValues.push(rect.left, (rect.left + rect.right) / 2, rect.right);
    yValues.push(rect.top, (rect.top + rect.bottom) / 2, rect.bottom);
  }
  if (bounds) {
    xValues.push(bounds.left, bounds.right);
    yValues.push(bounds.top, bounds.bottom);
  }
  const xs = uniqueSorted(xValues);
  const ys = uniqueSorted(yValues);
  const points = [];
  const pointByKey = new Map();
  const rows = new Map();
  const columns = new Map();

  for (const y of ys) {
    for (const x of xs) {
      const point = { x, y };
      if (obstacles.some((rect) => inside(rect, point))) continue;
      const index = points.length;
      points.push(point);
      pointByKey.set(`${x}:${y}`, index);
      const row = rows.get(y) || [];
      row.push(index);
      rows.set(y, row);
      const column = columns.get(x) || [];
      column.push(index);
      columns.set(x, column);
    }
  }

  const adjacency = Array.from({ length: points.length }, () => []);
  const connect = (indices, direction) => {
    for (let index = 1; index < indices.length; index++) {
      const fromIndex = indices[index - 1];
      const toIndex = indices[index];
      const from = points[fromIndex];
      const to = points[toIndex];
      if (obstacles.some((rect) => segmentCrosses(rect, from, to))) continue;
      const distance = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
      adjacency[fromIndex].push({ index: toIndex, direction, distance });
      adjacency[toIndex].push({ index: fromIndex, direction, distance });
    }
  };
  for (const indices of rows.values()) connect(indices, 'horizontal');
  for (const indices of columns.values()) connect(indices, 'vertical');

  return {
    route(start, end, sourceId, targetId) {
      const source = byId.get(sourceId);
      const target = byId.get(targetId);
      if (!source || !target) return simplify([start, { x: start.x, y: end.y }, end]);
      const startAnchor = { x: source.right + clearance, y: start.y };
      const endAnchor = { x: target.left - clearance, y: end.y };
      const route = shortestRoute(startAnchor, endAnchor, points, pointByKey, adjacency, bendPenalty);
      if (!route) {
        const outside = bounds?.top ?? Math.min(...obstacles.map(({ top }) => top), start.y, end.y) - clearance;
        return simplify([start, startAnchor, { x: startAnchor.x, y: outside }, { x: endAnchor.x, y: outside }, endAnchor, end]);
      }
      return simplify([start, ...route, end]);
    },
    routeBetween(sourceId, targetId) {
      const source = byId.get(sourceId);
      const target = byId.get(targetId);
      if (!source || !target) return [];

      let best = null;
      let bestScore = Infinity;
      for (const sourcePort of portsFor(source, clearance)) {
        for (const targetPort of portsFor(target, clearance)) {
          const middle = shortestRoute(
            sourcePort.anchor,
            targetPort.anchor,
            points,
            pointByKey,
            adjacency,
            bendPenalty,
          );
          if (!middle) continue;
          const route = simplify([
            sourcePort.point,
            sourcePort.anchor,
            ...middle,
            targetPort.anchor,
            targetPort.point,
          ]);
          const score = routeScore(route, bendPenalty);
          if (score >= bestScore) continue;
          best = route;
          bestScore = score;
        }
      }

      if (best) return best;
      const start = { x: source.right, y: (source.top + source.bottom) / 2 };
      const end = { x: target.left, y: (target.top + target.bottom) / 2 };
      return this.route(start, end, sourceId, targetId);
    },
  };
}

export function routeOrthogonal(start, end, rectangles, options = {}) {
  const router = createOrthogonalRouter(rectangles, options);
  return router.route(start, end, options.sourceId, options.targetId);
}

export function orthogonalPath(points) {
  return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
}
