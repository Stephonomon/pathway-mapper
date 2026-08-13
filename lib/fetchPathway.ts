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
 * A linked PDF wins over the page's own markup only when it is hosted on the same
 * site as the page: that is the institution's own authoritative artifact.
 * Pathway pages routinely *cite* third-party PDFs (an NHLBI guideline, a journal
 * article), and following one of those would silently ingest the wrong document,
 * so an off-site PDF never overrides a page that is itself a readable pathway —
 * it is only a last resort for a page that has no markup of its own. Candidate
 * links are scored so the algorithm beats the patient-education material most
 * pathway pages also publish.
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

/** True when the page renders its own pathway diagram as positioned markup. */
export function hasPathwayMarkup(html: string): boolean {
  return PATHWAY_MARKUP.test(html);
}

/**
 * The registrable domain, approximated as the last two labels. Good enough to
 * tell `nhlbi.nih.gov` from `chop.edu`, and to treat `media.chop.edu` and
 * `www.chop.edu` as the same site. It over-groups two-label public suffixes such
 * as `.nhs.uk`, which is acceptable here — the cost of a wrong grouping is only
 * that an off-site PDF is treated as on-site, and the scorer still has to like it.
 */
export function registrableDomain(hostname: string): string {
  return hostname.toLowerCase().split('.').filter(Boolean).slice(-2).join('.');
}

/** Same institution's site — a PDF here is the authoritative artifact, not a citation. */
export function isSameSite(a: URL, b: URL): boolean {
  return registrableDomain(a.hostname) === registrableDomain(b.hostname);
}

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

/**
 * Read the body while enforcing the size cap *during* the download.
 *
 * `content-length` is advisory — a hostile or misconfigured server can omit or
 * understate it — so buffering the whole response before checking its length
 * would let one stream gigabytes into memory. Stream instead and abort the
 * moment the accumulated bytes exceed the cap.
 */
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffered = new Uint8Array(await response.arrayBuffer());
    if (buffered.byteLength > max) {
      throw new FetchPathwayError('That file is larger than the 30MB limit.');
    }
    return buffered;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new FetchPathwayError('That file is larger than the 30MB limit.');
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Fetch one resource, following redirects manually so each hop is re-checked. */
async function fetchChecked(startUrl: string): Promise<FetchedResource> {
  let url = await assertPublicUrl(startUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    // The timeout covers the whole hop — connecting, headers, and streaming the
    // body — so a server that dribbles bytes forever cannot hold the request open.
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
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

      let body: Uint8Array;
      try {
        body = await readCapped(response, MAX_BYTES);
      } catch (err) {
        if (err instanceof FetchPathwayError) throw err;
        throw new FetchPathwayError(
          controller.signal.aborted
            ? `Timed out after ${TIMEOUT_MS / 1000}s fetching ${url.hostname}.`
            : `Could not read the response from ${url.hostname}: ${(err as Error).message}`,
        );
      }

      return { url, contentType: response.headers.get('content-type') ?? '', body };
    } finally {
      clearTimeout(timer);
    }
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

  const markup = hasPathwayMarkup(html);
  const asHtml = (): FetchedHtml => ({
    kind: 'html',
    html,
    sourceUrl: first.url.toString(),
    filename: filenameFor(first.url).replace(/\.pdf$/, ''),
  });

  // Split candidates by host. A same-site PDF is the institution's own artifact
  // and outranks the page's markup; an off-site one is a citation and must not.
  const candidates = findPdfLinks(html, first.url);
  const sameSite = candidates.filter((c) => isSameSite(new URL(c), first.url));
  const offSite = candidates.filter((c) => !isSameSite(new URL(c), first.url));

  const errors: string[] = [];
  const tryCandidates = async (urls: string[]): Promise<FetchedPathway | null> => {
    // Try the best few in order — the top-scoring link is occasionally a dead or
    // non-PDF URL, and falling through beats failing the whole ingest.
    for (const candidate of urls.slice(0, 3)) {
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
    return null;
  };

  // 1. The institution's own PDF, if it links one.
  const own = await tryCandidates(sameSite);
  if (own) return own;

  // 2. The page is itself the pathway — read it rather than follow a citation.
  if (markup) return asHtml();

  // 3. No markup and no same-site PDF: a page that only links out to the real
  //    document (an off-site PDF) is the remaining possibility.
  const external = await tryCandidates(offSite);
  if (external) return external;

  if (candidates.length === 0) {
    throw new FetchPathwayError(
      'That page has neither a linked PDF nor a pathway diagram this can read.',
    );
  }
  throw new FetchPathwayError(
    `Found ${candidates.length} PDF link(s) on that page but could not fetch a usable one: ${errors[0]}`,
  );
}
