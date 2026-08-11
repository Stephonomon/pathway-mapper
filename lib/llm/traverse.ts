/**
 * Stage 4: walk the pathway, one legal hop at a time.
 *
 * The design constraint that makes this safe: the model never sees the whole
 * graph and never emits a path. At each hop it sees the current node's verbatim
 * text and the edges that actually leave it, and it picks one id. This server
 * loop holds the state, validates the choice against the real adjacency, and
 * refuses anything else — so a route is, by construction, a sequence of turns the
 * document draws.
 *
 * Three further rules:
 *   - A node with one way out advances without a model call.
 *   - Acuity is decided by `rules/acuity.ts`, not the model; a contradicting
 *     choice is overridden and the discrepancy recorded.
 *   - Missing information produces a question, never a guess.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { PathwayEdge, PathwayGraph, PathwayNode, Route, RouteEvent, RouteStep } from '../schema';
import {
  classifyAcuity,
  describeFact,
  questionForMissingFact,
  type ClinicalFacts,
} from '../rules/acuity';
import { assertModelConfigured, pathwayModel } from './provider';
import { detectRuleset } from '../rules/registry';
import { extractFacts, type ExtractedFacts } from '../decisions/extract';
import { evaluateFork, forkFor, variableFor } from '../decisions/evaluate';
import { decisionModelSchema, type DecisionModel, type FactValues } from '../decisions/schema';

const DEFAULT_MAX_HOPS = 12;

const decisionSchema = z.object({
  action: z
    .enum(['advance', 'ask', 'arrive'])
    .describe('advance = take one of the listed edges; ask = request a missing fact; arrive = stop here'),
  edgeId: z.string().nullable().describe('Required when action is advance; must be one of the listed edge ids'),
  rationale: z.string().describe('One or two sentences explaining this turn to a clinician'),
  evidence: z
    .array(z.string())
    .describe('Short phrases quoted from the clinician\'s question that justify this turn'),
  confidence: z.number().min(0).max(1),
  question: z
    .object({ text: z.string(), options: z.array(z.string()) })
    .nullable()
    .describe('Required when action is ask'),
  summary: z.string().nullable().describe('Required when action is arrive: what the pathway concludes'),
});

const SYSTEM_PROMPT = `You are navigating a clinician through an approved clinical pathway document, one decision at a time, like turn-by-turn directions.

Rules you must follow:
- You may only take one of the edges listed for the current node. Never describe a jump to a node that is not reachable by a listed edge.
- Base every decision on the pathway's own text, which is given to you verbatim. Do not apply outside clinical knowledge to override what the document says.
- If the clinician's description does not contain the information a branch depends on, choose "ask" and request exactly the missing fact. Asking is a correct outcome, not a failure. Never guess between branches.
- Do not ask for the result of a screening step when the description already establishes a finding that the screen exists to detect. A documented positive finding is a positive screen; route on it rather than asking.
- If the current node is an endpoint of the pathway, choose "arrive".
- Your rationale is shown next to the document's own text, so keep it short and factual. Do not restate the node text.
- This is a safety-critical document. When two branches are genuinely plausible, ask rather than pick.`;

export interface TraverseOptions {
  graph: PathwayGraph;
  question: string;
  /** Answers to clarifying questions from earlier turns of the same session. */
  answers?: { question: string; answer: string }[];
  maxHops?: number;
  onEvent?: (event: RouteEvent) => void;
}

function nodeMap(graph: PathwayGraph): Map<string, PathwayNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

/** Edges leaving `nodeId` whose target is somewhere a clinician can actually be. */
function outgoingEdges(graph: PathwayGraph, nodeId: string, nodes: Map<string, PathwayNode>): PathwayEdge[] {
  return graph.edges.filter((e) => e.from === nodeId && nodes.get(e.to)?.routable !== false);
}

