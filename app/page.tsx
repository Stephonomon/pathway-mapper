import Link from 'next/link';
import { listDocs } from '@/lib/store';
import { UploadForm } from '@/components/UploadForm';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const docs = await listDocs();

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Pathway Mapper</h1>
        <p className="text-sm text-[var(--muted)]">
          Ask a question in plain language and get turn-by-turn directions through a clinical
          pathway, drawn on the pathway document itself.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Pathways</h2>
        {docs.length === 0 ? (
          <p className="rounded-lg border border-[var(--line)] bg-white p-4 text-sm text-[var(--muted)]">
            Nothing ingested yet. Upload a pathway PDF below.
          </p>
        ) : (
          <ul className="space-y-2">
            {docs.map((doc) => (
              <li
                key={doc.docId}
                className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-white p-3"
              >
                <div className="min-w-0">
                  <Link href={`/p/${doc.docId}`} className="text-sm font-medium hover:underline">
                    {doc.title}
                  </Link>
                  <p className="truncate text-xs text-[var(--muted)]">
                    {doc.docId} · v{doc.version}
                  </p>
                </div>
                <Link
                  href={`/review/${doc.docId}`}
                  className="shrink-0 rounded border border-[var(--line)] px-2 py-1 text-xs hover:bg-slate-50"
                >
                  Review extraction
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Add a pathway</h2>
        <UploadForm />
        <p className="text-xs text-[var(--muted)]">
          Vector PDFs only for now. Scanned pathways need an OCR/layout pass that is not built yet.
        </p>
      </section>
    </main>
  );
}
