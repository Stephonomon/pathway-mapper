/**
 * Stage 1c: assemble classified primitives into a candidate pathway graph.
 *
 * This produces the geometry-only graph — real bboxes, real edges traced through
 * real arrow shafts, verbatim text, real citation links. The labeling pass
 * (`lib/llm/label.ts`) adds semantics on top; it is never allowed to move a bbox.
 */

import type { LinkAnnotation, RawPage, TextRun } from './extract';
import type { Arrowhead, BoxPrimitive, PageGeometry, Shaft } from './primitives';
import type { Point, Rect } from './geometry';
import {
  areaOf,
  centerOf,
  colorDistance,
  distance,
  distanceToRect,
  expandRect,
  overlapRatio,
  roundRect,
  unionRect,
} from './geometry';

/** Max gap between a header box and its body box before they stop being one node. */
const STACK_GAP = 2.5;
/** How close a shaft endpoint must be to another to count as joined. */
const JOIN_TOLERANCE = 2.5;
/** How close an arrow end must be to a box to count as attached. */
const ATTACH_TOLERANCE = 9;
/** How far to search backwards from a headless arrow before giving up. */
const RAY_LIMIT = 48;

export interface CandidateNode {
  id: string;
  page: number;
  bbox: Rect;
  text: string;
  stroke: [number, number, number] | null;
  /** Node ids of boxes fully contained by this one. */
  childIds: string[];
  links: { text: string; url: string }[];
}

export interface CandidateEdge {
  id: string;
  from: string;
  to: string;
  polyline: Point[];
  arrowAt: Point;
  /** How the source end was resolved — surfaced in the review UI. */
  provenance: 'shaft' | 'ray';
  /**
   * Branch label read off the page: text that sits next to this arrow and inside
   * no node box (this pathway labels branches "Standard" / "Enhanced").
   */
  label: string | null;
}

export interface CandidateGraph {
  page: number;
  width: number;
  height: number;
  nodes: CandidateNode[];
  edges: CandidateEdge[];
  /** Arrowheads we could not attach at both ends — shown for manual repair. */
  unresolvedArrowheads: number;
}

function sameColor(a: BoxPrimitive['stroke'], b: BoxPrimitive['stroke']): boolean {
  if (!a || !b) return a === b;
  return colorDistance(a, b) < 0.05;
}

/**
 * Pathway nodes are frequently drawn as a title bar stacked directly on a body
 * box. Same width, same colour, touching — one node.
 */
function mergeStackedBoxes(boxes: BoxPrimitive[]): BoxPrimitive[] {
  const merged: BoxPrimitive[] = [];
  const consumed = new Set<number>();

  const ordered = [...boxes].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  for (let i = 0; i < ordered.length; i++) {
    if (consumed.has(i)) continue;
    let current = ordered[i];

    // Chain downwards so a title + body + footer stack collapses in one pass.
    let extended = true;
    while (extended) {
      extended = false;
      for (let j = i + 1; j < ordered.length; j++) {
        if (consumed.has(j)) continue;
        const next = ordered[j];
        const alignedX =
          Math.abs(next.rect.x - current.rect.x) <= 1.5 &&
          Math.abs(next.rect.w - current.rect.w) <= 1.5;
        const gap = next.rect.y - (current.rect.y + current.rect.h);
        if (alignedX && gap >= -1.5 && gap <= STACK_GAP && sameColor(next.stroke, current.stroke)) {
          current = { ...current, rect: unionRect(current.rect, next.rect) };
          consumed.add(j);
          extended = true;
        }
      }
    }
    merged.push(current);
  }
  return merged;
}