/**
 * The nodes that *enter* an acuity band: tagged with the band, and reached from
 * an untagged node. On this pathway that is exactly the three C-SSRS criteria
 * boxes, and not the risk-formulation or care-plan boxes downstream of them.
 */
function bandEntryNodes(graph: PathwayGraph, band: string, nodes: Map<string, PathwayNode>): string[] {
  return graph.nodes
    .filter(
      (node) =>
        node.acuity === band &&
        graph.edges.some((e) => e.to === node.id && nodes.get(e.from)?.acuity == null),
    )
    .map((n) => n.id);
}

/** Can `from` still reach any of `targets` by following edges? */
function canReachAny(
  graph: PathwayGraph,
  from: string,
  targets: Set<string>,
  nodes: Map<string, PathwayNode>,
): boolean {
  if (targets.has(from)) return true;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.from !== id || seen.has(edge.to)) continue;
      if (nodes.get(edge.to)?.routable === false) continue;
      if (targets.has(edge.to)) return true;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return false;
}

export type AcuityCheck =
  | { kind: 'ok'; rationale: string; evidence: string[] }
  | { kind: 'override'; edge: PathwayEdge; note: string; rationale: string; evidence: string[] }
  | { kind: 'ask'; question: { text: string; options: string[] } };

/**
 * The acuity verifier.
 *
 * The compiled table proposes a band; this checks it against the hand-written
 * C-SSRS criteria and has the last word. Three outcomes, and the important one
 * is the third: if the criteria cannot rule out a more severe band, nobody
 * advances — an unknown fact must never look like a decision.
 */
export function verifyAcuity(args: {
  chosen: PathwayNode;
  edges: PathwayEdge[];
  nodes: Map<string, PathwayNode>;
  verdict: ReturnType<typeof classifyAcuity> | null;
}): AcuityCheck | null {
  const { chosen, edges, nodes, verdict } = args;
  if (!verdict) return null;

  if (!verdict.decisive) {
    const missing = verdict.missing[0];
    if (missing) return { kind: 'ask', question: questionForMissingFact(missing) };
    return null;
  }

  const criteria = `Pathway criteria met: ${verdict.matched.join('; ')}.`;

  if (verdict.band && chosen.acuity !== verdict.band) {
    const required = edges.find((e) => nodes.get(e.to)?.acuity === verdict.band);
    if (required) {
      return {
        kind: 'override',
        edge: required,
        note: `Acuity override: the compiled table selected ${chosen.acuity ?? 'a non-acuity branch'}; the C-SSRS criteria in this pathway give ${verdict.band}. The pathway criteria were applied.`,
        rationale: criteria,
        evidence: verdict.matched,
      };
    }
    return null;
  }

  if (verdict.band && chosen.acuity === verdict.band) {
    return { kind: 'ok', rationale: criteria, evidence: verdict.matched };
  }

  return null;
}

function resolveStart(graph: PathwayGraph, nodes: Map<string, PathwayNode>): PathwayNode | null {
  for (const id of graph.entryNodeIds) {
    const node = nodes.get(id);
    if (node?.routable) return node;
  }
  const withInbound = new Set(graph.edges.map((e) => e.to));
  return graph.nodes.find((n) => n.routable && !withInbound.has(n.id)) ?? null;
}

function truncate(text: string, max = 900): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function describeEdges(edges: PathwayEdge[], nodes: Map<string, PathwayNode>): string {
  return edges
    .map((edge) => {
      const target = nodes.get(edge.to);
      const parts = [`- edgeId "${edge.id}" leads to: ${target?.label ?? edge.to}`];
      if (edge.label) parts.push(`  printed branch label: ${edge.label}`);
      if (edge.condition) parts.push(`  condition: ${edge.condition}`);
      if (target?.text) parts.push(`  destination text: ${JSON.stringify(truncate(target.text, 500))}`);
      return parts.join('\n');
    })
    .join('\n');
}

