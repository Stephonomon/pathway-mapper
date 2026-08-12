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
        <span className="ml-auto text-xs text-[var(--muted)]">
          {graph.nodes.length} steps · read automatically from the document
        </span>
      </header>

      <PathwayViewer graph={graph} />
    </main>
  );
}
