/**
 * Filesystem-backed document store. One directory per ingested pathway:
 *
 *   data/<docId>/source.pdf     the original, served to the viewer verbatim
 *   data/<docId>/graph.json     the validated PathwayGraph
 *   data/<docId>/audit.jsonl    one line per routing request (no PHI)
 *
 * Deliberately not a database: a pathway graph is a small, readable artifact
 * that can be diffed and inspected directly. Note that `data/` is gitignored —
 * ingested documents are other organisations' material and stay local.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathwayGraphSchema, type PathwayGraph } from './schema';

const DATA_DIR = process.env.PATHWAY_DATA_DIR ?? path.join(process.cwd(), 'data');

export function docDir(docId: string): string {
  // Guard against traversal — docIds come off the URL.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(docId)) {
    throw new Error(`invalid docId: ${docId}`);
  }
  return path.join(DATA_DIR, docId);
}

export function sourcePath(docId: string): string {
  return path.join(docDir(docId), 'source.pdf');
}

function graphPath(docId: string): string {
  return path.join(docDir(docId), 'graph.json');
}

export async function listDocs(): Promise<{ docId: string; title: string; version: number }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }

  const docs = await Promise.all(
    entries.map(async (docId) => {
      try {
        const graph = await readGraph(docId);
        return graph && { docId, title: graph.title, version: graph.version };
      } catch {
        return null;
      }
    }),
  );
  return docs.filter((d): d is { docId: string; title: string; version: number } => Boolean(d));
}

/**
 * Parsed graphs, keyed by docId and invalidated on mtime. A pathway graph is
 * immutable once ingested, so re-reading and re-validating it on every request
 * is pure waste — and with a library of a hundred pathways under load, that waste
 * lands on the request path.
 */
const graphCache = new Map<string, { mtimeMs: number; graph: PathwayGraph }>();

export async function readGraph(docId: string): Promise<PathwayGraph | null> {
  const file = graphPath(docId);
  try {
    const { mtimeMs } = await fs.stat(file);
    const cached = graphCache.get(docId);
    if (cached && cached.mtimeMs === mtimeMs) return cached.graph;

    const raw = await fs.readFile(file, 'utf8');
    const graph = pathwayGraphSchema.parse(JSON.parse(raw));
    graphCache.set(docId, { mtimeMs, graph });
    return graph;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeGraph(graph: PathwayGraph): Promise<PathwayGraph> {
  const validated = pathwayGraphSchema.parse(graph);
  await fs.mkdir(docDir(validated.docId), { recursive: true });
  await fs.writeFile(graphPath(validated.docId), JSON.stringify(validated, null, 2));
  graphCache.delete(validated.docId);
  return validated;
}

export async function writeSource(docId: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(docDir(docId), { recursive: true });
  await fs.writeFile(sourcePath(docId), bytes);
}

export async function readSource(docId: string): Promise<Buffer> {
  return fs.readFile(sourcePath(docId));
}

/**
 * Append-only audit trail. The question text is hashed rather than stored — a
 * free-text clinical question is potentially PHI, but we still want to be able to
 * prove which pathway version produced which route.
 */
export async function appendAudit(
  docId: string,
  entry: {
    questionHash: string;
    graphVersion: number;
    nodeIds: string[];
    status: string;
    at: string;
  },
): Promise<void> {
  await fs.mkdir(docDir(docId), { recursive: true });
  await fs.appendFile(path.join(docDir(docId), 'audit.jsonl'), `${JSON.stringify(entry)}\n`);
}

/** Slugify a filename or URL into a usable docId. */
export function toDocId(source: string): string {
  // A URL's last path segment names the document better than its host does.
  const cleaned = /^https?:\/\//i.test(source)
    ? (() => {
        try {
          const url = new URL(source);
          return url.pathname.split('/').filter(Boolean).pop() ?? url.hostname;
        } catch {
          return source;
        }
      })()
    : source;

  const base = path
    .basename(cleaned, path.extname(cleaned))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || `doc-${Date.now().toString(36)}`;
}