interface HopDecision {
  action: 'advance' | 'ask' | 'arrive';
  edgeId: string | null;
  rationale: string;
  evidence: string[];
  confidence: number;
  question: { text: string; options: string[] } | null;
  summary: string | null;
  ruleForced: boolean;
}

const TIMING_PROSE: Record<string, string> = {
  within_1_month: 'within the past 1 month',
  one_to_three_months: '1 to 3 months ago',
  over_three_months: 'more than 3 months ago',
  never: 'never (explicitly ruled out)',
};

/**
 * Render the established findings so the model routes on what is actually known
 * rather than re-asking for it. Unknowns are omitted — their absence is the
 * signal to ask.
 */
function describeFacts(facts: ClinicalFacts): string {
  const lines = Object.entries(facts)
    .filter(([, timing]) => timing !== 'unknown')
    .map(([key, timing]) => `- ${describeFact(key as keyof ClinicalFacts)}: ${TIMING_PROSE[timing]}`);
  return lines.length ? `Findings established from the description:\n${lines.join('\n')}` : '';
}

async function decideHop(args: {
  graph: PathwayGraph;
  current: PathwayNode;
  edges: PathwayEdge[];
  nodes: Map<string, PathwayNode>;
  question: string;
  answers: TraverseOptions['answers'];
  trail: PathwayNode[];
  facts: ClinicalFacts | null;
}): Promise<HopDecision> {
  const { graph, current, edges, nodes, question, answers, trail, facts } = args;

  const answerText = (answers ?? []).map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n');
  const factText = facts ? describeFacts(facts) : '';
  const prompt = [
    `Pathway: ${graph.title}`,
    '',
    `Clinician's question:\n${question}`,
    answerText ? `\nFollow-up answers so far:\n${answerText}` : '',
    factText ? `\n${factText}` : '',
    '',
    `Route so far: ${trail.map((n) => n.label).join(' → ') || '(start)'}`,
    '',
    `You are currently at node "${current.id}" (${current.label}).`,
    `Its text, verbatim from the document:\n${JSON.stringify(truncate(current.text))}`,
    '',
    `Edges leaving this node — you may only choose one of these ids:`,
    describeEdges(edges, nodes),
  ]
    .filter(Boolean)
    .join('\n');

  const validIds = new Set(edges.map((e) => e.id));
  let lastError = '';

  // Two attempts: an invalid edge id is a correctable mistake, not a failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { object } = await generateObject({
      model: pathwayModel(),
      schema: decisionSchema,
      system: SYSTEM_PROMPT,
      prompt: lastError ? `${prompt}\n\nYour previous answer was rejected: ${lastError}` : prompt,
    });

    if (object.action === 'advance') {
      if (!object.edgeId || !validIds.has(object.edgeId)) {
        lastError = `"${object.edgeId}" is not an edge leaving this node. Valid ids: ${[...validIds].join(', ')}.`;
        continue;
      }
    } else if (object.action === 'ask' && !object.question) {
      lastError = 'action "ask" requires a question.';
      continue;
    }

    return { ...object, ruleForced: false };
  }

  return {
    action: 'ask',
    edgeId: null,
    rationale: 'Could not determine the next step from the information given.',
    evidence: [],
    confidence: 0,
    question: {
      text: 'I could not determine which branch of the pathway applies. Which of these describes the patient?',
      options: edges.map((e) => e.label ?? nodes.get(e.to)?.label ?? e.id),
    },
    summary: null,
    ruleForced: false,
  };
}

