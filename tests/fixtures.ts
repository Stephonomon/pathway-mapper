/**
 * Source documents the tests read.
 *
 * These are the real, committed PDFs rather than copies, so `npm test` works on
 * a fresh clone with no ingest step and there is only ever one version of each
 * document in the repository.
 */

import path from 'node:path';

const root = process.cwd();

/** CHOP — suicide risk assessment. Filled-rect connectors, grey triangles. */
export const CHOP = path.join(
  root,
  "Suicide Risk Assessment and Care Planning Clinical Pathway – Outpatient _ Children's Hospital of Philadelphia.pdf",
);

/** Johns Hopkins All Children's — BRUE. Block-arrow polygons. */
export const BRUE = path.join(root, 'Resources', 'Sample.BRUE-Clinical-Pathway-graph.pdf');

/** Upstate — febrile infant. Stroked polylines, diamonds, rounded rects. */
export const UPSTATE = path.join(
  root,
  'Resources',
  'Sample.Upstate Pediatric Febrile Infant Clinical Pathway.pdf',
);
