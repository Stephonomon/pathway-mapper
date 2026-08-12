/**
 * Stage 2: give the geometric graph its semantics.
 *
 * The model receives the extracted nodes (verbatim text, position, stroke colour,
 * citations) and the extracted edges, and returns labels, node kinds, branch
 * conditions, and entry points. It cannot return geometry, so the merge below is
 * the only place labels and coordinates meet — and coordinates always win.
 */

import { generateObject } from 'ai';
import type { CandidateGraph } from '../pdf/infer';
import { labelingResultSchema, type Acuity, type LabelingResult, type PathwayGraph } from '../schema';
import { assertModelConfigured, pathwayModel } from './provider';

/** Stroke colours the pathway template uses for acuity bands. */
const ACUITY_SWATCHES: { rgb: [number, number, number]; acuity: Acuity }[] = [
  { rgb: [0.537, 0.788, 0.475], acuity: 'low' },
  { rgb: [0.816, 0.812, 0.435], acuity: 'intermediate' },
  { rgb: [0.91, 0.694, 0.663], acuity: 'high' },
];

function acuityFromStroke(stroke: [number, number, number] | null): Acuity | null {
  if (!stroke) return null;
  for (const swatch of ACUITY_SWATCHES) {
    const d = Math.hypot(
      stroke[0] - swatch.rgb[0],
      stroke[1] - swatch.rgb[1],
      stroke[2] - swatch.rgb[2],
    );
    if (d < 0.08) return swatch.acuity;
  }
  return null;
}

const SYSTEM_PROMPT = `You are labeling a clinical pathway flowchart that has already been extracted from a PDF.

The node boxes, their text, their positions, and the arrows between them were read directly out of the document's vector geometry. They are ground truth. Your job is to add the semantic layer:

- Give each node a short label (max 6 words) suitable for a turn-by-turn navigation panel.
- Classify each node's kind.
- Mark nodes routable only if a clinician could actually arrive there while working through the pathway. Navigation links, evidence/reference sidebars, page headers, footers, and legal disclaimers are NOT routable.
- For each edge, state the branch label exactly as printed on the document if one exists, and write a one-sentence condition describing what must be true of the patient to take that branch.
- Identify the entry node(s): where a clinician starts.
- Only report a missing edge if the node text plainly implies a connection the arrow extraction did not capture. Do not invent clinical logic that the document does not state.
- Flag any extracted edge that looks wrong.

Be conservative. This is a safety-critical document. When a condition is not stated in the text, say so in the condition field rather than inferring one.`;

