/**
 * CLI ingest — same pipeline as POST /api/ingest, usable without the server.
 *
 *   npm run ingest -- path/to/pathway.pdf [--no-label] [--doc-id my-id]
 *
 * `--no-label` stops after the deterministic pass, which is how you get a usable
 * document with no API key configured.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from './env';

loadEnv();

import { toDocId } from '../lib/store';
import { fetchPathwayDocument, FetchPathwayError } from '../lib/fetchPathway';
import { ingestDocument, type IngestInput } from '../lib/ingest';

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('usage: npm run ingest -- <pdf-path-or-url> [--no-label] [--doc-id <id>]');
    process.exit(1);
  }

  const noLabel = args.includes('--no-label');
  const docIdFlag = args.indexOf('--doc-id');
  const docId = docIdFlag >= 0 ? args[docIdFlag + 1] : toDocId(input);

  let payload: IngestInput;
  if (/^https?:\/\//i.test(input)) {
    console.log(`fetching ${input} …`);
    const fetched = await fetchPathwayDocument(input);
    if (fetched.sourceUrl !== input) console.log(`resolved to ${fetched.sourceUrl}`);
    console.log(`reading as ${fetched.kind.toUpperCase()}`);
    payload =
      fetched.kind === 'pdf'
        ? { kind: 'pdf', bytes: fetched.bytes, filename: fetched.filename, url: fetched.sourceUrl }
        : { kind: 'html', html: fetched.html, url: fetched.sourceUrl, filename: fetched.filename };
  } else {
    payload = {
      kind: 'pdf',
      bytes: new Uint8Array(await fs.readFile(input)),
      filename: path.basename(input),
    };
  }

  const { graph } = await ingestDocument(payload, {
    docId,
    noLabel,
    onProgress: (m) => console.log(m),
  });

  console.log(
    `${graph.docId}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, v${graph.version}`,
  );
  console.log(`entry: ${graph.entryNodeIds.join(', ') || '(none)'}`);
  for (const warning of graph.warnings) console.log(`  warning: ${warning}`);
  console.log(`\nopen http://localhost:3000/p/${graph.docId}`);
}

main().catch((err) => {
  // A bad or unsupported URL is a normal outcome, not a crash. Print what went
  // wrong without a stack trace the reader cannot act on.
  if (err instanceof FetchPathwayError) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
