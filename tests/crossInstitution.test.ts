/**
 * The generalisation test: three pathways from three institutions, each drawn a
 * different way.
 *
 * This is the suite that keeps the extractor honest. Every institution's
 * flowcharts use a different drawing vocabulary, and a classifier tuned to one of
 * them silently finds zero edges in the others — silently, because the pipeline
 * still produces a graph, just an unusable one. Each document below pins the
 * convention it exercises, so tightening a heuristic for one cannot quietly break
 * the rest.
 *
 * | Document | Connectors | Heads | Node shapes |
 * |---|---|---|---|
 * | CHOP     | thin filled rects | grey triangles | rectangles |
 * | JHACH    | 7-point block arrows | (part of the arrow) | rectangles |
 * | Upstate  | stroked polylines | black triangles | rounded rects + diamonds |
 */

import fs from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractDocument } from '@/lib/pdf/extract';
import { classifyPage } from '@/lib/pdf/primitives';
import { inferGraph, type CandidateGraph } from '@/lib/pdf/infer';

import { BRUE, CHOP, UPSTATE } from './fixtures';

async function extract(file: string): Promise<CandidateGraph> {
  const bytes = new Uint8Array(await fs.readFile(file));
  const doc = await extractDocument(bytes);
  const page = doc.pages[0];
  return inferGraph(page, classifyPage(page));
}

const graphs: Record<string, CandidateGraph> = {};

beforeAll(async () => {
  graphs.chop = await extract(CHOP);
  graphs.brue = await extract(BRUE);
  graphs.upstate = await extract(UPSTATE);
}, 60_000);

/** Text of the node an edge points at, flattened for matching. */
function edgeTargets(graph: CandidateGraph, fromNeedle: string): string[] {
  const from = graph.nodes.find((n) => n.text.includes(fromNeedle));
  if (!from) return [];
  return graph.edges
    .filter((e) => e.from === from.id)
    .map((e) => graph.nodes.find((n) => n.id === e.to)?.text.replace(/\s+/g, ' ') ?? '');
}

describe('every institution yields a connected graph', () => {
  it.each([
    ['chop', 22, 21],
    ['brue', 12, 9],
    ['upstate', 23, 9],
  ])('%s extracts nodes and edges', (key, minNodes, minEdges) => {
    const graph = graphs[key];
    expect(graph.nodes.length).toBeGreaterThanOrEqual(minNodes);
    // The real regression this guards: a vocabulary change dropping edges to 0.
    expect(graph.edges.length).toBeGreaterThanOrEqual(minEdges);
  });

  it.each(['chop', 'brue', 'upstate'])('%s has no edge pointing at a missing node', (key) => {
    const graph = graphs[key];
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
      expect(edge.from).not.toBe(edge.to);
    }
  });
});

describe('Johns Hopkins BRUE — block-arrow connectors', () => {
  it('traces the documented spine', () => {
    // Shaft and head are one 7-point polygon here, with no separate triangle.
    expect(edgeTargets(graphs.brue, 'Well-appearing patient less than 1 year old').join(' ')).toContain(
      'other symptoms or abnormal vital signs',
    );
    expect(edgeTargets(graphs.brue, 'Meets BRUE criteria').join(' ')).toContain('HIGHER RISK criteria');
  });

  it('splits the higher-risk decision both ways', () => {
    const out = edgeTargets(graphs.brue, 'HIGHER RISK criteria').join(' | ');
    expect(out).toContain('HIGHER-RISK BRUE');
    expect(out).toContain('LOWER-RISK BRUE');
  });
});

describe('Upstate febrile infant — stroked polylines and diamonds', () => {
  it('finds decision diamonds, which are not axis-aligned rectangles', () => {
    // "Increased IMs??" and "+ UA?" are rotated squares; an axis-aligned-rect
    // test rejects them and the whole middle of the pathway disappears.
    const texts = graphs.upstate.nodes.map((n) => n.text.replace(/\s+/g, ' '));
    expect(texts.some((t) => t.includes('Increased'))).toBe(true);
    expect(texts.some((t) => t.includes('UA?'))).toBe(true);
  });

  it('finds rounded-rectangle nodes', () => {
    const texts = graphs.upstate.nodes.map((n) => n.text.replace(/\s+/g, ' '));
    expect(texts.some((t) => t.includes('Obtain urinalysis'))).toBe(true);
  });

  it('traces from workup into the inflammatory-marker decision', () => {
    expect(edgeTargets(graphs.upstate, 'Obtain urinalysis').join(' ')).toContain('Increased');
  });
});

describe('graphics state', () => {
  it('does not produce white ink', async () => {
    // `q`/`Q` restore colour as well as the transform. Tracking only the
    // transform leaves colour stale after a restore, which showed up as arrows
    // filled white on a white page — and silently dropped every connector in the
    // BRUE pathway.
    const bytes = new Uint8Array(await fs.readFile(BRUE));
    const doc = await extractDocument(bytes);
    const arrows = doc.pages[0].paths.filter(
      (p) => p.paint === 'fill' && p.subpaths[0]?.length === 7 && p.bbox.w < 20 && p.bbox.h < 30,
    );
    expect(arrows.length).toBeGreaterThan(3);
    for (const arrow of arrows) {
      const lightness = arrow.fill ? (arrow.fill[0] + arrow.fill[1] + arrow.fill[2]) / 3 : 0;
      expect(lightness).toBeLessThan(0.9);
    }
  });
});