function describeGraph(graphs: CandidateGraph[]): string {
  const lines: string[] = [];
  for (const graph of graphs) {
    lines.push(`## Page ${graph.page} (${graph.width} x ${graph.height})`);
    lines.push('', '### Nodes');
    for (const node of graph.nodes) {
      const { x, y, w, h } = node.bbox;
      lines.push(
        `- ${node.id} @ (${x}, ${y}) ${w}x${h}${node.stroke ? ` stroke=${node.stroke.map((v) => v.toFixed(2)).join(',')}` : ''}`,
      );
      lines.push(`  text: ${JSON.stringify(node.text)}`);
      if (node.links.length) {
        lines.push(`  links: ${node.links.map((l) => `${l.text || '(?)'} -> ${l.url}`).join(' | ')}`);
      }
    }
    lines.push('', '### Edges (from arrow geometry)');
    for (const edge of graph.edges) {
      lines.push(
        `- ${edge.id}: ${edge.from} -> ${edge.to} (traced via ${edge.provenance})${edge.label ? ` printed label: ${JSON.stringify(edge.label)}` : ''}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface LabelOptions {
  docId: string;
  sourceFile: string;
  source?: { kind: 'pdf' | 'html'; html: string | null; url: string | null };
  /** Falls back to the extractor's own guess when labeling is skipped. */
  fallbackTitle?: string;
}

/** Build a PathwayGraph from candidates without calling a model. */
export function buildUnlabeledGraph(
  graphs: CandidateGraph[],
  options: LabelOptions,
): PathwayGraph {
  const now = new Date().toISOString();
  return {
    docId: options.docId,
    title: options.fallbackTitle ?? options.docId,
    sourceFile: options.sourceFile,
    pages: graphs.map((g) => ({ number: g.page, width: g.width, height: g.height })),
    nodes: graphs.flatMap((g) =>
      g.nodes.map((n) => ({
        id: n.id,
        page: n.page,
        bbox: n.bbox,
        text: n.text,
        label: n.text.split('\n')[0]?.slice(0, 60) || n.id,
        kind: 'action' as const,
        acuity: acuityFromStroke(n.stroke),
        routable: true,
        links: n.links,
        childIds: n.childIds,
        confidence: 0.4,
      })),
    ),
    edges: graphs.flatMap((g) =>
      g.edges.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        label: e.label,
        condition: null,
        polyline: e.polyline.map((p) => [p[0], p[1]] as [number, number]),
        arrowAt: [e.arrowAt[0], e.arrowAt[1]] as [number, number],
        provenance: e.provenance,
        confidence: e.provenance === 'shaft' ? 0.9 : 0.6,
      })),
    ),
    entryNodeIds: [],
    version: 1,
    extractedAt: now,
    labeledAt: null,
    decisions: null,
    compiledAt: null,
    source: options.source ?? { kind: 'pdf', html: null, url: null },
    warnings: graphs.flatMap((g) =>
      g.unresolvedArrowheads > 0
        ? [`page ${g.page}: ${g.unresolvedArrowheads} arrowheads could not be attached to nodes`]
        : [],
    ),
  };
}

/** Merge model labels onto the geometric graph. Geometry always wins. */
export function applyLabels(base: PathwayGraph, labels: LabelingResult): PathwayGraph {
  const nodeLabels = new Map(labels.nodes.map((n) => [n.id, n]));
  const edgeLabels = new Map(labels.edges.map((e) => [e.id, e]));
  const suspects = new Map(labels.suspectEdges.map((s) => [s.id, s.reason]));
  const knownNodeIds = new Set(base.nodes.map((n) => n.id));

  const nodes = base.nodes.map((node) => {
    const label = nodeLabels.get(node.id);
    if (!label) return node;
    return {
      ...node,
      label: label.label || node.label,
      kind: label.kind,
      // The stroke colour is evidence the model does not have; trust it first.
      acuity: node.acuity ?? label.acuity,
      routable: label.routable,
      confidence: label.confidence,
    };
  });

  const edges = base.edges.map((edge) => {
    const label = edgeLabels.get(edge.id);
    if (!label) return edge;
    return {
      ...edge,
      // A label read off the page beats one the model wrote.
      label: edge.label ?? label.label,
      condition: label.condition,
      // A flagged edge keeps its geometry but drops to low confidence so the
      // review UI surfaces it.
      confidence: suspects.has(edge.id) ? Math.min(edge.confidence, 0.3) : label.confidence,
    };
  });

  const warnings = [...base.warnings];
  for (const [id, reason] of suspects) warnings.push(`edge ${id} flagged during labeling: ${reason}`);

  // Model-proposed edges are admitted only between nodes that actually exist,
  // and are marked so the review UI can single them out.
  let added = 0;
  for (const missing of labels.missingEdges) {
    if (!knownNodeIds.has(missing.from) || !knownNodeIds.has(missing.to)) {
      warnings.push(`labeling proposed an edge between unknown nodes: ${missing.from} -> ${missing.to}`);
      continue;
    }
    if (edges.some((e) => e.from === missing.from && e.to === missing.to)) continue;
    added += 1;
    edges.push({
      id: `m${String(added).padStart(2, '0')}`,
      from: missing.from,
      to: missing.to,
      label: missing.label,
      condition: missing.condition,
      polyline: [],
      arrowAt: null,
      provenance: 'model',
      confidence: 0.35,
    });
    warnings.push(`edge ${missing.from} -> ${missing.to} was added by labeling: ${missing.rationale}`);
  }

  const entryNodeIds = labels.entryNodeIds.filter((id) => knownNodeIds.has(id));
  if (entryNodeIds.length === 0) {
    // Fall back to nodes with no inbound edges — a flowchart always has one.
    const withInbound = new Set(edges.map((e) => e.to));
    entryNodeIds.push(
      ...nodes.filter((n) => n.routable && !withInbound.has(n.id)).map((n) => n.id).slice(0, 1),
    );
    warnings.push('labeling did not return a usable entry node; inferred from graph in-degree');
  }

  return {
    ...base,
    title: labels.title || base.title,
    nodes,
    edges,
    entryNodeIds,
    labeledAt: new Date().toISOString(),
    warnings,
  };
}

/** Run the labeling pass. Falls back to the unlabeled graph if the model fails. */
export async function labelGraph(
  graphs: CandidateGraph[],
  options: LabelOptions,
): Promise<PathwayGraph> {
  const base = buildUnlabeledGraph(graphs, options);
  assertModelConfigured();

  const { object } = await generateObject({
    model: pathwayModel(),
    schema: labelingResultSchema,
    system: SYSTEM_PROMPT,
    prompt: `Label this extracted clinical pathway.\n\n${describeGraph(graphs)}`,
  });

  return applyLabels(base, object);
}
