/**
 * Single seam for model access.
 *
 * Everything else in the app asks for a model *by role* rather than importing a
 * provider directly, so moving to a CHOP-approved endpoint (Azure OpenAI, an
 * internal gateway) is a change to this file and nothing else.
 *
 * Two roles, because they are different jobs:
 *
 *   reasoning  Choosing a branch at a genuine clinical fork. Worth a strong
 *              model — it is the part a clinician will second-guess.
 *   fast       Mechanical structured extraction (pulling C-SSRS facts out of
 *              free text). Accuracy still matters because it feeds the acuity
 *              guardrail, but it is transcription, not judgement, and on the
 *              critical path for time-to-first-step.
 */

import { anthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

const DEFAULT_REASONING_MODEL = 'claude-opus-5';

/**
 * Haiku 4.5, benchmarked against the C-SSRS vignettes in `scripts/factbench.ts`:
 * 7/7 correct bands at ~1.3s, matching Opus's accuracy at a quarter of the
 * latency. Sonnet 5 scored 6/7 on the same set, so this is not merely the cheap
 * option — it is the best one for this job.
 */
const DEFAULT_FAST_MODEL = 'claude-haiku-4-5-20251001';

/** Branch decisions at real clinical forks. */
export function pathwayModel(): LanguageModel {
  return anthropic(process.env.PATHWAY_MODEL ?? DEFAULT_REASONING_MODEL);
}

/** Structured extraction and other mechanical passes. */
export function fastModel(): LanguageModel {
  return anthropic(
    process.env.PATHWAY_FAST_MODEL ?? process.env.PATHWAY_MODEL ?? DEFAULT_FAST_MODEL,
  );
}

export function assertModelConfigured(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.',
    );
  }
}
