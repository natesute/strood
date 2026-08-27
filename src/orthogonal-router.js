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

function containsRectangle(outer, inner) {
  return outer.left <= inner.left + EPSILON
    && outer.right >= inner.right - EPSILON
    && outer.top <= inner.top + EPSILON
    && outer.bottom >= inner.bottom - EPSILON;
}

function routeCrossesRectangle(route, rect) {
  for (let index = 1; index < route.length; index++) {
    if (segmentCrosses(rect, route[index - 1], route[index])) return true;
  }
  return false;
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

function rangeOverlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(Math.max(a0, a1), Math.max(b0, b1))
    - Math.max(Math.min(a0, a1), Math.min(b0, b1)));
}

export function findParallelSegmentConflicts(
  routes,
  minimumSeparation = 2,
  minimumOverlap = EPSILON,
) {
  const collisions = [];
  for (let leftRouteIndex = 0; leftRouteIndex < routes.length; leftRouteIndex++) {
    const leftRoute = routes[leftRouteIndex];
    for (let rightRouteIndex = leftRouteIndex + 1;
      rightRouteIndex < routes.length;
      rightRouteIndex++) {
      const rightRoute = routes[rightRouteIndex];
      for (let leftSegmentIndex = 1;
        leftSegmentIndex < leftRoute.length;
        leftSegmentIndex++) {
        const leftFrom = leftRoute[leftSegmentIndex - 1];
        const leftTo = leftRoute[leftSegmentIndex];
        const horizontal = Math.abs(leftFrom.y - leftTo.y) < EPSILON;
        for (let rightSegmentIndex = 1;
          rightSegmentIndex < rightRoute.length;
          rightSegmentIndex++) {
          const rightFrom = rightRoute[rightSegmentIndex - 1];
          const rightTo = rightRoute[rightSegmentIndex];
          if (horizontal !== (Math.abs(rightFrom.y - rightTo.y) < EPSILON)) continue;
          const laneDistance = horizontal
            ? Math.abs(leftFrom.y - rightFrom.y)
            : Math.abs(leftFrom.x - rightFrom.x);
          if (laneDistance >= minimumSeparation) continue;
          const overlap = horizontal
            ? rangeOverlap(leftFrom.x, leftTo.x, rightFrom.x, rightTo.x)
            : rangeOverlap(leftFrom.y, leftTo.y, rightFrom.y, rightTo.y);
          if (overlap <= minimumOverlap) continue;
          collisions.push({
            leftRouteIndex,
            rightRouteIndex,
            leftSegmentIndex,
            rightSegmentIndex,
            horizontal,
            coordinate: horizontal ? leftFrom.y : leftFrom.x,
            laneDistance,
            overlap,
          });
        }
      }
    }
  }
  return collisions;
}

export function findCoincidentSegments(routes, minimumOverlap = EPSILON) {
  return findParallelSegmentConflicts(routes, EPSILON, minimumOverlap);
}

function segmentCongestion(
  from,
  to,
  reservedSegments,
  overlapPenalty,
  crossingPenalty,
  parallelClearance,
  parallelPenalty,
  avoidOverlaps = false,
  minimumLaneSeparation = 0,
) {
  const horizontal = Math.abs(from.y - to.y) < EPSILON;
  let cost = 0;
  for (const reserved of reservedSegments) {
    const reservedHorizontal = Math.abs(reserved.from.y - reserved.to.y) < EPSILON;
    if (horizontal === reservedHorizontal) {
      const laneDistance = horizontal
        ? Math.abs(from.y - reserved.from.y)
        : Math.abs(from.x - reserved.from.x);
      const overlap = horizontal
        ? rangeOverlap(from.x, to.x, reserved.from.x, reserved.to.x)
        : rangeOverlap(from.y, to.y, reserved.from.y, reserved.to.y);
      if (avoidOverlaps && overlap > EPSILON
        && laneDistance < Math.max(EPSILON, minimumLaneSeparation)) return Infinity;
      if (laneDistance < EPSILON) {
        cost += overlap * overlapPenalty;
      } else if (laneDistance < parallelClearance) {
        const proximity = (parallelClearance - laneDistance) / parallelClearance;
        cost += overlap * parallelPenalty * proximity;
      }
      continue;
    }
    const horizontalSegment = horizontal ? { from, to } : reserved;
    const verticalSegment = horizontal ? reserved : { from, to };
    const crosses = verticalSegment.from.x > Math.min(horizontalSegment.from.x, horizontalSegment.to.x) + EPSILON
      && verticalSegment.from.x < Math.max(horizontalSegment.from.x, horizontalSegment.to.x) - EPSILON
      && horizontalSegment.from.y > Math.min(verticalSegment.from.y, verticalSegment.to.y) + EPSILON
      && horizontalSegment.from.y < Math.max(verticalSegment.from.y, verticalSegment.to.y) - EPSILON;
    if (crosses) cost += crossingPenalty;
  }
  return cost;
}

