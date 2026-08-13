import Link from 'next/link';
import { listDocs } from '@/lib/store';
import { UploadForm } from '@/components/UploadForm';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const docs = await listDocs();

  return (
    <main className="mx-auto max-w-2xl space-y-12 px-6 py-16">
      <header className="space-y-3">
        <p className="eyebrow">Clinical pathway navigation</p>
        <h1 className="text-[2rem] font-semibold leading-tight">Pathway Mapper</h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-[var(--muted)]">
          Ask a question in plain language and get turn-by-turn directions through a clinical
          pathway, drawn on the pathway document itself.
        </p>
      </header>

      <section className="space-y-4">
        <h2 className="eyebrow">Pathways</h2>
        {docs.length === 0 ? (
          <p className="card p-5 text-sm text-[var(--muted)]">
            Nothing ingested yet. Add a pathway below.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow-xs)]">
            {docs.map((doc) => (
              <li key={doc.docId}>
                <Link
                  href={`/p/${doc.docId}`}
                  className="group flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-[var(--surface)]"
                >
                  <div className="min-w-0">
                    <span className="block truncate text-[15px] font-medium">{doc.title}</span>
                    <span className="mt-0.5 block truncate font-[family-name:var(--font-mono)] text-xs text-[var(--faint)]">
                      {doc.docId} · v{doc.version}
                    </span>
                  </div>
                  <span
                    aria-hidden
                    className="shrink-0 translate-x-0 text-[var(--faint)] transition-all group-hover:translate-x-0.5 group-hover:text-[var(--accent)]"
                  >
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="eyebrow">Add a pathway</h2>
        <UploadForm />
        <p className="text-xs text-[var(--faint)]">
          Vector PDFs only for now. Scanned pathways need an OCR/layout pass that is not built yet.
        </p>
      </section>
    </main>
  );
}