/** Join text runs into readable lines, respecting pdf.js's ligature splits. */
function textForRect(runs: TextRun[], rect: Rect): string {
  const inside = runs
    .filter((r) => overlapRatio(r.bbox, rect) > 0.6)
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  if (inside.length === 0) return '';

  const lines: TextRun[][] = [];
  for (const run of inside) {
    const line = lines[lines.length - 1];
    const prev = line?.[line.length - 1];
    // Same visual line when the baselines are within half a line height.
    if (prev && Math.abs(prev.bbox.y - run.bbox.y) < Math.max(prev.bbox.h, run.bbox.h) * 0.6) {
      line.push(run);
    } else {
      lines.push([run]);
    }
  }

  return lines
    .map((line) =>
      line
        .sort((a, b) => a.bbox.x - b.bbox.x)
        .reduce((acc, run, i) => {
          if (i === 0) return run.text;
          const prev = line[i - 1];
          const gap = run.bbox.x - (prev.bbox.x + prev.bbox.w);
          // pdf.js splits at ligatures ("Non-Speci|fi|c"); rejoin without a space.
          return gap < 0.6 ? acc + run.text : `${acc} ${run.text}`;
        }, '')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

function linksForRect(links: LinkAnnotation[], rect: Rect, runs: TextRun[]): CandidateNode['links'] {
  const out = new Map<string, string>();
  for (const link of links) {
    if (overlapRatio(link.bbox, rect) <= 0.6) continue;
    const label = runs
      .filter((r) => overlapRatio(r.bbox, expandRect(link.bbox, 1)) > 0.5)
      .map((r) => r.text)
      .join('')
      .trim();
    // Keep the first (longest-context) label we see for each destination.
    if (!out.has(link.url) || label.length > (out.get(link.url) ?? '').length) {
      out.set(link.url, label);
    }
  }
  return [...out.entries()].map(([url, text]) => ({ url, text }));
}

/** How many segments a single connector may be made of before we give up. */
const MAX_CHAIN_SEGMENTS = 12;

/**
 * Walk the chain of shafts leading away from an arrowhead's base, stopping at
 * the first point that touches a box.
 *
 * Stopping early matters. On a page where connectors are stroked polylines there
 * can be hundreds of segments, and any two that happen to touch will be joined —
 * so a chain walked to its "end" wanders off across the document. A connector
 * runs from one box to another, so the first box reached *is* the source.
 */
function traceShaftChain(
  start: Point,
  shafts: Shaft[],
  reachedSource: (p: Point) => boolean,
): { polyline: Point[]; end: Point } | null {
  const used = new Set<number>();

  const nearestShaft = (from: Point): { index: number; far: Point } | null => {
    let best: { index: number; far: Point } | null = null;
    let bestDistance = JOIN_TOLERANCE;
    shafts.forEach((shaft, index) => {
      if (used.has(index)) return;
      const da = distance(from, shaft.a);
      const db = distance(from, shaft.b);
      if (da <= bestDistance) {
        bestDistance = da;
        best = { index, far: shaft.b };
      }
      if (db <= bestDistance) {
        bestDistance = db;
        best = { index, far: shaft.a };
      }
    });
    return best;
  };

  const polyline: Point[] = [start];
  let cursor = start;

  for (let step = 0; step < MAX_CHAIN_SEGMENTS; step++) {
    const next = nearestShaft(cursor);
    if (!next) break;
    used.add(next.index);
    polyline.push(next.far);
    cursor = next.far;
    if (reachedSource(cursor)) break;
  }

  if (polyline.length < 2) return null;
  return { polyline, end: cursor };
}

function boxAt(point: Point, nodes: CandidateNode[], tolerance = ATTACH_TOLERANCE): CandidateNode | null {
  let best: CandidateNode | null = null;
  let bestDistance = tolerance;
  for (const node of nodes) {
    const d = distanceToRect(node.bbox, point);
    // Prefer the tightest box when several are within tolerance (nested groups).
    if (d <= bestDistance && (!best || areaOf(node.bbox) < areaOf(best.bbox))) {
      bestDistance = d;
      best = node;
    }
  }
  return best;
}

/** Shortest distance from a point to a polyline, sampling each segment. */
function distanceToPolyline(polyline: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    const [ax, ay] = polyline[i - 1];
    const [bx, by] = polyline[i];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / lengthSq));
    best = Math.min(best, distance(p, [ax + t * dx, ay + t * dy]));
  }
  return best;
}

/**
 * Branch labels are drawn as free-floating text beside an arrow, not inside any
 * box, so they are invisible to node text assignment. Attach each orphan run to
 * the arrow it sits closest to.
 */