function parallelLaneIsClear(from, to, reservedSegments, clearance) {
  const horizontal = Math.abs(from.y - to.y) < EPSILON;
  return reservedSegments.every((reserved) => {
    const reservedHorizontal = Math.abs(reserved.from.y - reserved.to.y) < EPSILON;
    if (horizontal !== reservedHorizontal) return true;
    const overlap = horizontal
      ? rangeOverlap(from.x, to.x, reserved.from.x, reserved.to.x)
      : rangeOverlap(from.y, to.y, reserved.from.y, reserved.to.y);
    if (overlap <= EPSILON) return true;
    const laneDistance = horizontal
      ? Math.abs(from.y - reserved.from.y)
      : Math.abs(from.x - reserved.from.x);
    return laneDistance >= clearance - EPSILON;
  });
}

function shiftedSegment(points, segmentIndex, candidate, horizontal) {
  const shifted = points.map((point) => ({ ...point }));
  if (horizontal) {
    shifted[segmentIndex - 1].y = candidate;
    shifted[segmentIndex].y = candidate;
  } else {
    shifted[segmentIndex - 1].x = candidate;
    shifted[segmentIndex].x = candidate;
  }
  return shifted;
}

function introducesObstacleCrossing(before, after, segmentIndex, rectangles) {
  const firstAffected = Math.max(1, segmentIndex - 1);
  const lastAffected = Math.min(before.length - 1, segmentIndex + 1);
  return rectangles.some((rect) => {
    for (let affected = firstAffected; affected <= lastAffected; affected++) {
      const crossedBefore = segmentCrosses(rect, before[affected - 1], before[affected]);
      const crossesAfter = segmentCrosses(rect, after[affected - 1], after[affected]);
      if (!crossedBefore && crossesAfter) return true;
    }
    return false;
  });
}

export function spaceOrthogonalRoutes(routes, rectangles, {
  bounds,
  spacing = 7,
} = {}) {
  const result = routes.map((route) => route.map((point) => ({ ...point })));
  const orientations = [false, true, false, true];

  for (const horizontal of orientations) {
    const movable = [];
    const assigned = [];
    for (let routeIndex = 0; routeIndex < result.length; routeIndex++) {
      const route = result[routeIndex];
      for (let segmentIndex = 1; segmentIndex < route.length; segmentIndex++) {
        const from = route[segmentIndex - 1];
        const to = route[segmentIndex];
        if ((Math.abs(from.y - to.y) < EPSILON) !== horizontal) continue;
        const segment = { from, to };
        if (segmentIndex > 1 && segmentIndex < route.length - 1) {
          movable.push({
            routeIndex,
            segmentIndex,
            length: Math.abs(from.x - to.x) + Math.abs(from.y - to.y),
          });
        } else {
          assigned.push(segment);
        }
      }
    }
    movable.sort((left, right) => right.length - left.length);

    for (const { routeIndex, segmentIndex } of movable) {
      const route = result[routeIndex];
      const from = route[segmentIndex - 1];
      const currentCoordinate = horizontal ? from.y : from.x;
      const origin = horizontal ? (bounds?.top ?? 0) : (bounds?.left ?? 0);
      const nearestLane = Math.round((currentCoordinate - origin) / spacing);
      const candidates = Array.from({ length: 31 }, (_, index) => index - 15)
        .map((offset) => origin + (nearestLane + offset) * spacing)
        .sort((left, right) => Math.abs(left - currentCoordinate) - Math.abs(right - currentCoordinate));
      let selected = route;
      for (const candidate of candidates) {
        if (bounds && (horizontal
          ? candidate < bounds.top - spacing || candidate > bounds.bottom + spacing
          : candidate < bounds.left - spacing || candidate > bounds.right + spacing)) continue;
        const shifted = shiftedSegment(route, segmentIndex, candidate, horizontal);
        if (!parallelLaneIsClear(
          shifted[segmentIndex - 1],
          shifted[segmentIndex],
          assigned,
          spacing,
        )) continue;
        if (introducesObstacleCrossing(route, shifted, segmentIndex, rectangles)) continue;
        selected = shifted;
        break;
      }
      result[routeIndex] = selected;
      assigned.push({
        from: selected[segmentIndex - 1],
        to: selected[segmentIndex],
      });
    }
  }

  return result.map(simplify);
}

function routeScore(points, bendPenalty, congestion) {
  let score = 0;
  let previousDirection = null;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const direction = from.x === to.x ? 'vertical' : 'horizontal';
    score += Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
    if (previousDirection && previousDirection !== direction) score += bendPenalty;
    score += segmentCongestion(
      from,
      to,
      congestion.reservedSegments,
      congestion.overlapPenalty,
      congestion.crossingPenalty,
      congestion.parallelClearance,
      congestion.parallelPenalty,
      congestion.avoidOverlaps,
      congestion.minimumLaneSeparation,
    );
    previousDirection = direction;
  }
  return score;
}

function staggeredOffsets(min, max, spacing) {
  const lanes = Math.max(0, Math.floor(((max - min) / 2 - 10) / spacing));
  const result = [0];
  for (let lane = 1; lane <= lanes; lane++) result.push(lane * spacing, -lane * spacing);
  return result;
}

