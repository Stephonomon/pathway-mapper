/**
 * POST /api/ingest — add a pathway, from a URL or an uploaded file.
 *
 * The reading itself lives in `lib/ingest.ts`, shared with the CLI so both
 * routes produce identical graphs.
 */

import { toDocId } from '@/lib/store';
import { fetchPathwayDocument, FetchPathwayError } from '@/lib/fetchPathway';
import { ingestDocument, type IngestInput } from '@/lib/ingest';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const url = typeof form?.get('url') === 'string' ? String(form.get('url')).trim() : '';

  let payload: IngestInput;
  let sourceUrl: string | null = null;

  if (url) {
    // Most pathways are published on the web; asking someone to download a PDF
    // just to hand it back is friction for no reason.
    try {
      const fetched = await fetchPathwayDocument(url);
      sourceUrl = fetched.sourceUrl;
      payload =
        fetched.kind === 'pdf'
          ? { kind: 'pdf', bytes: fetched.bytes, filename: fetched.filename, url: fetched.sourceUrl }
          : { kind: 'html', html: fetched.html, url: fetched.sourceUrl, filename: fetched.filename };
    } catch (err) {
      const message = err instanceof FetchPathwayError ? err.message : (err as Error).message;
      return Response.json({ error: message }, { status: 422 });
    }
  } else if (file instanceof File) {
    payload = {
      kind: 'pdf',
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
    };
  } else {
    return Response.json({ error: 'Provide either a "file" upload or a "url" field.' }, { status: 400 });
  }

  const docId = toDocId(sourceUrl ?? payload.filename);

  try {
    const { graph, labeled } = await ingestDocument(payload, { docId });
    return Response.json({
      docId: graph.docId,
      title: graph.title,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      warnings: graph.warnings,
      labeled,
      sourceUrl,
      kind: graph.source.kind,
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 422 });
  }
}
