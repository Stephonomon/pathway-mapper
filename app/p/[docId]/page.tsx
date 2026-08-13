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
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-[var(--line)] bg-white/85 px-5 py-3 backdrop-blur-sm">
        <Link
          href="/"
          className="text-xs font-medium text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
        >
          ← Pathways
        </Link>
        <span className="h-3.5 w-px bg-[var(--line-strong)]" aria-hidden />
        <h1 className="text-sm font-semibold">{graph.title}</h1>
        <span className="ml-auto font-[family-name:var(--font-mono)] text-xs text-[var(--faint)]">
          {graph.nodes.length} steps · read automatically
        </span>
      </header>

      <PathwayViewer graph={graph} />
    </main>
  );
}
