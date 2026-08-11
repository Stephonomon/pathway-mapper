import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReviewCanvas } from '@/components/ReviewCanvas';
import { readGraph } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const graph = await readGraph(docId).catch(() => null);
  if (!graph) notFound();

  return (
    <main className="min-h-screen">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-[var(--line)] bg-white px-4 py-3">
        <Link href="/" className="text-xs text-[var(--muted)] hover:underline">
          ← Pathways
        </Link>
        <h1 className="text-sm font-semibold">Review extraction · {graph.title}</h1>
        <Link
          href={`/p/${graph.docId}`}
          className="ml-auto rounded border border-[var(--line)] px-2 py-1 text-xs hover:bg-slate-50"
        >
          Open viewer
        </Link>
      </header>

      <ReviewCanvas graph={graph} />
    </main>
  );
}