function portOffset(rect, side, portUsage, spacing) {
  const horizontal = side === 'top' || side === 'bottom';
  const offsets = staggeredOffsets(
    horizontal ? rect.left : rect.top,
    horizontal ? rect.right : rect.bottom,
    spacing,
  );
  const key = `${rect.id}:${side}`;
  return { key, offset: offsets[(portUsage.get(key) || 0) % offsets.length] };
}

function portsFor(rect, clearance, portUsage, portSpacing) {
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const top = portOffset(rect, 'top', portUsage, portSpacing);
  const right = portOffset(rect, 'right', portUsage, portSpacing);
  const bottom = portOffset(rect, 'bottom', portUsage, portSpacing);
  const left = portOffset(rect, 'left', portUsage, portSpacing);
  return [
    {
      side: 'top',
      usageKey: top.key,
      point: { x: centerX + top.offset, y: rect.top },
      anchor: { x: centerX + top.offset, y: rect.top - clearance },
    },
    {
      side: 'right',
      usageKey: right.key,
      point: { x: rect.right, y: centerY + right.offset },
      anchor: { x: rect.right + clearance, y: centerY + right.offset },
    },
    {
      side: 'bottom',
      usageKey: bottom.key,
      point: { x: centerX + bottom.offset, y: rect.bottom },
      anchor: { x: centerX + bottom.offset, y: rect.bottom + clearance },
    },
    {
      side: 'left',
      usageKey: left.key,
      point: { x: rect.left, y: centerY + left.offset },
      anchor: { x: rect.left - clearance, y: centerY + left.offset },
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

function shortestRoute(start, end, points, pointByKey, adjacency, bendPenalty, congestion) {
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
      const distance = currentDistance + edge.distance + turn + segmentCongestion(
        points[current.index],
        points[edge.index],
        congestion.reservedSegments,
        congestion.overlapPenalty,
        congestion.crossingPenalty,
        congestion.parallelClearance,
        congestion.parallelPenalty,
        congestion.avoidOverlaps,
        congestion.minimumLaneSeparation,
      );
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

function fallbackVisibilityRoute(
  start,
  end,
  rectangles,
  {
    sourceId,
    targetId,
    bounds,
    bendPenalty,
    clearance,
    congestion,
    extraXValues,
    extraYValues,
  },
) {
  const blockers = rectangles
    .filter((rect) => rect.id !== sourceId && rect.id !== targetId)
    .map((rect) => ({
      ...rect,
      left: rect.left - clearance,
      right: rect.right + clearance,
      top: rect.top - clearance,
      bottom: rect.bottom + clearance,
    }));
  const xs = uniqueSorted([
    start.x,
    end.x,
    ...extraXValues,
    ...(bounds ? [bounds.left, bounds.right] : []),
    ...blockers.flatMap((rect) => [rect.left, rect.right]),
  ]);
  const ys = uniqueSorted([
    start.y,
    end.y,
    ...extraYValues,
    ...(bounds ? [bounds.top, bounds.bottom] : []),
    ...blockers.flatMap((rect) => [rect.top, rect.bottom]),
  ]);
  const points = [];
  const pointByKey = new Map();
  const rows = new Map();
  const columns = new Map();
  for (const y of ys) {
    for (const x of xs) {
      const point = { x, y };
      if (blockers.some((rect) => inside(rect, point))) continue;
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
    for (let index = 1; index < indices.length; index += 1) {
      const fromIndex = indices[index - 1];
      const toIndex = indices[index];
      const from = points[fromIndex];
      const to = points[toIndex];
      if (blockers.some((rect) => segmentCrosses(rect, from, to))) continue;
      const distance = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
      adjacency[fromIndex].push({ index: toIndex, direction, distance });
      adjacency[toIndex].push({ index: fromIndex, direction, distance });
    }
  };
  for (const indices of rows.values()) connect(indices, 'horizontal');
  for (const indices of columns.values()) connect(indices, 'vertical');
  return shortestRoute(start, end, points, pointByKey, adjacency, bendPenalty, congestion);
}

function anchorForPort(rect, point, clearance) {
  const sides = [
    { side: 'left', distance: Math.abs(point.x - rect.left) },
    { side: 'right', distance: Math.abs(point.x - rect.right) },
    { side: 'top', distance: Math.abs(point.y - rect.top) },
    { side: 'bottom', distance: Math.abs(point.y - rect.bottom) },
  ];
  const { side } = sides.sort((left, right) => left.distance - right.distance)[0];
  if (side === 'left') return { x: rect.left - clearance, y: point.y };
  if (side === 'right') return { x: rect.right + clearance, y: point.y };
  if (side === 'top') return { x: point.x, y: rect.top - clearance };
  return { x: point.x, y: rect.bottom + clearance };
}

function routeOverlapsReserved(route, reservedSegments, minimumLaneSeparation) {
  for (let index = 1; index < route.length; index++) {
    if (segmentCongestion(
      route[index - 1],
      route[index],
      reservedSegments,
      0,
      0,
      0,
      0,
      true,
      minimumLaneSeparation,
    ) === Infinity) return true;
  }
  return false;
}

export function createOrthogonalRouter(rectangles, {
  clearance = 12,
  bendPenalty = 18,
  portSpacing = 12,
  laneSpacing = 7,
  overlapPenalty = 6,
  crossingPenalty = 28,
  parallelClearance = 7,
  parallelPenalty = 0,
  avoidOverlaps = false,
  minimumLaneSeparation = 0,
  fallbackClearance = 0,
  extraXValues = [],
  extraYValues = [],
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
  const xValues = [...extraXValues];
  const yValues = [...extraYValues];
  for (const rect of obstacles) {
    xValues.push(rect.left - laneSpacing, rect.left, (rect.left + rect.right) / 2,
      rect.right, rect.right + laneSpacing);
    yValues.push(rect.top - laneSpacing, rect.top, (rect.top + rect.bottom) / 2,
      rect.bottom, rect.bottom + laneSpacing);
  }
  for (const rect of rectangles) {
    xValues.push(...staggeredOffsets(rect.left, rect.right, portSpacing)
      .map((offset) => (rect.left + rect.right) / 2 + offset));
    yValues.push(...staggeredOffsets(rect.top, rect.bottom, portSpacing)
      .map((offset) => (rect.top + rect.bottom) / 2 + offset));
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

  const portUsage = new Map();
  const reservedSegments = [];
  const congestion = {
    reservedSegments,
    overlapPenalty,
    crossingPenalty,
    parallelClearance,
    parallelPenalty,
    avoidOverlaps,
    minimumLaneSeparation,
  };
  const reserve = (route) => {
    for (let index = 1; index < route.length; index++) {
      reservedSegments.push({ from: route[index - 1], to: route[index] });
    }
  };

  return {
    route(start, end, sourceId, targetId) {
      const source = byId.get(sourceId);
      const target = byId.get(targetId);
      if (!source || !target) return simplify([start, { x: start.x, y: end.y }, end]);
      if (sourceId !== targetId
        && (containsRectangle(source, target) || containsRectangle(target, source))) return [];
      const startAnchor = anchorForPort(source, start, clearance);
      const endAnchor = anchorForPort(target, end, clearance);
      const middle = shortestRoute(
        startAnchor,
        endAnchor,
        points,
        pointByKey,
        adjacency,
        bendPenalty,
        congestion,
      );
      const result = middle ? simplify([start, startAnchor, ...middle, endAnchor, end]) : null;
      if (!result || (avoidOverlaps
        && routeOverlapsReserved(result, reservedSegments, minimumLaneSeparation))) {
        if (sourceId === targetId) return [];
        const fallback = fallbackVisibilityRoute(start, end, rectangles, {
          sourceId,
          targetId,
          bounds,
          bendPenalty,
          clearance: fallbackClearance,
          congestion,
          extraXValues,
          extraYValues,
        });
        if (!fallback || rectangles.some((rect) => rect.id !== sourceId && rect.id !== targetId
          && routeCrossesRectangle(fallback, rect))
          || (avoidOverlaps
            && routeOverlapsReserved(fallback, reservedSegments, minimumLaneSeparation))) return [];
        reserve(fallback);
        return fallback;
      }
      reserve(result);
      return result;
    },
    routeBetween(sourceId, targetId) {
      const source = byId.get(sourceId);
      const target = byId.get(targetId);
      if (!source || !target) return [];

      let best = null;
      let bestScore = Infinity;
      let bestPorts = null;
      for (const sourcePort of portsFor(source, clearance, portUsage, portSpacing)) {
        for (const targetPort of portsFor(target, clearance, portUsage, portSpacing)) {
          if (sourceId === targetId && sourcePort.side === targetPort.side) continue;
          const middle = shortestRoute(
            sourcePort.anchor,
            targetPort.anchor,
            points,
            pointByKey,
            adjacency,
            bendPenalty,
            congestion,
          );
          if (!middle) continue;
          const route = simplify([
            sourcePort.point,
            sourcePort.anchor,
            ...middle,
            targetPort.anchor,
            targetPort.point,
          ]);
          const score = routeScore(route, bendPenalty, congestion);
          if (score >= bestScore) continue;
          best = route;
          bestPorts = [sourcePort, targetPort];
          bestScore = score;
        }
      }

      if (best) {
        for (const port of bestPorts) portUsage.set(port.usageKey, (portUsage.get(port.usageKey) || 0) + 1);
        reserve(best);
        return best;
      }
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

function selfLoopSide(rect, rectangles, bounds) {
  const candidates = [
    { side: 'right', gap: (bounds?.right ?? Infinity) - rect.right },
    { side: 'bottom', gap: (bounds?.bottom ?? Infinity) - rect.bottom },
    { side: 'left', gap: rect.left - (bounds?.left ?? -Infinity) },
    { side: 'top', gap: rect.top - (bounds?.top ?? -Infinity) },
  ];
  for (const other of rectangles) {
    if (other.id === rect.id) continue;
    const overlapsVertically = other.top < rect.bottom && other.bottom > rect.top;
    const overlapsHorizontally = other.left < rect.right && other.right > rect.left;
    if (overlapsVertically && other.left >= rect.right) {
      candidates[0].gap = Math.min(candidates[0].gap, other.left - rect.right);
    }
    if (overlapsHorizontally && other.top >= rect.bottom) {
      candidates[1].gap = Math.min(candidates[1].gap, other.top - rect.bottom);
    }
    if (overlapsVertically && other.right <= rect.left) {
      candidates[2].gap = Math.min(candidates[2].gap, rect.left - other.right);
    }
    if (overlapsHorizontally && other.bottom <= rect.top) {
      candidates[3].gap = Math.min(candidates[3].gap, rect.top - other.bottom);
    }
  }
  return candidates.sort((left, right) => right.gap - left.gap)[0].side;
}

function facingSides(source, target, selfSide = null) {
  if (selfSide) return { sourceSide: selfSide, targetSide: selfSide };
  const sourceX = (source.left + source.right) / 2;
  const sourceY = (source.top + source.bottom) / 2;
  const targetX = (target.left + target.right) / 2;
  const targetY = (target.top + target.bottom) / 2;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceSide: 'right', targetSide: 'left' }
      : { sourceSide: 'left', targetSide: 'right' };
  }
  return dy >= 0
    ? { sourceSide: 'bottom', targetSide: 'top' }
    : { sourceSide: 'top', targetSide: 'bottom' };
}

function pointOnSide(rect, side, coordinate) {
  if (side === 'left') return { x: rect.left, y: coordinate };
  if (side === 'right') return { x: rect.right, y: coordinate };
  if (side === 'top') return { x: coordinate, y: rect.top };
  return { x: coordinate, y: rect.bottom };
}

function portCoordinate(rect, side, index, count) {
  const start = side === 'left' || side === 'right' ? rect.top : rect.left;
  const end = side === 'left' || side === 'right' ? rect.bottom : rect.right;
  return start + ((index + 1) * (end - start)) / (count + 1);
}

function uniquePortCoordinate(desired, min, max, used) {
  const rounded = (value) => Math.round(value * 1000) / 1000;
  for (const step of [0.5, 0.001]) {
    const attempts = Math.ceil((max - min) / step) + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const distance = Math.ceil(attempt / 2) * step;
      const candidate = rounded(desired + (attempt % 2 ? distance : -distance));
      if (candidate <= min + EPSILON || candidate >= max - EPSILON || used.has(candidate)) continue;
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error('Not enough unique edge ports on a node side');
}

function routingLaneBank(min, max, requestedCount, spacing) {
  const capacity = Math.max(0, Math.floor((max - min) / spacing) - 1);
  const count = Math.min(requestedCount, capacity);
  return Array.from({ length: count }, (_, index) =>
    min + ((index + 1) * (max - min)) / (count + 1));
}

export function routeOrthogonalEdges(rectangles, edges, options = {}) {
  const byId = new Map(rectangles.map((rectangle) => [rectangle.id, rectangle]));
  const assignments = edges.map((edge, edgeIndex) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) return { edge, edgeIndex, source, target };
    return {
      edge,
      edgeIndex,
      source,
      target,
      ...facingSides(
        source,
        target,
        edge.from === edge.to ? selfLoopSide(source, rectangles, options.bounds) : null,
      ),
    };
  });
  const incidences = new Map();
  const usedHorizontalPortLanes = new Set();
  const usedVerticalPortLanes = new Set();
  const addIncidence = (assignment, endpoint, rect, side, other) => {
    const key = `${rect.id}:${side}`;
    const entries = incidences.get(key) || [];
    entries.push({ assignment, endpoint, rect, side, other });
    incidences.set(key, entries);
  };
  for (const assignment of assignments) {
    if (!assignment.source || !assignment.target) continue;
    addIncidence(
      assignment,
      'sourcePort',
      assignment.source,
      assignment.sourceSide,
      assignment.target,
    );
    addIncidence(
      assignment,
      'targetPort',
      assignment.target,
      assignment.targetSide,
      assignment.source,
    );
  }

  for (const entries of incidences.values()) {
    const verticalSide = entries[0].side === 'left' || entries[0].side === 'right';
    entries.sort((left, right) => {
      const leftPosition = verticalSide
        ? (left.other.top + left.other.bottom) / 2
        : (left.other.left + left.other.right) / 2;
      const rightPosition = verticalSide
        ? (right.other.top + right.other.bottom) / 2
        : (right.other.left + right.other.right) / 2;
      return leftPosition - rightPosition
        || String(left.assignment.edge.id).localeCompare(String(right.assignment.edge.id))
        || left.assignment.edgeIndex - right.assignment.edgeIndex;
    });
    entries.forEach((entry, index) => {
      const min = verticalSide ? entry.rect.top : entry.rect.left;
      const max = verticalSide ? entry.rect.bottom : entry.rect.right;
      const coordinate = uniquePortCoordinate(
        portCoordinate(entry.rect, entry.side, index, entries.length),
        min,
        max,
        verticalSide ? usedHorizontalPortLanes : usedVerticalPortLanes,
      );
      entry.assignment[entry.endpoint] = pointOnSide(
        entry.rect,
        entry.side,
        coordinate,
      );
    });
  }

  const extraXValues = [...(options.extraXValues || [])];
  const extraYValues = [...(options.extraYValues || [])];
  for (const assignment of assignments) {
    if (!assignment.sourcePort || !assignment.targetPort) continue;
    for (const [port, side] of [
      [assignment.sourcePort, assignment.sourceSide],
      [assignment.targetPort, assignment.targetSide],
    ]) {
      if (side === 'left' || side === 'right') extraYValues.push(port.y);
      else extraXValues.push(port.x);
    }
  }
  const routingBounds = options.bounds || (rectangles.length ? {
    left: Math.min(...rectangles.map((rectangle) => rectangle.left)) - 24,
    right: Math.max(...rectangles.map((rectangle) => rectangle.right)) + 24,
    top: Math.min(...rectangles.map((rectangle) => rectangle.top)) - 24,
    bottom: Math.max(...rectangles.map((rectangle) => rectangle.bottom)) + 24,
  } : { left: 0, right: 100, top: 0, bottom: 100 });
  const laneSpacing = options.laneSpacing ?? 7;
  const laneBankX = routingLaneBank(
    routingBounds.left,
    routingBounds.right,
    edges.length,
    laneSpacing,
  );
  const laneBankY = routingLaneBank(
    routingBounds.top,
    routingBounds.bottom,
    edges.length,
    laneSpacing,
  );
  const minimumLaneSeparation = options.minimumLaneSeparation ?? 2;
  const flexiblePorts = rectangles.length < (options.flexiblePortNodeLimit ?? 30);
  const fallbackClearance = flexiblePorts
    ? Math.max(0, (options.clearance ?? 12) - 2)
    : 0;
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const difficultFirst = [...assignments].sort((left, right) => {
    const leftDegree = (degree.get(left.edge.from) || 0) + (degree.get(left.edge.to) || 0);
    const rightDegree = (degree.get(right.edge.from) || 0) + (degree.get(right.edge.to) || 0);
    const leftSpan = left.source && left.target
      ? Math.abs((left.source.left + left.source.right) - (left.target.left + left.target.right))
        + Math.abs((left.source.top + left.source.bottom) - (left.target.top + left.target.bottom))
      : 0;
    const rightSpan = right.source && right.target
      ? Math.abs((right.source.left + right.source.right) - (right.target.left + right.target.right))
        + Math.abs((right.source.top + right.source.bottom) - (right.target.top + right.target.bottom))
      : 0;
    return rightDegree - leftDegree
      || rightSpan - leftSpan
      || String(left.edge.id).localeCompare(String(right.edge.id))
      || left.edgeIndex - right.edgeIndex;
  });
  const attempts = [
    { order: assignments, extraLanes: false },
    { order: assignments, extraLanes: true },
    { order: difficultFirst, extraLanes: true },
    { order: [...assignments].reverse(), extraLanes: true },
  ];
  let failedEdgeId = null;
  const failedAttempts = [];
  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
    const attempt = attempts[attemptIndex];
    const router = createOrthogonalRouter(rectangles, {
      ...options,
      avoidOverlaps: true,
      minimumLaneSeparation,
      fallbackClearance,
      extraXValues: attempt.extraLanes ? [...extraXValues, ...laneBankX] : extraXValues,
      extraYValues: attempt.extraLanes ? [...extraYValues, ...laneBankY] : extraYValues,
    });
    const routes = Array.from({ length: edges.length }, () => []);
    let complete = true;
    for (const assignment of attempt.order) {
      if (!assignment.sourcePort || !assignment.targetPort) {
        failedEdgeId = assignment.edge.id;
        complete = false;
        break;
      }
      const useFlexiblePorts = flexiblePorts && assignment.edge.from !== assignment.edge.to;
      let route = useFlexiblePorts
        ? router.routeBetween(assignment.edge.from, assignment.edge.to)
        : router.route(
          assignment.sourcePort,
          assignment.targetPort,
          assignment.edge.from,
          assignment.edge.to,
        );
      if (!route.length && !useFlexiblePorts) {
        route = router.routeBetween(assignment.edge.from, assignment.edge.to);
      }
      if (!route.length) {
        failedEdgeId = assignment.edge.id;
        complete = false;
        break;
      }
      routes[assignment.edgeIndex] = route;
    }
    if (!complete) {
      failedAttempts.push(`${attemptIndex + 1}:${failedEdgeId}`);
      continue;
    }
    if (!findParallelSegmentConflicts(
      routes,
      Math.max(EPSILON, minimumLaneSeparation),
      0,
    ).length) return routes;
    failedAttempts.push(`${attemptIndex + 1}:parallel-conflict`);
  }
  throw new Error(`Cannot route edges without overlap (${failedAttempts.join(', ')})`);
}

export function findOrthogonalCrossings(points, previousRoutes, margin = 5) {
  const crossings = [];
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex++) {
    const from = points[segmentIndex - 1];
    const to = points[segmentIndex];
    const horizontal = Math.abs(from.y - to.y) < EPSILON;
    for (const route of previousRoutes) {
      for (let otherIndex = 1; otherIndex < route.length; otherIndex++) {
        const otherFrom = route[otherIndex - 1];
        const otherTo = route[otherIndex];
        const otherHorizontal = Math.abs(otherFrom.y - otherTo.y) < EPSILON;
        if (horizontal === otherHorizontal) continue;
        const horizontalSegment = horizontal ? { from, to } : { from: otherFrom, to: otherTo };
        const verticalSegment = horizontal ? { from: otherFrom, to: otherTo } : { from, to };
        const x = verticalSegment.from.x;
        const y = horizontalSegment.from.y;
        if (x < Math.min(horizontalSegment.from.x, horizontalSegment.to.x) - EPSILON
          || x > Math.max(horizontalSegment.from.x, horizontalSegment.to.x) + EPSILON
          || y < Math.min(verticalSegment.from.y, verticalSegment.to.y) - EPSILON
          || y > Math.max(verticalSegment.from.y, verticalSegment.to.y) + EPSILON) continue;
        const crossingAxis = horizontal ? x : y;
        const segmentStart = horizontal ? from.x : from.y;
        const segmentEnd = horizontal ? to.x : to.y;
        if (crossingAxis <= Math.min(segmentStart, segmentEnd) + margin
          || crossingAxis >= Math.max(segmentStart, segmentEnd) - margin) continue;
        if (crossings.some((crossing) => crossing.segmentIndex === segmentIndex
          && Math.abs(crossing.x - x) < EPSILON && Math.abs(crossing.y - y) < EPSILON)) continue;
        crossings.push({ segmentIndex, x, y });
      }
    }
  }
  return crossings;
}

function groupedSegmentBridges(
  from,
  to,
  crossings,
  segmentIndex,
  bridgeRadius,
  maxBridgeDepth,
) {
  const horizontal = Math.abs(from.y - to.y) < EPSILON;
  const direction = horizontal ? Math.sign(to.x - from.x) : Math.sign(to.y - from.y);
  const bridges = crossings
    .filter((crossing) => crossing.segmentIndex === segmentIndex)
    .sort((left, right) => direction * ((horizontal ? left.x : left.y) - (horizontal ? right.x : right.y)));
  const bridgeGroups = [];
  for (const bridge of bridges) {
    const axis = horizontal ? bridge.x : bridge.y;
    const group = bridgeGroups.at(-1);
    if (group && Math.abs(axis - group.lastAxis) <= bridgeRadius * 3) {
      group.lastAxis = axis;
    } else {
      bridgeGroups.push({ firstAxis: axis, lastAxis: axis });
    }
  }
  return bridgeGroups.map((bridge) => {
    const before = bridge.firstAxis - direction * bridgeRadius;
    const after = bridge.lastAxis + direction * bridgeRadius;
    const bridgeDepth = Math.min(
      maxBridgeDepth,
      Math.max(bridgeRadius, Math.abs(after - before) / 2),
    );
    return { horizontal, before, after, bridgeDepth };
  });
}

export function orthogonalPath(
  points,
  crossings = [],
  { bridgeRadius = 4.5, maxBridgeDepth = 9 } = {},
) {
  if (!points.length) return '';
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex++) {
    const from = points[segmentIndex - 1];
    const to = points[segmentIndex];
    for (const bridge of groupedSegmentBridges(
      from,
      to,
      crossings,
      segmentIndex,
      bridgeRadius,
      maxBridgeDepth,
    )) {
      if (bridge.horizontal) {
        path += ` L ${bridge.before} ${from.y}`;
        path += ` C ${bridge.before} ${from.y - bridge.bridgeDepth} ${bridge.after} ${from.y - bridge.bridgeDepth} ${bridge.after} ${from.y}`;
      } else {
        path += ` L ${from.x} ${bridge.before}`;
        path += ` C ${from.x + bridge.bridgeDepth} ${bridge.before} ${from.x + bridge.bridgeDepth} ${bridge.after} ${from.x} ${bridge.after}`;
      }
    }
    path += ` L ${to.x} ${to.y}`;
  }
  return path;
}

export function orthogonalBridgePath(
  points,
  crossings = [],
  { bridgeRadius = 4.5, maxBridgeDepth = 9 } = {},
) {
  let path = '';
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex++) {
    const from = points[segmentIndex - 1];
    const to = points[segmentIndex];
    for (const bridge of groupedSegmentBridges(
      from,
      to,
      crossings,
      segmentIndex,
      bridgeRadius,
      maxBridgeDepth,
    )) {
      path += bridge.horizontal
        ? ` M ${bridge.before} ${from.y} C ${bridge.before} ${from.y - bridge.bridgeDepth} ${bridge.after} ${from.y - bridge.bridgeDepth} ${bridge.after} ${from.y}`
        : ` M ${from.x} ${bridge.before} C ${from.x + bridge.bridgeDepth} ${bridge.before} ${from.x + bridge.bridgeDepth} ${bridge.after} ${from.x} ${bridge.after}`;
    }
  }
  return path.trim();
}

function bridgeGeometry(points, crossings, bridgeRadius, maxBridgeDepth, cutoutOffset) {
  const geometry = [];
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex++) {
    const from = points[segmentIndex - 1];
    const to = points[segmentIndex];
    for (const bridge of groupedSegmentBridges(
      from,
      to,
      crossings,
      segmentIndex,
      bridgeRadius,
      maxBridgeDepth,
    )) {
      if (bridge.horizontal) {
        geometry.push({
          path: `M ${bridge.before} ${from.y} C ${bridge.before} ${from.y - bridge.bridgeDepth} ${bridge.after} ${from.y - bridge.bridgeDepth} ${bridge.after} ${from.y}`,
          cutoutPath: `M ${bridge.before} ${from.y + cutoutOffset} C ${bridge.before} ${from.y - bridge.bridgeDepth + cutoutOffset} ${bridge.after} ${from.y - bridge.bridgeDepth + cutoutOffset} ${bridge.after} ${from.y + cutoutOffset}`,
          bounds: {
            left: Math.min(bridge.before, bridge.after),
            right: Math.max(bridge.before, bridge.after),
            top: from.y - bridge.bridgeDepth,
            bottom: from.y,
          },
        });
      } else {
        geometry.push({
          path: `M ${from.x} ${bridge.before} C ${from.x + bridge.bridgeDepth} ${bridge.before} ${from.x + bridge.bridgeDepth} ${bridge.after} ${from.x} ${bridge.after}`,
          cutoutPath: `M ${from.x - cutoutOffset} ${bridge.before} C ${from.x + bridge.bridgeDepth - cutoutOffset} ${bridge.before} ${from.x + bridge.bridgeDepth - cutoutOffset} ${bridge.after} ${from.x - cutoutOffset} ${bridge.after}`,
          bounds: {
            left: from.x,
            right: from.x + bridge.bridgeDepth,
            top: Math.min(bridge.before, bridge.after),
            bottom: Math.max(bridge.before, bridge.after),
          },
        });
      }
    }
  }
  return geometry;
}

function renderedRouteBounds(points, bridgeGeometryForRoute) {
  const bounds = [];
  for (let segmentIndex = 1; segmentIndex < points.length; segmentIndex++) {
    const from = points[segmentIndex - 1];
    const to = points[segmentIndex];
    bounds.push({
      left: Math.min(from.x, to.x),
      right: Math.max(from.x, to.x),
      top: Math.min(from.y, to.y),
      bottom: Math.max(from.y, to.y),
    });
  }
  bounds.push(...bridgeGeometryForRoute.map((bridge) => bridge.bounds));
  return bounds;
}

function paddedBoundsIntersect(left, right, padding) {
  return left.left - padding <= right.right + EPSILON
    && left.right + padding >= right.left - EPSILON
    && left.top - padding <= right.bottom + EPSILON
    && left.bottom + padding >= right.top - EPSILON;
}

export function planOrthogonalBridges(routes, {
  bridgeRadius = 4.5,
  maxBridgeDepth = 9,
  interactionPadding = 4,
  cutoutOffset = 0,
} = {}) {
  const crossingsByEdge = routes.map((route, edgeIndex) =>
    findOrthogonalCrossings(route, routes.slice(0, edgeIndex)));
  const bridgesByEdge = routes.map((route, edgeIndex) => bridgeGeometry(
    route,
    crossingsByEdge[edgeIndex],
    bridgeRadius,
    maxBridgeDepth,
    cutoutOffset,
  ));
  const routeBounds = routes.map((route, edgeIndex) =>
    renderedRouteBounds(route, bridgesByEdge[edgeIndex]));
  const bridgePathsByEdge = bridgesByEdge.map((bridges) =>
    bridges.map((bridge) => bridge.path));
  const underpassCutouts = routes.map((_, edgeIndex) => bridgesByEdge.flatMap(
    (bridges, bridgeEdgeIndex) => (bridgeEdgeIndex === edgeIndex ? [] : bridges
      .filter((bridge) => routeBounds[edgeIndex].some((bounds) =>
        paddedBoundsIntersect(bridge.bounds, bounds, interactionPadding)))
      .map((bridge) => bridge.cutoutPath)),
  ));
  const bridgeOverlayCutouts = routes.map((_, edgeIndex) => bridgesByEdge.flatMap(
    (bridges, bridgeEdgeIndex) => (bridgeEdgeIndex <= edgeIndex ? [] : bridges
      .filter((bridge) => bridgesByEdge[edgeIndex].some((targetBridge) =>
        paddedBoundsIntersect(bridge.bounds, targetBridge.bounds, interactionPadding)))
      .map((bridge) => bridge.cutoutPath)),
  ));
  return {
    crossingsByEdge,
    underpassCutouts,
    bridgePathsByEdge,
    bridgeOverlayCutouts,
  };
}
