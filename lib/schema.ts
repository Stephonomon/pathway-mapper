/**
 * The contracts every stage agrees on.
 *
 * Two rules encoded here rather than in prose:
 *
 *  1. Geometry is not model output. `bbox`, `polyline`, and `arrowAt` come from
 *     the deterministic extractor and never appear in a schema the LLM fills in.
 *  2. The graph owns the topology. Routing selects among existing edge ids; it
 *     cannot describe a jump that the document does not draw.
 */

import { z } from 'zod';

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Rect = z.infer<typeof rectSchema>;

export const pointSchema = z.tuple([z.number(), z.number()]);

/**
 * `reference` and `note` nodes exist on the page (nav links, evidence sidebars,
 * disclaimers) but are never destinations — see `routable`.
 */
export const nodeKindSchema = z.enum([
  'start',
  'decision',
  'action',
  'branch',
  'terminal',
  'reference',
  'note',
]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const acuitySchema = z.enum(['low', 'intermediate', 'high']);
export type Acuity = z.infer<typeof acuitySchema>;

export const citationSchema = z.object({
  text: z.string(),
  url: z.string(),
});

export const pathwayNodeSchema = z.object({
  id: z.string(),
  page: z.number().int().positive(),
  /** Top-left origin, page units. Extractor-owned. */
  bbox: rectSchema,
  /** Verbatim text from the PDF. Displayed as-is; never paraphrased. */
  text: z.string(),
  /** Short human label for the turn-by-turn panel. */
  label: z.string(),
  kind: nodeKindSchema,
  acuity: acuitySchema.nullable(),
  /** False for page furniture, so routing can never land here. */
  routable: z.boolean(),
  links: z.array(citationSchema),
  childIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type PathwayNode = z.infer<typeof pathwayNodeSchema>;

export const pathwayEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  /** Branch label as printed, e.g. "Positive Suicide Screen". */
  label: z.string().nullable(),
  /** Normalised predicate the routing loop reasons against. */
  condition: z.string().nullable(),
  /** Extractor-owned; drives the animated trace. Empty for model-added edges. */
  polyline: z.array(pointSchema),
  arrowAt: pointSchema.nullable(),
  provenance: z.enum(['shaft', 'ray', 'model', 'human']),
  confidence: z.number().min(0).max(1),
});
export type PathwayEdge = z.infer<typeof pathwayEdgeSchema>;

export const pathwayPageSchema = z.object({
  number: z.number().int().positive(),
  width: z.number(),
  height: z.number(),
});

/**
 * Compiled at ingest, consulted at query time. Declared here as a passthrough so
 * `lib/schema.ts` stays free of a circular import with `lib/decisions/`; the real
 * shape is `decisionModelSchema` and it is validated at compile time.
 */
export const storedDecisionModelSchema = z
  .object({
    dataItems: z.array(z.record(z.string(), z.unknown())),
    forks: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export const pathwayGraphSchema = z.object({
  docId: z.string(),
  title: z.string(),
  sourceFile: z.string(),
  pages: z.array(pathwayPageSchema),
  nodes: z.array(pathwayNodeSchema),
  edges: z.array(pathwayEdgeSchema),
  entryNodeIds: z.array(z.string()),
  version: z.number().int().nonnegative(),
  extractedAt: z.string(),
  labeledAt: z.string().nullable(),
  /** Non-fatal problems worth showing in the review UI. */
  warnings: z.array(z.string()),
  /**
   * The precomputed decision table. Null when compilation was skipped or failed;
   * routing then falls back to asking the model at every fork.
   */
  decisions: storedDecisionModelSchema.nullable().default(null),
  compiledAt: z.string().nullable().default(null),
});
export type PathwayGraph = z.infer<typeof pathwayGraphSchema>;

/* ------------------------------------------------------------------ labeling */

/**
 * What the labeling model is allowed to say. Note the absence of any geometry
 * field — the model annotates the graph, it does not redraw it.
 */
export const labelingResultSchema = z.object({
  title: z.string().describe('Title of the pathway as printed on the document'),
  entryNodeIds: z
    .array(z.string())
    .describe('Node ids where a clinician enters the pathway, usually exactly one'),
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string().describe('Short name, max 6 words, for the turn-by-turn panel'),
      kind: nodeKindSchema,
      acuity: acuitySchema.nullable().describe('Only when the node states an acuity band'),
      routable: z
        .boolean()
        .describe('False for nav links, evidence sidebars, footers, and disclaimers'),
      confidence: z.number().min(0).max(1),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      label: z.string().nullable().describe('Branch label exactly as printed, or null'),
      condition: z
        .string()
        .nullable()
        .describe('One sentence stating what must be true of the patient to take this branch'),
      confidence: z.number().min(0).max(1),
    }),
  ),
  missingEdges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().nullable(),
        condition: z.string().nullable(),
        rationale: z.string().describe('Why this connection exists in the document'),
      }),
    )
    .describe('Connections visible in the document that the geometry pass missed'),
  suspectEdges: z
    .array(z.object({ id: z.string(), reason: z.string() }))
    .describe('Extracted edges that appear wrong and need human review'),
});
export type LabelingResult = z.infer<typeof labelingResultSchema>;

/* ------------------------------------------------------------------- routing */

export const routeStepSchema = z.object({
  nodeId: z.string(),
  edgeIdFromPrev: z.string().nullable(),
  /** Why this turn was taken. Model prose — clearly separated from node text. */
  rationale: z.string(),
  /** Phrases quoted from the user's question that justified the turn. */
  evidence: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  /** True when a deterministic rule, not the model, decided this hop. */
  ruleForced: z.boolean(),
});
export type RouteStep = z.infer<typeof routeStepSchema>;

export const routeStatusSchema = z.enum(['complete', 'needs_input', 'ambiguous', 'error']);

export const routeSchema = z.object({
  docId: z.string(),
  graphVersion: z.number(),
  steps: z.array(routeStepSchema),
  status: routeStatusSchema,
  question: z
    .object({ text: z.string(), options: z.array(z.string()) })
    .nullable(),
  summary: z.string().nullable(),
  citations: z.array(citationSchema.extend({ nodeId: z.string() })),
  notes: z.array(z.string()),
});
export type Route = z.infer<typeof routeSchema>;

/** Server-sent event payloads for the streaming route endpoint. */
export type RouteEvent =
  | { type: 'step'; step: RouteStep }
  | { type: 'question'; question: { text: string; options: string[] } }
  | { type: 'done'; route: Route }
  | { type: 'error'; message: string };
