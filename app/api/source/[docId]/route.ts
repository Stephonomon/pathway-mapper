/** GET /api/source/:docId — serve the original PDF to the viewer, unmodified. */

import { readSource } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  try {
    const bytes = await readSource(docId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/pdf',
        'cache-control': 'private, max-age=3600',
      },
    });
  } catch {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}
