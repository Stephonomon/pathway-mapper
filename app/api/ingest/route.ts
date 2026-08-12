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
import { fetchPathwayPdf, FetchPathwayError } from '@/lib/fetchPathway';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const url = typeof form?.get('url') === 'string' ? String(form.get('url')).trim() : '';

  let bytes: Uint8Array;
  let sourceName: string;
  let sourceUrl: string | null = null;

  if (url) {
    // Not everyone has the PDF to hand; most pathways are published on the web.
    try {
      const fetched = await fetchPathwayPdf(url);
      bytes = fetched.bytes;
      sourceName = fetched.filename;
      sourceUrl = fetched.sourceUrl;
    } catch (err) {
      const message = err instanceof FetchPathwayError ? err.message : (err as Error).message;
      return Response.json({ error: message }, { status: 422 });
    }
  } else if (file instanceof File) {
    bytes = new Uint8Array(await file.arrayBuffer());
    sourceName = file.name;
  } else {
    return Response.json(
      { error: 'Provide either a "file" upload or a "url" field.' },
      { status: 400 },
    );
  }

  const docId = toDocId(sourceUrl ?? sourceName);

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
  const options = { docId, sourceFile: sourceUrl ?? sourceName, fallbackTitle: sourceName };

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
    sourceUrl,
  });
}
