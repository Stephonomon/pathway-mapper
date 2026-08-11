/**
 * Geometry helpers shared by extraction, inference, and the SVG overlay.
 *
 * Canonical coordinate space for this whole project: **top-left origin, page
 * units** (e.g. 612 x 792 for US Letter). This is what pdf.js produces after the
 * base transform on the operator list, and what `page.getViewport({ scale: 1 })`
 * renders into, so a bbox extracted here drops straight onto the canvas overlay
 * with no reconciliation.
 */

export type Point = readonly [number, number];

/** PDF transform matrix `[a, b, c, d, e, f]`. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Apply `m` then `n` (i.e. the result transforms a point as `n(m(p))`). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function boundsOf(points: readonly Point[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function centerOf(r: Rect): Point {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

export function areaOf(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function containsPoint(r: Rect, [x, y]: Point, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

/** Fraction of `inner`'s area that falls inside `outer`. */
export function overlapRatio(inner: Rect, outer: Rect): number {
  const w = Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x);
  const h = Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y);
  if (w <= 0 || h <= 0) return 0;
  const a = areaOf(inner);
  return a === 0 ? 0 : (w * h) / a;
}

/** True when two rects describe essentially the same box (fill/stroke pairs). */
export function nearlySameRect(a: Rect, b: Rect, tol = 1.5): boolean {
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.w - b.w) <= tol &&
    Math.abs(a.h - b.h) <= tol
  );
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Shortest distance from a point to the perimeter of a rect (0 when inside). */
export function distanceToRect(r: Rect, [x, y]: Point): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export function expandRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

/** Parse pdf.js's `#rrggbb` colour strings into 0-1 RGB. */
export function parseHexColor(hex: string | null | undefined): [number, number, number] | null {
  if (!hex || typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function roundRect(r: Rect, digits = 2): Rect {
  const f = 10 ** digits;
  return {
    x: Math.round(r.x * f) / f,
    y: Math.round(r.y * f) / f,
    w: Math.round(r.w * f) / f,
    h: Math.round(r.h * f) / f,
  };
}
