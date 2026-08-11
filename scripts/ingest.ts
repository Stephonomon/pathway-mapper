/**
 * CLI ingest — same pipeline as POST /api/ingest, usable without the server.
 *
 *   npm run ingest -- path/to/pathway.pdf [--no-label] [--doc-id my-id]
 *
 * `--no-label` stops after the deterministic pass, which is how you get a usable
 * document with no API key configured.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from './env';
import { extractDocument } from '../lib/pdf/extract';

loadEnv();

import { classifyPage } from '../lib/pdf/primitives';
import { inferGraph } from '../lib/pdf/infer';
import { buildUnlabeledGraph, labelGraph } from '../lib/llm/label';
import { compileDecisionModel } from '../lib/decisions/compile';
import { toDocId, writeGraph, writeSource } from '../lib/store';

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('usage: npm run ingest -- <pdf> [--no-label] [--doc-id <id>]');
    process.exit(1);
  }

  const noLabel = args.includes('--no-label');
  const docIdFlag = args.indexOf('--doc-id');
  const docId = docIdFlag >= 0 ? args[docIdFlag + 1] : toDocId(path.basename(input));

  const bytes = new Uint8Array(await fs.readFile(input));
  const doc = await extractDocument(bytes);
  const graphs = doc.pages.map((page) => inferGraph(page, classifyPage(page)));

  const options = { docId, sourceFile: path.basename(input), fallbackTitle: path.basename(input) };
  await writeSource(docId, bytes);

  let graph;
  if (noLabel) {
    graph = buildUnlabeledGraph(graphs, options);
    graph.warnings.push('ingested with --no-label: labels and branch conditions are placeholders');
  } else {
    try {
      graph = await labelGraph(graphs, options);
    } catch (err) {
      console.warn(`labeling failed (${(err as Error).message}); saving geometry-only graph`);
      graph = buildUnlabeledGraph(graphs, options);
      graph.warnings.push(`labeling did not run: ${(err as Error).message}`);
    }
  }

  // Precompute the decision table. This is the work that keeps query time down:
  // deriving what each fork branches on is per-pathway, not per-question.
  if (!noLabel) {
    try {
      const { model, warnings } = await compileDecisionModel(graph);
      graph.decisions = model;
      graph.compiledAt = new Date().toISOString();
      graph.warnings.push(...warnings);
      const judgement = model.forks.filter((f) => f.judgementCall).length;
      console.log(
        `compiled ${model.variables.length} decision variables, ${model.forks.length} forks (${judgement} left to clinical judgement)`,
      );
    } catch (err) {
      console.warn(`decision compilation failed (${(err as Error).message}); routing will ask the model at every fork`);
      graph.warnings.push(`decision compilation failed: ${(err as Error).message}`);
    }
  }

  const saved = await writeGraph(graph);
  console.log(
    `${saved.docId}: ${saved.nodes.length} nodes, ${saved.edges.length} edges, v${saved.version}`,
  );
  console.log(`entry: ${saved.entryNodeIds.join(', ') || '(none)'}`);
  for (const warning of saved.warnings) console.log(`  warning: ${warning}`);
  console.log(`\nopen http://localhost:3000/p/${saved.docId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
