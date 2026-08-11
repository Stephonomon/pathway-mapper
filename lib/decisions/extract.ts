/**
 * The one place that turns a clinician's narrative into facts.
 *
 * It returns two views of the same reading:
 *
 *   compiled  values for the variables `compile.ts` found in this document.
 *             Drives the compiled decision table.
 *   clinical  the canonical C-SSRS fields, when the pathway has acuity bands.
 *             Drives `rules/acuity.ts`, which verifies what the table decided.
 *
 * ## Why two calls and not one merged schema
 *
 * Merging them is the obvious consolidation and it was tried. It costs accuracy:
 * on the `npm run factbench` vignettes, Haiku scored 7/7 on the C-SSRS schema
 * alone but 7/7, 6/7, 5/7 across three runs of the merged schema — and the
 * recurring failure was an under-triage, not a safe "ask". Filling the
 * pathway-specific variables and the C-SSRS block in one pass makes the model
 * worse at both.
 *
 * So the calls stay separate and run concurrently. Wall clock is max(a, b) rather
 * than a + b, which is what actually matters; the only thing "saved" by merging
 * would have been a second cheap request, at the price of the safety-critical
 * read. Consolidation here means one API and one result object, not one request.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { fastModel } from '../llm/provider';
import { clinicalFactsSchema, UNKNOWN_FACTS, type ClinicalFacts } from '../rules/acuity';
import { UNKNOWN, type DecisionModel, type FactValues } from './schema';

const COMPILED_SYSTEM_PROMPT = `Extract structured facts from a clinician's description of a patient, for routing through a clinical pathway.

For each field, choose exactly one of the allowed values.

Use "${UNKNOWN}" whenever the description does not establish the fact. This is the expected answer for most fields, and guessing is harmful — a wrong value routes a patient down a wrong branch, whereas "${UNKNOWN}" simply causes the clinician to be asked.

Only choose a definite value when the description states it, or explicitly rules it out. Do not infer one fact from another.`;

const CLINICAL_SYSTEM_PROMPT = `Extract structured suicide-risk facts from a clinician's description. For each item, report when it most recently occurred.

Use "unknown" whenever the description does not say — this is the expected answer for most fields, and guessing is harmful. Use "never" only when the description explicitly rules the item out ("no prior attempts", "denies any plan").

Do not infer one item from another. A patient who reports a plan has not thereby reported an attempt.`;

export interface ExtractedFacts {
  compiled: FactValues;
  clinical: ClinicalFacts;
}

export const EMPTY_FACTS: ExtractedFacts = { compiled: {}, clinical: UNKNOWN_FACTS };

function compiledSchema(model: DecisionModel) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const variable of model.dataItems) {
    const values: [string, ...string[]] = [UNKNOWN, ...variable.options];
    shape[variable.key] = z.enum(values).describe(variable.description);
  }
  return z.object(shape);
}

function promptFor(question: string, answers: { question: string; answer: string }[]): string {
  const answerText = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n');
  return `Clinician's description:\n${question}${answerText ? `\n\nFollow-up answers:\n${answerText}` : ''}`;
}

export async function extractFacts(options: {
  model: DecisionModel | null;
  /** Only read the C-SSRS block on pathways that actually band by acuity. */
  includeClinical: boolean;
  question: string;
  answers?: { question: string; answer: string }[];
}): Promise<ExtractedFacts> {
  const { model, includeClinical, question, answers = [] } = options;
  const prompt = promptFor(question, answers);

  const wantsCompiled = (model?.dataItems.length ?? 0) > 0;
  if (!wantsCompiled && !includeClinical) return EMPTY_FACTS;

  // Both reads are independent, so pay for one round trip, not two.
  const [compiled, clinical] = await Promise.all([
    wantsCompiled
      ? generateObject({
          model: fastModel(),
          schema: compiledSchema(model!),
          system: COMPILED_SYSTEM_PROMPT,
          prompt,
        })
          .then((r) => r.object as FactValues)
          // Everything unknown makes the router ask rather than act — the safe failure.
          .catch(() => ({}) as FactValues)
      : Promise.resolve({} as FactValues),
    includeClinical
      ? generateObject({
          model: fastModel(),
          schema: clinicalFactsSchema,
          system: CLINICAL_SYSTEM_PROMPT,
          prompt,
        })
          .then((r) => r.object)
          .catch(() => UNKNOWN_FACTS)
      : Promise.resolve(UNKNOWN_FACTS),
  ]);

  return { compiled, clinical };
}
