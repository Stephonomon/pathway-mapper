/**
 * Stage 1 of the pipeline: turn a PDF into typed vector/text/link primitives.
 *
 * Everything here is deterministic — no model involved. We walk pdf.js's operator
 * list maintaining a CTM stack, decode `constructPath` payloads into subpaths, and
 * emit paths, text runs, and link annotations in the canonical top-left page space
 * described in `geometry.ts`.
 */

import type { Matrix, Point, Rect } from './geometry';
import { applyMatrix, boundsOf, multiply, parseHexColor } from './geometry';

/** pdf.js `DrawOPS` — the subpath command encoding inside `constructPath`. */
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUADRATIC_CURVE_TO = 3;
const DRAW_CLOSE_PATH = 4;

export type PaintKind = 'fill' | 'stroke' | 'fillStroke' | 'none';

export interface PathPrimitive {
  /** Index in the operator list — stable id for debugging extraction. */
  index: number;
  paint: PaintKind;
  /** True when the path was painted with an even-odd fill rule. */
  evenOdd: boolean;
  fill: [number, number, number] | null;
  stroke: [number, number, number] | null;
  lineWidth: number;
  /**
   * Subpaths as flattened point lists. Bezier control points are retained so the
   * bbox stays correct, but consecutive on-curve points are what edge inference
   * walks.
   */
  subpaths: Point[][];
  /** True when the subpath list came from a single `re` (rectangle) operator. */
  closed: boolean[];
  bbox: Rect;
}

export interface TextRun {
  index: number;
  text: string;
  bbox: Rect;
  /** Effective font size in page units (already includes the page CTM scale). */
  size: number;
  fontName: string;
  hasEOL: boolean;
}

export interface LinkAnnotation {
  url: string;
  bbox: Rect;
}

export interface RawPage {
  pageNumber: number;
  width: number;
  height: number;
  paths: PathPrimitive[];
  texts: TextRun[];
  links: LinkAnnotation[];
}

export interface RawDocument {
  pages: RawPage[];
}

interface PdfJsModule {
  getDocument(src: { data: Uint8Array; [k: string]: unknown }): { promise: Promise<PdfDocumentProxy> };
  OPS: Record<string, number>;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}

interface PdfPageProxy {
  view: number[];
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  getTextContent(): Promise<{ items: unknown[] }>;
  getAnnotations(): Promise<unknown[]>;
}

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/**
 * Load the legacy (non-worker) build. Extraction runs server-side in a Next route
 * handler and in the CLI, neither of which has a DOM for the default build.
 */
async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJsModule>;
  }
  return pdfjsPromise;
}

/** Decode one pdf.js subpath buffer into points, applying `ctm` as we go. */
function decodeSubpath(data: ArrayLike<number>, ctm: Matrix): { points: Point[]; closed: boolean } {
  const points: Point[] = [];
  let closed = false;
  let i = 0;
  while (i < data.length) {
    const op = data[i++];
    switch (op) {
      case DRAW_MOVE_TO:
      case DRAW_LINE_TO:
        points.push(applyMatrix(ctm, data[i++], data[i++]));
        break;
      case DRAW_CURVE_TO:
        // Keep control points: they bound the curve, which is what the bbox needs.
        points.push(applyMatrix(ctm, data[i++], data[i++]));
        points.push(applyMatrix(ctm, data[i++], data[i++]));
        points.push(applyMatrix(ctm, data[i++], data[i++]));
        break;
      case DRAW_QUADRATIC_CURVE_TO:
        points.push(applyMatrix(ctm, data[i++], data[i++]));
        points.push(applyMatrix(ctm, data[i++], data[i++]));
        break;
      case DRAW_CLOSE_PATH:
        closed = true;
        break;
      default:
        // Unknown opcode: we cannot know its operand count, so stop this subpath
        // rather than misread the rest of the buffer as coordinates.
        i = data.length;
        break;
    }
  }
  return { points, closed };
}

function paintKindFor(op: number, OPS: Record<string, number>): { paint: PaintKind; evenOdd: boolean } {
  switch (op) {
    case OPS.fill:
      return { paint: 'fill', evenOdd: false };
    case OPS.eoFill:
      return { paint: 'fill', evenOdd: true };
    case OPS.stroke:
    case OPS.closeStroke:
      return { paint: 'stroke', evenOdd: false };
    case OPS.fillStroke:
    case OPS.closeFillStroke:
      return { paint: 'fillStroke', evenOdd: false };
    case OPS.eoFillStroke:
    case OPS.closeEOFillStroke:
      return { paint: 'fillStroke', evenOdd: true };
    default:
      return { paint: 'none', evenOdd: false };
  }
}

