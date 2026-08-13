/**
 * The route highlighter falls back to right-angle routing for edges with no
 * traced geometry. These pin the two properties that make it read like a drawn
 * flowchart line: every segment is axis-aligned, and the ends sit on the boxes'
 * facing edges — never a diagonal cutting across the page.
 */

import { describe, expect, it } from 'vitest';
import { orthogonalRoute, routeEdgePoints, simplify, type Point } from '@/lib/route/orthogonal';
import type { Rect } from '@/lib/schema';

const box = (x: number, y: number, w = 100, h = 40): Rect => ({ x, y, w, h });

/** Every consecutive pair shares an x or a y — i.e. no diagonal segments. */
function allAxisAligned(points: Point[]): boolean {
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i][0] - points[i - 1][0]);
    const dy = Math.abs(points[i][1] - points[i - 1][1]);
    if (dx > 0.5 && dy > 0.5) return false;
  }
  return true;
}

describe('orthogonalRoute', () => {
  it('draws a straight drop between vertically-aligned boxes', () => {
    const from = box(0, 0);
    const to = box(0, 100);
    const path = orthogonalRoute(from, to);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual([50, 40]); // bottom-centre of `from`
    expect(path[1]).toEqual([50, 100]); // top-centre of `to`
  });

  it('draws a clean Z to an offset box below, all right angles', () => {
    const from = box(0, 0);
    const to = box(200, 120);
    const path = orthogonalRoute(from, to);
    expect(allAxisAligned(path)).toBe(true);
    // Exits the bottom of `from` and enters the top of `to`.
    expect(path[0]).toEqual([50, 40]);
    expect(path[path.length - 1]).toEqual([250, 120]);
    // A genuine jog: more than a single straight segment.
    expect(path.length).toBeGreaterThan(2);
  });

  it('routes horizontally when the boxes are side by side', () => {
    const from = box(0, 0);
    const to = box(200, 5); // rows overlap, columns do not
    const path = orthogonalRoute(from, to);
    expect(allAxisAligned(path)).toBe(true);
    expect(path[0]).toEqual([100, 20]); // right edge of `from`
    expect(path[path.length - 1]).toEqual([200, 25]); // left edge of `to`
  });

  it('exits upward when the target is above', () => {
    const from = box(0, 200);
    const to = box(0, 0);
    const path = orthogonalRoute(from, to);
    expect(path[0]).toEqual([50, 200]); // top of `from`
    expect(path[path.length - 1]).toEqual([50, 40]); // bottom of `to`
  });

  it('never emits a diagonal, whatever the offset', () => {
    for (const [dx, dy] of [
      [200, 30],
      [-150, 220],
      [40, -180],
      [300, 300],
    ]) {
      expect(allAxisAligned(orthogonalRoute(box(0, 0), box(dx, dy)))).toBe(true);
    }
  });
});

describe('routeEdgePoints', () => {
  it('keeps a real traced polyline (3+ points) untouched', () => {
    const traced: Point[] = [
      [0, 0],
      [0, 50],
      [80, 50],
      [80, 90],
    ];
    expect(routeEdgePoints(traced, box(0, 0), box(200, 100))).toBe(traced);
  });

  it('synthesises a path when geometry is a straight stub or missing', () => {
    const stub: Point[] = [
      [10, 10],
      [12, 12],
    ];
    const out = routeEdgePoints(stub, box(0, 0), box(200, 120));
    expect(out).not.toBe(stub);
    expect(allAxisAligned(out)).toBe(true);
  });
});

describe('simplify', () => {
  it('collapses a collinear run to its endpoints', () => {
    expect(
      simplify([
        [0, 0],
        [0, 25],
        [0, 50],
      ]),
    ).toEqual([
      [0, 0],
      [0, 50],
    ]);
  });

  it('drops coincident points', () => {
    expect(
      simplify([
        [0, 0],
        [0, 0],
        [0, 40],
      ]),
    ).toEqual([
      [0, 0],
      [0, 40],
    ]);
  });
});
