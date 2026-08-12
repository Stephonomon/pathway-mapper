'use client';

/**
 * Renders a pathway that was published as HTML rather than PDF.
 *
 * The institution's own (sanitised) markup is put back on screen, so the
 * document remains the interface exactly as it does for a PDF. Two jobs beyond
 * rendering:
 *
 *  1. **Re-measure.** Ingest computed node boxes by summing inline offsets,
 *     which is close but not exact. Here the real layout exists, so every node
 *     tagged `data-pathway-node` is measured and the graph's geometry replaced.
 *     Nothing on screen depends on the server's approximation.
 *  2. **Contain.** Third-party CSS should not leak into the app, and app styles
 *     should not restyle the pathway. The markup goes in a shadow root with the
 *     minimum styling needed to draw boxes and arrows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PathwayGraph, Rect } from '@/lib/schema';

/**
 * Enough CSS to render CHOP-style pathway markup. Their own stylesheet is not
 * fetched — pulling a third party's CSS into our origin invites more than it
 * solves — so the handful of classes their boxes and arrows use are restated.
 */
const PATHWAY_CSS = `
  :host { all: initial; }
  .stage { position: relative; font-family: Arial, Helvetica, sans-serif; font-size: 10px;
           line-height: 1.3; color: #222; background: #fff; }
  .stage a { color: #1f6feb; text-decoration: none; }
  /* The source stylesheet is not fetched, so text can run longer here than the
     author intended. Clip inside the box rather than letting neighbouring steps
     overlap into an unreadable pile. */
  .outline, .nooutline, .goalsoutline {
    box-sizing: border-box; padding: 3px 5px; background: #fff; overflow: hidden; }
  .outline { border: 1px solid #7f9fb5; border-radius: 2px; }
  .goalsoutline { border: 1px solid #bcd; border-radius: 2px; }
  .outline.nonurgent { border-color: #4aa64a; }
  .outline.urgent    { border-color: #cfc45f; }
  .outline.critical  { border-color: #d98b80; }
  .arrow-line__vertical--solid { border-left: 2px solid #999; }
  .arrow-line__horizontal--solid { border-top: 2px solid #999; }
  .arrow-head__down, .arrow-head__up, .arrow-head__left, .arrow-head__right {
    width: 0; height: 0; border: 5px solid transparent; }
  .arrow-head__down  { border-top-color: #999; }
  .arrow-head__up    { border-bottom-color: #999; }
  .arrow-head__left  { border-right-color: #999; }
  .arrow-head__right { border-left-color: #999; }
  h1 { font-size: 15px; font-weight: 600; margin: 0; }
  ul { margin: 2px 0 2px 14px; padding: 0; }
`;

interface HtmlPathwayStageProps {
  graph: PathwayGraph;
  /** Called with measured geometry so the overlay lines up with what rendered. */
  onMeasured: (boxes: Map<string, Rect>, size: { width: number; height: number }) => void;
}

export function HtmlPathwayStage({ graph, onMeasured }: HtmlPathwayStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Measuring triggers a re-render, which triggers the ResizeObserver, which
   * would measure again — so only report a genuinely different result. Without
   * this the component loops until React gives up.
   */
  const lastReported = useRef<string>('');

  const measure = useCallback(
    (root: ShadowRoot) => {
      const stage = root.querySelector('.stage') as HTMLElement | null;
      if (!stage) return;

      const origin = stage.getBoundingClientRect();
      // getBoundingClientRect reports post-transform pixels, and the viewer
      // scales this stage to fit. Divide that back out so measurements are in
      // the same unscaled page units the overlay's viewBox uses — otherwise
      // every box is scaled twice and the halos drift off the document.
      const scale = stage.offsetWidth > 0 ? origin.width / stage.offsetWidth : 1;
      const unscale = scale > 0.01 ? 1 / scale : 1;

      const boxes = new Map<string, Rect>();
      for (const el of root.querySelectorAll('[data-pathway-node]')) {
        const id = el.getAttribute('data-pathway-node');
        if (!id) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const next: Rect = {
          x: (r.left - origin.left) * unscale,
          y: (r.top - origin.top) * unscale,
          w: r.width * unscale,
          h: r.height * unscale,
        };
        // A node may span several elements (title bar plus body); union them.
        const prev = boxes.get(id);
        boxes.set(
          id,
          prev
            ? {
                x: Math.min(prev.x, next.x),
                y: Math.min(prev.y, next.y),
                w: Math.max(prev.x + prev.w, next.x + next.w) - Math.min(prev.x, next.x),
                h: Math.max(prev.y + prev.h, next.y + next.h) - Math.min(prev.y, next.y),
              }
            : next,
        );
      }

      // scrollWidth/Height are layout values, already unscaled.
      const size = {
        width: Math.max(stage.scrollWidth, origin.width * unscale),
        height: Math.max(stage.scrollHeight, origin.height * unscale),
      };

      // Round before comparing: sub-pixel jitter is not a change worth acting on.
      const signature = JSON.stringify([
        Math.round(size.width),
        Math.round(size.height),
        [...boxes.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([id, r]) => [id, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]),
      ]);
      if (signature === lastReported.current) return;
      lastReported.current = signature;

      onMeasured(boxes, size);
    },
    [onMeasured],
  );

  useEffect(() => {
    const host = hostRef.current;
    const html = graph.source.html;
    if (!host || !html) return;

    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    root.innerHTML = '';

    const style = document.createElement('style');
    style.textContent = PATHWAY_CSS;
    root.append(style);

    const stage = document.createElement('div');
    stage.className = 'stage';
    // Already sanitised at ingest: no scripts, no handlers, no frames.
    stage.innerHTML = html;
    root.append(stage);

    // The source page centres its canvas, so some boxes sit at negative offsets.
    // Detached from that layout they would be clipped, so shift everything into
    // view once and measure from there.
    requestAnimationFrame(() => {
      const origin = stage.getBoundingClientRect();
      let minX = 0;
      let minY = 0;
      for (const el of stage.querySelectorAll('*')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        minX = Math.min(minX, r.left - origin.left);
        minY = Math.min(minY, r.top - origin.top);
      }
      if (minX < 0 || minY < 0) {
        stage.style.paddingLeft = `${Math.ceil(-minX)}px`;
        stage.style.paddingTop = `${Math.ceil(-minY)}px`;
      }
      measure(root);
    });

    // Measure after layout settles, and again if fonts or images shift it.
    const run = () => measure(root);
    const raf = requestAnimationFrame(run);
    const observer = new ResizeObserver(run);
    observer.observe(host);

    try {
      void document.fonts?.ready.then(run);
    } catch {
      setError(null);
    }

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [graph.source.html, measure]);

  if (!graph.source.html) {
    return <p className="p-6 text-sm text-[var(--muted)]">This pathway has no stored markup.</p>;
  }

  return (
    <>
      <div ref={hostRef} />
      {error && <p className="p-2 text-xs text-rose-700">{error}</p>}
    </>
  );
}
