/**
 * Stage 1b: classify raw path primitives into the shapes a flowchart is made of.
 *
 * Still deterministic. The hard part is that every institution draws flowcharts
 * differently, and a classifier tuned to one of them finds zero edges in the
 * others. Three real vocabularies, all supported here (see
 * `docs/extraction-notes.md`):
 *
 *   CHOP           connectors are thin *filled rectangles*; heads are small grey
 *                  filled triangles. No stroked lines anywhere on the page.
 *   Johns Hopkins  connectors are single 7-point *block-arrow polygons* — shaft
 *                  and head are one shape, with no separate triangle.
 *   Upstate        connectors are *stroked polylines*; heads are small black
 *                  filled triangles.
 *
 * So the detectors are written per-shape and run together, rather than the page
 * being assumed to follow one convention. Anything that matches nothing stays
 * unclassified rather than being forced into a bucket; the labeling pass and the
 * review UI are where ambiguity gets resolved.
 */

import type { PathPrimitive, RawPage } from './extract';
import type { Point, Rect } from './geometry';
import { boundsOf, distance, nearlySameRect } from './geometry';

/**
 * Connectors are drawn in ink, not in paper. Rather than matching one
 * institution's specific grey, reject anything close to white and accept the
 * rest — the shape and size constraints below do the real filtering.
 */
const MAX_INK_LIGHTNESS = 0.82;

/**
 * Link underlines are thin filled rects too, and on a document with a hundred
 * hyperlinks they would masquerade as arrow shafts. They are drawn in a
 * saturated link colour, so reject strongly saturated hues for shafts only.
 */
const MAX_SHAFT_SATURATION = 0.22;

/** Smallest rectangle we will treat as a node rather than a rule or a tick. */
const MIN_BOX_W = 24;
const MIN_BOX_H = 8;

/** Thin-rectangle limits for arrow shafts. */
const MAX_SHAFT_THICKNESS = 2.5;
const MIN_SHAFT_LENGTH = 4;

/** Arrow heads are small; anything larger is a real shape. */
const MAX_ARROWHEAD_SIZE = 16;

/** Block arrows (shaft and head as one polygon) sit in this size band. */
const BLOCK_ARROW_MIN_POINTS = 5;
const BLOCK_ARROW_MAX_POINTS = 9;
const BLOCK_ARROW_MAX_GIRTH = 24;
const BLOCK_ARROW_MIN_LENGTH = 7;

export interface BoxPrimitive {
  rect: Rect;
  stroke: [number, number, number] | null;
  fill: [number, number, number] | null;
  sourceIndex: number;
}

export interface Arrowhead {
  /** The point of the triangle — where the arrow lands. */
  tip: Point;
  /** Midpoint of the opposite side — where the shaft meets the head. */
  base: Point;
  /** Unit vector from base to tip. */
  direction: Point;
  rect: Rect;
  sourceIndex: number;
}

export interface Shaft {
  /** Centreline endpoints of the thin rectangle. */
  a: Point;
  b: Point;
  horizontal: boolean;
  rect: Rect;
  sourceIndex: number;
}

export interface PageGeometry {
  pageNumber: number;
  width: number;
  height: number;
  boxes: BoxPrimitive[];
  arrowheads: Arrowhead[];
  shafts: Shaft[];
}

/**
 * A path with no colour set was never given one, and PDF's initial colour is
 * black. Johns Hopkins' pathway relies on that default throughout, so treating
 * null as "no colour" rather than "black" loses every connector on the page.
 */
const BLACK: [number, number, number] = [0, 0, 0];

function colorOf(color: readonly number[] | null): [number, number, number] {
  return color ? [color[0], color[1], color[2]] : BLACK;
}

function lightness(color: readonly number[] | null): number {
  const [r, g, b] = colorOf(color);
  return (r + g + b) / 3;
}

