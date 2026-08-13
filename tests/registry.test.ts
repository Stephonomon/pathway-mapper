/**
 * Hand-written rulesets must not leak between pathways.
 *
 * This regression is real and was found by testing across institutions: acuity
 * bands were detected from stroke colour alone, and Johns Hopkins' BRUE pathway
 * colours "Higher-risk BRUE" red and "Lower-risk BRUE" green. That was enough to
 * engage the C-SSRS ruleset on a febrile-infant pathway, which then asked the
 * clinician about active suicidal ideation with a specific plan and intent.
 *
 * Colour is a visual convention. It does not travel between institutions, and
 * nothing safety-critical may key off it.
 */

import { describe, expect, it } from 'vitest';
import { detectRuleset } from '@/lib/rules/registry';
import type { PathwayGraph, PathwayNode } from '@/lib/schema';

const node = (id: string, text: string, acuity: PathwayNode['acuity'] = null): PathwayNode => ({
  id,
  page: 1,
  bbox: { x: 0, y: 0, w: 10, h: 10 },
  text,
  label: id,
  kind: 'action',
  acuity,
  routable: true,
  links: [],
  childIds: [],
  confidence: 1,
});

const graph = (nodes: PathwayNode[]): PathwayGraph => ({
  docId: 'test',
  title: 'test',
  sourceFile: 'test.pdf',
  pages: [{ number: 1, width: 612, height: 792 }],
  nodes,
  edges: [],
  entryNodeIds: [],
  version: 1,
  extractedAt: '',
  labeledAt: null,
  warnings: [],
  decisions: null,
  compiledAt: null,
  examples: [],
  source: { kind: 'pdf' as const, html: null, url: null },
});

describe('ruleset detection', () => {
  it('recognises the pathway the C-SSRS rules were written from', () => {
    expect(
      detectRuleset(
        graph([
          node('n1', 'Use the Columbia Suicide Severity Rating Scale to complete Suicide Risk Assessment'),
          node('n2', 'Low Acuity\nSuicidal Ideation\nWish to Be Dead', 'low'),
        ]),
      ),
    ).toBe('cssrs');
  });

  it('does NOT fire on a BRUE pathway whose risk boxes are red and green', () => {
    // The exact shape of the bug: acuity tags present, subject matter unrelated.
    expect(
      detectRuleset(
        graph([
          node('n1', 'Well-appearing patient less than 1 year old presenting with a caregiver observed BRUE'),
          node('n2', 'HIGHER-RISK BRUE: Out of scope of the pathway, manage accordingly', 'high'),
          node('n3', 'LOWER-RISK BRUE', 'low'),
        ]),
      ),
    ).toBeNull();
  });

  it('does NOT fire on a febrile infant pathway', () => {
    expect(
      detectRuleset(
        graph([
          node('n1', '29-60 days old, well appearing, no evident source of infection'),
          node('n2', 'Obtain urinalysis, urine gram stain and culture, blood culture', 'low'),
        ]),
      ),
    ).toBeNull();
  });

  it('does not fire on a single passing mention of suicide', () => {
    // One marker is not enough — a general behavioural health pathway may
    // reference suicide risk without transcribing the C-SSRS criteria.
    expect(
      detectRuleset(
        graph([node('n1', 'Screen for depression and suicidal ideation at every visit')]),
      ),
    ).toBeNull();
  });
});
