/**
 * Right-angle (Manhattan) routing for highlighted route edges.
 *
 * Most connectors are traced off the page as a multi-point polyline and drawn
 * verbatim. But some edges carry no usable geometry — an arrowhead whose shaft
 * could not be chained (`ray`), or an edge the labeling pass added because the
 * geometry pass missed the connector entirely (`model`). Drawing those as a
 * straight line cuts a diagonal across the diagram, which reads nothing like the
 * document's right-angle flowchart lines.
 *
 * This synthesises a flowchart-style path between the two boxes instead: exit and
 * enter on the facing edges, with the jog placed in the channel between them. It
 * is deliberately geometry-only and has no bearing on routing — which boxes are
 * connected, and in what order, is decided and validated elsewhere. This only
 * decides how an already-correct connection is drawn.
 */

import type { Rect } from '../schema';

export type Point = [number, number];

/** Two points closer than this on an axis are treated as coincident/aligned. */
const EPS = 0.5;

function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return !(b0 > a1 || a0 > b1);
}

/**
 * Drop coincident points and collapse collinear runs, so a straight connector
 * comes back as two points and an L/Z keeps only its corners.
 */
export function simplify(points: Point[]): Point[] {
  const dedup: Point[] = [];
  for (const p of points) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) continue;
    dedup.push(p);
  }

  const out: Point[] = [];
  for (let i = 0; i < dedup.length; i++) {
    if (i > 0 && i < dedup.length - 1) {
      const [ax, ay] = dedup[i - 1];
      const [bx, by] = dedup[i];
      const [cx, cy] = dedup[i + 1];
      const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
      const dot = (bx - ax) * (cx - bx) + (by - ay) * (cy - by);
      // The middle point sits on the straight run from its neighbours — drop it.
      if (Math.abs(cross) < EPS && dot >= 0) continue;
    }
    out.push(dedup[i]);
  }
  return out;
}

/**
 * A right-angle path from `from` to `to`.
 *
 * The dominant axis follows how the boxes are separated. Clinical pathways flow
 * top-to-bottom, so boxes on different rows route vertically (exit the bottom,
 * jog across, enter the top) even when the horizontal offset is larger; boxes
 * sharing a row route horizontally. Only when the boxes overlap on both axes —
 * rare for a route edge — does the larger gap decide. The path exits the source's
 * facing edge, jogs across the midline of the gap, and enters the target's facing
 * edge, so a directly-below box gives a straight drop and an offset one a clean Z.
 */
export function orthogonalRoute(from: Rect, to: Rect): Point[] {
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2;
  const tcy = to.y + to.h / 2;

  const vOverlap = rangesOverlap(from.y, from.y + from.h, to.y, to.y + to.h);
  const hOverlap = rangesOverlap(from.x, from.x + from.w, to.x, to.x + to.w);

  let vertical: boolean;
  if (!vOverlap) vertical = true; // different rows — flow down (or up) the channel
  else if (!hOverlap) vertical = false; // same row, different columns — flow across
  else vertical = Math.abs(tcy - fcy) >= Math.abs(tcx - fcx); // overlapping both ways

  if (vertical) {
    const down = tcy >= fcy;
    const exit: Point = [fcx, down ? from.y + from.h : from.y];
    const entry: Point = [tcx, down ? to.y : to.y + to.h];
    const midY = (exit[1] + entry[1]) / 2;
    return simplify([exit, [exit[0], midY], [entry[0], midY], entry]);
  }

  const right = tcx >= fcx;
  const exit: Point = [right ? from.x + from.w : from.x, fcy];
  const entry: Point = [right ? to.x : to.x + to.w, tcy];
  const midX = (exit[0] + entry[0]) / 2;
  return simplify([exit, [midX, exit[1]], [midX, entry[1]], entry]);
}

/**
 * The points a route edge should be drawn with: the traced polyline when it
 * carries real bends, otherwise a synthesised right-angle path between the boxes.
 */
export function routeEdgePoints(polyline: Point[], from: Rect, to: Rect): Point[] {
  if (polyline.length >= 3) return polyline;
  return orthogonalRoute(from, to);
}
