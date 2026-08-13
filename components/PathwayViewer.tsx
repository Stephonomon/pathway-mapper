'use client';

/**
 * The viewer: original document underneath, invisible layer on top, turn-by-turn
 * panel beside it.
 *
 * Route playback follows the shape a navigation app uses:
 *
 *   routing   steps stream in and light up on the full page — you watch the
 *             route get built, without the camera moving
 *   touring   the camera walks the turns one at a time, zoomed in
 *   overview  it pulls back to frame the entire path
 *
 * Any manual pan/zoom pauses the tour rather than fighting it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { pathwayExampleSchema, type PathwayGraph, type Rect, type Route, type RouteEvent, type RouteStep } from '@/lib/schema';
import { detectRuleset } from '@/lib/rules/registry';
import { OverlayLayer } from './OverlayLayer';
import { PdfCanvas } from './PdfCanvas';
import { HtmlPathwayStage } from './HtmlPathwayStage';
import { RoutePanel } from './RoutePanel';
import { RoutePlayback } from './RoutePlayback';
import { ViewportControls } from './ViewportControls';

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;
/** Zoom ceiling while touring — close enough to read, not so close it's lost. */
const TOUR_ZOOM = 2.6;
const NODE_PADDING = 52; // page units of breathing room around a focused node
const ROUTE_PADDING = 26;

/** How long the camera rests on each turn. */
const DWELL_MS = 2200;
const TOUR_EASE_MS = 850;
const OVERVIEW_EASE_MS = 1100;
const MANUAL_EASE_MS = 220;

type Phase = 'idle' | 'routing' | 'touring' | 'overview';

interface Viewport {
  tx: number;
  ty: number;
  z: number;
}

interface PathwayViewerProps {
  graph: PathwayGraph;
}

function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

