/**
 * Characterise how a pathway PDF is drawn.
 *
 *   npm run diagnose -- path/to/pathway.pdf
 *
 * Run this first when a new document extracts badly. Every institution's
 * flowcharts are built differently — CHOP draws connectors as filled rectangles,
 * others use stroked lines — and this prints the actual drawing vocabulary so the
 * classifier can be aimed at it instead of guessed at.
 */

import fs from 'node:fs/promises';
import { extractDocument, type PathPrimitive, type RawPage } from '../lib/pdf/extract';
import { asAxisAlignedRect } from '../lib/pdf/primitives';

function hex(c: readonly number[] | null): string {
  if (!c) return '—';
  return `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

function tally<T>(items: T[], key: (t: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Does this path contain a curve? Rounded corners and elbows show up here. */
function pointCount(p: PathPrimitive): number {
  return p.subpaths.reduce((n, sp) => n + sp.length, 0);
}

function report(page: RawPage) {
  const { paths, texts, links, width, height } = page;
  console.log(`\n─── page ${page.pageNumber}  ${width} x ${height}`);
  console.log(`    ${paths.length} paths, ${texts.length} text runs, ${links.length} links`);

  const stroked = paths.filter((p) => p.paint === 'stroke' || p.paint === 'fillStroke');
  const filled = paths.filter((p) => p.paint === 'fill' || p.paint === 'fillStroke');

  const strokedRects = stroked.filter((p) => asAxisAlignedRect(p));
  const strokedLines = stroked.filter((p) => !asAxisAlignedRect(p));
  const filledRects = filled.filter((p) => asAxisAlignedRect(p));
  const triangles = filled.filter((p) => p.subpaths.length === 1 && p.subpaths[0].length === 3);

  console.log(`\n  STROKED: ${stroked.length}  (${strokedRects.length} axis-aligned rects, ${strokedLines.length} other)`);
  console.log(`  FILLED:  ${filled.length}  (${filledRects.length} axis-aligned rects, ${triangles.length} triangles)`);

  // Boxes: what a node is likely drawn as.
  const boxCandidates = [...strokedRects, ...filledRects].filter(
    (p) => p.bbox.w > 24 && p.bbox.h > 8 && p.bbox.w * p.bbox.h < width * height * 0.5,
  );
  console.log(`\n  BOX CANDIDATES (>24x8): ${boxCandidates.length}`);
  for (const [k, n] of tally(boxCandidates, (p) => `${p.paint} stroke=${hex(p.stroke)} fill=${hex(p.fill)}`).slice(0, 6)) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }

  // Connectors: the part that varies most between institutions.
  const thinFilled = filled.filter((p) => {
    const r = asAxisAlignedRect(p);
    return r && Math.min(r.w, r.h) <= 2.5 && Math.max(r.w, r.h) >= 4;
  });
  console.log(`\n  CONNECTOR CANDIDATES`);
  console.log(`    stroked non-rect paths (lines/elbows): ${strokedLines.length}`);
  if (strokedLines.length) {
    for (const [k, n] of tally(strokedLines, (p) => `stroke=${hex(p.stroke)} width=${p.lineWidth.toFixed(1)} pts=${pointCount(p)} subpaths=${p.subpaths.length}`).slice(0, 6)) {
      console.log(`      ${String(n).padStart(4)}  ${k}`);
    }
  }
  console.log(`    thin filled rects (shafts):            ${thinFilled.length}`);
  if (thinFilled.length) {
    for (const [k, n] of tally(thinFilled, (p) => `fill=${hex(p.fill)}`).slice(0, 6)) {
      console.log(`      ${String(n).padStart(4)}  ${k}`);
    }
  }

  console.log(`    filled triangles (arrowheads):         ${triangles.length}`);
  if (triangles.length) {
    for (const [k, n] of tally(triangles, (p) => `fill=${hex(p.fill)} size=${p.bbox.w.toFixed(0)}x${p.bbox.h.toFixed(0)}`).slice(0, 8)) {
      console.log(`      ${String(n).padStart(4)}  ${k}`);
    }
  }

  // Small filled polygons that are not triangles — arrowheads are sometimes
  // drawn as 4-point kites or with a curved back.
  const smallPolys = filled.filter(
    (p) => p.bbox.w > 1 && p.bbox.h > 1 && p.bbox.w < 20 && p.bbox.h < 20 && !asAxisAlignedRect(p),
  );
  console.log(`    small non-rect filled shapes (<20x20): ${smallPolys.length}`);
  for (const [k, n] of tally(smallPolys, (p) => `pts=${pointCount(p)} fill=${hex(p.fill)} size=${p.bbox.w.toFixed(0)}x${p.bbox.h.toFixed(0)}`).slice(0, 8)) {
    console.log(`      ${String(n).padStart(4)}  ${k}`);
  }

  // Arrowheads are occasionally glyphs from a font rather than vector shapes.
  const arrowGlyphs = texts.filter((t) => /[▸▶►▼▾→⇒➔➤]/.test(t.text));
  if (arrowGlyphs.length) {
    console.log(`\n  ARROW GLYPHS IN TEXT: ${arrowGlyphs.length} — connectors may be typographic`);
  }

  console.log(`\n  SAMPLE TEXT (reading order):`);
  for (const t of texts.slice(0, 5)) {
    console.log(`    (${t.bbox.x.toFixed(0)},${t.bbox.y.toFixed(0)}) ${JSON.stringify(t.text.slice(0, 60))}`);
  }
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: npm run diagnose -- <pdf>');
    process.exit(1);
  }
  const doc = await extractDocument(new Uint8Array(await fs.readFile(input)));
  console.log(`\n════ ${input}`);
  for (const page of doc.pages) report(page);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
