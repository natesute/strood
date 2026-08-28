import { describe, expect, it } from 'vitest';
import { organicLayout } from '../src/organic-layout.js';

const box = (id, width = 200, height = 120) => ({ id, width, height });

function gapBetween(a, b) {
  const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
  const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
  return Math.max(gapX, gapY);
}

function centre(boxLayout) {
  return { x: boxLayout.x + boxLayout.width / 2, y: boxLayout.y + boxLayout.height / 2 };
}

function distance(a, b) {
  return Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);
}

describe('organicLayout', () => {
  it('keeps a routing corridor between every pair of nodes', () => {
    const nodes = [box('hub', 190, 140)];
    const edges = [];
    for (let index = 0; index < 18; index++) {
      nodes.push(box(`leaf-${index}`, 330, 172));
      edges.push({ from: 'hub', to: `leaf-${index}` });
    }
    const layout = organicLayout({ nodes, edges });
    const boxes = Object.values(layout);
    for (let left = 0; left < boxes.length; left++) {
      for (let right = left + 1; right < boxes.length; right++) {
        expect(gapBetween(boxes[left], boxes[right])).toBeGreaterThanOrEqual(28);
      }
    }
  });

  it('pulls connected nodes closer than unrelated ones', () => {
    const nodes = [];
    const edges = [];
    for (const cluster of ['a', 'b', 'c', 'd']) {
      nodes.push(box(`${cluster}-hub`));
      for (let index = 0; index < 3; index++) {
        nodes.push(box(`${cluster}-leaf-${index}`));
        edges.push({ from: `${cluster}-hub`, to: `${cluster}-leaf-${index}` });
      }
    }
    const layout = organicLayout({ nodes, edges });
    // Compaction packs everything corridor-tight, so pointwise distances
    // converge; what must survive is coherence — every cluster keeps its own
    // region, so members sit far closer to their own centroid than to any
    // other cluster's.
    const clusters = ['a', 'b', 'c', 'd'];
    const members = (cluster) => [
      layout[`${cluster}-hub`],
      layout[`${cluster}-leaf-0`],
      layout[`${cluster}-leaf-1`],
      layout[`${cluster}-leaf-2`],
    ];
    const centroids = Object.fromEntries(clusters.map((cluster) => {
      const points = members(cluster).map(centre);
      return [cluster, {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      }];
    }));
    const toCentroid = (boxLayout, cluster) => Math.hypot(
      centre(boxLayout).x - centroids[cluster].x,
      centre(boxLayout).y - centroids[cluster].y,
    );
    const own = [];
    const foreign = [];
    for (const cluster of clusters) {
      for (const member of members(cluster)) {
        own.push(toCentroid(member, cluster));
        foreign.push(Math.min(...clusters.filter((name) => name !== cluster)
          .map((name) => toCentroid(member, name))));
      }
    }
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(own)).toBeLessThan(mean(foreign) * 0.75);
  });

  it('keeps edges short relative to the drawing size', () => {
    const nodes = [];
    const edges = [];
    for (let chain = 0; chain < 5; chain++) {
      let previous = null;
      for (let index = 0; index < 4; index++) {
        const id = `chain-${chain}-${index}`;
        nodes.push(box(id, 330, 172));
        if (previous) edges.push({ from: previous, to: id });
        previous = id;
      }
    }
    const layout = organicLayout({ nodes, edges });
    const boxes = Object.values(layout);
    const spanX = Math.max(...boxes.map((item) => item.x + item.width))
      - Math.min(...boxes.map((item) => item.x));
    for (const edge of edges) {
      expect(distance(layout[edge.from], layout[edge.to])).toBeLessThan(spanX / 2);
    }
  });

  it('lands near the viewport aspect so the fitted zoom fills the screen', () => {
    const nodes = [];
    for (let index = 0; index < 26; index++) nodes.push(box(`n-${index}`, 260, 150));
    const layout = organicLayout({ nodes, edges: [], viewportWidth: 1280, viewportHeight: 720 });
    const boxes = Object.values(layout);
    const width = Math.max(...boxes.map((item) => item.x + item.width));
    const height = Math.max(...boxes.map((item) => item.y + item.height));
    const aspect = width / height;
    expect(aspect).toBeGreaterThan(1.2);
    expect(aspect).toBeLessThan(2.4);
  });

  it('is deterministic and survives dependency cycles', () => {
    const nodes = [box('x'), box('y'), box('z')];
    const edges = [
      { from: 'x', to: 'y' },
      { from: 'y', to: 'z' },
      { from: 'z', to: 'x' },
    ];
    const first = organicLayout({ nodes, edges });
    const second = organicLayout({ nodes, edges });
    expect(second).toEqual(first);
    expect(Object.keys(first)).toHaveLength(3);
    expect(organicLayout({ nodes: [], edges: [] })).toEqual({});
  });
});
