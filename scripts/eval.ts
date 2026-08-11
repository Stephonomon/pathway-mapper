/**
 * Routing eval. Not a unit test — it calls the model, so it needs a key and
 * costs money:
 *
 *   npm run eval -- suicide-risk-outpatient
 *
 * Run it on every prompt or guardrail change. Vignettes assert on node *text*
 * rather than ids so the suite survives re-extraction, and each one states which
 * pathway criterion it is probing.
 */

import { loadEnv } from './env';
import { traverse } from '../lib/llm/traverse';

loadEnv();

import { readGraph } from '../lib/store';
import type { PathwayGraph, Route } from '../lib/schema';

interface Vignette {
  name: string;
  question: string;
  /** Substrings that must each appear in the text of some node on the route. */
  expectNodes: string[];
  /** Substrings that must appear in no node on the route. */
  forbidNodes?: string[];
  /**
   * Acceptable end states. Several vignettes correctly end in `needs_input`: the
   * risk-formulation → care-plan branch carries no printed condition, so the
   * pathway leaves that call to the clinician and the router must ask.
   */
  expectStatus: Route['status'][];
  why: string;
}

const VIGNETTES: Vignette[] = [
  {
    name: 'negative screen',
    question:
      '9yo here for a well visit. Screened for suicide risk today and the screen was negative. No concerns raised by parent or child.',
    expectNodes: ['Negative Suicide Screen'],
    forbidNodes: ['Columbia Suicide Severity Rating Scale'],
    expectStatus: ['complete'],
    why: 'A negative screen must exit the pathway without a risk assessment.',
  },
  {
    name: 'high acuity — plan and intent this week',
    question:
      '16yo says that this week he has been thinking about taking all of his mother\'s pills, and says he intends to do it. No prior attempts.',
    expectNodes: ['High Acuity'],
    forbidNodes: ['Low Acuity', 'Intermediate Acuity'],
    expectStatus: ['complete', 'needs_input'],
    why: 'Active ideation with specific plan and intent within 1 month is high acuity.',
  },
  {
    name: 'high acuity — attempt six weeks ago',
    question:
      '15yo with an overdose attempt about six weeks ago. Currently denies any ideation, plan, or intent.',
    expectNodes: ['High Acuity'],
    forbidNodes: ['Low Acuity', 'Negative Suicide Risk Assessment'],
    expectStatus: ['complete', 'needs_input'],
    why: 'Suicidal behavior within the past 3 months is high acuity regardless of current ideation. This is the under-triage case the guardrail exists for.',
  },
  {
    name: 'intermediate acuity — recent non-specific thoughts',
    question:
      '13yo reports thoughts of killing herself over the past two weeks, with no method, no plan, and no intent. She has never made an attempt and has never self-injured.',
    expectNodes: ['Intermediate Acuity'],
    forbidNodes: ['High Acuity'],
    expectStatus: ['complete', 'needs_input'],
    why: 'Non-specific active suicidal thoughts within 1 month is intermediate acuity.',
  },
  {
    name: 'low acuity — passive wish, no history',
    question:
      '14yo told her school counselor last week that she wishes she were dead. She denies any active thoughts of killing herself, has no method, plan, or intent, has never made an attempt or preparatory act, and has never self-injured.',
    expectNodes: ['Low Acuity'],
    forbidNodes: ['High Acuity', 'Intermediate Acuity'],
    expectStatus: ['complete', 'needs_input'],
    why: 'A recent wish to be dead with no behavior history is low acuity.',
  },
  {
    name: 'low acuity — self-injury within 3 months',
    question:
      '15yo with cutting about two months ago, not with intent to die. Denies any wish to be dead and any suicidal thoughts, ever. No attempts or preparatory acts, ever.',
    expectNodes: ['Low Acuity'],
    forbidNodes: ['Negative Suicide Screen', 'Negative Suicide Risk Assessment'],
    expectStatus: ['complete', 'needs_input'],
    why: 'The document lists non-suicidal self-injury within 3 months as a low acuity criterion, so the pathway has a place for this patient. Routing them out at "negative screen" is under-triage.',
  },
  {
    name: 'behavior history unknown must ask',
    question: '14yo said last week she wishes she were dead.',
    expectNodes: [],
    expectStatus: ['needs_input'],
    why: 'Low acuity requires no history of suicidal behavior. Unknown history must produce a question, not a guess.',
  },
  {
    name: 'bare question must ask',
    question: 'Teenager with some mental health concerns. What should I do?',
    expectNodes: [],
    expectStatus: ['needs_input'],
    why: 'Nothing here determines a branch; the pathway must ask rather than pick.',
  },
];

function routeText(graph: PathwayGraph, route: Route): string {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  return route.steps.map((s) => nodes.get(s.nodeId)?.text ?? '').join('\n---\n');
}

async function main() {
  const docId = process.argv[2] ?? 'suicide-risk-outpatient';
  const graph = await readGraph(docId);
  if (!graph) {
    console.error(`no graph for "${docId}" — run: npm run ingest -- <pdf> --doc-id ${docId}`);
    process.exit(1);
  }
  if (!graph.labeledAt) {
    console.warn(
      'warning: this graph was never labeled, so branch conditions are empty and routing will be weak.\n',
    );
  }

  let passed = 0;
  const failures: string[] = [];

  for (const vignette of VIGNETTES) {
    process.stdout.write(`${vignette.name} … `);
    let route: Route;
    try {
      route = await traverse({ graph, question: vignette.question });
    } catch (err) {
      failures.push(`${vignette.name}: threw ${(err as Error).message}`);
      console.log('ERROR');
      continue;
    }

    const text = routeText(graph, route);
    const problems: string[] = [];

    if (!vignette.expectStatus.includes(route.status)) {
      problems.push(`status ${route.status}, expected one of ${vignette.expectStatus.join('/')}`);
    }
    for (const needle of vignette.expectNodes) {
      if (!text.includes(needle)) problems.push(`route never reached "${needle}"`);
    }
    for (const needle of vignette.forbidNodes ?? []) {
      if (text.includes(needle)) problems.push(`route wrongly reached "${needle}"`);
    }

    if (problems.length === 0) {
      passed++;
      console.log('pass');
    } else {
      console.log('FAIL');
      failures.push(`${vignette.name}\n    ${vignette.why}\n    ${problems.join('\n    ')}`);
    }
  }

  console.log(`\n${passed}/${VIGNETTES.length} vignettes passed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
