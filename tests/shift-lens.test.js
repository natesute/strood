import { describe, expect, it } from 'vitest';
import { clampedSampleRect, lensWorldTransform } from '../src/shift-lens.js';

describe('lensWorldTransform', () => {
  const camera = { x: -120, y: 64, scale: 0.8 };
  const base = { pointerX: 300, pointerY: 210, camera, radius: 132, zoom: 2.25 };

  it('maps the surface point under the pointer to the lens centre', () => {
    const transform = lensWorldTransform(base);
    const worldX = (base.pointerX - camera.x) / camera.scale;
    const worldY = (base.pointerY - camera.y) / camera.scale;
    expect(transform.translateX + worldX * transform.scale).toBeCloseTo(base.radius);
    expect(transform.translateY + worldY * transform.scale).toBeCloseTo(base.radius);
    expect(transform.scale).toBeCloseTo(camera.scale * base.zoom);
  });

  it('keeps every channel scale anchored at the lens centre', () => {
    const worldX = (base.pointerX - camera.x) / camera.scale;
    for (const channelScale of [0.992, 1, 1.008]) {
      const transform = lensWorldTransform({ ...base, channelScale });
      expect(transform.translateX + worldX * transform.scale).toBeCloseTo(base.radius);
      expect(transform.scale).toBeCloseTo(camera.scale * base.zoom * channelScale);
    }
  });

  it('separates off-centre points proportionally to the channel scale', () => {
    const plain = lensWorldTransform(base);
    const shifted = lensWorldTransform({ ...base, channelScale: 1.01 });
    const worldX = (base.pointerX - camera.x) / camera.scale;
    const offCentre = worldX + 40;
    const plainScreen = plain.translateX + offCentre * plain.scale;
    const shiftedScreen = shifted.translateX + offCentre * shifted.scale;
    expect(shiftedScreen - plainScreen).toBeCloseTo(40 * camera.scale * base.zoom * 0.01);
  });
});

describe('clampedSampleRect', () => {
  it('returns the full square when the sample fits inside the source', () => {
    const rect = clampedSampleRect({
      centerX: 200, centerY: 150, half: 50, sourceWidth: 800, sourceHeight: 600, targetSize: 264,
    });
    expect(rect).toEqual({ sx: 150, sy: 100, sw: 100, sh: 100, dx: 0, dy: 0, dw: 264, dh: 264 });
  });

  it('clamps at the source edge and offsets the destination to match', () => {
    const rect = clampedSampleRect({
      centerX: 20, centerY: 150, half: 50, sourceWidth: 800, sourceHeight: 600, targetSize: 264,
    });
    expect(rect.sx).toBe(0);
    expect(rect.sw).toBe(70);
    expect(rect.dx).toBeCloseTo(30 * 2.64);
    expect(rect.dw).toBeCloseTo(70 * 2.64);
    expect(rect.dy).toBe(0);
    expect(rect.dh).toBe(264);
  });

  it('returns null when the sample misses the source entirely', () => {
    expect(clampedSampleRect({
      centerX: -80, centerY: 150, half: 50, sourceWidth: 800, sourceHeight: 600, targetSize: 264,
    })).toBeNull();
    expect(clampedSampleRect({
      centerX: 10, centerY: 10, half: 0, sourceWidth: 800, sourceHeight: 600, targetSize: 264,
    })).toBeNull();
  });
});
