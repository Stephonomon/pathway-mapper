/**
 * Ingest-time compilation of a pathway's decision table.
 *
 * Runs once per document, not once per query. The output is validated hard
 * before it is stored: a rule may only reference edges that leave its own fork,
 * variables that were actually declared, and values those variables can take.
 * Anything else is dropped with a warning rather than trusted — a compiled rule
 * routes patients without a model in the loop, so it has to be structurally
 * incapable of pointing somewhere that does not exist.
 */

import { generateObject } from 'ai';
import type { PathwayGraph } from '../schema';
import { pathwayModel } from '../llm/provider';
import { decisionModelSchema, UNKNOWN, type DecisionModel } from './schema';

const SYSTEM_PROMPT = `You are compiling a clinical pathway flowchart into a decision table that will route patients WITHOUT a language model in the loop. Precision matters more than coverage.

You are given the pathway's nodes (with their text exactly as printed) and every fork — each node with more than one way out — along with the edges leaving it.

Produce two things:

1. VARIABLES: the small set of patient facts this document actually branches on. Each needs a snake_case key, a description written for whoever extracts it from a clinical narrative, a question to ask the clinician when it is missing, and a closed list of short lowercase option tokens with human-readable labels. Prefer few, reusable variables over many narrow ones. Never include "unknown" in the options — it is added automatically.

2. FORKS: for each fork, rules mapping facts to one outgoing edge. A rule is a conjunction: every clause must hold for it to fire. To express "A or B selects this edge", write two rules for the same edge.

Rules you must follow:
- Only write a rule when the document states the criteria. Do not encode clinical knowledge the document does not print.
- If a fork is a clinician judgement call that the document does not determine — no printed criteria, the choice depends on an assessment the narrative cannot contain — set judgementCall: true, give it no rules, and fill in judgementQuestion plus one judgementOption per outgoing edge. This is a correct and expected answer. It is much better than inventing criteria. Write the question the way a colleague would ask it, and phrase each option as the clinical action that branch represents.
- Every rule's edgeId must be one of the edges listed for that fork.
- Every clause's variable must be one you declared, and its values must come from that variable's options.
- Make the rules exhaustive and mutually exclusive where the document allows it. Two rules selecting different edges must never be able to fire at once.
- Where the document orders branches by severity, encode the most severe branch so it wins on its own criteria alone, without needing the milder branches ruled out.`;

function describeForks(graph: PathwayGraph): string {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines: string[] = ['## Nodes', ''];

  for (const node of graph.nodes) {
    if (!node.routable) continue;
    lines.push(`- ${node.id} (${node.label}): ${JSON.stringify(node.text.slice(0, 700))}`);
  }

  lines.push('', '## Forks (nodes with more than one way out)', '');
  for (const node of graph.nodes) {
    if (!node.routable) continue;
    const outgoing = graph.edges.filter(
      (e) => e.from === node.id && nodes.get(e.to)?.routable !== false,
    );
    if (outgoing.length < 2) continue;

    lines.push(`### Fork at ${node.id} — ${node.label}`);
    lines.push(`Node text: ${JSON.stringify(node.text.slice(0, 700))}`);
    for (const edge of outgoing) {
      const target = nodes.get(edge.to);
      lines.push(
        `- edgeId "${edge.id}" → ${target?.label ?? edge.to}` +
          (edge.label ? ` [printed label: ${edge.label}]` : '') +
          (target?.acuity ? ` [acuity: ${target.acuity}]` : ''),
      );
      if (target?.text) lines.push(`    destination text: ${JSON.stringify(target.text.slice(0, 500))}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface CompileResult {
  model: DecisionModel;
  warnings: string[];
}

/** Drop anything structurally unsound before it can route a patient. */
function validate(graph: PathwayGraph, model: DecisionModel): CompileResult {
  const warnings: string[] = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));

  const variables = model.variables.filter((v) => {
    if (v.options.length === 0) {
      warnings.push(`decision variable "${v.key}" has no options; dropped`);
      return false;
    }
    return true;
  });
  // Keep labels aligned with options even if the model returned a short list.
  for (const v of variables) {
    if (v.optionLabels.length !== v.options.length) {
      v.optionLabels = v.options.map((o, i) => v.optionLabels[i] ?? o);
    }
  }
  const byKey = new Map(variables.map((v) => [v.key, v]));

  const forks = model.forks.flatMap((fork) => {
    const node = nodes.get(fork.nodeId);
    if (!node) {
      warnings.push(`compiled fork references unknown node "${fork.nodeId}"; dropped`);
      return [];
    }
    const legal = new Set(
      graph.edges
        .filter((e) => e.from === fork.nodeId && nodes.get(e.to)?.routable !== false)
        .map((e) => e.id),
    );

    const rules = fork.rules.filter((rule) => {
      if (!legal.has(rule.edgeId)) {
        warnings.push(
          `compiled rule at ${fork.nodeId} targets edge "${rule.edgeId}", which does not leave that node; dropped`,
        );
        return false;
      }
      for (const clause of rule.clauses) {
        const variable = byKey.get(clause.variable);
        if (!variable) {
          warnings.push(
            `compiled rule at ${fork.nodeId} uses undeclared variable "${clause.variable}"; dropped`,
          );
          return false;
        }
        const allowed = new Set([...variable.options, UNKNOWN]);
        const bad = clause.in.filter((v) => !allowed.has(v));
        if (bad.length > 0) {
          warnings.push(
            `compiled rule at ${fork.nodeId} uses values [${bad.join(', ')}] not in "${clause.variable}"; dropped`,
          );
          return false;
        }
      }
      return true;
    });

    const judgementOptions = fork.judgementOptions.filter((o) => {
      if (legal.has(o.edgeId)) return true;
      warnings.push(
        `judgement option at ${fork.nodeId} targets edge "${o.edgeId}", which does not leave that node; dropped`,
      );
      return false;
    });

    // A judgement fork without a usable question cannot be asked, so it is not a
    // judgement fork — let the model handle it rather than dead-ending.
    const judgementCall =
      fork.judgementCall && Boolean(fork.judgementQuestion) && judgementOptions.length >= 2;
    if (fork.judgementCall && !judgementCall) {
      warnings.push(
        `fork at ${fork.nodeId} (${node.label}) was marked a judgement call but has no usable question or options; deferring to the model`,
      );
    }

    if (!judgementCall && rules.length === 0) {
      warnings.push(`fork at ${fork.nodeId} (${node.label}) compiled to no usable rules`);
    }
    return [{ ...fork, rules, judgementCall, judgementOptions }];
  });

  return { model: { variables, forks }, warnings };
}

export async function compileDecisionModel(graph: PathwayGraph): Promise<CompileResult> {
  const { object } = await generateObject({
    model: pathwayModel(),
    schema: decisionModelSchema,
    system: SYSTEM_PROMPT,
    prompt: `Compile this pathway into a decision table.\n\nPathway: ${graph.title}\n\n${describeForks(graph)}`,
  });
  return validate(graph, object);
}
