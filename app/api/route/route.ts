/**
 * POST /api/route — walk the pathway for a free-text question.
 *
 * Streams newline-delimited JSON `RouteEvent`s so the overlay can light each node
 * as the decision is made rather than after the whole route resolves.
 */

import { createHash } from 'node:crypto';
import { traverse } from '@/lib/llm/traverse';
import { appendAudit, readGraph } from '@/lib/store';
import type { RouteEvent } from '@/lib/schema';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface RouteRequestBody {
  docId?: string;
  question?: string;
  answers?: { question: string; answer: string }[];
}

export async function POST(request: Request) {
  let body: RouteRequestBody;
  try {
    body = (await request.json()) as RouteRequestBody;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { docId, question, answers = [] } = body;
  if (!docId || !question?.trim()) {
    return Response.json({ error: 'docId and question are required' }, { status: 400 });
  }

  const graph = await readGraph(docId);
  if (!graph) {
    return Response.json({ error: `no graph for "${docId}" — ingest it first` }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RouteEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const route = await traverse({ graph, question, answers, onEvent: send });

        // Audit the decision trail, not the question text — a free-text clinical
        // description is potentially PHI.
        await appendAudit(docId, {
          questionHash: createHash('sha256').update(question).digest('hex').slice(0, 16),
          graphVersion: graph.version,
          nodeIds: route.steps.map((s) => s.nodeId),
          status: route.status,
          at: new Date().toISOString(),
        });
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
