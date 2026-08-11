/**
 * Encoding-variability experiment.
 *
 *   npm run variability -- [pdf] [runs]
 *
 * GLIF (Ohno-Machado et al., JAMIA 1998) reported that two independent encoders
 * of the *same* guideline produced substantially different representations. That
 * finding is the main practical obstacle to shareable computable guidelines, and
 * it applies to a language model doing the encoding just as much as to a person.
 *
 * This measures it. The geometry pass is deterministic, so the topology is fixed
 * by the document and cannot vary — which is itself the interesting part. Only
 * the interpretive layers (labeling and decision compilation) can disagree, so
 * running them repeatedly over identical geometry isolates exactly how much
 * encoder variability remains, and where.
 */

import fs from 'node:fs/promises';
import { loadEnv } from './env';

loadEnv();

import { extractDocument } from '../lib/pdf/extract';
import { classifyPage } from '../lib/pdf/primitives';
import { inferGraph } from '../lib/pdf/infer';
import { labelGraph } from '../lib/llm/label';
import { compileDecisionModel } from '../lib/decisions/compile';
import { traverse } from '../lib/llm/traverse';
import { decisionModelSchema } from '../lib/decisions/schema';
import type { PathwayGraph } from '../lib/schema';

function agreement<T>(runs: T[][], key: (t: T) => string, value: (t: T) => string): number {
  if (runs.length < 2) return 1;
  const keys = new Set(runs.flat().map(key));
  let agree = 0;
  for (const k of keys) {
    const values = runs.map((run) => run.find((t) => key(t) === k)).map((t) => (t ? value(t) : '—'));
    if (values.every((v) => v === values[0])) agree++;
  }
  return keys.size === 0 ? 1 : agree / keys.size;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

async function main() {
  const input =
    process.argv[2] ??
    "Suicide Risk Assessment and Care Planning Clinical Pathway – Outpatient _ Children's Hospital of Philadelphia.pdf";
  const runs = Number(process.argv[3] ?? 3);

  const bytes = new Uint8Array(await fs.readFile(input));
  const doc = await extractDocument(bytes);
  const candidates = doc.pages.map((p) => inferGraph(p, classifyPage(p)));

  const nodeCount = candidates.reduce((n, g) => n + g.nodes.length, 0);
  const edgeCount = candidates.reduce((n, g) => n + g.edges.length, 0);
  console.log(`\ngeometry (deterministic): ${nodeCount} nodes, ${edgeCount} edges`);
  console.log(`running the interpretive passes ${runs} times over identical geometry…\n`);

  const graphs: PathwayGraph[] = [];
  for (let i = 0; i < runs; i++) {
    const graph = await labelGraph(candidates, {
      docId: 'variability',
      sourceFile: input,
      fallbackTitle: input,
    });
    const compiled = await compileDecisionModel(graph);
    graph.decisions = compiled.model;
    graphs.push(graph);
    process.stdout.write(
      `  run ${i + 1}: entry=${graph.entryNodeIds.join(',')} ` +
        `vars=${compiled.model.dataItems.length} ` +
        `forks=${compiled.model.forks.length} ` +
        `judgement=${compiled.model.forks.filter((f) => f.judgementCall).length}\n`,
    );
  }

  console.log('\n── stability across runs');

  // Topology cannot vary: it came from the document, not from a model.
  const topologies = graphs.map((g) =>
    JSON.stringify(g.edges.map((e) => `${e.from}->${e.to}`).sort()),
  );
  console.log(
    `  graph topology            ${topologies.every((t) => t === topologies[0]) ? 'IDENTICAL' : 'VARIES'}`,
  );

  const entries = graphs.map((g) => g.entryNodeIds.join(','));
  console.log(
    `  entry node                ${entries.every((e) => e === entries[0]) ? 'IDENTICAL' : `VARIES (${[...new Set(entries)].join(' | ')})`}`,
  );

  console.log(
    `  node kind                 ${pct(agreement(graphs.map((g) => g.nodes), (n) => n.id, (n) => n.kind))}`,
  );
  console.log(
    `  node routable             ${pct(agreement(graphs.map((g) => g.nodes), (n) => n.id, (n) => String(n.routable)))}`,
  );
  console.log(
    `  node acuity               ${pct(agreement(graphs.map((g) => g.nodes), (n) => n.id, (n) => String(n.acuity)))}`,
  );
  console.log(
    `  edge printed label        ${pct(agreement(graphs.map((g) => g.edges), (e) => e.id, (e) => String(e.label)))}`,
  );

  const models = graphs.map((g) => decisionModelSchema.parse(g.decisions));
  const varNames = models.map((m) => m.dataItems.map((v) => v.key).sort().join(','));
  console.log(
    `  decision variable names   ${varNames.every((v) => v === varNames[0]) ? 'IDENTICAL' : 'VARIES'}`,
  );
  for (const [i, v] of varNames.entries()) console.log(`      run ${i + 1}: ${v}`);

  console.log(
    `  which forks are judgement ${pct(agreement(models.map((m) => m.forks), (f) => f.nodeId, (f) => String(f.judgementCall)))}`,
  );

  // The question that actually matters: would these encodings route a patient
  // the same way? Compare each fork's rules as a set of (edge, clause) facts.
  const ruleShape = (m: (typeof models)[number]) =>
    m.forks
      .flatMap((f) =>
        f.rules.map(
          (r) =>
            `${f.nodeId}:${r.edgeId}:${r.clauses
              .map((c) => `${c.variable}∈{${[...c.in].sort().join(',')}}`)
              .sort()
              .join('&')}`,
        ),
      )
      .sort();
  const shapes = models.map(ruleShape);
  const shared = shapes[0].filter((r) => shapes.every((s) => s.includes(r)));
  console.log(
    `\n  fork rules: ${shapes.map((s) => s.length).join(' / ')} rules per run, ${shared.length} identical across all runs`,
  );

  // The question that actually matters is not whether the encodings look alike
  // but whether they route a patient alike. Representational divergence is only
  // a problem if it is also behavioural divergence.
  console.log('\n── behavioural equivalence: do these encodings route the same patient the same way?');

  const VIGNETTES: [string, string][] = [
    ['negative screen', '9yo well visit, screened for suicide risk today, screen was negative.'],
    [
      'plan and intent',
      "16yo says that this week he has been thinking about taking all of his mother's pills and says he intends to do it. No prior attempts.",
    ],
    [
      'attempt 6 weeks ago',
      '15yo with an overdose attempt about six weeks ago. Currently denies any ideation, plan, or intent.',
    ],
    [
      'passive wish, no history',
      '14yo told her school counselor last week that she wishes she were dead. She denies any active thoughts of killing herself, has no method, plan, or intent, has never made an attempt or preparatory act, and has never self-injured.',
    ],
    ['underspecified', '14yo said last week she wishes she were dead.'],
  ];

  let same = 0;
  for (const [name, question] of VIGNETTES) {
    const outcomes = await Promise.all(
      graphs.map(async (graph) => {
        const route = await traverse({ graph, question });
        const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
        const last = route.steps[route.steps.length - 1];
        // Compare node *identity*, not the label: labels are model-written and
        // vary in wording between encodings without the route differing at all.
        void nodes;
        return `${route.status}@${last?.nodeId ?? '—'}`;
      }),
    );
    const agree = outcomes.every((o) => o === outcomes[0]);
    if (agree) same++;
    console.log(`  ${agree ? 'same ' : 'DIFF '} ${name.padEnd(26)} ${[...new Set(outcomes)].join('  |  ')}`);
  }
  console.log(`\n  ${same}/${VIGNETTES.length} vignettes routed identically by all ${runs} encodings`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
