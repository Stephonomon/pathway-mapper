/**
 * Stage 1b: classify raw path primitives into the shapes a flowchart is made of.
 *
 * Still deterministic. The vocabulary here was derived from how the CHOP pathway
 * PDFs are actually drawn (see `docs/extraction-notes.md`):
 *
 *   - node boxes  -> stroked axis-aligned rectangles, each backed by a white fill
 *   - arrow heads -> small filled triangles in the connector grey
 *   - arrow shafts-> very thin filled rectangles in the same grey
 *   - link rules  -> very thin filled rectangles in the link blue (ignored)
 *
 * Anything that does not match stays unclassified rather than being forced into a
 * bucket; the labeling pass and the review UI are where ambiguity gets resolved.
 */

import type { PathPrimitive, RawPage } from './extract';
import type { Point, Rect } from './geometry';
import { boundsOf, distance, nearlySameRect } from './geometry';

/** Connector grey sampled from the pathway PDFs (#ababab). */
const CONNECTOR_GREY = 0.671;
const GREY_TOLERANCE = 0.22;

/** Smallest rectangle we will treat as a node rather than a rule or a tick. */
const MIN_BOX_W = 24;
const MIN_BOX_H = 8;

/** Thin-rectangle limits for arrow shafts. */
const MAX_SHAFT_THICKNESS = 2.5;
const MIN_SHAFT_LENGTH = 4;

/** Arrow heads are small; anything larger is a real shape. */
const MAX_ARROWHEAD_SIZE = 14;

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

function isGrey(color: readonly number[] | null): boolean {
  if (!color) return false;
  const [r, g, b] = color;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread > 0.08) return false; // coloured, e.g. the link blue
  return Math.abs((r + g + b) / 3 - CONNECTOR_GREY) <= GREY_TOLERANCE;
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
    const rect = asAxisAlignedRect(path);
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

function collectArrowheads(paths: PathPrimitive[]): Arrowhead[] {
  const heads: Arrowhead[] = [];
  for (const path of paths) {
    if (path.paint === 'stroke') continue;
    if (!isGrey(path.fill)) continue;
    const { w, h } = path.bbox;
    if (w > MAX_ARROWHEAD_SIZE || h > MAX_ARROWHEAD_SIZE) continue;
    if (w < 1 || h < 1) continue;

    const tri = asTriangle(path);
    if (!tri) continue;

    const { tip, base } = orientTriangle(tri);
    heads.push({
      tip,
      base,
      direction: unitVector(base, tip),
      rect: path.bbox,
      sourceIndex: path.index,
    });
  }
  return heads;
}

function collectShafts(paths: PathPrimitive[]): Shaft[] {
  const shafts: Shaft[] = [];
  for (const path of paths) {
    if (path.paint === 'stroke') continue;
    if (!isGrey(path.fill)) continue;
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
  return {
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    boxes: collectBoxes(page.paths, pageArea),
    arrowheads: collectArrowheads(page.paths),
    shafts: collectShafts(page.paths),
  };
}
