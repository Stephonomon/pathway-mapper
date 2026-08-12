/**
 * Source documents the extraction tests read.
 *
 * These are other organisations' published PDFs and are deliberately NOT
 * committed — see `.gitignore`. Put whatever you are testing with in
 * `Resources/` and these tests light up; without them they skip, so a fresh
 * clone still runs green.
 *
 * The README lists where each of these can be downloaded.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

/** CHOP — suicide risk. Filled-rect connectors, grey triangles. */
export const CHOP = path.join(
  root,
  'Resources',
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

export function has(file: string): boolean {
  return fs.existsSync(file);
}

/** True when every document a suite needs is present locally. */
export function hasAll(...files: string[]): boolean {
  return files.every(has);
}
