/**
 * CLI: run the deterministic extraction pipeline over a PDF and write out both
 * the candidate graph and a debug SVG.
 *
 *   npm run extract -- path/to/pathway.pdf [outDir]
 *
 * The SVG is the fast way to judge extraction quality: if the boxes and arrows
 * line up with the source document, everything downstream has solid ground.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { extractDocument } from '../lib/pdf/extract';
import { classifyPage } from '../lib/pdf/primitives';
import { inferGraph, type CandidateGraph } from '../lib/pdf/infer';

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

function debugSvg(graph: CandidateGraph): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${graph.width} ${graph.height}" width="${graph.width}" height="${graph.height}">`,
    `<rect width="${graph.width}" height="${graph.height}" fill="#fff"/>`,
  );

  for (const node of graph.nodes) {
    const isGroup = node.childIds.length > 0;
    const { x, y, w, h } = node.bbox;
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${isGroup ? '#f5f9ff' : '#eef7ee'}" stroke="${isGroup ? '#6aa3e0' : '#3a8a3a'}" stroke-width="0.6"/>`,
      `<text x="${x + 2}" y="${y + 7}" font-family="monospace" font-size="5" fill="#c0392b">${node.id}</text>`,
    );
    const firstLine = node.text.split('\n')[0]?.slice(0, 42) ?? '';
    parts.push(
      `<text x="${x + 2}" y="${y + 14}" font-family="sans-serif" font-size="4" fill="#333">${escapeXml(firstLine)}</text>`,
    );
  }

  for (const edge of graph.edges) {
    const d = edge.polyline.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
    const color = edge.provenance === 'shaft' ? '#d35400' : '#8e44ad';
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1"/>`);
    parts.push(
      `<circle cx="${edge.arrowAt[0]}" cy="${edge.arrowAt[1]}" r="1.6" fill="${color}"/>`,
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}

async function main() {
  const [input, outDirArg] = process.argv.slice(2);
  if (!input) {
    console.error('usage: npm run extract -- <pdf> [outDir]');
    process.exit(1);
  }

  const outDir = outDirArg ?? path.join('data', 'debug');
  await fs.mkdir(outDir, { recursive: true });

  const bytes = new Uint8Array(await fs.readFile(input));
  const doc = await extractDocument(bytes);

  const graphs = doc.pages.map((page) => inferGraph(page, classifyPage(page)));

  await fs.writeFile(path.join(outDir, 'graph.json'), JSON.stringify(graphs, null, 2));
  for (const graph of graphs) {
    await fs.writeFile(path.join(outDir, `page-${graph.page}.svg`), debugSvg(graph));
  }

  for (const graph of graphs) {
    console.log(
      `page ${graph.page}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.unresolvedArrowheads} unresolved arrowheads`,
    );
    for (const node of graph.nodes) {
      const kind = node.childIds.length ? `group(${node.childIds.length})` : 'leaf';
      const preview = node.text.replace(/\n/g, ' / ').slice(0, 72);
      console.log(
        `  ${node.id} ${kind.padEnd(9)} [${node.links.length} links] ${preview || '(no text)'}`,
      );
    }
    for (const edge of graph.edges) {
      console.log(`  ${edge.from} -> ${edge.to}  (${edge.provenance})`);
    }
  }

  console.log(`\nwrote ${path.join(outDir, 'graph.json')} and debug SVG(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
