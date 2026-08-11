'use client';

/**
 * Turn-by-turn directions. One row per hop: where you are, why the pathway sent
 * you there, and the document's own words for it.
 */

import type { PathwayGraph, Route, RouteStep } from '@/lib/schema';

const ACUITY_STYLES: Record<string, string> = {
  low: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  intermediate: 'bg-amber-50 text-amber-800 border-amber-200',
  high: 'bg-rose-50 text-rose-800 border-rose-200',
};

interface RoutePanelProps {
  graph: PathwayGraph;
  steps: RouteStep[];
  activeIndex: number;
  route: Route | null;
  onSelect: (index: number) => void;
}

export function RoutePanel({ graph, steps, activeIndex, route, onSelect }: RoutePanelProps) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [e.id, e]));

  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--line)] bg-white p-4 text-sm text-[var(--muted)]">
        Describe the patient above and the pathway will be traced step by step on the document.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold">Route</h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onSelect(Math.max(0, activeIndex - 1))}
            disabled={activeIndex <= 0}
            className="rounded border border-[var(--line)] px-2 py-1 text-xs disabled:opacity-40"
          >
            ← Prev
          </button>
          <button
            type="button"
            onClick={() => onSelect(Math.min(steps.length - 1, activeIndex + 1))}
            disabled={activeIndex >= steps.length - 1}
            className="rounded border border-[var(--line)] px-2 py-1 text-xs disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      </div>

      <ol className="space-y-2">
        {steps.map((step, i) => {
          const node = nodes.get(step.nodeId);
          const edge = step.edgeIdFromPrev ? edges.get(step.edgeIdFromPrev) : null;
          const isActive = i === activeIndex;
          return (
            <li key={`${step.nodeId}-${i}`}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  isActive
                    ? 'border-[var(--accent)] bg-white shadow-sm'
                    : 'border-[var(--line)] bg-white/60 hover:bg-white'
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-white">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{node?.label ?? step.nodeId}</span>
                      {node?.acuity && (
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${ACUITY_STYLES[node.acuity]}`}
                        >
                          {node.acuity}
                        </span>
                      )}
                      {step.ruleForced && (
                        <span className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                          pathway criteria
                        </span>
                      )}
                    </div>

                    {edge?.label && (
                      <div className="mt-1 text-xs text-[var(--muted)]">
                        via <span className="font-medium">{edge.label}</span>
                      </div>
                    )}

                    <p className="mt-1 text-xs text-[var(--muted)]">{step.rationale}</p>

                    {isActive && node?.text && (
                      <pre className="mt-2 whitespace-pre-wrap border-l-2 border-[var(--line)] pl-2 font-sans text-[11px] leading-snug text-[var(--ink)]">
                        {node.text}
                      </pre>
                    )}

                    {isActive && node && node.links.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {node.links.map((link) => (
                          <a
                            key={link.url}
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-[var(--accent)] hover:bg-slate-50"
                          >
                            {link.text || 'reference'} ↗
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ol>

      {route?.notes?.map((note) => (
        <p
          key={note}
          className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
        >
          {note}
        </p>
      ))}
    </div>
  );
}
