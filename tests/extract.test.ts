/**
 * Golden test for the deterministic pipeline against the reference pathway.
 *
 * The assertions are chosen to fail loudly on the two regressions that are
 * otherwise silent: a coordinate-space flip (boxes look fine but hold the wrong
 * text) and a change in how pdf.js encodes paths (edges quietly vanish).
 */

import fs from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractDocument, type RawPage } from '@/lib/pdf/extract';
import { classifyPage } from '@/lib/pdf/primitives';
import { inferGraph, type CandidateGraph } from '@/lib/pdf/infer';

import { CHOP, has } from './fixtures';

const SAMPLE = CHOP;
// The source PDFs are other organisations' material and are not committed. Skip
// rather than fail when they are not present locally.
const ready = has(SAMPLE);

let page: RawPage;
let graph: CandidateGraph;

beforeAll(async () => {
  if (!ready) return;
  const bytes = new Uint8Array(await fs.readFile(SAMPLE));
  const doc = await extractDocument(bytes);
  page = doc.pages[0];
  graph = inferGraph(page, classifyPage(page));
}, 30_000);

describe.skipIf(!ready)('raw extraction', () => {
  it('reads a single US Letter page', () => {
    expect(page.width).toBe(612);
    expect(page.height).toBe(792);
  });

  it('recovers the link annotations that become node citations', () => {
    expect(page.links.length).toBeGreaterThanOrEqual(100);
    expect(page.links.every((l) => l.url.startsWith('http'))).toBe(true);
  });
});

describe.skipIf(!ready)('classification', () => {
  it('finds every arrowhead in the flowchart', () => {
    const { arrowheads } = classifyPage(page);
    expect(arrowheads.length).toBe(21);
  });

  it('finds the arrow shafts, which are filled rects rather than strokes', () => {
    const { shafts } = classifyPage(page);
    expect(shafts.length).toBeGreaterThan(15);
  });
});

describe.skipIf(!ready)('inferred graph', () => {
  it('attaches every arrowhead to a source and a target', () => {
    expect(graph.unresolvedArrowheads).toBe(0);
    expect(graph.edges.length).toBe(21);
  });

  it('produces the expected node count', () => {
    expect(graph.nodes.length).toBe(22);
  });

  it('places text in the right boxes — catches a coordinate-space flip', () => {
    // These three strings only land in these three boxes when paths and text
    // share the canonical top-left space.
    const low = graph.nodes.find((n) => n.text.startsWith('Low Acuity'));
    const intermediate = graph.nodes.find((n) => n.text.startsWith('Intermediate Acuity'));
    const high = graph.nodes.find((n) => n.text.startsWith('High Acuity'));

    // Compare with line breaks flattened: the source wraps mid-phrase.
    const flat = (s?: string) => s?.replace(/\s+/g, ' ') ?? '';
    expect(flat(low?.text)).toContain('Wish to Be Dead');
    expect(flat(intermediate?.text)).toContain('Non-Specific Active Suicidal Thoughts');
    expect(flat(high?.text)).toContain('Specific Plan and Intent');

    // ...and they sit left-to-right in that order.
    expect(low!.bbox.x).toBeLessThan(intermediate!.bbox.x);
    expect(intermediate!.bbox.x).toBeLessThan(high!.bbox.x);
  });

  it('carries acuity stroke colours through to the boxes', () => {
    const low = graph.nodes.find((n) => n.text.startsWith('Low Acuity'));
    expect(low?.stroke?.[1]).toBeCloseTo(0.788, 2);
  });

  it('merges a title bar into its body box', () => {
    // "Low Acuity" is a separate 10pt-tall stroked rect stacked on a 107pt body.
    const low = graph.nodes.find((n) => n.text.startsWith('Low Acuity'));
    expect(low!.bbox.h).toBeGreaterThan(110);
  });

  it('traces the documented spine of the pathway', () => {
    const byText = (needle: string) =>
      graph.nodes.find((n) => n.text.includes(needle))?.id;

    const screen = byText('Screen for Suicide Risk');
    const positive = byText('Positive Suicide Screen');
    const columbia = byText('Columbia Suicide Severity Rating Scale');
    const high = byText('High Acuity');

    const hasEdge = (from?: string, to?: string) =>
      Boolean(from && to && graph.edges.some((e) => e.from === from && e.to === to));

    expect(hasEdge(screen, positive)).toBe(true);
    expect(hasEdge(positive, columbia)).toBe(true);
    expect(hasEdge(columbia, high)).toBe(true);
  });

  it('reads branch labels that float beside the arrows, outside any box', () => {
    // "Standard" / "Enhanced" are loose text between the risk-formulation and
    // care-plan rows. They belong to no node, so only edge-label attachment
    // finds them — and without them the care-plan branches have no stated
    // condition at all.
    const labeled = graph.edges.filter((e) => e.label !== null);
    expect(labeled.length).toBe(6);
    expect(new Set(labeled.map((e) => e.label))).toEqual(new Set(['Standard', 'Enhanced']));
  });

  it('gives every edge real endpoints and no self-loops', () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
      expect(edge.from).not.toBe(edge.to);
    }
  });

  it('ends at the three endpoints the document defines', () => {
    const withOutbound = new Set(graph.edges.map((e) => e.from));
    const connected = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
    const terminals = [...connected]
      .filter((id) => !withOutbound.has(id))
      .map((id) => graph.nodes.find((n) => n.id === id)!.text.split('\n')[0])
      .sort();

    expect(terminals).toEqual([
      'Initiate Care, Maintain Engagement',
      'Negative Suicide Risk Assessment',
      'Negative Suicide Screen',
    ]);
  });
});
