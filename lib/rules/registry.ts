/**
 * Which hand-written ruleset, if any, applies to a given pathway.
 *
 * This exists because of a real bug found by testing across institutions. Acuity
 * bands were being detected from stroke colour alone, and Johns Hopkins' BRUE
 * pathway colours "Higher-risk BRUE" red and "Lower-risk BRUE" green. That was
 * enough to engage the entire C-SSRS machinery on a febrile-infant pathway, which
 * then asked the clinician about "active suicidal ideation with a specific plan
 * and intent". Colour is a visual convention, not a semantic one, and it does not
 * travel between institutions.
 *
 * So a hand-written ruleset is opt-in per pathway and identified by what the
 * document actually says. Detection is computed at routing time rather than
 * stored on the graph: a stored field could go missing or stale, and the failure
 * mode of that is a safety rule silently switching itself off.
 */

import type { PathwayGraph } from '../schema';

export type RulesetId = 'cssrs';

/**
 * Phrases that only co-occur in a document transcribing the Columbia Suicide
 * Severity Rating Scale. Two are required, so a passing mention of suicide in an
 * unrelated pathway does not pull in criteria written for another document.
 */
const CSSRS_MARKERS = [
  'columbia suicide severity',
  'wish to be dead',
  'suicidal ideation',
  'suicidal behavior',
  'non-suicidal self-injurious',
];

const MIN_MARKERS = 2;

export function detectRuleset(graph: PathwayGraph): RulesetId | null {
  const corpus = graph.nodes
    .map((n) => n.text)
    .join(' ')
    .toLowerCase();

  const hits = CSSRS_MARKERS.filter((m) => corpus.includes(m)).length;
  return hits >= MIN_MARKERS ? 'cssrs' : null;
}
