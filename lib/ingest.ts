/**
 * One place that turns a fetched document into a stored pathway graph.
 *
 * Two readers feed the same downstream pipeline. A PDF goes through the vector
 * extractor; an HTML pathway goes through the DOM reader. Both produce a
 * `CandidateGraph`, so labeling, decision compilation, routing and the overlay
 * are shared and neither has to know where the graph came from.
 */

import { extractDocument } from './pdf/extract';
import { classifyPage } from './pdf/primitives';
import { inferGraph, type CandidateGraph } from './pdf/infer';
import { extractHtmlPathway } from './html/extract';
import { buildUnlabeledGraph, labelGraph, type LabelOptions } from './llm/label';
import { compileDecisionModel } from './decisions/compile';
import { generateExamples } from './llm/examples';
import { writeGraph, writeSource } from './store';
import type { PathwayGraph } from './schema';

export type IngestInput =
  | { kind: 'pdf'; bytes: Uint8Array; filename: string; url?: string | null }
  | { kind: 'html'; html: string; url: string; filename: string };

export interface IngestOptions {
  docId: string;
  /** Skip the model passes — useful without an API key. */
  noLabel?: boolean;
  onProgress?: (message: string) => void;
}

export interface IngestResult {
  graph: PathwayGraph;
  labeled: boolean;
}

/** Read the document into candidate graphs plus the display source. */
async function read(input: IngestInput): Promise<{
  graphs: CandidateGraph[];
  title: string;
  source: PathwayGraph['source'];
}> {
  if (input.kind === 'html') {
    const extracted = extractHtmlPathway(input.html, input.url);
    if (!extracted) {
      throw new Error('That page has no pathway diagram this can read.');
    }
    return {
      graphs: [extracted.graph],
      title: extracted.title,
      source: { kind: 'html', html: extracted.fragment, url: input.url },
    };
  }

  const doc = await extractDocument(input.bytes);
  return {
    graphs: doc.pages.map((page) => inferGraph(page, classifyPage(page))),
    title: input.filename,
    source: { kind: 'pdf', html: null, url: input.url ?? null },
  };
}

export async function ingestDocument(
  input: IngestInput,
  options: IngestOptions,
): Promise<IngestResult> {
  const progress = options.onProgress ?? (() => {});
  const { graphs, title, source } = await read(input);

  const nodeCount = graphs.reduce((sum, g) => sum + g.nodes.length, 0);
  if (nodeCount === 0) {
    throw new Error(
      input.kind === 'pdf'
        ? 'No flowchart boxes found — this may be a scanned PDF, which is not supported yet.'
        : 'No pathway boxes found on that page.',
    );
  }

  // A PDF is served back to the viewer verbatim; HTML travels inside the graph.
  if (input.kind === 'pdf') await writeSource(options.docId, input.bytes);

  const labelOptions: LabelOptions = {
    docId: options.docId,
    sourceFile: source.url ?? input.filename,
    fallbackTitle: title,
    source,
  };

  let graph: PathwayGraph;
  let labeled = false;

  if (options.noLabel) {
    graph = buildUnlabeledGraph(graphs, labelOptions);
    graph.warnings.push('ingested with --no-label: labels and branch conditions are placeholders');
  } else {
    try {
      graph = await labelGraph(graphs, labelOptions);
      labeled = true;
    } catch (err) {
      graph = buildUnlabeledGraph(graphs, labelOptions);
      graph.warnings.push(`labeling did not run: ${(err as Error).message}. Graph is geometry-only.`);
    }
  }

  if (labeled) {
    // Starter cases run alongside compilation and independently of it — a fresh
    // upload should still get questions to try even if the decision table fails.
    const examplesPromise = generateExamples(graph).catch((err) => {
      graph.warnings.push(`sample questions were not generated: ${(err as Error).message}`);
      return [] as PathwayGraph['examples'];
    });

    try {
      const { model, warnings } = await compileDecisionModel(graph);
      graph.decisions = model;
      graph.compiledAt = new Date().toISOString();
      graph.warnings.push(...warnings);
      progress(
        `compiled ${model.dataItems.length} data items, ${model.forks.length} forks ` +
          `(${model.forks.filter((f) => f.judgementCall).length} left to clinical judgement)`,
      );
    } catch (err) {
      graph.warnings.push(`decision compilation failed: ${(err as Error).message}`);
    }

    graph.examples = await examplesPromise;
    progress(`generated ${graph.examples.length} sample questions`);
  }

  return { graph: await writeGraph(graph), labeled };
}
