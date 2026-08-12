/**
 * Reading a pathway published as HTML rather than PDF.
 *
 * Some institutions — CHOP among them — render their pathways as absolutely
 * positioned HTML rather than linking a PDF, so the PDF reader has nothing to
 * work with. The good news is that this markup is far *more* explicit than
 * vector geometry: the class names say what everything is.
 *
 *   .outline                        a node box
 *   .outline.urgent / .critical     a node box carrying an acuity band
 *   .nooutline                      a box drawn without a border
 *   .goalsoutline                   navigation chrome, not a pathway step
 *   .arrow-head__down / __left …    an arrowhead, with its direction named
 *   .arrow-line__vertical--solid    a connector
 *
 * Geometry comes from inline `top`/`left` summed up the tree. That is accurate
 * to about a pixel for the absolutely positioned elements a pathway is built
 * from — enough to match arrowheads to boxes — but it drifts for content in
 * normal flow. The viewer therefore re-measures the real boxes from the rendered
 * DOM, so nothing on screen depends on this approximation being exact.
 */

import { parse, type HTMLElement } from 'node-html-parser';
import type { Rect } from '../pdf/geometry';
import type { CandidateEdge, CandidateGraph, CandidateNode } from '../pdf/infer';

/** Root container CHOP wraps a pathway algorithm in. */
const PATHWAY_ROOT = 'div.pathway';

/** Classes that mark page furniture rather than a step in the pathway. */
const CHROME_CLASSES = ['goalsoutline', 'header', 'popup', 'nobullets5a'];

/** Stroke colours matching the PDF path, so downstream acuity handling is shared. */
const ACUITY_STROKES: Record<string, [number, number, number]> = {
  low: [0.537, 0.788, 0.475],
  intermediate: [0.816, 0.812, 0.435],
  high: [0.91, 0.694, 0.663],
};

const ACUITY_BY_CLASS: Record<string, 'low' | 'intermediate' | 'high'> = {
  nonurgent: 'low',
  urgent: 'intermediate',
  critical: 'high',
};

interface Positioned {
  el: HTMLElement;
  rect: Rect;
  classes: string[];
}

function styleMap(el: HTMLElement): Record<string, string> {
  const raw = el.getAttribute('style') ?? '';
  const out: Record<string, string> = {};
  for (const decl of raw.split(';')) {
    const [k, ...rest] = decl.split(':');
    if (!k || rest.length === 0) continue;
    out[k.trim().toLowerCase()] = rest.join(':').trim().toLowerCase();
  }
  return out;
}

