import { describe, expect, it } from 'vitest';
import {
  createOrthogonalRouter,
  findCoincidentSegments,
  findOrthogonalCrossings,
  findParallelSegmentConflicts,
  orthogonalBridgePath,
  orthogonalPath,
  planOrthogonalBridges,
  routeOrthogonalEdges,
  spaceOrthogonalRoutes,
} from '../src/orthogonal-router.js';

function crossesInterior(from, to, rect) {
  if (from.y === to.y) {
    return from.y > rect.top && from.y < rect.bottom
      && Math.max(Math.min(from.x, to.x), rect.left) < Math.min(Math.max(from.x, to.x), rect.right);
  }
  return from.x > rect.left && from.x < rect.right
    && Math.max(Math.min(from.y, to.y), rect.top) < Math.min(Math.max(from.y, to.y), rect.bottom);
}

function closestParallelLaneDistance(routes, minimumOverlap = 5) {
  let closest = Infinity;
  for (let left = 0; left < routes.length; left += 1) {
    for (let right = left + 1; right < routes.length; right += 1) {
      for (let a = 1; a < routes[left].length; a += 1) {
        const aFrom = routes[left][a - 1];
        const aTo = routes[left][a];
        const horizontal = aFrom.y === aTo.y;
        for (let b = 1; b < routes[right].length; b += 1) {
          const bFrom = routes[right][b - 1];
          const bTo = routes[right][b];
          if (horizontal !== (bFrom.y === bTo.y)) continue;
          const overlap = horizontal
            ? Math.max(0, Math.min(Math.max(aFrom.x, aTo.x), Math.max(bFrom.x, bTo.x))
              - Math.max(Math.min(aFrom.x, aTo.x), Math.min(bFrom.x, bTo.x)))
            : Math.max(0, Math.min(Math.max(aFrom.y, aTo.y), Math.max(bFrom.y, bTo.y))
              - Math.max(Math.min(aFrom.y, aTo.y), Math.min(bFrom.y, bTo.y)));
          if (overlap <= minimumOverlap) continue;
          const distance = horizontal
            ? Math.abs(aFrom.y - bFrom.y)
            : Math.abs(aFrom.x - bFrom.x);
          closest = Math.min(closest, distance);
        }
      }
    }
  }
  return closest;
}

