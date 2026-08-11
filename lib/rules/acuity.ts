/**
 * The C-SSRS acuity bands, transcribed from the pathway document as a decision
 * table.
 *
 * This exists because acuity is the one branch in this pathway where being wrong
 * is dangerous, and it is fully determined by the text — there is no judgement
 * call. So the model is not allowed to make it. The model's only job is to read
 * structured facts out of the clinician's free-text question (perception); the
 * table below decides the band (adjudication), and `traverse.ts` treats its
 * verdict as binding.
 *
 * Source text, verbatim from the pathway:
 *
 *   Low Acuity          SI, at least 1 of: [within past 1 month] Wish to Be Dead;
 *                       [>1 month ago] Non-Specific Active Suicidal Thoughts,
 *                       Active SI with Any Methods (Not Plan) without Intent to
 *                       Act; [within past 3 months] Non-suicidal Self-injurious
 *                       Behavior. AND Suicidal Behavior: No History.
 *
 *   Intermediate Acuity SI, at least 1 of: [within past 1 month] Non-Specific
 *                       Active Suicidal Thoughts, Active SI with Any Methods (Not
 *                       Plan) without Intent to Act; [>1 month ago] Active SI with
 *                       Some Intent to Act without Specific Plan, Active SI with
 *                       Specific Plan and Intent. AND/OR Suicidal Behavior: [>3
 *                       months ago] Suicidal Behavior.
 *
 *   High Acuity         SI, at least 1 of: [within past 1 month] Active SI with
 *                       Some Intent to Act without Specific Plan, Active SI with
 *                       Specific Plan and Intent. AND/OR Suicidal Behavior:
 *                       [within past 3 months] Suicidal Behavior.
 */

import { z } from 'zod';
import type { Acuity } from '../schema';

export const timingSchema = z.enum([
  'within_1_month',
  'one_to_three_months',
  'over_three_months',
  'never',
  'unknown',
]);
export type Timing = z.infer<typeof timingSchema>;

export const clinicalFactsSchema = z.object({
  wishToBeDead: timingSchema.describe('Most recent passive wish to be dead / not wake up'),
  nonSpecificActiveThoughts: timingSchema.describe(
    'Most recent non-specific active suicidal thoughts, with no method, intent, or plan',
  ),
  activeIdeationWithMethodNoIntent: timingSchema.describe(
    'Most recent active ideation with a method considered, but no intent to act',
  ),
  activeIdeationWithIntentNoPlan: timingSchema.describe(
    'Most recent active ideation with some intent to act, without a specific plan',
  ),
  activeIdeationWithPlanAndIntent: timingSchema.describe(
    'Most recent active ideation with both a specific plan and intent',
  ),
  nonSuicidalSelfInjury: timingSchema.describe('Most recent non-suicidal self-injurious behavior'),
  suicidalBehavior: timingSchema.describe(
    'Most recent suicidal behavior: attempt, aborted or interrupted attempt, or preparatory acts',
  ),
});
export type ClinicalFacts = z.infer<typeof clinicalFactsSchema>;

export const UNKNOWN_FACTS: ClinicalFacts = {
  wishToBeDead: 'unknown',
  nonSpecificActiveThoughts: 'unknown',
  activeIdeationWithMethodNoIntent: 'unknown',
  activeIdeationWithIntentNoPlan: 'unknown',
  activeIdeationWithPlanAndIntent: 'unknown',
  nonSuicidalSelfInjury: 'unknown',
  suicidalBehavior: 'unknown',
};

/** Human-readable names, used in clarifying questions and rationales. */
const FACT_LABELS: Record<keyof ClinicalFacts, string> = {
  wishToBeDead: 'wish to be dead',
  nonSpecificActiveThoughts: 'non-specific active suicidal thoughts',
  activeIdeationWithMethodNoIntent: 'active ideation with a method but no intent',
  activeIdeationWithIntentNoPlan: 'active ideation with some intent but no specific plan',
  activeIdeationWithPlanAndIntent: 'active ideation with a specific plan and intent',
  nonSuicidalSelfInjury: 'non-suicidal self-injury',
  suicidalBehavior: 'suicidal behavior (attempt, aborted/interrupted attempt, preparatory acts)',
};

const RECENT: Timing[] = ['within_1_month'];
/** The document's "more than 1 month ago". */
const OLDER: Timing[] = ['one_to_three_months', 'over_three_months'];
/** The document's "within the past 3 months". */
const WITHIN_3_MONTHS: Timing[] = ['within_1_month', 'one_to_three_months'];

const isIn = (value: Timing, set: Timing[]) => set.includes(value);

export interface AcuityVerdict {
  band: Acuity | null;
  /** True when the bands above `band` are ruled out by known facts. */
  decisive: boolean;
  /** Verbatim criteria that fired, for the rationale shown to the clinician. */
  matched: string[];
  /** Facts whose absence prevents a decisive verdict, most important first. */
  missing: (keyof ClinicalFacts)[];
}

