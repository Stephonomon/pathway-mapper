/**
 * Model benchmark for the single extraction pass.
 *
 *   npm run factbench
 *
 * This is how `DEFAULT_FAST_MODEL` gets chosen. It runs the *real* merged schema
 * — compiled variables plus the C-SSRS block — because that is what production
 * asks for, and a benchmark of a schema nobody uses proves nothing.
 *
 * The assertion is the acuity band the hand-written verifier derives, since that
 * is the safety-critical consequence of getting extraction wrong.
 */

import { loadEnv } from './env';

loadEnv();

import { classifyAcuity } from '../lib/rules/acuity';
import { extractFacts } from '../lib/decisions/extract';
import { decisionModelSchema, type DecisionModel } from '../lib/decisions/schema';
import { readGraph } from '../lib/store';

const CASES: [string, string, string | null][] = [
  [
    'plan+intent this week',
    "16yo says that this week he has been thinking about taking all of his mother's pills and says he intends to do it. No prior attempts.",
    'high',
  ],
  [
    'attempt 6wk',
    '15yo with an overdose attempt about six weeks ago. Currently denies any ideation, plan, or intent.',
    'high',
  ],
  [
    'nonspecific 2wk',
    '13yo reports thoughts of killing herself over the past two weeks, with no method, no plan, and no intent. She has never made an attempt and has never self-injured.',
    'intermediate',
  ],
  [
    'passive wish',
    '14yo told her school counselor last week that she wishes she were dead. She denies any active thoughts of killing herself, has no method, plan, or intent, has never made an attempt or preparatory act, and has never self-injured.',
    'low',
  ],
  [
    'nssi 2mo',
    '15yo with cutting about two months ago, not with intent to die. Denies any wish to be dead and any suicidal thoughts, ever. No attempts or preparatory acts, ever.',
    'low',
  ],
  ['unknown history', '14yo said last week she wishes she were dead.', null],
  ['bare', 'Teenager with some mental health concerns. What should I do?', null],
];

const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'];

async function run(modelId: string, decisions: DecisionModel | null) {
  process.env.PATHWAY_FAST_MODEL = modelId;
  console.log(`\n===== ${modelId}`);

  let ok = 0;
  let elapsed = 0;

  for (const [name, question, expected] of CASES) {
    const started = Date.now();
    const facts = await extractFacts({
      model: decisions,
      includeClinical: true,
      question,
    });
    const took = Date.now() - started;
    elapsed += took;

    const verdict = classifyAcuity(facts.clinical);
    const got = verdict.decisive ? verdict.band ?? 'none' : 'ASK';
    const want = expected ?? 'ASK';
    const pass = got === want;
    if (pass) ok++;

    console.log(
      `  ${pass ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${String(got).padEnd(13)} want ${String(want).padEnd(13)} ${took}ms`,
    );
  }

  console.log(`  ${ok}/${CASES.length} correct, ${Math.round(elapsed / CASES.length)}ms average`);
}

async function main() {
  const graph = await readGraph(process.argv[2] ?? 'suicide-risk-outpatient');
  const parsed = graph?.decisions ? decisionModelSchema.safeParse(graph.decisions) : null;
  const decisions = parsed?.success ? parsed.data : null;

  console.log(
    decisions
      ? `benchmarking the merged schema: ${decisions.variables.length} compiled variables + the C-SSRS block`
      : 'no compiled decision model found; benchmarking the C-SSRS block alone',
  );

  const original = process.env.PATHWAY_FAST_MODEL;
  try {
    for (const model of MODELS) {
      try {
        await run(model, decisions);
      } catch (err) {
        console.log(`  error: ${(err as Error).message.slice(0, 140)}`);
      }
    }
  } finally {
    if (original === undefined) delete process.env.PATHWAY_FAST_MODEL;
    else process.env.PATHWAY_FAST_MODEL = original;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
