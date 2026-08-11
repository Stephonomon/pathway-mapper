/**
 * POST /api/ingest — multipart upload of a pathway PDF.
 *
 * Runs extraction, then labeling. If labeling fails (no key, model error) the
 * geometric graph is still saved so the document is usable and reviewable — the
 * deterministic half of the pipeline does not depend on a model being reachable.
 */

import { extractDocument } from '@/lib/pdf/extract';
import { classifyPage } from '@/lib/pdf/primitives';
import { inferGraph } from '@/lib/pdf/infer';
import { buildUnlabeledGraph, labelGraph } from '@/lib/llm/label';
import { compileDecisionModel } from '@/lib/decisions/compile';
import { toDocId, writeGraph, writeSource } from '@/lib/store';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'expected a multipart form with a "file" field' }, { status: 400 });
  }

  const docId = toDocId(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());

  let graphs;
  try {
    const doc = await extractDocument(bytes);
    graphs = doc.pages.map((page) => inferGraph(page, classifyPage(page)));
  } catch (err) {
    return Response.json(
      { error: `could not extract this PDF: ${(err as Error).message}` },
      { status: 422 },
    );
  }

  const nodeCount = graphs.reduce((sum, g) => sum + g.nodes.length, 0);
  if (nodeCount === 0) {
    return Response.json(
      { error: 'no flowchart boxes found — this may be a scanned PDF, which is not supported yet' },
      { status: 422 },
    );
  }

  await writeSource(docId, bytes);
  const options = { docId, sourceFile: file.name, fallbackTitle: file.name };

  let graph;
  let labelingError: string | null = null;
  try {
    graph = await labelGraph(graphs, options);
  } catch (err) {
    labelingError = err instanceof Error ? err.message : String(err);
    graph = buildUnlabeledGraph(graphs, options);
    graph.warnings.push(`labeling did not run: ${labelingError}. Graph is geometry-only.`);
  }

  // Precompute the decision table so query time is extraction + lookup.
  if (labelingError === null) {
    try {
      const { model, warnings } = await compileDecisionModel(graph);
      graph.decisions = model;
      graph.compiledAt = new Date().toISOString();
      graph.warnings.push(...warnings);
    } catch (err) {
      graph.warnings.push(`decision compilation failed: ${(err as Error).message}`);
    }
  }

  const saved = await writeGraph(graph);
  return Response.json({
    docId: saved.docId,
    title: saved.title,
    nodes: saved.nodes.length,
    edges: saved.edges.length,
    warnings: saved.warnings,
    labeled: labelingError === null,
  });
}
