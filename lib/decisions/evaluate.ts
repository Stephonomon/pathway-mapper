/**
 * The query-time half of the decision model: pure, deterministic, no model call.
 *
 * Given the compiled table and the facts extracted for this patient, decide what
 * happens at a fork. Every outcome is auditable — a fired rule names the clauses
 * that fired and the document sentence behind them.
 */

import type { DecisionModel, FactValues, Fork, ForkRule } from './schema';
import { UNKNOWN } from './schema';

export type ForkOutcome =
  | { kind: 'advance'; edgeId: string; rationale: string; evidence: string[] }
  /** A rule would fire but for a fact we do not have — ask for exactly that fact. */
  | { kind: 'ask'; variableKey: string }
  /**
   * The document states no criteria here; compilation already established that
   * and wrote the question. Asking costs nothing at query time.
   */
  | { kind: 'judgement'; question: string; options: { edgeId: string; label: string }[] }
  /** The table cannot settle it: no fork compiled, or contradictory rules. */
  | { kind: 'defer'; reason: string };

function valueOf(facts: FactValues, key: string): string {
  return facts[key] ?? UNKNOWN;
}

type RuleState = 'fired' | 'blocked' | 'failed';

/**
 * A rule fires when every clause matches. It is *blocked* — not failed — when
 * the only thing standing in the way is a fact we have not established, which is
 * the difference between "ask" and "this branch is wrong".
 */
function evaluateRule(rule: ForkRule, facts: FactValues): { state: RuleState; missing: string[] } {
  const missing: string[] = [];
  for (const clause of rule.clauses) {
    const value = valueOf(facts, clause.variable);
    if (value === UNKNOWN) {
      missing.push(clause.variable);
      continue;
    }
    if (!clause.in.includes(value)) return { state: 'failed', missing: [] };
  }
  return { state: missing.length > 0 ? 'blocked' : 'fired', missing };
}

export function evaluateFork(
  fork: Fork | undefined,
  facts: FactValues,
  legalEdgeIds: Set<string>,
  /** Answers already given this session, used to resolve judgement forks. */
  answers: { question: string; answer: string }[] = [],
): ForkOutcome {
  if (!fork) return { kind: 'defer', reason: 'no compiled rules for this fork' };

  if (fork.judgementCall && fork.judgementQuestion) {
    const options = fork.judgementOptions.filter((o) => legalEdgeIds.has(o.edgeId));
    if (options.length >= 2) {
      // If the clinician has already answered this fork, their answer selects the
      // edge outright — no model call to interpret it.
      const answered = answers.find((a) => a.question === fork.judgementQuestion);
      const chosen = answered && options.find((o) => o.label === answered.answer);
      if (chosen) {
        return {
          kind: 'advance',
          edgeId: chosen.edgeId,
          rationale: `Clinician selected: ${chosen.label}.`,
          evidence: [answered!.answer],
        };
      }
      return { kind: 'judgement', question: fork.judgementQuestion, options };
    }
    return { kind: 'defer', reason: 'judgement fork has too few usable options' };
  }

  // A rule pointing at an edge that no longer exists is stale compilation, not a
  // decision. Drop it rather than routing somewhere impossible.
  const rules = fork.rules.filter((r) => legalEdgeIds.has(r.edgeId));
  if (rules.length === 0) return { kind: 'defer', reason: 'no applicable rules' };

  const fired: ForkRule[] = [];
  const blocked: { rule: ForkRule; missing: string[] }[] = [];

  for (const rule of rules) {
    const { state, missing } = evaluateRule(rule, facts);
    if (state === 'fired') fired.push(rule);
    else if (state === 'blocked') blocked.push({ rule, missing });
  }

  const firedEdges = new Set(fired.map((r) => r.edgeId));

  if (firedEdges.size === 1) {
    // If another branch is still merely blocked, a new fact could contradict this
    // one. Only commit when nothing else is in contention.
    const contested = blocked.some((b) => b.rule.edgeId !== fired[0].edgeId);
    if (contested) return { kind: 'ask', variableKey: blocked[0].missing[0] };
    return {
      kind: 'advance',
      edgeId: fired[0].edgeId,
      rationale: fired.map((r) => r.rationale).join(' '),
      evidence: fired.flatMap((r) => r.clauses.map((c) => `${c.variable}: ${valueOf(facts, c.variable)}`)),
    };
  }

  if (firedEdges.size > 1) {
    return { kind: 'defer', reason: 'compiled rules select more than one branch' };
  }

  if (blocked.length > 0) {
    return { kind: 'ask', variableKey: blocked[0].missing[0] };
  }

  return { kind: 'defer', reason: 'no compiled rule matches these facts' };
}

export function forkFor(model: DecisionModel | null, nodeId: string): Fork | undefined {
  return model?.forks.find((f) => f.nodeId === nodeId);
}

export function dataItemFor(model: DecisionModel | null, key: string) {
  return model?.dataItems.find((v) => v.key === key);
}
