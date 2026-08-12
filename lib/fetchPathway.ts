/**
 * Resolve a URL to a pathway document.
 *
 * Three shapes are common in the wild and all are supported:
 *
 *   direct PDF     childrensmercy.org/.../abdominal-pain-algorithm.pdf
 *   linked PDF     a landing page that links the algorithm PDF
 *   HTML pathway   chop.edu/clinical-pathway/… — the page *is* the flowchart,
 *                  drawn as positioned markup, with no PDF anywhere
 *
 * A linked PDF wins over the page's own markup when both exist: it is the
 * authoritative artifact. Candidate links are scored so the algorithm beats the
 * patient-education material most pathway pages also publish.
 *
 * This endpoint takes a URL from the user and fetches it server-side, which is a
 * request-forgery surface. The guards below are deliberately strict: HTTPS only,
 * no private or loopback addresses, a size cap, a timeout, and a redirect chain
 * that is re-validated at every hop rather than handed to the HTTP client.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'PathwayMapper/0.1 (clinical pathway reader)';

/** Cheap check for a page that renders its pathway as markup rather than a PDF. */
const PATHWAY_MARKUP = /class=["'][^"']*\bpathway\b/i;

export class FetchPathwayError extends Error {}

/** Reject anything that could reach the host's own network. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
    // IPv4-mapped, e.g. ::ffff:127.0.0.1
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FetchPathwayError(`Not a valid URL: ${raw}`);
  }

  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') {
    throw new FetchPathwayError('Only https URLs are supported.');
  }

  const host = url.hostname;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) {
    throw new FetchPathwayError(`Could not resolve ${host}.`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new FetchPathwayError(`Refusing to fetch a private address (${host}).`);
    }
  }
  return url;
}

interface FetchedResource {
  url: URL;
  contentType: string;
  body: Uint8Array;
}

/** Fetch one resource, following redirects manually so each hop is re-checked. */
async function fetchChecked(startUrl: string): Promise<FetchedResource> {
  let url = await assertPublicUrl(startUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'application/pdf,text/html;q=0.9,*/*;q=0.5' },
      });
    } catch (err) {
      throw new FetchPathwayError(
        controller.signal.aborted
          ? `Timed out after ${TIMEOUT_MS / 1000}s fetching ${url.hostname}.`
          : `Could not reach ${url.hostname}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new FetchPathwayError(`Redirect with no destination from ${url.hostname}.`);
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) {
      throw new FetchPathwayError(`${url.hostname} returned ${response.status} ${response.statusText}.`);
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) {
      throw new FetchPathwayError(`That file is ${Math.round(declared / 1e6)}MB; the limit is 30MB.`);
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_BYTES) {
      throw new FetchPathwayError('That file is larger than the 30MB limit.');
    }

    return { url, contentType: response.headers.get('content-type') ?? '', body };
  }

  throw new FetchPathwayError('Too many redirects.');
}

function looksLikePdf(bytes: Uint8Array, contentType: string): boolean {
  if (contentType.includes('application/pdf')) return true;
  // Trust the bytes over the header — some servers mislabel PDFs as octet-stream.
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

/**
 * Pull candidate PDF links out of a landing page, best first.
 *
 * Pathway pages usually link several PDFs — the algorithm plus supporting
 * material like patient education or references. Score by how much the link
 * looks like the flowchart itself.
 */
export function findPdfLinks(html: string, base: URL): string[] {
  const seen = new Map<string, number>();
  const anchor = /<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;

  for (const match of html.matchAll(anchor)) {
    const [, href, inner] = match;
    let absolute: string;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      continue;
    }

    const haystack = `${decodeURIComponent(absolute)} ${inner.replace(/<[^>]*>/g, ' ')}`.toLowerCase();
    let score = 0;
    if (/algorithm|flowchart|pathway|guideline|clinical.?practice/.test(haystack)) score += 3;
    if (/\bprint|full|complete\b/.test(haystack)) score += 1;
    if (/education|handout|family|parent|reference|citation|appendix|poster/.test(haystack)) score -= 3;
    score += Math.max(0, 2 - Math.abs(haystack.length - 120) / 200);

    seen.set(absolute, Math.max(seen.get(absolute) ?? -Infinity, score));
  }

  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([url]) => url);
}

/** Derive a readable filename for the stored document. */
function filenameFor(url: URL): string {
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? 'pathway');
  return last.toLowerCase().endsWith('.pdf') ? last : `${last}.pdf`;
}

export interface FetchedPathway {
  kind: 'pdf';
  bytes: Uint8Array;
  /** The URL the PDF actually came from, which may differ from what was given. */
  sourceUrl: string;
  filename: string;
}

/** Some institutions publish the pathway as the page itself, with no PDF at all. */
export interface FetchedHtml {
  kind: 'html';
  html: string;
  sourceUrl: string;
  filename: string;
}

export type FetchedDocument = FetchedPathway | FetchedHtml;

export async function fetchPathwayDocument(input: string): Promise<FetchedDocument> {
  const first = await fetchChecked(input);

  if (looksLikePdf(first.body, first.contentType)) {
    return {
      kind: 'pdf',
      bytes: first.body,
      sourceUrl: first.url.toString(),
      filename: filenameFor(first.url),
    };
  }

  if (!first.contentType.includes('text/html')) {
    throw new FetchPathwayError(
      `That URL returned ${first.contentType || 'an unknown type'}, not a PDF or a web page.`,
    );
  }

  const html = new TextDecoder('utf-8', { fatal: false }).decode(first.body);

  // Prefer a linked PDF when there is one — it is the authoritative artifact.
  // Otherwise the page may *be* the pathway, rendered as positioned HTML.
  const candidates = findPdfLinks(html, first.url);
  if (candidates.length === 0) {
    if (PATHWAY_MARKUP.test(html)) {
      return {
        kind: 'html',
        html,
        sourceUrl: first.url.toString(),
        filename: filenameFor(first.url).replace(/\.pdf$/, ''),
      };
    }
    throw new FetchPathwayError(
      'That page has neither a linked PDF nor a pathway diagram this can read.',
    );
  }

  // Try the best candidates in order — the top-scoring link is occasionally a
  // dead or non-PDF URL, and falling through beats failing the whole ingest.
  const errors: string[] = [];
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const resource = await fetchChecked(candidate);
      if (looksLikePdf(resource.body, resource.contentType)) {
        return {
          kind: 'pdf',
          bytes: resource.body,
          sourceUrl: resource.url.toString(),
          filename: filenameFor(resource.url),
        };
      }
      errors.push(`${candidate} was not a PDF`);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  if (PATHWAY_MARKUP.test(html)) {
    return {
      kind: 'html',
      html,
      sourceUrl: first.url.toString(),
      filename: filenameFor(first.url).replace(/\.pdf$/, ''),
    };
  }

  throw new FetchPathwayError(
    `Found ${candidates.length} PDF link(s) on that page but could not fetch one: ${errors[0]}`,
  );
}