export async function traverse(options: TraverseOptions): Promise<Route> {
  const { graph, question, answers = [], maxHops = DEFAULT_MAX_HOPS, onEvent } = options;
  assertModelConfigured();

  const nodes = nodeMap(graph);
  const steps: RouteStep[] = [];
  const notes: string[] = [];
  const visited = new Set<string>();

  const emit = (event: RouteEvent) => onEvent?.(event);

  const finish = (
    status: Route['status'],
    extras: { question?: Route['question']; summary?: string | null } = {},
  ): Route => {
    const citations = steps.flatMap((step) => {
      const node = nodes.get(step.nodeId);
      return (node?.links ?? []).map((link) => ({ ...link, nodeId: step.nodeId }));
    });
    const route: Route = {
      docId: graph.docId,
      graphVersion: graph.version,
      steps,
      status,
      question: extras.question ?? null,
      summary: extras.summary ?? null,
      citations,
      notes,
    };
    emit({ type: 'done', route });
    return route;
  };

  const start = resolveStart(graph, nodes);
  if (!start) {
    notes.push('This pathway has no identifiable entry node. Review the extracted graph.');
    return finish('error');
  }

  // One extraction call, kicked off now and *not* awaited here. Blocking before
  // emitting anything means the user watches a blank document for its full
  // duration; corridors with one way out need no facts at all, so the await
  // happens lazily at the first fork that actually depends on it.
  // The C-SSRS ruleset only applies to the pathway it was transcribed from.
  // Acuity colours travel between institutions; acuity *criteria* do not. See
  // `rules/registry.ts` — this gate is what stops a BRUE pathway, whose
  // higher/lower-risk boxes are red and green, from being asked about suicidal
  // ideation.
  const hasAcuity =
    detectRuleset(graph) === 'cssrs' && graph.nodes.some((n) => n.acuity !== null);

  const decisions: DecisionModel | null = (() => {
    if (!graph.decisions) return null;
    const parsed = decisionModelSchema.safeParse(graph.decisions);
    return parsed.success ? parsed.data : null;
  })();

  const factsPromise = extractFacts({
    model: decisions,
    includeClinical: hasAcuity,
    question,
    answers,
  });

  let factState: {
    facts: ExtractedFacts;
    /** The hand-written C-SSRS reading. Verifies what the table decides. */
    verdict: ReturnType<typeof classifyAcuity> | null;
    bandTargets: Set<string>;
  } | null = null;

  /**
   * Resolve the fact picture, once. A decisive acuity band constrains the whole
   * upstream route, not just the fork where the bands appear: if the criteria say
   * "low acuity", any branch from which the low-acuity box is unreachable is
   * wrong — which is what stops a patient with recent self-injury from being
   * routed out at "negative screen" when the pathway plainly has a place for them.
   */
  const resolveFacts = async () => {
    if (!factState) {
      const facts = await factsPromise;
      const verdict = hasAcuity ? classifyAcuity(facts.clinical) : null;
      factState = {
        facts,
        verdict,
        bandTargets: new Set(
          verdict?.decisive && verdict.band ? bandEntryNodes(graph, verdict.band, nodes) : [],
        ),
      };
    }
    return factState;
  };

  let current: PathwayNode = start;
  const trail: PathwayNode[] = [];

  const pushStep = (step: RouteStep) => {
    steps.push(step);
    emit({ type: 'step', step });
  };

  pushStep({
    nodeId: current.id,
    edgeIdFromPrev: null,
    rationale: 'Pathway entry point.',
    evidence: [],
    confidence: 1,
    ruleForced: false,
  });
  visited.add(current.id);
  trail.push(current);

  // Every band's entry node, regardless of which band the patient is in — this is
  // how the loop recognises "the fork where acuity is assigned". Purely
  // structural, so it needs no facts.
  const entryNodeIdsForBands = new Set(
    hasAcuity
      ? (['low', 'intermediate', 'high'] as const).flatMap((band) =>
          bandEntryNodes(graph, band, nodes),
        )
      : [],
  );

  for (let hop = 0; hop < maxHops; hop++) {
    let edges = outgoingEdges(graph, current.id, nodes);

    if (edges.length === 0) {
      return finish('complete', { summary: current.text.split('\n')[0] ?? current.label });
    }

    // A corridor with one way out is not a decision — take it without waiting on
    // fact extraction or spending a model call.
    let verdict: ReturnType<typeof classifyAcuity> | null = null;
    let hopFacts: ClinicalFacts | null = null;
    if (edges.length > 1) {
      const resolved = await resolveFacts();
      verdict = resolved.verdict;
      hopFacts = resolved.facts.clinical;

      if (resolved.bandTargets.size > 0 && !resolved.bandTargets.has(current.id)) {
        const viable = edges.filter((e) => canReachAny(graph, e.to, resolved.bandTargets, nodes));
        // Only narrow while the band is still ahead of us; downstream of it every
        // branch fails this test and the filter must not fire.
        if (viable.length > 0 && viable.length < edges.length) {
          edges = viable;
        }
      }
    }

    // The compiled decision table resolves most real forks with no reasoning
    // call at all — that work was done once, at ingest. Only forks it cannot
    // settle reach the model below.
    const entersAcuityBand = edges.some((e) => entryNodeIdsForBands.has(e.to));
    if (edges.length > 1 && decisions) {
      const resolved = await resolveFacts();
      const outcome = evaluateFork(
        forkFor(decisions, current.id),
        resolved.facts.compiled,
        new Set(edges.map((e) => e.id)),
        answers,
      );

      if (outcome.kind === 'advance') {
        const edge = edges.find((e) => e.id === outcome.edgeId);
        const next = edge && nodes.get(edge.to);
        if (edge && next && !visited.has(next.id)) {
          // At an acuity fork the compiled table proposes; `rules/acuity.ts`
          // disposes. It is hand-written and hand-tested against the printed
          // C-SSRS criteria, so it gets the last word on the band — and if it
          // cannot rule out a more severe band, nobody advances.
          const check = entersAcuityBand
            ? verifyAcuity({ chosen: next, edges, nodes, verdict })
            : null;

          if (check?.kind === 'ask') {
            emit({ type: 'question', question: check.question });
            return finish('needs_input', { question: check.question });
          }

          const finalEdge = check?.kind === 'override' ? check.edge : edge;
          const finalNext = nodes.get(finalEdge.to);
          if (!finalNext) return finish('ambiguous');
          if (check?.kind === 'override') notes.push(check.note);

          pushStep({
            nodeId: finalNext.id,
            edgeIdFromPrev: finalEdge.id,
            rationale: check?.rationale ?? outcome.rationale,
            evidence: check?.evidence ?? outcome.evidence,
            confidence: 1,
            ruleForced: true,
          });
          visited.add(finalNext.id);
          trail.push(finalNext);
          current = finalNext;
          continue;
        }
      } else if (outcome.kind === 'ask') {
        const variable = variableFor(decisions, outcome.variableKey);
        if (variable) {
          const ask = { text: variable.question, options: variable.optionLabels };
          emit({ type: 'question', question: ask });
          return finish('needs_input', { question: ask });
        }
      } else if (outcome.kind === 'judgement') {
        // Compilation already established that the document does not decide this
        // fork, so there is nothing for a model to work out.
        const ask = { text: outcome.question, options: outcome.options.map((o) => o.label) };
        emit({ type: 'question', question: ask });
        return finish('needs_input', { question: ask });
      }
      // 'defer' (and any unusable outcome) falls through to the model.
    }

    let decision: HopDecision;

    if (edges.length === 1) {
      // Nothing to decide — do not spend a model call on a corridor.
      decision = {
        action: 'advance',
        edgeId: edges[0].id,
        rationale: 'Only one path leaves this step.',
        evidence: [],
        confidence: 1,
        question: null,
        summary: null,
        ruleForced: false,
      };
    } else {
      decision = await decideHop({
        graph,
        current,
        edges,
        nodes,
        question,
        answers,
        trail,
        // Resolved just above: a model call only happens at a real fork.
        facts: hopFacts,
      });

      // Guardrail: at the fork that *enters* the acuity bands, the C-SSRS table
      // decides — not the model, and not only when the model already picked an
      // acuity branch. The dangerous case is the model routing a patient AWAY
      // from an acuity branch (e.g. "denies current ideation" after an attempt
      // six weeks ago), so the override applies to every choice at this fork.
      //
      // It deliberately does NOT apply further downstream. Boxes below the bands
      // inherit the band's colour, but the choices between them (this pathway
      // labels them "Standard" and "Enhanced") are clinical judgement the
      // document leaves open — forcing those would be the guardrail overstepping.
      const acuityEdges = edges.filter((e) => entryNodeIdsForBands.has(e.to));
      if (acuityEdges.length > 0 && verdict) {
        const chosenEdge = decision.edgeId ? edges.find((e) => e.id === decision.edgeId) : null;
        const chosenTarget = chosenEdge ? nodes.get(chosenEdge.to) : null;
        const requiredEdge = verdict.band
          ? acuityEdges.find((e) => nodes.get(e.to)?.acuity === verdict.band)
          : null;

        if (!verdict.decisive) {
          // Every branch here depends on facts we do not have. Ask for the most
          // load-bearing one rather than let any branch be taken.
          const missing = verdict.missing[0];
          if (missing) {
            decision = {
              action: 'ask',
              edgeId: null,
              rationale: `Acuity cannot be assigned yet: the timing of ${describeFact(missing)} is not established.`,
              evidence: [],
              confidence: 0,
              question: questionForMissingFact(missing),
              summary: null,
              ruleForced: true,
            };
          }
        } else if (requiredEdge) {
          if (chosenEdge?.id !== requiredEdge.id) {
            notes.push(
              `Acuity override: the pathway's C-SSRS criteria give ${verdict.band} acuity, but the route was heading to "${chosenTarget?.label ?? 'another branch'}". The pathway criteria were applied.`,
            );
          }
          decision = {
            action: 'advance',
            edgeId: requiredEdge.id,
            rationale: `Pathway criteria met: ${verdict.matched.join('; ')}.`,
            evidence: verdict.matched,
            confidence: 1,
            question: null,
            summary: null,
            ruleForced: true,
          };
        } else if (verdict.band && !requiredEdge) {
          // Decisive band with nowhere to send it — the graph disagrees with the
          // rules. Surface it rather than silently trusting either.
          notes.push(
            `The C-SSRS criteria give ${verdict.band} acuity, but no branch from "${current.label}" leads there. Review the extracted graph.`,
          );
        } else if (chosenTarget && entryNodeIdsForBands.has(chosenTarget.id)) {
          // Decisive with no band means every criterion was ruled out, so an
          // acuity branch is wrong here.
          notes.push(
            `The pathway's C-SSRS criteria were not met, but the route selected ${chosenTarget.acuity} acuity. Verify against the document.`,
          );
        }
      }
    }

    if (decision.action === 'ask' && decision.question) {
      emit({ type: 'question', question: decision.question });
      return finish('needs_input', { question: decision.question });
    }

    if (decision.action === 'arrive' || !decision.edgeId) {
      return finish('complete', { summary: decision.summary ?? current.label });
    }

    const edge = edges.find((e) => e.id === decision.edgeId);
    const next = edge && nodes.get(edge.to);
    if (!edge || !next) {
      notes.push('The selected branch could not be resolved against the graph.');
      return finish('ambiguous');
    }

    if (visited.has(next.id)) {
      notes.push(`Stopped: the route revisited "${next.label}", which would loop.`);
      return finish('ambiguous');
    }

    pushStep({
      nodeId: next.id,
      edgeIdFromPrev: edge.id,
      rationale: decision.rationale,
      evidence: decision.evidence,
      confidence: decision.confidence,
      ruleForced: decision.ruleForced,
    });

    visited.add(next.id);
    trail.push(next);
    current = next;
  }

  notes.push(`Stopped after ${maxHops} steps without reaching an endpoint.`);
  return finish('ambiguous');
}
