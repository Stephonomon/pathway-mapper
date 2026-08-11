'use client';

/**
 * Renders one PDF page to a canvas at CSS size `width x height` in page units.
 *
 * The canvas is deliberately laid out in *page units* so that a sibling SVG with
 * `viewBox="0 0 pageWidth pageHeight"` shares its coordinate system exactly. That
 * is what lets extracted bboxes be dropped onto the overlay untransformed.
 */

import { useEffect, useRef, useState } from 'react';

interface PdfCanvasProps {
  src: string;
  pageNumber: number;
  /** Page width in PDF units — the canvas CSS width. */
  width: number;
  height: number;
  /** Extra device-pixel multiplier so the page stays sharp when zoomed in. */
  resolution?: number;
  onError?: (message: string) => void;
}

export function PdfCanvas({
  src,
  pageNumber,
  width,
  height,
  resolution = 3,
  onError,
}: PdfCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();

        const doc = await pdfjs.getDocument({ url: src }).promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }

        const page = await doc.getPage(pageNumber);
        const canvas = canvasRef.current;
        if (!canvas) return;

        const scale = resolution * (window.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        const context = canvas.getContext('2d');
        if (!context) return;

        const task = page.render({ canvas, canvasContext: context, viewport });
        await task.promise;
        if (!cancelled) setReady(true);

        cleanup = () => {
          task.cancel();
          void doc.destroy();
        };
      } catch (err) {
        if (!cancelled) onError?.(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [src, pageNumber, resolution, onError]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      className={`bg-white transition-opacity duration-300 ${ready ? 'opacity-100' : 'opacity-0'}`}
      aria-label={`Clinical pathway document, page ${pageNumber}`}
    />
  );
}
