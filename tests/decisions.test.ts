/**
 * The compiled decision table routes patients with no model in the loop, so its
 * evaluator gets the same scrutiny as the hand-written acuity rules.
 *
 * The theme of these cases: an unknown fact must never look like a decision.
 */

import { describe, expect, it } from 'vitest';
import { evaluateFork } from '@/lib/decisions/evaluate';
import type { Fork } from '@/lib/decisions/schema';

const LEGAL = new Set(['e1', 'e2', 'e3']);

const fork = (patch: Partial<Fork>): Fork => ({
  nodeId: 'n1',
  rules: [],
  judgementCall: false,
  judgementQuestion: null,
  judgementOptions: [],
  ...patch,
});

const rule = (edgeId: string, clauses: { variable: string; in: string[] }[]) => ({
  edgeId,
  clauses,
  rationale: `takes ${edgeId}`,
});

describe('rule firing', () => {
  const screen = fork({
    rules: [
      rule('e1', [{ variable: 'screen', in: ['negative'] }]),
      rule('e2', [{ variable: 'screen', in: ['positive'] }]),
    ],
  });

  it('advances when exactly one rule fires', () => {
    const out = evaluateFork(screen, { screen: 'positive' }, LEGAL);
    expect(out).toMatchObject({ kind: 'advance', edgeId: 'e2' });
  });

  it('asks for the fact when the deciding variable is unknown', () => {
    const out = evaluateFork(screen, {}, LEGAL);
    expect(out).toMatchObject({ kind: 'ask', variableKey: 'screen' });
  });

  it('treats a missing key the same as an explicit unknown', () => {
    expect(evaluateFork(screen, { screen: 'unknown' }, LEGAL)).toEqual(
      evaluateFork(screen, {}, LEGAL),
    );
  });

  it('requires every clause of a conjunction to hold', () => {
    const both = fork({
      rules: [rule('e1', [{ variable: 'a', in: ['yes'] }, { variable: 'b', in: ['yes'] }])],
    });
    expect(evaluateFork(both, { a: 'yes', b: 'no' }, LEGAL)).toMatchObject({ kind: 'defer' });
    expect(evaluateFork(both, { a: 'yes', b: 'yes' }, LEGAL)).toMatchObject({
      kind: 'advance',
      edgeId: 'e1',
    });
  });

  it('supports disjunction as two rules on one edge', () => {
    const either = fork({
      rules: [
        rule('e1', [{ variable: 'a', in: ['yes'] }]),
        rule('e1', [{ variable: 'b', in: ['yes'] }]),
      ],
    });
    expect(evaluateFork(either, { a: 'yes', b: 'no' }, LEGAL)).toMatchObject({ edgeId: 'e1' });
    expect(evaluateFork(either, { a: 'no', b: 'yes' }, LEGAL)).toMatchObject({ edgeId: 'e1' });
  });
});

describe('refusing to commit', () => {
  it('asks rather than advancing when another branch is still in contention', () => {
    // e1 fires on what we know, but e2 could also fire once `b` is established.
    // Committing here would be exactly the under-triage failure mode.
    const contested = fork({
      rules: [
        rule('e1', [{ variable: 'a', in: ['yes'] }]),
        rule('e2', [{ variable: 'b', in: ['yes'] }]),
      ],
    });
    const out = evaluateFork(contested, { a: 'yes' }, LEGAL);
    expect(out).toMatchObject({ kind: 'ask', variableKey: 'b' });
  });

  it('defers when rules select more than one branch', () => {
    const contradictory = fork({
      rules: [
        rule('e1', [{ variable: 'a', in: ['yes'] }]),
        rule('e2', [{ variable: 'a', in: ['yes'] }]),
      ],
    });
    expect(evaluateFork(contradictory, { a: 'yes' }, LEGAL)).toMatchObject({ kind: 'defer' });
  });

  it('defers when no fork was compiled', () => {
    expect(evaluateFork(undefined, { a: 'yes' }, LEGAL)).toMatchObject({ kind: 'defer' });
  });

  it('ignores rules pointing at edges that do not leave this node', () => {
    // Stale compilation must not route somewhere impossible.
    const stale = fork({ rules: [rule('e99', [{ variable: 'a', in: ['yes'] }])] });
    expect(evaluateFork(stale, { a: 'yes' }, LEGAL)).toMatchObject({ kind: 'defer' });
  });
});

describe('judgement forks', () => {
  const judgement = fork({
    judgementCall: true,
    judgementQuestion: 'Standard or enhanced care?',
    judgementOptions: [
      { edgeId: 'e1', label: 'Standard care' },
      { edgeId: 'e2', label: 'Enhanced care' },
    ],
  });

  it('asks immediately, with no facts needed', () => {
    const out = evaluateFork(judgement, {}, LEGAL);
    expect(out).toMatchObject({ kind: 'judgement', question: 'Standard or enhanced care?' });
  });

  it("resolves from the clinician's earlier answer without a model call", () => {
    const out = evaluateFork(judgement, {}, LEGAL, [
      { question: 'Standard or enhanced care?', answer: 'Enhanced care' },
    ]);
    expect(out).toMatchObject({ kind: 'advance', edgeId: 'e2' });
  });

  it('re-asks when the answer does not match a known option', () => {
    const out = evaluateFork(judgement, {}, LEGAL, [
      { question: 'Standard or enhanced care?', answer: 'something else' },
    ]);
    expect(out.kind).toBe('judgement');
  });

  it('defers when its options no longer exist on the graph', () => {
    const out = evaluateFork(judgement, {}, new Set(['e3']));
    expect(out).toMatchObject({ kind: 'defer' });
  });
});
