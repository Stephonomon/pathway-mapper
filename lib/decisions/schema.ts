/**
 * The compiled decision model — the preprocessing artifact that makes routing
 * fast at scale.
 *
 * The insight: a clinical pathway's forks are almost all decision tables. What
 * varies per patient is a small set of facts; which branch those facts imply is
 * fixed by the document and identical for every user, forever. So deriving the
 * table is per-*pathway* work, not per-*query* work — do it once at ingest and
 * the query path collapses to "extract facts, then look up".
 *
 * `lib/rules/acuity.ts` is this same idea hand-written for one document. This
 * generalises it to any pathway, and the hand-written rules stay in place as an
 * override wherever they apply.
 *
 * The vocabulary follows GLIF (Ohno-Machado et al., JAMIA 1998): what this calls
 * a *data item* is GLIF's data item, and a fork rule is its *criteria for
 * proceeding*. Aligning the names costs nothing and makes the model legible to
 * anyone who knows that literature.
 *
 * Conditions are deliberately NOT a recursive expression language. A rule is a
 * conjunction of membership tests, and several rules may target the same edge to
 * express disjunction. That is enough for a decision table, it survives a JSON
 * Schema round-trip through the model cleanly, and it is evaluated by a twenty
 * line function with no `eval` anywhere near it.
 */

import { z } from 'zod';

/** Every data item carries this, so "we don't know yet" is always representable. */
export const UNKNOWN = 'unknown';

export const dataItemSchema = z.object({
  key: z
    .string()
    .describe('snake_case identifier, e.g. "screen_result" or "prior_attempt_timing"'),
  description: z
    .string()
    .describe('What this fact means, written for whoever extracts it from a clinical description'),
  question: z
    .string()
    .describe('The question to put to the clinician when this fact is missing'),
  options: z
    .array(z.string())
    .describe(
      'The allowed values, excluding "unknown" which is always added. Use short lowercase tokens.',
    ),
  optionLabels: z
    .array(z.string())
    .describe('Human-readable label for each option, in the same order, for the answer buttons'),
});
export type DataItem = z.infer<typeof dataItemSchema>;

export const forkRuleSchema = z.object({
  edgeId: z.string().describe('The edge this rule selects. Must be an edge leaving the fork node.'),
  clauses: z
    .array(
      z.object({
        variable: z.string().describe('A data item key declared in `dataItems`'),
        in: z.array(z.string()).describe('Values of that variable which satisfy this clause'),
      }),
    )
    .describe('All clauses must hold for the rule to fire. An empty list means "always".'),
  rationale: z
    .string()
    .describe('One sentence, quoting the document, for why these facts imply this branch'),
});
export type ForkRule = z.infer<typeof forkRuleSchema>;

export const forkSchema = z.object({
  nodeId: z.string().describe('The node with more than one way out'),
  rules: z.array(forkRuleSchema),
  /**
   * Set when the document does not determine this fork at all — it is a
   * clinician judgement call (this pathway's "Standard" vs "Enhanced" is one).
   * The router asks rather than pretending a rule exists.
   */
  judgementCall: z
    .boolean()
    .describe('True when the document states no criteria for this fork and a human must decide'),
  /**
   * Precomputed so a judgement-call fork costs zero model calls: we already know
   * at ingest that this one has to be put to the clinician, and what to ask.
   */
  judgementQuestion: z
    .string()
    .nullable()
    .describe('When judgementCall is true: the question to put to the clinician'),
  judgementOptions: z
    .array(
      z.object({
        edgeId: z.string().describe('An edge leaving this fork'),
        label: z.string().describe('How to describe choosing that branch, in clinical terms'),
      }),
    )
    .describe('When judgementCall is true: one option per outgoing edge. Empty otherwise.'),
});
export type Fork = z.infer<typeof forkSchema>;

/**
 * Worked examples for the question box, written once per pathway at compile time.
 *
 * These used to be a hardcoded list, which meant a suicide-risk vignette appeared
 * on an infant apnoea pathway. Generating them per document is the only version
 * of this that survives a library of a hundred pathways.
 */
export const pathwayExampleSchema = z.object({
  label: z.string().describe('Two or three words for a chip, e.g. "Recent attempt"'),
  hint: z.string().describe('One line on what this case demonstrates'),
  text: z.string().describe('A realistic one or two sentence case description a clinician might type'),
});
export type PathwayExample = z.infer<typeof pathwayExampleSchema>;

export const decisionModelSchema = z.object({
  dataItems: z.array(dataItemSchema),
  forks: z.array(forkSchema),
  examples: z
    .array(pathwayExampleSchema)
    .describe('Four to six starter cases spanning this pathway\'s distinct outcomes')
    .default([]),
});
export type DecisionModel = z.infer<typeof decisionModelSchema>;

/** Data item values for one patient. Missing keys are treated as `unknown`. */
export type FactValues = Record<string, string>;
