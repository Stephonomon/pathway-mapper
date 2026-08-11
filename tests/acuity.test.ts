/**
 * The acuity decision table is the one place in this system where a wrong answer
 * is dangerous, so it is tested against the pathway text case by case.
 */

import { describe, expect, it } from 'vitest';
import { classifyAcuity, UNKNOWN_FACTS, type ClinicalFacts } from '@/lib/rules/acuity';

const facts = (patch: Partial<ClinicalFacts>): ClinicalFacts => ({
  ...UNKNOWN_FACTS,
  ...patch,
});

/** Everything explicitly ruled out — the baseline for "no criteria met". */
const NOTHING: ClinicalFacts = {
  wishToBeDead: 'never',
  nonSpecificActiveThoughts: 'never',
  activeIdeationWithMethodNoIntent: 'never',
  activeIdeationWithIntentNoPlan: 'never',
  activeIdeationWithPlanAndIntent: 'never',
  nonSuicidalSelfInjury: 'never',
  suicidalBehavior: 'never',
};

describe('high acuity', () => {
  it('fires on a specific plan and intent within the past month', () => {
    const verdict = classifyAcuity(facts({ activeIdeationWithPlanAndIntent: 'within_1_month' }));
    expect(verdict.band).toBe('high');
    expect(verdict.decisive).toBe(true);
  });

  it('fires on intent without a plan within the past month', () => {
    expect(classifyAcuity(facts({ activeIdeationWithIntentNoPlan: 'within_1_month' })).band).toBe(
      'high',
    );
  });

  it('fires on suicidal behavior within the past 3 months', () => {
    expect(classifyAcuity(facts({ suicidalBehavior: 'within_1_month' })).band).toBe('high');
    expect(classifyAcuity(facts({ suicidalBehavior: 'one_to_three_months' })).band).toBe('high');
  });

  it('is decisive even when everything else is unknown, since nothing outranks it', () => {
    const verdict = classifyAcuity(facts({ suicidalBehavior: 'within_1_month' }));
    expect(verdict.decisive).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it('outranks lower-band criteria that also match', () => {
    const verdict = classifyAcuity({
      ...NOTHING,
      wishToBeDead: 'within_1_month',
      activeIdeationWithPlanAndIntent: 'within_1_month',
    });
    expect(verdict.band).toBe('high');
  });
});

describe('intermediate acuity', () => {
  it('fires on non-specific active thoughts within the past month', () => {
    const verdict = classifyAcuity({ ...NOTHING, nonSpecificActiveThoughts: 'within_1_month' });
    expect(verdict.band).toBe('intermediate');
    expect(verdict.decisive).toBe(true);
  });

  it('fires on plan-and-intent that is older than a month', () => {
    expect(
      classifyAcuity({ ...NOTHING, activeIdeationWithPlanAndIntent: 'over_three_months' }).band,
    ).toBe('intermediate');
  });

  it('fires on suicidal behavior more than 3 months ago', () => {
    expect(classifyAcuity({ ...NOTHING, suicidalBehavior: 'over_three_months' }).band).toBe(
      'intermediate',
    );
  });
});

describe('low acuity', () => {
  it('fires on a recent wish to be dead with no behavior history', () => {
    const verdict = classifyAcuity({ ...NOTHING, wishToBeDead: 'within_1_month' });
    expect(verdict.band).toBe('low');
    expect(verdict.decisive).toBe(true);
  });

  it('fires on non-suicidal self-injury within the past 3 months', () => {
    expect(classifyAcuity({ ...NOTHING, nonSuicidalSelfInjury: 'one_to_three_months' }).band).toBe(
      'low',
    );
  });

  it('does NOT apply when there is any history of suicidal behavior', () => {
    // The document requires "No History of Suicidal Behavior" for low acuity, so
    // an old attempt must lift this patient to intermediate.
    const verdict = classifyAcuity({
      ...NOTHING,
      wishToBeDead: 'within_1_month',
      suicidalBehavior: 'over_three_months',
    });
    expect(verdict.band).toBe('intermediate');
  });
});

describe('unknowns', () => {
  it('refuses to assign low acuity while behavior history is unknown', () => {
    // Low acuity requires "No History of Suicidal Behavior". An unknown history
    // is not the same as no history, so the correct answer is to ask.
    const verdict = classifyAcuity(facts({ wishToBeDead: 'within_1_month' }));
    expect(verdict.band).toBeNull();
    expect(verdict.decisive).toBe(false);
    expect(verdict.missing).toContain('suicidalBehavior');
  });

  it('assigns low acuity once behavior history is explicitly ruled out', () => {
    const verdict = classifyAcuity(
      facts({ wishToBeDead: 'within_1_month', suicidalBehavior: 'never' }),
    );
    expect(verdict.band).toBe('low');
    // Still not decisive: the intermediate-band facts remain unknown.
    expect(verdict.decisive).toBe(false);
    expect(verdict.missing).toContain('nonSpecificActiveThoughts');
  });

  it('returns no band and asks for the high-acuity facts when nothing is known', () => {
    const verdict = classifyAcuity(UNKNOWN_FACTS);
    expect(verdict.band).toBeNull();
    expect(verdict.decisive).toBe(false);
    expect(verdict.missing[0]).toBe('activeIdeationWithPlanAndIntent');
  });

  it('reports nothing at all when every criterion is explicitly ruled out', () => {
    const verdict = classifyAcuity(NOTHING);
    expect(verdict.band).toBeNull();
    expect(verdict.missing).toEqual([]);
  });
});
