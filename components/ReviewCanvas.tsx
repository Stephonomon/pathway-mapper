'use client';

/**
 * Where extraction gets a human signature.
 *
 * Same overlay component as the viewer, in inspect mode: every extracted node is
 * outlined, clicking one opens its label/kind/routable fields, and edges can be
 * relabelled or deleted. Saving bumps the graph version and stamps a reviewer, so
 * a route can always be traced back to a specific reviewed artifact.
 */

import { useMemo, useRef, useState } from 'react';
import type { PathwayGraph, NodeKind } from '@/lib/schema';
import { OverlayLayer } from './OverlayLayer';
import { PdfCanvas } from './PdfCanvas';

const NODE_KINDS: NodeKind[] = [
  'start',
  'decision',
  'action',
  'branch',
  'terminal',
  'reference',
  'note',
];

export function ReviewCanvas({ graph: initial }: { graph: PathwayGraph }) {
  const [graph, setGraph] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const page = graph.pages[0];
  const selected = useMemo(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );
  const incident = useMemo(
    () => graph.edges.filter((e) => e.from === selectedId || e.to === selectedId),
    [graph.edges, selectedId],
  );

  const updateNode = (id: string, patch: Partial<PathwayGraph['nodes'][number]>) =>
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));

  const updateEdge = (id: string, patch: Partial<PathwayGraph['edges'][number]>) =>
    setGraph((g) => ({ ...g, edges: g.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));

  const deleteEdge = (id: string) =>
    setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }));

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`/api/graph/${graph.docId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...graph, reviewedBy: reviewer.trim() || 'unattributed' }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? 'save failed');
      setGraph(json as PathwayGraph);
      setSaved(`Saved as v${(json as PathwayGraph).version}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!page) return <p className="p-6">This document has no pages.</p>;

  const unlabeled = graph.nodes.filter((n) => n.confidence < 0.5).length;
  const lowConfidenceEdges = graph.edges.filter((e) => e.confidence < 0.5);

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div
        ref={stageRef}
        className="relative h-[80vh] overflow-auto rounded-lg border border-[var(--line)] bg-white"
      >
        <div className="relative" style={{ width: page.width * 1.4, height: page.height * 1.4 }}>
          <PdfCanvas
            src={`/api/source/${graph.docId}`}
            pageNumber={page.number}
            width={page.width * 1.4}
            height={page.height * 1.4}
            onError={setError}
          />
          <OverlayLayer
            graph={graph}
            pageNumber={page.number}
            routeNodeIds={selectedId ? [selectedId] : []}
            routeEdgeIds={[]}
            activeIndex={0}
            dim={0.45}
            showAllNodes
            onSelectNode={setSelectedId}
          />
        </div>
      </div>

      <aside className="space-y-3">
        <div className="rounded-lg border border-[var(--line)] bg-white p-3 text-xs">
          <p className="font-semibold text-sm">{graph.title}</p>
          <p className="mt-1 text-[var(--muted)]">
            {graph.nodes.length} nodes · {graph.edges.length} edges · v{graph.version}
            {graph.reviewedBy ? ` · reviewed by ${graph.reviewedBy}` : ' · never reviewed'}
          </p>
          <p className="mt-1 text-[var(--muted)]">
            Entry: {graph.entryNodeIds.join(', ') || 'none set'}
          </p>
          {unlabeled > 0 && (
            <p className="mt-1 text-amber-800">{unlabeled} nodes have low labeling confidence.</p>
          )}
        </div>

        {graph.warnings.length > 0 && (
          <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            {graph.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}

        {lowConfidenceEdges.length > 0 && (
          <div className="rounded-lg border border-[var(--line)] bg-white p-3 text-xs">
            <p className="font-semibold">Edges needing a look</p>
            <ul className="mt-1 space-y-1">
              {lowConfidenceEdges.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2">
                  <span>
                    {e.from} → {e.to}{' '}
                    <span className="text-[var(--muted)]">({e.provenance})</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteEdge(e.id)}
                    className="rounded border border-rose-200 px-1.5 py-0.5 text-[10px] text-rose-700"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {selected ? (
          <div className="space-y-2 rounded-lg border border-[var(--accent)] bg-white p-3 text-xs">
            <p className="font-semibold text-sm">{selected.id}</p>

            <label className="block">
              <span className="text-[var(--muted)]">Label</span>
              <input
                value={selected.label}
                onChange={(e) => updateNode(selected.id, { label: e.target.value })}
                className="mt-0.5 w-full rounded border border-[var(--line)] px-2 py-1"
              />
            </label>

            <label className="block">
              <span className="text-[var(--muted)]">Kind</span>
              <select
                value={selected.kind}
                onChange={(e) => updateNode(selected.id, { kind: e.target.value as NodeKind })}
                className="mt-0.5 w-full rounded border border-[var(--line)] px-2 py-1"
              >
                {NODE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selected.routable}
                onChange={(e) => updateNode(selected.id, { routable: e.target.checked })}
              />
              <span>Routable — a clinician can land on this step</span>
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={graph.entryNodeIds.includes(selected.id)}
                onChange={(e) =>
                  setGraph((g) => ({
                    ...g,
                    entryNodeIds: e.target.checked
                      ? [...new Set([...g.entryNodeIds, selected.id])]
                      : g.entryNodeIds.filter((id) => id !== selected.id),
                  }))
                }
              />
              <span>Entry point</span>
            </label>

            <div>
              <span className="text-[var(--muted)]">Text from the document</span>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[var(--line)] bg-slate-50 p-2 font-sans text-[11px]">
                {selected.text || '(no text)'}
              </pre>
            </div>

            {incident.length > 0 && (
              <div className="space-y-1">
                <span className="text-[var(--muted)]">Edges and criteria for proceeding</span>
                {incident.map((edge) => (
                  <div key={edge.id} className="rounded border border-[var(--line)] p-1.5">
                    <p className="font-medium">
                      {edge.from} → {edge.to}{' '}
                      <span className="text-[var(--muted)]">({edge.provenance})</span>
                    </p>
                    <input
                      value={edge.label ?? ''}
                      placeholder="branch label"
                      onChange={(e) => updateEdge(edge.id, { label: e.target.value || null })}
                      className="mt-1 w-full rounded border border-[var(--line)] px-1.5 py-0.5"
                    />
                    <input
                      value={edge.condition ?? ''}
                      placeholder="criteria for proceeding"
                      onChange={(e) => updateEdge(edge.id, { condition: e.target.value || null })}
                      className="mt-1 w-full rounded border border-[var(--line)] px-1.5 py-0.5"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="rounded-lg border border-[var(--line)] bg-white p-3 text-xs text-[var(--muted)]">
            Click any outlined box on the document to inspect and correct it.
          </p>
        )}

        <div className="space-y-2 rounded-lg border border-[var(--line)] bg-white p-3">
          <input
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            placeholder="Your name (recorded with this version)"
            className="w-full rounded border border-[var(--line)] px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Sign off and save'}
          </button>
          {saved && <p className="text-xs text-emerald-700">{saved}</p>}
          {error && <p className="text-xs text-rose-700">{error}</p>}
        </div>
      </aside>
    </div>
  );
}
