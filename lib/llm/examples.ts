/**
 * Starter cases for the question box, generated once per pathway at ingest.
 *
 * These used to be produced inside the decision-table compilation, which meant a
 * pathway whose compilation failed or came back thin also came back with no
 * starter cases. They are a UI affordance, not part of the routing table, so they
 * are generated on their own here — a fresh upload always gets a set of questions
 * to try, chosen to send the router down different paths to different outcomes.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { pathwayExampleSchema, type PathwayExample, type PathwayGraph } from '../schema';
import { pathwayModel } from './provider';

const SYSTEM_PROMPT = `You write starter cases for a clinical pathway's question box.

Given a pathway, produce four to six realistic cases a clinician might type, chosen so they send the router down DIFFERENT paths to DIFFERENT outcomes — the point is to let a user try the variety of routes the pathway contains, not to cover the same disposition twice.

Requirements:
- Each case is one or two sentences, in the register a clinician actually uses (age, presentation, the findings the pathway branches on).
- Include at least one deliberately UNDERSPECIFIED case that omits a fact the pathway needs, so the tool has to stop and ask rather than route straight through.
- Every case must be about THIS pathway's subject matter and nothing else. Do not invent findings the pathway has no place for.
- Give each case a two-or-three word chip label and a one-line hint naming the path or outcome it demonstrates (e.g. "reaches high-acuity disposition", "underspecified — should ask about timing").`;

const outputSchema = z.object({
  examples: z.array(pathwayExampleSchema).min(3).max(8),
});

/** The distinct endpoints and decision points, to anchor "different outcomes". */
function describePathway(graph: PathwayGraph): string {
  const routable = graph.nodes.filter((n) => n.routable);
  const hasOut = new Set(graph.edges.map((e) => e.from));
  const outcomes = routable.filter((n) => !hasOut.has(n.id));
  const decisions = routable.filter(
    (n) => graph.edges.filter((e) => e.from === n.id).length > 1,
  );

  const line = (n: (typeof routable)[number]) =>
    `- ${n.label}${n.acuity ? ` [acuity: ${n.acuity}]` : ''}: ${JSON.stringify(n.text.slice(0, 240))}`;

  return [
    '## Decision points',
    ...decisions.map(line),
    '',
    '## Distinct outcomes the pathway can reach',
    ...outcomes.map(line),
  ].join('\n');
}

export async function generateExamples(graph: PathwayGraph): Promise<PathwayExample[]> {
  const { object } = await generateObject({
    model: pathwayModel(),
    schema: outputSchema,
    system: SYSTEM_PROMPT,
    prompt: `Write starter cases for this pathway.\n\nPathway: ${graph.title}\n\n${describePathway(graph)}`,
  });
  return object.examples;
}