function attachEdgeLabels(edges: CandidateEdge[], nodes: CandidateNode[], runs: TextRun[]): void {
  const MAX_LABEL_DISTANCE = 14;

  const orphans = runs.filter(
    (run) => !nodes.some((node) => overlapRatio(run.bbox, node.bbox) > 0.6),
  );

  const perEdge = new Map<string, { run: TextRun; d: number }[]>();
  for (const run of orphans) {
    const centre: Point = [run.bbox.x + run.bbox.w / 2, run.bbox.y + run.bbox.h / 2];
    let best: { edge: CandidateEdge; d: number } | null = null;
    for (const edge of edges) {
      if (edge.polyline.length < 2) continue;
      const d = distanceToPolyline(edge.polyline, centre);
      if (d <= MAX_LABEL_DISTANCE && (!best || d < best.d)) best = { edge, d };
    }
    if (!best) continue;
    const list = perEdge.get(best.edge.id) ?? [];
    list.push({ run, d: best.d });
    perEdge.set(best.edge.id, list);
  }

  for (const edge of edges) {
    const hits = perEdge.get(edge.id);
    if (!hits?.length) continue;
    edge.label =
      hits
        .sort((a, b) => a.run.bbox.y - b.run.bbox.y || a.run.bbox.x - b.run.bbox.x)
        .map((h) => h.run.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim() || null;
  }
}

/** Step backwards from a point until we hit a box — for arrows drawn without shafts. */
function rayCastToBox(from: Point, direction: Point, nodes: CandidateNode[]): CandidateNode | null {
  for (let step = 2; step <= RAY_LIMIT; step += 2) {
    const probe: Point = [from[0] - direction[0] * step, from[1] - direction[1] * step];
    const hit = boxAt(probe, nodes, 1.5);
    if (hit) return hit;
  }
  return null;
}

export function inferGraph(page: RawPage, geometry: PageGeometry): CandidateGraph {
  const boxes = mergeStackedBoxes(geometry.boxes);

  const nodes: CandidateNode[] = boxes.map((box, i) => ({
    id: `n${String(i + 1).padStart(2, '0')}`,
    page: page.pageNumber,
    bbox: roundRect(box.rect),
    text: textForRect(page.texts, box.rect),
    stroke: box.stroke,
    childIds: [],
    links: linksForRect(page.links, box.rect, page.texts),
  }));

  // Record containment so the labeling pass can tell groups from leaves, and so
  // routing can ignore purely decorative wrappers.
  for (const outer of nodes) {
    for (const inner of nodes) {
      if (inner === outer) continue;
      if (areaOf(inner.bbox) >= areaOf(outer.bbox)) continue;
      if (overlapRatio(inner.bbox, outer.bbox) > 0.95) outer.childIds.push(inner.id);
    }
  }

  // A node's own text should exclude text that belongs to a nested child.
  for (const node of nodes) {
    if (node.childIds.length === 0) continue;
    const children = nodes.filter((n) => node.childIds.includes(n.id));
    const ownRuns = page.texts.filter(
      (run) =>
        overlapRatio(run.bbox, node.bbox) > 0.6 &&
        !children.some((child) => overlapRatio(run.bbox, child.bbox) > 0.6),
    );
    node.text = textForRect(ownRuns, node.bbox);
  }

  const edges: CandidateEdge[] = [];
  const seen = new Set<string>();
  let unresolved = 0;

  // The same arrow is often drawn twice — a filled triangle sitting on top of a
  // block-arrow polygon — and both detectors fire. Keep one head per tip.
  const heads: Arrowhead[] = [];
  for (const head of geometry.arrowheads) {
    if (heads.some((k) => distance(k.tip, head.tip) < 3)) continue;
    heads.push(head);
  }

  heads.forEach((head: Arrowhead, i) => {
    const target = boxAt(head.tip, nodes);
    if (!target) {
      unresolved++;
      return;
    }

    let source: CandidateNode | null = null;
    let polyline: Point[] = [head.base, head.tip];
    let provenance: CandidateEdge['provenance'] = 'ray';

    // Stop the walk at the first box that is not the one we are pointing at.
    const chain = traceShaftChain(head.base, geometry.shafts, (p) => {
      const hit = boxAt(p, nodes);
      return Boolean(hit && hit.id !== target.id);
    });
    if (chain) {
      const found = boxAt(chain.end, nodes);
      if (found && found.id !== target.id) {
        source = found;
        polyline = [...chain.polyline].reverse().concat([head.tip]);
        provenance = 'shaft';
      }
    }
    if (!source) {
      source = rayCastToBox(head.base, head.direction, nodes);
    }

    if (!source || source.id === target.id) {
      unresolved++;
      return;
    }

    const key = `${source.id}->${target.id}`;
    if (seen.has(key)) return;
    seen.add(key);

    edges.push({
      id: `e${String(i + 1).padStart(2, '0')}`,
      from: source.id,
      to: target.id,
      polyline,
      arrowAt: head.tip,
      provenance,
      label: null,
    });
  });

  attachEdgeLabels(edges, nodes, page.texts);

  // Drop decorative boxes: no text, no citations, and nothing flows through them
  // (logos, watermarks, spacer panels). Anything an arrow touches is kept.
  const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
  const kept = nodes.filter(
    (n) => n.text !== '' || n.links.length > 0 || connected.has(n.id) || n.childIds.length > 0,
  );
  const keptIds = new Set(kept.map((n) => n.id));
  for (const node of kept) {
    node.childIds = node.childIds.filter((id) => keptIds.has(id));
  }

  return {
    page: page.pageNumber,
    width: page.width,
    height: page.height,
    nodes: kept,
    edges,
    unresolvedArrowheads: unresolved,
  };
}

/** Convenience: the centre of a node, used by the overlay's pan/zoom. */
export function nodeCenter(node: CandidateNode): Point {
  return centerOf(node.bbox);
}
