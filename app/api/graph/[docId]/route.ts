/** GET /api/graph/:docId — read the stored pathway graph. */

import { readGraph } from '@/lib/store';

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