describe('orthogonal graph routing', () => {
  it('uses right-angle lanes that clear every intervening node', () => {
    const rectangles = [
      { id: 'source', left: 10, right: 50, top: 20, bottom: 60 },
      { id: 'blocker', left: 80, right: 120, top: 10, bottom: 70 },
      { id: 'target', left: 150, right: 190, top: 20, bottom: 60 },
    ];
    const router = createOrthogonalRouter(rectangles, {
      clearance: 5,
      bounds: { left: 0, right: 200, top: 0, bottom: 100 },
    });
    const route = router.route({ x: 50, y: 40 }, { x: 150, y: 40 }, 'source', 'target');

    expect(route.length).toBeGreaterThan(2);
    for (let index = 1; index < route.length; index++) {
      const from = route[index - 1];
      const to = route[index];
      expect(from.x === to.x || from.y === to.y).toBe(true);
      expect(crossesInterior(from, to, rectangles[1])).toBe(false);
    }
    expect(orthogonalPath(route)).toMatch(/^M [\d.]+ [\d.]+(?: L [\d.]+ [\d.]+)+$/);
    expect(orthogonalPath(route)).not.toMatch(/[CAQ]/);
  });

  it('routes a self-edge as a visible loop outside its node', () => {
    const rectangle = { id: 'self', left: 20, right: 100, top: 20, bottom: 120 };
    const router = createOrthogonalRouter([rectangle], {
      clearance: 12,
      bounds: { left: 0, right: 140, top: 0, bottom: 160 },
    });
    const route = router.routeBetween('self', 'self');

    expect(route.length).toBeGreaterThan(2);
    expect(route[0]).not.toEqual(route.at(-1));
    for (let index = 1; index < route.length; index += 1) {
      expect(route[index].x === route[index - 1].x
        || route[index].y === route[index - 1].y).toBe(true);
      expect(crossesInterior(route[index - 1], route[index], rectangle)).toBe(false);
    }
  });

  it('does not draw a dishonest fallback between containing nodes', () => {
    const rectangles = [
      { id: 'outer', left: 20, right: 200, top: 20, bottom: 180 },
      { id: 'inner', left: 80, right: 140, top: 70, bottom: 130 },
    ];
    const router = createOrthogonalRouter(rectangles, {
      clearance: 12,
      bounds: { left: 0, right: 220, top: 0, bottom: 200 },
    });

    expect(router.routeBetween('outer', 'inner')).toEqual([]);
    expect(router.routeBetween('inner', 'outer')).toEqual([]);
  });

  it('chooses the closest pair of node sides', () => {
    const rectangles = [
      { id: 'source', left: 20, right: 100, top: 10, bottom: 50 },
      { id: 'target', left: 30, right: 110, top: 100, bottom: 140 },
    ];
    const router = createOrthogonalRouter(rectangles, {
      clearance: 5,
      bounds: { left: 0, right: 160, top: 0, bottom: 160 },
    });
    const route = router.routeBetween('source', 'target');

    expect(route[0]).toEqual({ x: 60, y: 50 });
    expect(route.at(-1)).toEqual({ x: 70, y: 100 });
    expect(route.every((point, index) => index === 0
      || point.x === route[index - 1].x
      || point.y === route[index - 1].y)).toBe(true);
  });

  it('reserves staggered ports and lanes instead of stacking repeated routes', () => {
    const rectangles = [
      { id: 'source', left: 20, right: 100, top: 20, bottom: 120 },
      { id: 'target', left: 220, right: 300, top: 20, bottom: 120 },
    ];
    const router = createOrthogonalRouter(rectangles, {
      clearance: 12,
      bounds: { left: 0, right: 320, top: 0, bottom: 160 },
    });
    const first = router.routeBetween('source', 'target');
    const second = router.routeBetween('source', 'target');

    expect(second).not.toEqual(first);
    expect(second[0]).not.toEqual(first[0]);
    expect(second.at(-1)).not.toEqual(first.at(-1));
    expect(closestParallelLaneDistance([first, second])).toBeGreaterThanOrEqual(7);
    for (const route of [first, second]) {
      expect(route.every((point, index) => index === 0
        || point.x === route[index - 1].x
        || point.y === route[index - 1].y)).toBe(true);
    }
  });

  it('spaces a batch of nearby highway lanes onto a consistent circuit grid', () => {
    const routes = [
      [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 40 }, { x: 110, y: 40 }, { x: 110, y: 70 }, { x: 120, y: 70 }],
      [{ x: 0, y: 20 }, { x: 12, y: 20 }, { x: 12, y: 42 }, { x: 112, y: 42 }, { x: 112, y: 80 }, { x: 120, y: 80 }],
      [{ x: 0, y: 30 }, { x: 14, y: 30 }, { x: 14, y: 44 }, { x: 114, y: 44 }, { x: 114, y: 90 }, { x: 120, y: 90 }],
    ];
    const spaced = spaceOrthogonalRoutes(routes, [], {
      bounds: { left: 0, right: 120, top: 0, bottom: 100 },
    });

    expect(closestParallelLaneDistance(spaced)).toBeGreaterThanOrEqual(7);
    expect(spaced.map((route) => [route[0], route.at(-1)]))
      .toEqual(routes.map((route) => [route[0], route.at(-1)]));
  });

  it('routes dense fan-out and fan-in edges without any coincident segments', () => {
    const rectangles = [
      { id: 'source', left: 20, right: 100, top: 100, bottom: 180 },
      { id: 'lane-1', left: 260, right: 340, top: 20, bottom: 70 },
      { id: 'lane-2', left: 260, right: 340, top: 80, bottom: 130 },
      { id: 'lane-3', left: 260, right: 340, top: 140, bottom: 190 },
      { id: 'lane-4', left: 260, right: 340, top: 200, bottom: 250 },
      { id: 'sink', left: 500, right: 580, top: 100, bottom: 180 },
    ];
    const edges = rectangles.slice(1, -1).flatMap(({ id }, index) => [
      { id: `out-${index}`, from: 'source', to: id },
      { id: `in-${index}`, from: id, to: 'sink' },
    ]);
    const options = {
      clearance: 12,
      minimumLaneSeparation: 5,
      bounds: { left: 0, right: 600, top: 0, bottom: 280 },
    };
    const routes = routeOrthogonalEdges(rectangles, edges, options);

    expect(routes).toHaveLength(edges.length);
    expect(routes.every((route) => route.length > 1)).toBe(true);
    expect(findCoincidentSegments(routes)).toEqual([]);
    expect(findParallelSegmentConflicts(routes, 5, 0)).toEqual([]);
    expect(new Set(routes.filter((_, index) => index % 2 === 0)
      .map((route) => route[0].y)).size).toBe(4);
    expect(new Set(routes.filter((_, index) => index % 2 === 1)
      .map((route) => route.at(-1).y)).size).toBe(4);
    expect(routeOrthogonalEdges(rectangles, edges, options)).toEqual(routes);
  });

  it('detects even short positive-length coincident edge segments', () => {
    const routes = [
      [{ x: 0, y: 10 }, { x: 20, y: 10 }],
      [{ x: 17, y: 10 }, { x: 30, y: 10 }],
    ];

    expect(findCoincidentSegments(routes)).toMatchObject([{
      leftRouteIndex: 0,
      rightRouteIndex: 1,
      overlap: 3,
    }]);
  });

  it('rejects parallel runs close enough for their strokes to overlap', () => {
    const routes = [
      [{ x: 0, y: 10 }, { x: 80, y: 10 }],
      [{ x: 20, y: 11 }, { x: 60, y: 11 }],
    ];

    expect(findCoincidentSegments(routes)).toEqual([]);
    expect(findParallelSegmentConflicts(routes, 2)).toMatchObject([{
      laneDistance: 1,
      overlap: 40,
    }]);
  });

  it('routes a cramped self-edge around an exposed side of its node', () => {
    const rectangles = Array.from({ length: 9 }, (_, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const left = 50 + column * 90;
      const top = 50 + row * 60;
      return { id: `n${index}`, left, right: left + 80, top, bottom: top + 50 };
    });
    const route = routeOrthogonalEdges(
      rectangles,
      [{ id: 'self-7', from: 'n7', to: 'n7' }],
      { clearance: 12, bounds: { left: 0, right: 370, top: 0, bottom: 280 } },
    )[0];
    const self = rectangles[7];

    expect(route.length).toBeGreaterThan(3);
    expect(route[0]).not.toEqual(route.at(-1));
    for (let index = 1; index < route.length; index++) {
      expect(crossesInterior(route[index - 1], route[index], self)).toBe(false);
    }
  });

  it('draws a circuit bridge where a later route crosses an earlier route', () => {
    const earlier = [[{ x: 50, y: 0 }, { x: 50, y: 60 }]];
    const later = [{ x: 0, y: 30 }, { x: 100, y: 30 }];
    const crossings = findOrthogonalCrossings(later, earlier);
    const path = orthogonalPath(later, crossings);

    expect(crossings).toEqual([{ segmentIndex: 1, x: 50, y: 30 }]);
    expect(path).toContain(' C ');
    expect(path).toMatch(/^M 0 30 L 45\.5 30 C /);
    expect(path.endsWith(' L 100 30')).toBe(true);
    expect(orthogonalBridgePath(later, crossings))
      .toBe('M 45.5 30 C 45.5 25.5 54.5 25.5 54.5 30');
  });

  it('masks every other edge reached by the rendered bridge curve', () => {
    const routes = [
      [{ x: 0, y: 26.625 }, { x: 100, y: 26.625 }],
      [{ x: 50, y: 0 }, { x: 50, y: 60 }],
      [{ x: 0, y: 30 }, { x: 100, y: 30 }],
    ];
    const bridgePath = 'M 45.5 30 C 45.5 25.5 54.5 25.5 54.5 30';
    const { crossingsByEdge, underpassCutouts } = planOrthogonalBridges(routes);
    const renderedBridgeMidpointY = (30 + 3 * 25.5 + 3 * 25.5 + 30) / 8;

    expect(findParallelSegmentConflicts([routes[0], routes[2]], 2)).toEqual([]);
    expect(routes[0][0].y).toBe(renderedBridgeMidpointY);
    expect(crossingsByEdge[2]).toContainEqual({ segmentIndex: 1, x: 50, y: 30 });
    expect(underpassCutouts[0]).toContain(bridgePath);
    expect(underpassCutouts[1]).toContain(bridgePath);
    expect(underpassCutouts[2]).not.toContain(bridgePath);
  });

  it('keeps bridge clearance on the inside of the curve', () => {
    const horizontal = [
      [{ x: 50, y: 0 }, { x: 50, y: 60 }],
      [{ x: 0, y: 30 }, { x: 100, y: 30 }],
    ];
    const vertical = [
      [{ x: 0, y: 30 }, { x: 100, y: 30 }],
      [{ x: 50, y: 0 }, { x: 50, y: 60 }],
    ];

    expect(planOrthogonalBridges(horizontal, { cutoutOffset: 2 }).underpassCutouts[0])
      .toContain('M 45.5 32 C 45.5 27.5 54.5 27.5 54.5 32');
    expect(planOrthogonalBridges(vertical, { cutoutOffset: 2 }).underpassCutouts[0])
      .toContain('M 48 25.5 C 52.5 25.5 52.5 34.5 48 34.5');
  });

  it('uses bridge overlays for priority without exposing later straight segments', () => {
    const vertical = [{ x: 50, y: 0 }, { x: 50, y: 60 }];
    const earlierBridge = [{ x: 0, y: 30 }, { x: 100, y: 30 }];
    const laterBridge = [{ x: 0, y: 26.625 }, { x: 100, y: 26.625 }];
    const earlierBridgePath = 'M 45.5 30 C 45.5 25.5 54.5 25.5 54.5 30';
    const laterBridgePath = 'M 45.5 26.625 C 45.5 22.125 54.5 22.125 54.5 26.625';
    const bridgePlan = planOrthogonalBridges([vertical, earlierBridge, laterBridge]);

    expect(bridgePlan.underpassCutouts[1]).toContain(laterBridgePath);
    expect(bridgePlan.underpassCutouts[2]).toContain(earlierBridgePath);
    expect(bridgePlan.bridgeOverlayCutouts[1]).toContain(laterBridgePath);
    expect(bridgePlan.bridgeOverlayCutouts[2]).not.toContain(earlierBridgePath);

    const laterStraight = [{ x: 44, y: 26.625 }, { x: 49, y: 26.625 }];
    const straightPlan = planOrthogonalBridges([vertical, earlierBridge, laterStraight]);
    expect(straightPlan.crossingsByEdge[2]).toEqual([]);
    expect(straightPlan.underpassCutouts[2]).toContain(earlierBridgePath);

    const mixedPlan = planOrthogonalBridges([
      [{ x: 20, y: 0 }, { x: 20, y: 60 }],
      [{ x: 80, y: 0 }, { x: 80, y: 60 }],
      [{ x: 0, y: 30 }, { x: 100, y: 30 }],
      [{ x: 0, y: 26.625 }, { x: 79, y: 26.625 }],
    ]);
    const farEarlierBridge = 'M 75.5 30 C 75.5 25.5 84.5 25.5 84.5 30';
    const mixedLaterBridge = 'M 15.5 26.625 C 15.5 22.125 24.5 22.125 24.5 26.625';
    expect(mixedPlan.bridgePathsByEdge[3]).toEqual([mixedLaterBridge]);
    expect(mixedPlan.underpassCutouts[3]).toContain(farEarlierBridge);
    expect(mixedPlan.bridgeOverlayCutouts[2]).toContain(mixedLaterBridge);
  });

  it('accepts scale-adjusted padding for non-scaling bridge strokes', () => {
    const routes = [
      [{ x: 50, y: 0 }, { x: 50, y: 60 }],
      [{ x: 0, y: 30 }, { x: 100, y: 30 }],
      [{ x: 44, y: 21 }, { x: 49, y: 21 }],
    ];
    const bridgePath = 'M 45.5 30 C 45.5 25.5 54.5 25.5 54.5 30';

    expect(planOrthogonalBridges(routes, { interactionPadding: 4 })
      .underpassCutouts[2]).not.toContain(bridgePath);
    expect(planOrthogonalBridges(routes, { interactionPadding: 8 })
      .underpassCutouts[2]).toContain(bridgePath);
  });

  it('bridges a crossing near the older route corner when the new segment has room', () => {
    const earlier = [[
      { x: 0, y: 30 },
      { x: 52, y: 30 },
      { x: 52, y: 70 },
    ]];
    const later = [{ x: 50, y: 0 }, { x: 50, y: 80 }];

    expect(findOrthogonalCrossings(later, earlier))
      .toEqual([{ segmentIndex: 1, x: 50, y: 30 }]);
  });

  it('does not bridge a shared endpoint where the new route cannot fit a jump', () => {
    const earlier = [[{ x: 50, y: 0 }, { x: 50, y: 30 }]];
    const later = [{ x: 0, y: 30 }, { x: 50, y: 30 }];

    expect(findOrthogonalCrossings(later, earlier)).toEqual([]);
  });

  it('ignores perpendicular lanes whose finite segments do not meet', () => {
    const earlier = [[{ x: 0, y: 30 }, { x: 20, y: 30 }]];
    const later = [{ x: 50, y: 0 }, { x: 50, y: 80 }];

    expect(findOrthogonalCrossings(later, earlier)).toEqual([]);
  });

  it('uses one clean bridge for a bundle of nearby highway lanes', () => {
    const highway = [30, 37, 44].map((y) => [
      { x: 0, y },
      { x: 100, y },
    ]);
    const crossingRoute = [{ x: 50, y: 0 }, { x: 50, y: 80 }];
    const crossings = findOrthogonalCrossings(crossingRoute, highway);
    const path = orthogonalPath(crossingRoute, crossings);

    expect(crossings).toHaveLength(3);
    expect(path.match(/ C /g)).toHaveLength(1);
    expect(path).toBe('M 50 0 L 50 25.5 C 59 25.5 59 48.5 50 48.5 L 50 80');
  });

  it('keeps a bundled bridge inside the router clearance', () => {
    const highway = [30, 37, 44, 51, 58].map((y) => [
      { x: 0, y },
      { x: 100, y },
    ]);
    const crossingRoute = [{ x: 50, y: 0 }, { x: 50, y: 90 }];
    const crossings = findOrthogonalCrossings(crossingRoute, highway);
    const path = orthogonalPath(crossingRoute, crossings);

    expect(crossings).toHaveLength(5);
    expect(path.match(/ C /g)).toHaveLength(1);
    expect(path).toContain('C 59 25.5 59 62.5 50 62.5');
  });
});
