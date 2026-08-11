import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PathwayViewer } from '@/components/PathwayViewer';
import { readGraph } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function ViewerPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  const graph = await readGraph(docId).catch(() => null);
  if (!graph) notFound();

  return (
    <main className="min-h-screen">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-[var(--line)] bg-white px-4 py-3">
        <Link href="/" className="text-xs text-[var(--muted)] hover:underline">
          ← Pathways
        </Link>
        <h1 className="text-sm font-semibold">{graph.title}</h1>
        {!graph.reviewedAt && (
          <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
            extraction unreviewed
          </span>
        )}
        <Link
          href={`/review/${graph.docId}`}
          className="ml-auto rounded border border-[var(--line)] px-2 py-1 text-xs hover:bg-slate-50"
        >
          Review extraction
        </Link>
      </header>

      <PathwayViewer graph={graph} />
    </main>
  );
}