function saturation(color: readonly number[] | null): number {
  const [r, g, b] = colorOf(color);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/** Ink rather than paper: dark enough to be a mark on the page. */
function isInk(color: readonly number[] | null): boolean {
  return lightness(color) <= MAX_INK_LIGHTNESS;
}

/** Return the rect if this path is a single axis-aligned rectangle. */
export function asAxisAlignedRect(path: PathPrimitive, tol = 0.75): Rect | null {
  if (path.subpaths.length !== 1) return null;
  const pts = path.subpaths[0];
  if (pts.length < 4 || pts.length > 5) return null;

  const bbox = boundsOf(pts);
  for (const [x, y] of pts) {
    const onVertical = Math.abs(x - bbox.x) <= tol || Math.abs(x - (bbox.x + bbox.w)) <= tol;
    const onHorizontal = Math.abs(y - bbox.y) <= tol || Math.abs(y - (bbox.y + bbox.h)) <= tol;
    if (!onVertical || !onHorizontal) return null;
  }
  return bbox;
}

/** Shoelace area of a polygon, used to tell solid shapes from thin ones. */
function polygonArea(pts: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * Return the bounding box if this path is a plausible node shape.
 *
 * Institutions draw nodes as plain rectangles (CHOP), rounded rectangles and
 * decision diamonds (Upstate), and stadium shapes. What they have in common is
 * being closed and reasonably solid — filling a good fraction of their own
 * bounding box. An elbow connector or a bracket is closed-ish but thin, so the
 * coverage test separates them: a diamond covers 0.5 of its box, a rounded
 * rectangle about 0.95, an L-shaped polyline far less.
 */
export function asNodeShape(path: PathPrimitive, minCoverage = 0.45): Rect | null {
  const rect = asAxisAlignedRect(path);
  if (rect) return rect;

  if (path.subpaths.length !== 1) return null;
  const pts = path.subpaths[0];
  if (pts.length < 4) return null;
  // An unclosed path is a line or a bracket, not a shape.
  if (!path.closed[0]) return null;

  const bbox = boundsOf(pts);
  if (bbox.w <= 0 || bbox.h <= 0) return null;
  if (polygonArea(pts) / (bbox.w * bbox.h) < minCoverage) return null;

  return bbox;
}

/** Return the triangle's three vertices if this path is a filled triangle. */
function asTriangle(path: PathPrimitive): Point[] | null {
  if (path.subpaths.length !== 1) return null;
  const pts = path.subpaths[0];
  if (pts.length !== 3) return null;
  return pts;
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * The tip is the vertex furthest from the midpoint of the other two — for the
 * isosceles heads these PDFs use, that is unambiguous.
 */
function orientTriangle(pts: Point[]): { tip: Point; base: Point } {
  let bestIndex = 0;
  let bestDistance = -1;
  for (let i = 0; i < 3; i++) {
    const others = [pts[(i + 1) % 3], pts[(i + 2) % 3]] as const;
    const d = distance(pts[i], midpoint(others[0], others[1]));
    if (d > bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }
  const tip = pts[bestIndex];
  const base = midpoint(pts[(bestIndex + 1) % 3], pts[(bestIndex + 2) % 3]);
  return { tip, base };
}

function unitVector(from: Point, to: Point): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/**
 * Node boxes are drawn as a white fill plus a coloured stroke at the same
 * coordinates. Keep the stroked copy — it carries the acuity colour.
 */
function collectBoxes(paths: PathPrimitive[], pageArea: number): BoxPrimitive[] {
  const stroked: BoxPrimitive[] = [];
  const filled: BoxPrimitive[] = [];

  for (const path of paths) {
    const rect = asNodeShape(path);
    if (!rect) continue;
    if (rect.w < MIN_BOX_W || rect.h < MIN_BOX_H) continue;
    // Full-bleed background panels are page furniture, not nodes.
    if (rect.w * rect.h > pageArea * 0.5) continue;

    const box: BoxPrimitive = {
      rect,
      stroke: path.stroke,
      fill: path.fill,
      sourceIndex: path.index,
    };
    if (path.paint === 'stroke' || path.paint === 'fillStroke') stroked.push(box);
    else filled.push(box);
  }

  // A filled rect only becomes its own box when nothing stroked covers it.
  const unmatched = filled.filter(
    (f) => !stroked.some((s) => nearlySameRect(s.rect, f.rect, 1.5)),
  );
  return [...stroked, ...unmatched].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/**
 * A block arrow is one polygon that is both shaft and head — the shape you get
 * from a word processor's arrow tool. Seven points is the canonical form (three
 * for the head, four for the tail), but allow a little slack.
 *
 * The tip is the vertex furthest from the centroid *along the long axis*; the
 * tail is the midpoint of the opposite end. That yields both an arrowhead and
 * the shaft it implies, so the rest of the pipeline treats it like any other
 * connector.
 */
function asBlockArrow(path: PathPrimitive): { head: Omit<Arrowhead, 'sourceIndex'>; tail: Point } | null {
  if (path.subpaths.length !== 1) return null;
  const pts = path.subpaths[0];
  if (pts.length < BLOCK_ARROW_MIN_POINTS || pts.length > BLOCK_ARROW_MAX_POINTS) return null;

  const { w, h } = path.bbox;
  const girth = Math.min(w, h);
  const length = Math.max(w, h);
  if (girth > BLOCK_ARROW_MAX_GIRTH || length < BLOCK_ARROW_MIN_LENGTH) return null;
  // An arrow is longer than it is wide; a squarish blob is something else.
  if (length < girth * 1.3) return null;

  const vertical = h >= w;
  const cx = path.bbox.x + w / 2;
  const cy = path.bbox.y + h / 2;

  // Along the long axis, the tip end is whichever extreme has fewer vertices
  // near it: the head narrows to a point, the tail is a flat edge.
  const along = (p: Point) => (vertical ? p[1] : p[0]);
  const across = (p: Point) => (vertical ? p[0] : p[1]);
  const centreAcross = vertical ? cx : cy;

  const lo = Math.min(...pts.map(along));
  const hi = Math.max(...pts.map(along));
  const nearLo = pts.filter((p) => Math.abs(along(p) - lo) < girth * 0.35);
  const nearHi = pts.filter((p) => Math.abs(along(p) - hi) < girth * 0.35);
  if (nearLo.length === nearHi.length) return null; // symmetric: not an arrow

  const tipAtLo = nearLo.length < nearHi.length;
  const tipAlong = tipAtLo ? lo : hi;
  const tailAlong = tipAtLo ? hi : lo;

  const tip: Point = vertical ? [centreAcross, tipAlong] : [tipAlong, centreAcross];
  const tail: Point = vertical ? [centreAcross, tailAlong] : [tailAlong, centreAcross];
  // The head occupies roughly the last third; put its base there so shaft
  // tracing starts from the right place.
  const baseAlong = tipAlong + (tailAlong - tipAlong) * 0.35;
  const base: Point = vertical ? [centreAcross, baseAlong] : [baseAlong, centreAcross];

  void across;
  return {
    head: { tip, base, direction: unitVector(base, tip), rect: path.bbox },
    tail,
  };
}

/**
 * Arrowheads, from any of the conventions seen in the wild: a small filled
 * triangle in any ink colour, or the pointed end of a block arrow.
 */
function collectArrowheads(paths: PathPrimitive[]): { heads: Arrowhead[]; blockShafts: Shaft[] } {
  const heads: Arrowhead[] = [];
  const blockShafts: Shaft[] = [];

  for (const path of paths) {
    if (path.paint === 'stroke') continue;
    if (!isInk(path.fill)) continue;
    const { w, h } = path.bbox;
    if (w < 1 || h < 1) continue;

    const tri = asTriangle(path);
    if (tri && w <= MAX_ARROWHEAD_SIZE && h <= MAX_ARROWHEAD_SIZE) {
      const { tip, base } = orientTriangle(tri);
      heads.push({
        tip,
        base,
        direction: unitVector(base, tip),
        rect: path.bbox,
        sourceIndex: path.index,
      });
      continue;
    }

    const block = asBlockArrow(path);
    if (block) {
      heads.push({ ...block.head, sourceIndex: path.index });
      blockShafts.push({
        a: block.head.base,
        b: block.tail,
        horizontal: Math.abs(block.tail[0] - block.head.base[0]) >= Math.abs(block.tail[1] - block.head.base[1]),
        rect: path.bbox,
        sourceIndex: path.index,
      });
    }
  }

  return { heads, blockShafts };
}

/**
 * Shafts, from either convention: thin filled rectangles (CHOP) or the segments
 * of a stroked polyline (Upstate). Both reduce to a line between two points, so
 * edge tracing does not need to care which it got.
 */
function collectShafts(paths: PathPrimitive[]): Shaft[] {
  const shafts: Shaft[] = [];

  for (const path of paths) {
    const stroked = path.paint === 'stroke' || path.paint === 'fillStroke';

    // Stroked polylines: every segment is a shaft. Skip rectangles — those are
    // node outlines, not connectors.
    if (stroked && isInk(path.stroke) && !asNodeShape(path)) {
      for (const subpath of path.subpaths) {
        for (let i = 1; i < subpath.length; i++) {
          const a = subpath[i - 1];
          const b = subpath[i];
          if (distance(a, b) < MIN_SHAFT_LENGTH) continue;
          shafts.push({
            a,
            b,
            horizontal: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]),
            rect: boundsOf([a, b]),
            sourceIndex: path.index,
          });
        }
      }
      continue;
    }

    if (path.paint === 'stroke') continue;
    if (!isInk(path.fill)) continue;
    // Hyperlink underlines are thin filled rects in a saturated link colour.
    if (saturation(path.fill) > MAX_SHAFT_SATURATION) continue;

    const rect = asAxisAlignedRect(path);
    if (!rect) continue;

    const thickness = Math.min(rect.w, rect.h);
    const length = Math.max(rect.w, rect.h);
    if (thickness > MAX_SHAFT_THICKNESS || length < MIN_SHAFT_LENGTH) continue;

    const horizontal = rect.w >= rect.h;
    const cy = rect.y + rect.h / 2;
    const cx = rect.x + rect.w / 2;
    shafts.push({
      a: horizontal ? [rect.x, cy] : [cx, rect.y],
      b: horizontal ? [rect.x + rect.w, cy] : [cx, rect.y + rect.h],
      horizontal,
      rect,
      sourceIndex: path.index,
    });
  }

  return shafts;
}

export function classifyPage(page: RawPage): PageGeometry {
  const pageArea = page.width * page.height;
  const { heads, blockShafts } = collectArrowheads(page.paths);
  return {
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    boxes: collectBoxes(page.paths, pageArea),
    arrowheads: heads,
    // Block arrows carry their own shaft, since the polygon is both.
    shafts: [...collectShafts(page.paths), ...blockShafts],
  };
}