function px(value: string | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * Absolute position within the pathway root, by summing inline offsets of every
 * positioned ancestor. No layout engine is involved, which is why this is an
 * approximation rather than the truth.
 */
function absoluteRect(el: HTMLElement, root: HTMLElement): Rect {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  let hops = 0;

  while (node && node !== root && hops < 32) {
    const style = styleMap(node);
    if (style.position === 'absolute' || style.position === 'relative') {
      x += px(style.left);
      y += px(style.top);
    }
    node = node.parentNode as HTMLElement | null;
    hops += 1;
  }

  const own = styleMap(el);
  return { x, y, w: px(own.width) || 0, h: px(own.height) || 0 };
}

function classesOf(el: HTMLElement): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

function textOf(el: HTMLElement): string {
  return el.structuredText
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function linksOf(el: HTMLElement, base: string): { text: string; url: string }[] {
  const out = new Map<string, string>();
  for (const a of el.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      continue;
    }
    const label = a.structuredText.replace(/\s+/g, ' ').trim();
    if (!out.has(absolute) || label.length > (out.get(absolute) ?? '').length) {
      out.set(absolute, label);
    }
  }
  return [...out.entries()].map(([url, text]) => ({ url, text }));
}

/** Direction encoded in an arrowhead's class, e.g. `arrow-head__down`. */
function arrowDirection(classes: string[]): [number, number] | null {
  const head = classes.find((c) => c.startsWith('arrow-head__'));
  if (!head) return null;
  const which = head.replace('arrow-head__', '').split('--')[0];
  switch (which) {
    case 'down':
      return [0, 1];
    case 'up':
      return [0, -1];
    case 'left':
      return [-1, 0];
    case 'right':
      return [1, 0];
    default:
      return null;
  }
}

/**
 * The fragment is third-party markup that the viewer renders inside our own
 * origin, so it is stripped before storage: no scripts, no event handlers, no
 * embedded frames, and no javascript: URLs. Links are neutered to open in a new
 * tab rather than navigate the app.
 */
function sanitize(root: HTMLElement): void {
  for (const el of root.querySelectorAll('script, style, iframe, object, embed, form, input, link, meta')) {
    el.remove();
  }
  for (const el of root.querySelectorAll('*')) {
    for (const name of Object.keys(el.attributes)) {
      const value = el.getAttribute(name) ?? '';
      if (/^on/i.test(name)) el.removeAttribute(name);
      else if (/^(href|src|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(value)) {
        el.removeAttribute(name);
      }
    }
  }
  for (const a of root.querySelectorAll('a')) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
  }
}

export interface HtmlExtraction {
  graph: CandidateGraph;
  /** The pathway markup, kept so the viewer can render the real document. */
  fragment: string;
  title: string;
}

/**
 * The heart of the difference from the PDF path: nodes are boxes whose class
 * says they are boxes, and edges come from arrowheads whose class says which way
 * they point. There is no shape classification to do.
 */
export function extractHtmlPathway(html: string, baseUrl: string): HtmlExtraction | null {
  const doc = parse(html);
  const root = doc.querySelector(PATHWAY_ROOT);
  if (!root) return null;

  const positioned: Positioned[] = [];
  for (const el of root.querySelectorAll('div, span, p, td')) {
    const classes = classesOf(el);
    positioned.push({ el, rect: absoluteRect(el, root), classes });
  }

  // --- Nodes: boxes that carry text and are not chrome.
  const boxes = positioned.filter(({ classes, rect }) => {
    const isBox = classes.some((c) => c === 'outline' || c === 'nooutline');
    if (!isBox) return false;
    if (classes.some((c) => CHROME_CLASSES.includes(c))) return false;
    return rect.w >= 40;
  });

  // A title bar stacked flush on a body box is one node, exactly as in the PDF
  // path — "Findings Suggestive of Abuse" and its criteria are one step.
  const merged: { rect: Rect; els: HTMLElement[]; classes: string[] }[] = [];
  for (const box of boxes.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
    // These boxes rarely carry an inline height, so measure top-to-top rather
    // than from the bottom edge: a title bar sits within ~40px of its body.
    const host = merged.find(
      (m) =>
        Math.abs(m.rect.x - box.rect.x) <= 6 &&
        Math.abs(m.rect.w - box.rect.w) <= 12 &&
        box.rect.y - m.rect.y > 0 &&
        box.rect.y - m.rect.y <= 40,
    );
    if (host) {
      const bottom = Math.max(host.rect.y + host.rect.h, box.rect.y + (box.rect.h || 46));
      host.rect = {
        x: Math.min(host.rect.x, box.rect.x),
        y: Math.min(host.rect.y, box.rect.y),
        w: Math.max(host.rect.w, box.rect.w),
        h: bottom - Math.min(host.rect.y, box.rect.y),
      };
      host.els.push(box.el);
      host.classes.push(...box.classes);
    } else {
      merged.push({ rect: { ...box.rect }, els: [box.el], classes: [...box.classes] });
    }
  }

  const nodes: CandidateNode[] = [];
  for (const group of merged) {
    const text = group.els.map(textOf).filter(Boolean).join('\n');
    if (!text) continue;
    // Navigation blocks and the credits footer are entirely links or metadata.
    const links = group.els.flatMap((el) => linksOf(el, baseUrl));
    const linkText = links.map((l) => l.text).join(' ');
    if (links.length >= 4 && linkText.length > text.length * 0.6) continue;
    if (/^(posted|last revised|authors?|editors?):/i.test(text)) continue;

    const acuity = group.classes.map((c) => ACUITY_BY_CLASS[c]).find(Boolean) ?? null;
    const id = `n${String(nodes.length + 1).padStart(2, '0')}`;
    nodes.push({
      id,
      page: 1,
      bbox: {
        x: group.rect.x,
        y: group.rect.y,
        w: group.rect.w,
        h: group.rect.h || Math.max(18, text.split('\n').length * 14),
      },
      text,
      stroke: acuity ? ACUITY_STROKES[acuity] : null,
      childIds: [],
      links,
    });
    // Tag the elements so the viewer can find this node in the rendered DOM.
    for (const el of group.els) el.setAttribute('data-pathway-node', id);
  }

  // --- Edges: one per arrowhead. Its class names the direction, so match by
  // directional band — the nearest box behind it and the nearest box ahead —
  // rather than nearest-anything, which pairs stacked boxes with each other.
  const heads = positioned.filter(({ classes }) => classes.some((c) => c.startsWith('arrow-head__')));

  const edges: CandidateEdge[] = [];
  const seen = new Set<string>();
  let unresolved = 0;

  const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
    Math.min(a1, b1) - Math.max(a0, b0) > -12;

  /** Nearest node ahead of `from` along `dir`, whose cross-axis range overlaps. */
  const nodeAlong = (x: number, y: number, dir: [number, number], ahead: boolean): CandidateNode | null => {
    const sign = ahead ? 1 : -1;
    let best: CandidateNode | null = null;
    let bestGap = Infinity;

    for (const node of nodes) {
      const { x: nx, y: ny, w, h } = node.bbox;
      let gap: number;
      if (dir[1] !== 0) {
        if (!overlaps(nx, nx + w, x - 4, x + 4)) continue;
        const forward = dir[1] * sign;
        gap = forward > 0 ? ny - y : y - (ny + h);
      } else {
        if (!overlaps(ny, ny + h, y - 4, y + 4)) continue;
        const forward = dir[0] * sign;
        gap = forward > 0 ? nx - x : x - (nx + w);
      }
      if (gap < -8 || gap > 260) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = node;
      }
    }
    return best;
  };

  heads.forEach(({ rect, classes }, i) => {
    const direction = arrowDirection(classes);
    if (!direction) return;

    const tipX = rect.x + rect.w / 2;
    const tipY = rect.y + rect.h / 2;

    const target = nodeAlong(tipX, tipY, direction, true);
    const source = nodeAlong(tipX, tipY, direction, false);

    if (!target || !source || target.id === source.id) {
      unresolved += 1;
      return;
    }

    const key = `${source.id}->${target.id}`;
    if (seen.has(key)) return;
    seen.add(key);

    edges.push({
      id: `e${String(i + 1).padStart(2, '0')}`,
      from: source.id,
      to: target.id,
      polyline: [
        [tipX - direction[0] * 26, tipY - direction[1] * 26],
        [tipX, tipY],
      ],
      arrowAt: [tipX, tipY],
      provenance: 'shaft',
      label: null,
    });
  });

  // The fragment leaves its site, so relative URLs must be made absolute first.
  for (const el of root.querySelectorAll('a, img')) {
    for (const attr of ['href', 'src'] as const) {
      const value = el.getAttribute(attr);
      if (!value || /^(https?:|data:|#)/i.test(value)) continue;
      try {
        el.setAttribute(attr, new URL(value, baseUrl).toString());
      } catch {
        el.removeAttribute(attr);
      }
    }
  }
  sanitize(root);

  const titleEl = doc.querySelector('h1');
  const title = titleEl ? titleEl.structuredText.replace(/\s+/g, ' ').trim() : 'Clinical pathway';

  const bounds = nodes.reduce(
    (acc, n) => ({
      w: Math.max(acc.w, n.bbox.x + n.bbox.w),
      h: Math.max(acc.h, n.bbox.y + n.bbox.h),
    }),
    { w: 0, h: 0 },
  );

  return {
    graph: {
      page: 1,
      width: Math.max(bounds.w + 60, 900),
      height: Math.max(bounds.h + 60, 700),
      nodes,
      edges,
      unresolvedArrowheads: unresolved,
    },
    fragment: root.outerHTML,
    title,
  };
}

