'use client';

/**
 * Two ways in: a URL, or a file.
 *
 * URL is offered first because most pathways are published on the web and asking
 * someone to download a PDF just to hand it back is friction for no reason. A
 * landing page works as well as a direct PDF link — the server looks for the
 * pathway PDF on the page.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface IngestResult {
  docId: string;
  title: string;
  nodes: number;
  edges: number;
  warnings: string[];
  labeled: boolean;
  sourceUrl: string | null;
}

type Mode = 'url' | 'file';

export function UploadForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('url');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (data: FormData) => {
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
  };

  const tab = (value: Mode, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setMode(value)}
      className={`-mb-px border-b-2 px-1 pb-2 text-xs font-medium transition-colors ${
        mode === value
          ? 'border-[var(--accent)] text-[var(--ink)]'
          : 'border-transparent text-[var(--muted)] hover:text-[var(--ink)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-5 border-b border-[var(--line)]">
        {tab('url', 'From a link')}
        {tab('file', 'From a file')}
      </div>

      {mode === 'url' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!url.trim()) return;
            const data = new FormData();
            data.set('url', url.trim());
            void submit(data);
          }}
          className="space-y-2"
        >
          <div className="flex flex-wrap gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.example.org/clinical-pathway/…"
              required
              className="field min-w-0 flex-1"
            />
            <button type="submit" disabled={busy} className="btn-primary shrink-0">
              {busy ? 'Reading…' : 'Read pathway'}
            </button>
          </div>
          <p className="text-xs text-[var(--faint)]">
            Paste a link to the pathway PDF, or to the page it sits on — the PDF will be found
            for you.
          </p>
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            if (!(data.get('file') as File)?.size) return;
            void submit(data);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            type="file"
            name="file"
            accept="application/pdf"
            required
            className="flex-1 text-sm text-[var(--muted)] file:mr-3 file:rounded-[var(--r-sm)] file:border file:border-[var(--line-strong)] file:bg-[var(--panel)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--ink)] hover:file:bg-[var(--surface)]"
          />
          <button type="submit" disabled={busy} className="btn-primary shrink-0">
            {busy ? 'Reading…' : 'Read pathway'}
          </button>
        </form>
      )}

      {busy && (
        <p className="text-xs text-[var(--muted)]">
          Reading the document, then working out what each decision depends on. Around a minute.
        </p>
      )}

      {error && (
        <p className="rounded-[var(--r)] border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
          {error}
        </p>
      )}

      {result && (
        <div className="rounded-[var(--r)] border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
          <p>
            <strong>{result.title}</strong>: {result.nodes} steps, {result.edges} connections
            {result.labeled ? '' : ' (geometry only — labeling did not run)'}
          </p>
          {result.warnings.length > 0 && (
            <p className="mt-1 text-amber-900">
              {result.warnings.length} note{result.warnings.length === 1 ? '' : 's'} about how it was
              read — shown on the pathway.
            </p>
          )}
          <a href={`/p/${result.docId}`} className="mt-1 inline-block font-medium underline">
            Open it →
          </a>
        </div>
      )}
    </div>
  );
}