function extractPaths(
  fnArray: number[],
  argsArray: unknown[],
  OPS: Record<string, number>,
  pageHeight: number,
): PathPrimitive[] {
  const paths: PathPrimitive[] = [];
  // The operator list yields PDF user space (bottom-left origin). Seed the stack
  // with a flip so paths land in the same top-left space as text runs and link
  // annotations — the whole point of having one canonical space.
  const base: Matrix = [1, 0, 0, -1, 0, pageHeight];
  let ctm: Matrix = base;
  const stack: Matrix[] = [];
  let fill: [number, number, number] | null = null;
  let stroke: [number, number, number] | null = null;
  let lineWidth = 1;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as never;

    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? base;
    } else if (fn === OPS.transform) {
      ctm = multiply(Array.from(args as ArrayLike<number>) as unknown as Matrix, ctm);
    } else if (fn === OPS.setFillRGBColor) {
      fill = parseHexColor((args as unknown as string[])[0]);
    } else if (fn === OPS.setStrokeRGBColor) {
      stroke = parseHexColor((args as unknown as string[])[0]);
    } else if (fn === OPS.setLineWidth) {
      lineWidth = Number((args as unknown as number[])[0]) || 1;
    } else if (fn === OPS.constructPath) {
      const [drawOp, rawSubpaths] = args as unknown as [number, ArrayLike<number>[]];
      const { paint, evenOdd } = paintKindFor(drawOp, OPS);
      if (paint === 'none') continue; // clipping / endPath — no ink on the page

      const subpaths: Point[][] = [];
      const closed: boolean[] = [];
      for (const raw of rawSubpaths ?? []) {
        const decoded = decodeSubpath(raw, ctm);
        if (decoded.points.length === 0) continue;
        subpaths.push(decoded.points);
        closed.push(decoded.closed);
      }
      if (subpaths.length === 0) continue;

      paths.push({
        index: i,
        paint,
        evenOdd,
        fill: paint === 'stroke' ? null : fill,
        stroke: paint === 'fill' ? null : stroke,
        // Line width is in path space; scale it into page space.
        lineWidth: lineWidth * Math.hypot(ctm[0], ctm[1]),
        subpaths,
        closed,
        bbox: boundsOf(subpaths.flat()),
      });
    }
  }

  return paths;
}

interface RawTextItem {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
  fontName?: string;
  hasEOL?: boolean;
}

function extractTexts(items: unknown[], pageHeight: number): TextRun[] {
  const runs: TextRun[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as RawTextItem;
    if (typeof item.str !== 'string' || item.str.trim() === '') continue;
    const t = item.transform;
    if (!t) continue;

    const size = Math.abs(t[3]) || Math.hypot(t[2], t[3]);
    const h = item.height && item.height > 0 ? item.height : size;
    const w = item.width ?? 0;
    // getTextContent reports a bottom-left-origin baseline; convert to top-left
    // origin and lift the box to cover the glyph body above that baseline.
    runs.push({
      index: i,
      text: item.str,
      bbox: { x: t[4], y: pageHeight - t[5] - h, w, h },
      size,
      fontName: item.fontName ?? '',
      hasEOL: Boolean(item.hasEOL),
    });
  }
  return runs;
}

interface RawAnnotation {
  subtype?: string;
  url?: string;
  unsafeUrl?: string;
  rect?: number[];
}

function extractLinks(annotations: unknown[], pageHeight: number): LinkAnnotation[] {
  const links: LinkAnnotation[] = [];
  for (const raw of annotations) {
    const a = raw as RawAnnotation;
    const url = a.url ?? a.unsafeUrl;
    if (!url || !a.rect) continue;
    const [x1, y1, x2, y2] = a.rect;
    links.push({
      url,
      bbox: {
        x: Math.min(x1, x2),
        y: pageHeight - Math.max(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1),
      },
    });
  }
  return links;
}

/** Extract every primitive we can get deterministically out of a PDF. */
export async function extractDocument(bytes: Uint8Array): Promise<RawDocument> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    // pdf.js takes ownership of the buffer and detaches it. Callers routinely
    // need the same bytes afterwards (to persist the source file), so hand over
    // a copy rather than their array.
    data: new Uint8Array(bytes),
    // Pathway PDFs use subset fonts; we only need metrics, not rendering.
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;

  try {
    const pages: RawPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [, , width, height] = page.view;
      const [ops, text, annotations] = await Promise.all([
        page.getOperatorList(),
        page.getTextContent(),
        page.getAnnotations(),
      ]);

      pages.push({
        pageNumber: n,
        width,
        height,
        paths: extractPaths(ops.fnArray, ops.argsArray, pdfjs.OPS, height),
        texts: extractTexts(text.items, height),
        links: extractLinks(annotations, height),
      });
    }
    return { pages };
  } finally {
    await doc.destroy();
  }
}