export function PathwayViewer({ graph: stored }: PathwayViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);

  /**
   * HTML pathways are re-measured once rendered: the server's geometry came from
   * summing inline offsets, which is close but not exact. Everything downstream
   * — the overlay, pan/zoom, route framing — then works off real layout.
   */
  const [measured, setMeasured] = useState<{
    boxes: Map<string, Rect>;
    size: { width: number; height: number };
  } | null>(null);

  // Stable identity: a new function each render would restart the measurement
  // effect and loop.
  const handleMeasured = useCallback(
    (boxes: Map<string, Rect>, size: { width: number; height: number }) =>
      setMeasured({ boxes, size }),
    [],
  );

  const graph = useMemo(() => {
    if (stored.source.kind !== 'html' || !measured) return stored;
    return {
      ...stored,
      pages: [{ number: 1, width: measured.size.width, height: measured.size.height }],
      nodes: stored.nodes.map((n) => ({ ...n, bbox: measured.boxes.get(n.id) ?? n.bbox })),
      edges: stored.edges.map((e) => {
        // Redraw connectors between the measured boxes they actually join.
        const from = measured.boxes.get(e.from);
        const to = measured.boxes.get(e.to);
        if (!from || !to) return e;
        const a: [number, number] = [from.x + from.w / 2, from.y + from.h];
        const b: [number, number] = [to.x + to.w / 2, to.y];
        return { ...e, polyline: [a, b], arrowAt: b };
      }),
    };
  }, [stored, measured]);

  const page = graph.pages[0];

  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [steps, setSteps] = useState<RouteStep[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [answers, setAnswers] = useState<{ question: string; answer: string }[]>([]);
  const [clarify, setClarify] = useState<{ text: string; options: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [playing, setPlaying] = useState(false);
  const [fit, setFit] = useState(0);
  const [viewport, setViewport] = useState<Viewport>({ tx: 0, ty: 0, z: 1 });
  const [easeMs, setEaseMs] = useState(TOUR_EASE_MS);

  /**
   * Starter cases are generated per pathway at ingest. They were once a hardcoded
   * list, which put suicide-risk vignettes on an infant apnoea pathway.
   */
  const examples = useMemo(() => {
    if (graph.examples?.length) return graph.examples;
    // Back-compat: graphs ingested before this moved to a dedicated step kept the
    // starter cases inside the decision model.
    const legacy = z.object({ examples: z.array(pathwayExampleSchema) }).safeParse(graph.decisions);
    return legacy.success ? legacy.data.examples : [];
  }, [graph.examples, graph.decisions]);

  /**
   * Crisis resources belong on a pathway about suicide risk and nowhere else.
   * Showing 988 on a febrile-infant pathway misrepresents what the clinician is
   * looking at. Reuses the ruleset gate that keeps the C-SSRS rules scoped.
   */
  const isSuicideRiskPathway = useMemo(() => detectRuleset(graph) === 'cssrs', [graph]);

  const routeNodeIds = useMemo(() => steps.map((s) => s.nodeId), [steps]);
  const routeEdgeIds = useMemo(() => steps.slice(1).map((s) => s.edgeIdFromPrev ?? ''), [steps]);

  const routeBounds = useMemo(() => {
    const boxes = routeNodeIds
      .map((id) => graph.nodes.find((n) => n.id === id)?.bbox)
      .filter((b): b is Rect => Boolean(b));
    return unionRects(boxes);
  }, [routeNodeIds, graph.nodes]);

  // Fit the page to the stage width, and keep it fitted on resize.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !page) return;
    const observer = new ResizeObserver(() => setFit(stage.clientWidth / page.width));
    observer.observe(stage);
    setFit(stage.clientWidth / page.width);
    return () => observer.disconnect();
  }, [page]);

  /** Keep the page overlapping the stage no matter how far the user pans. */
  const clamp = useCallback(
    (v: Viewport): Viewport => {
      const stage = stageRef.current;
      if (!stage || !page || fit === 0) return v;
      const axis = (t: number, size: number, extent: number) =>
        extent <= size ? (size - extent) / 2 : Math.min(0, Math.max(size - extent, t));
      return {
        z: v.z,
        tx: axis(v.tx, stage.clientWidth, page.width * fit * v.z),
        ty: axis(v.ty, stage.clientHeight, page.height * fit * v.z),
      };
    },
    [fit, page],
  );

  /** Centre an area of the page, zoomed to fill the stage up to `maxZoom`. */
  const focusRect = useCallback(
    (rect: Rect, opts: { padding: number; maxZoom: number; ease: number }) => {
      const stage = stageRef.current;
      if (!stage || !page || fit === 0) return;

      const vw = stage.clientWidth;
      const vh = stage.clientHeight;
      const boxW = (rect.w + opts.padding * 2) * fit;
      const boxH = (rect.h + opts.padding * 2) * fit;
      const z = Math.max(MIN_ZOOM, Math.min(opts.maxZoom, Math.min(vw / boxW, vh / boxH)));
      const cx = (rect.x + rect.w / 2) * fit;
      const cy = (rect.y + rect.h / 2) * fit;

      setEaseMs(opts.ease);
      setViewport(clamp({ tx: vw / 2 - cx * z, ty: vh / 2 - cy * z, z }));
    },
    [clamp, fit, page],
  );

  const fitPage = useCallback(() => {
    if (!page) return;
    focusRect({ x: 0, y: 0, w: page.width, h: page.height }, { padding: 4, maxZoom: 1, ease: OVERVIEW_EASE_MS });
  }, [focusRect, page]);

  const fitRoute = useCallback(() => {
    if (!routeBounds) return fitPage();
    focusRect(routeBounds, { padding: ROUTE_PADDING, maxZoom: 1.6, ease: OVERVIEW_EASE_MS });
  }, [focusRect, fitPage, routeBounds]);

  const focusNode = useCallback(
    (nodeId: string, ease = TOUR_EASE_MS) => {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node) focusRect(node.bbox, { padding: NODE_PADDING, maxZoom: TOUR_ZOOM, ease });
    },
    [focusRect, graph.nodes],
  );

  /** Manual controls pause the tour — the user is driving now. */
  const takeManualControl = useCallback(() => {
    setPlaying(false);
    setPhase((p) => (p === 'routing' ? p : 'idle'));
  }, []);

  const pan = useCallback(
    (dx: number, dy: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      takeManualControl();
      setEaseMs(MANUAL_EASE_MS);
      setViewport((v) =>
        clamp({ ...v, tx: v.tx - dx * stage.clientWidth, ty: v.ty - dy * stage.clientHeight }),
      );
    },
    [clamp, takeManualControl],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      takeManualControl();
      setEaseMs(MANUAL_EASE_MS);
      setViewport((v) => {
        const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.z * factor));
        const scale = z / v.z;
        // Zoom about the centre of the stage so the focus point stays put.
        const cx = stage.clientWidth / 2;
        const cy = stage.clientHeight / 2;
        return clamp({ z, tx: cx - (cx - v.tx) * scale, ty: cy - (cy - v.ty) * scale });
      });
    },
    [clamp, takeManualControl],
  );

  // Frame the whole page once we know the stage size.
  useEffect(() => {
    if (fit > 0 && phase === 'idle' && steps.length === 0) fitPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit]);

  // The tour: rest on each turn, then advance; pull back to overview at the end.
  useEffect(() => {
    if (phase !== 'touring' || !playing) return;

    if (activeIndex >= steps.length - 1) {
      const timer = setTimeout(() => {
        setPhase('overview');
        setPlaying(false);
      }, DWELL_MS);
      return () => clearTimeout(timer);
    }

    const timer = setTimeout(() => setActiveIndex((i) => i + 1), DWELL_MS);
    return () => clearTimeout(timer);
  }, [phase, playing, activeIndex, steps.length]);

  // Camera follows the active turn, but only while touring — otherwise a manual
  // pan would be snatched back the moment this effect re-ran.
  useEffect(() => {
    if (phase !== 'touring') return;
    const nodeId = routeNodeIds[activeIndex];
    if (nodeId) focusNode(nodeId);
  }, [activeIndex, phase, routeNodeIds, focusNode]);

  useEffect(() => {
    if (phase === 'overview') fitRoute();
  }, [phase, fitRoute]);

  const selectStep = useCallback(
    (index: number) => {
      setPlaying(false);
      setPhase('touring');
      setActiveIndex(index);
    },
    [],
  );

  const startTour = useCallback(() => {
    if (steps.length === 0) return;
    setPhase('touring');
    setActiveIndex(0);
    setPlaying(true);
  }, [steps.length]);

  const ask = useCallback(
    async (text: string, currentAnswers: { question: string; answer: string }[]) => {
      setPending(true);
      setError(null);
      setClarify(null);
      setSteps([]);
      setRoute(null);
      setActiveIndex(0);
      setPlaying(false);
      setPhase('routing');
      fitPage();

      try {
        const response = await fetch('/api/route', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docId: graph.docId, question: text, answers: currentAnswers }),
        });
        if (!response.ok || !response.body) {
          throw new Error((await response.json().catch(() => null))?.error ?? 'routing failed');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let arrived = 0;

        // Newline-delimited JSON: each hop lands as the server decides it.
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line) continue;

            const event = JSON.parse(line) as RouteEvent;
            if (event.type === 'step') {
              arrived += 1;
              setSteps((prev) => [...prev, event.step]);
              setActiveIndex(arrived - 1);
            } else if (event.type === 'question') {
              setClarify(event.question);
            } else if (event.type === 'done') {
              setRoute(event.route);
            } else if (event.type === 'error') {
              setError(event.message);
            }
          }
        }

        // Route found — now walk the user through it.
        if (arrived > 1) {
          setPhase('touring');
          setActiveIndex(0);
          setPlaying(true);
        } else {
          setPhase('overview');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase('idle');
      } finally {
        setPending(false);
      }
    },
    [graph.docId, fitPage],
  );

  const submitAnswer = useCallback(
    (answer: string) => {
      if (!clarify) return;
      const next = [...answers, { question: clarify.text, answer }];
      setAnswers(next);
      void ask(question, next);
    },
    [answers, ask, clarify, question],
  );

  if (!page) return <p className="p-6">This document has no pages.</p>;

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAnswers([]);
            void ask(question, []);
          }}
          className="flex gap-2"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={
              examples[0]
                ? `Describe the patient, e.g. “${examples[0].text.slice(0, 90)}…”`
                : 'Describe the patient and the question in plain language'
            }
            className="field min-w-0 flex-1"
          />
          <button
            type="submit"
            disabled={pending || question.trim().length === 0}
            className="btn-primary shrink-0"
          >
            {pending ? 'Routing…' : 'Route'}
          </button>
        </form>

        {examples.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="eyebrow mr-0.5">Try</span>
          {examples.map((sample) => (
            <button
              key={sample.label}
              type="button"
              title={`${sample.hint}\n\n${sample.text}`}
              disabled={pending}
              onClick={() => {
                setQuestion(sample.text);
                setAnswers([]);
                void ask(sample.text, []);
              }}
              className="rounded-full border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1 text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-weak)] hover:text-[var(--accent-ink)] disabled:opacity-40"
            >
              {sample.label}
            </button>
          ))}
        </div>
        )}

        <div
          ref={stageRef}
          className="relative h-[74vh] overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow-xs)]"
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.z})`,
              transition: `transform ${easeMs}ms cubic-bezier(0.33, 1, 0.68, 1)`,
              width: page.width * fit,
              height: page.height * fit,
            }}
          >
            {graph.source.kind === 'html' ? (
              // The institution's own markup, put back on screen at page scale.
              <div
                style={{
                  width: page.width,
                  height: page.height,
                  transform: `scale(${fit})`,
                  transformOrigin: 'top left',
                }}
              >
                <HtmlPathwayStage graph={stored} onMeasured={handleMeasured} />
              </div>
            ) : (
              <PdfCanvas
                src={`/api/source/${graph.docId}`}
                pageNumber={page.number}
                width={page.width * fit}
                height={page.height * fit}
                onError={setError}
              />
            )}
            <OverlayLayer
              graph={graph}
              pageNumber={page.number}
              routeNodeIds={routeNodeIds}
              routeEdgeIds={routeEdgeIds}
              activeIndex={activeIndex}
              onSelectNode={(id) => {
                const index = routeNodeIds.indexOf(id);
                if (index >= 0) selectStep(index);
                else {
                  takeManualControl();
                  focusNode(id, MANUAL_EASE_MS);
                }
              }}
            />
          </div>

          <RoutePlayback
            stepCount={steps.length}
            activeIndex={activeIndex}
            playing={playing}
            phase={phase}
            onPlayPause={() => {
              if (phase !== 'touring') setPhase('touring');
              setPlaying((p) => !p);
            }}
            onPrev={() => selectStep(Math.max(0, activeIndex - 1))}
            onNext={() => selectStep(Math.min(steps.length - 1, activeIndex + 1))}
            onReplay={startTour}
          />

          <ViewportControls
            onPan={pan}
            onZoom={zoomBy}
            onFitPage={() => {
              takeManualControl();
              fitPage();
            }}
            onFitRoute={() => {
              setPlaying(false);
              setPhase('overview');
              // Also apply directly: if we are already in 'overview' the effect
              // below would not re-fire, and the button would silently do nothing.
              fitRoute();
            }}
            hasRoute={steps.length > 0}
            zoom={viewport.z}
          />
        </div>
      </section>

      <aside className="space-y-3">
        {error && (
          <p className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">{error}</p>
        )}

        {/* A clinician should know when they are routing through a reading of the
            document that nobody has checked, and what the extractor was unsure of. */}
        {(
          <details className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
            <summary className="cursor-pointer font-medium">
              How this pathway was read
              {graph.warnings.length > 0 &&
                ` · ${graph.warnings.length} note${graph.warnings.length === 1 ? '' : 's'}`}
            </summary>
            <p className="mt-2">
              Every step below is drawn from the document, but the boxes and arrows were
              detected automatically. Check each step against the page before acting on it.
            </p>
            {graph.warnings.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {graph.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </details>
        )}

        {clarify && (
          <div className="rounded-[var(--r)] border border-[var(--accent)] bg-[var(--panel)] p-3 shadow-[var(--shadow-sm)] ring-1 ring-[var(--accent-weak)]">
            <p className="text-sm font-medium">{clarify.text}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {clarify.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => submitAnswer(option)}
                  className="btn-ghost"
                >
                  {option}
                </button>
              ))}
            </div>
            <p className="mt-2.5 text-[11px] text-[var(--muted)]">
              The pathway needs this before it can place the patient. Answering resumes the route.
            </p>
          </div>
        )}

        <RoutePanel
          graph={graph}
          steps={steps}
          activeIndex={activeIndex}
          route={route}
          onSelect={selectStep}
        />

        <SafetyFooter showCrisisResources={isSuicideRiskPathway} />
      </aside>
    </div>
  );
}

function SafetyFooter({ showCrisisResources }: { showCrisisResources: boolean }) {
  return (
    <div className="card space-y-2 p-3 text-[11px] leading-snug text-[var(--muted)]">
      <p>
        <strong className="text-[var(--ink)]">Decision support, not triage.</strong> This tool
        navigates an approved clinical pathway document. It does not provide medical advice and does
        not replace clinical judgement. Verify every step against the document itself.
      </p>
      <p>
        Questions are not stored. Only the pathway version and the node sequence are recorded for
        audit.
      </p>
      {showCrisisResources && (
        <p className="text-[var(--ink)]">
          Crisis resources: <strong>988</strong> Suicide &amp; Crisis Lifeline · Crisis Text Line: text{' '}
          <strong>HOME</strong> to <strong>741741</strong>
        </p>
      )}
    </div>
  );
}
