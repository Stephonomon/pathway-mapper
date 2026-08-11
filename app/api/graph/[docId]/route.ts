/**
 * GET  /api/graph/:docId — read the stored pathway graph.
 * PUT  /api/graph/:docId — save a reviewed graph (bumps version, stamps reviewer).
 */

import { pathwayGraphSchema } from '@/lib/schema';
import { readGraph, writeGraph } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  try {
    const graph = await readGraph(docId);
    if (!graph) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(graph);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const existing = await readGraph(docId);
  if (!existing) return Response.json({ error: 'not found' }, { status: 404 });

  const parsed = pathwayGraphSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: 'invalid graph', issues: parsed.error.issues }, { status: 400 });
  }
  if (parsed.data.docId !== docId) {
    return Response.json({ error: 'docId mismatch' }, { status: 400 });
  }

  // A review is a new version of the artifact, and it is signed.
  const saved = await writeGraph({
    ...parsed.data,
    version: existing.version + 1,
    reviewedAt: new Date().toISOString(),
    reviewedBy: parsed.data.reviewedBy ?? 'unattributed',
  });
  return Response.json(saved);
}
