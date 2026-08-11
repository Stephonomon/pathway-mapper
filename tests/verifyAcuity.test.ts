/**
 * The acuity verifier has the last word on banding: the compiled table proposes,
 * this disposes. So it gets tested directly, not only through the end-to-end
 * eval.
 *
 * The property that matters throughout: an unknown fact must never look like a
 * decision, and under-triage must never be reachable.
 */

import { describe, expect, it } from 'vitest';
import { verifyAcuity } from '@/lib/llm/traverse';
import { classifyAcuity, UNKNOWN_FACTS, type ClinicalFacts } from '@/lib/rules/acuity';
import type { Acuity, PathwayEdge, PathwayNode } from '@/lib/schema';

const node = (id: string, acuity: Acuity | null): PathwayNode => ({
  id,
  page: 1,
  bbox: { x: 0, y: 0, w: 1, h: 1 },
  text: id,
  label: id,
  kind: 'branch',
  acuity,
  routable: true,
  links: [],
  childIds: [],
  confidence: 1,
});

const edge = (id: string, to: string): PathwayEdge => ({
  id,
  from: 'fork',
  to,
  label: null,
  condition: null,
  polyline: [],
  arrowAt: null,
  provenance: 'shaft',
  confidence: 1,
});

const LOW = node('low', 'low');
const MID = node('mid', 'intermediate');
const HIGH = node('high', 'high');
const NEGATIVE = node('negative', null);

const nodes = new Map([LOW, MID, HIGH, NEGATIVE].map((n) => [n.id, n]));
const edges = [
  edge('e-low', 'low'),
  edge('e-mid', 'mid'),
  edge('e-high', 'high'),
  edge('e-neg', 'negative'),
];

const check = (chosen: PathwayNode, facts: ClinicalFacts) =>
  verifyAcuity({ chosen, edges, nodes, verdict: classifyAcuity(facts) });

const NOTHING: ClinicalFacts = {
  wishToBeDead: 'never',
  nonSpecificActiveThoughts: 'never',
  activeIdeationWithMethodNoIntent: 'never',
  activeIdeationWithPlanAndIntent: 'never',
  activeIdeationWithIntentNoPlan: 'never',
  nonSuicidalSelfInjury: 'never',
  suicidalBehavior: 'never',
};

describe('agreement', () => {
  it('accepts the table when it matches the criteria', () => {
    const out = check(HIGH, { ...NOTHING, activeIdeationWithPlanAndIntent: 'within_1_month' });
    expect(out?.kind).toBe('ok');
    expect(out).toMatchObject({ rationale: expect.stringContaining('Pathway criteria met') });
  });
});

describe('override', () => {
  it('overrides the table when the criteria give a different band', () => {
    // The compiled table says low; an attempt six weeks ago makes it high.
    const out = check(LOW, { ...NOTHING, suicidalBehavior: 'one_to_three_months' });
    expect(out?.kind).toBe('override');
    expect(out).toMatchObject({ edge: expect.objectContaining({ to: 'high' }) });
  });

  it('overrides a non-acuity branch too — the under-triage case', () => {
    // Routing this patient to "negative risk assessment" is the exact failure the
    // verifier exists to catch.
    const out = check(NEGATIVE, { ...NOTHING, suicidalBehavior: 'within_1_month' });
    expect(out?.kind).toBe('override');
    expect(out).toMatchObject({ edge: expect.objectContaining({ to: 'high' }) });
  });

  it('records the discrepancy rather than silently correcting it', () => {
    const out = check(LOW, { ...NOTHING, suicidalBehavior: 'one_to_three_months' });
    expect(out).toMatchObject({ note: expect.stringContaining('Acuity override') });
  });
});

describe('refusing to commit', () => {
  it('asks when the criteria cannot rule out a more severe band', () => {
    // Nothing is established, so any band could still be correct.
    const out = check(LOW, UNKNOWN_FACTS);
    expect(out?.kind).toBe('ask');
  });

  it('asks even when the table looks confident', () => {
    // A recent wish to be dead suggests low, but nothing severe has been ruled
    // out, so the pathway cannot place this patient at all.
    const out = check(LOW, { ...UNKNOWN_FACTS, wishToBeDead: 'within_1_month' });
    expect(out?.kind).toBe('ask');
  });

  it('asks about the most severe unruled-out band first', () => {
    // Ordering is deliberate: establish whether high acuity applies before
    // spending the clinician's attention on what separates low from intermediate.
    const out = check(LOW, { ...UNKNOWN_FACTS, wishToBeDead: 'within_1_month' });
    expect(out).toMatchObject({
      question: expect.objectContaining({
        text: expect.stringContaining('specific plan and intent'),
      }),
    });
  });
});

describe('standing aside', () => {
  it('does not interfere when no criteria are met at all', () => {
    // Every item explicitly ruled out: a negative risk assessment is correct, and
    // the verifier has nothing to say about it.
    expect(check(NEGATIVE, NOTHING)).toBeNull();
  });

  it('does not interfere on pathways with no acuity bands', () => {
    expect(verifyAcuity({ chosen: NEGATIVE, edges, nodes, verdict: null })).toBeNull();
  });

  it('stands aside rather than inventing a branch that does not exist', () => {
    const out = verifyAcuity({
      chosen: LOW,
      edges: [edge('e-low', 'low'), edge('e-neg', 'negative')], // no high branch here
      nodes,
      verdict: classifyAcuity({ ...NOTHING, suicidalBehavior: 'within_1_month' }),
    });
    expect(out).toBeNull();
  });
});
