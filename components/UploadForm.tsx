'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface IngestResult {
  docId: string;
  title: string;
  nodes: number;
  edges: number;
  warnings: string[];
  labeled: boolean;
}

export function UploadForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          if (!(data.get('file') as File)?.size) return;

          setBusy(true);
          setError(null);
          setResult(null);
          try {
            const response = await fetch('/api/ingest', { method: 'POST', body: data });
            const json = await response.json();
            if (!response.ok) throw new Error(json.error ?? 'ingest failed');
            setResult(json as IngestResult);
            router.refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          type="file"
          name="file"
          accept="application/pdf"
          required
          className="text-sm file:mr-3 file:rounded file:border file:border-[var(--line)] file:bg-white file:px-3 file:py-1.5 file:text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Extracting…' : 'Ingest'}
        </button>
      </form>

      {error && (
        <p className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">{error}</p>
      )}

      {result && (
        <div className="rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          <p>
            <strong>{result.title}</strong>: {result.nodes} nodes, {result.edges} edges
            {result.labeled ? '' : ' (geometry only — labeling did not run)'}
          </p>
          {result.warnings.map((w) => (
            <p key={w} className="mt-1 text-amber-900">
              {w}
            </p>
          ))}
          <p className="mt-1">
            Review the extraction before routing anyone through it.
          </p>
        </div>
      )}
    </div>
  );
}
