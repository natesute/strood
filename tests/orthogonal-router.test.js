import { describe, expect, it } from 'vitest';
import { createOrthogonalRouter, orthogonalPath } from '../src/orthogonal-router.js';

function crossesInterior(from, to, rect) {
  if (from.y === to.y) {
    return from.y > rect.top && from.y < rect.bottom
      && Math.max(Math.min(from.x, to.x), rect.left) < Math.min(Math.max(from.x, to.x), rect.right);
  }
  return from.x > rect.left && from.x < rect.right
    && Math.max(Math.min(from.y, to.y), rect.top) < Math.min(Math.max(from.y, to.y), rect.bottom);
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
});