function highCriteria(f: ClinicalFacts): string[] {
  const hits: string[] = [];
  if (isIn(f.activeIdeationWithIntentNoPlan, RECENT)) {
    hits.push('Active suicidal ideation with some intent to act, without specific plan, within the past 1 month');
  }
  if (isIn(f.activeIdeationWithPlanAndIntent, RECENT)) {
    hits.push('Active suicidal ideation with specific plan and intent within the past 1 month');
  }
  if (isIn(f.suicidalBehavior, WITHIN_3_MONTHS)) {
    hits.push('Suicidal behavior within the past 3 months');
  }
  return hits;
}

function intermediateCriteria(f: ClinicalFacts): string[] {
  const hits: string[] = [];
  if (isIn(f.nonSpecificActiveThoughts, RECENT)) {
    hits.push('Non-specific active suicidal thoughts within the past 1 month');
  }
  if (isIn(f.activeIdeationWithMethodNoIntent, RECENT)) {
    hits.push('Active suicidal ideation with any methods (not plan) without intent to act, within the past 1 month');
  }
  if (isIn(f.activeIdeationWithIntentNoPlan, OLDER)) {
    hits.push('Active suicidal ideation with some intent to act, without specific plan, more than 1 month ago');
  }
  if (isIn(f.activeIdeationWithPlanAndIntent, OLDER)) {
    hits.push('Active suicidal ideation with specific plan and intent more than 1 month ago');
  }
  if (f.suicidalBehavior === 'over_three_months') {
    hits.push('Suicidal behavior more than 3 months ago');
  }
  return hits;
}

function lowCriteria(f: ClinicalFacts): string[] {
  // Low acuity additionally requires no history of suicidal behavior at all.
  if (f.suicidalBehavior !== 'never') return [];
  const hits: string[] = [];
  if (isIn(f.wishToBeDead, RECENT)) hits.push('Wish to be dead within the past 1 month');
  if (isIn(f.nonSpecificActiveThoughts, OLDER)) {
    hits.push('Non-specific active suicidal thoughts more than 1 month ago');
  }
  if (isIn(f.activeIdeationWithMethodNoIntent, OLDER)) {
    hits.push('Active suicidal ideation with any methods (not plan) without intent to act, more than 1 month ago');
  }
  if (isIn(f.nonSuicidalSelfInjury, WITHIN_3_MONTHS)) {
    hits.push('Non-suicidal self-injurious behavior within the past 3 months');
  }
  return hits;
}

/**
 * Facts that must be known before we can rule out a band. Anything still
 * `unknown` here is what the clinician gets asked about.
 */
function unknownsBlocking(f: ClinicalFacts, band: Acuity | null): (keyof ClinicalFacts)[] {
  const blocking: (keyof ClinicalFacts)[] = [];
  const check = (key: keyof ClinicalFacts) => {
    if (f[key] === 'unknown') blocking.push(key);
  };

  // Ruling out high acuity always requires these three.
  if (band !== 'high') {
    check('activeIdeationWithPlanAndIntent');
    check('activeIdeationWithIntentNoPlan');
    check('suicidalBehavior');
  }
  // Ruling out intermediate additionally requires the recent-thoughts facts.
  if (band === 'low' || band === null) {
    check('nonSpecificActiveThoughts');
    check('activeIdeationWithMethodNoIntent');
  }
  return blocking;
}

/**
 * Apply the table. Most severe band that matches wins — the pathway is explicitly
 * ordered that way, and under-triage is the failure mode that matters.
 */
export function classifyAcuity(facts: ClinicalFacts): AcuityVerdict {
  const high = highCriteria(facts);
  if (high.length > 0) {
    // Nothing outranks high, so no unknown can change this answer.
    return { band: 'high', decisive: true, matched: high, missing: [] };
  }

  const intermediate = intermediateCriteria(facts);
  if (intermediate.length > 0) {
    const missing = unknownsBlocking(facts, 'intermediate');
    return { band: 'intermediate', decisive: missing.length === 0, matched: intermediate, missing };
  }

  const low = lowCriteria(facts);
  if (low.length > 0) {
    const missing = unknownsBlocking(facts, 'low');
    return { band: 'low', decisive: missing.length === 0, matched: low, missing };
  }

  // No band. This is decisive only when every criterion was explicitly ruled
  // out — which is what a negative risk assessment looks like.
  const missing = unknownsBlocking(facts, null);
  return { band: null, decisive: missing.length === 0, matched: [], missing };
}

/** Turn the highest-priority missing fact into a question for the clinician. */
export function questionForMissingFact(
  key: keyof ClinicalFacts,
): { text: string; options: string[] } {
  return {
    text: `To place this patient on the pathway I need the timing of ${FACT_LABELS[key]}. When did it most recently occur?`,
    options: [
      'Within the past 1 month',
      '1 to 3 months ago',
      'More than 3 months ago',
      'Never',
    ],
  };
}

export function describeFact(key: keyof ClinicalFacts): string {
  return FACT_LABELS[key];
}
