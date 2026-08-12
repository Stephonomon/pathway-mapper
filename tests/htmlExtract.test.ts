/**
 * Reading a pathway published as HTML.
 *
 * The markup below is synthetic but mirrors how CHOP builds a pathway page:
 * absolutely positioned boxes, a title bar stacked on a body, acuity carried in
 * a class rather than a colour, and arrowheads whose class names their
 * direction. No third-party document is needed, so this suite always runs.
 */

import { describe, expect, it } from 'vitest';
import { extractHtmlPathway } from '@/lib/html/extract';

const BASE = 'https://example.org/clinical-pathway/demo';

const PAGE = `
<html><body>
<h1>Demo Clinical Pathway</h1>
<div class="pathway">
  <div class="nooutline" style="position:absolute; top:20px; left:0px; width:200px;">
    <div class="goalsoutline" style="width:150px;"><a href="/goals">Goals and Metrics</a></div>
    <div class="goalsoutline" style="width:150px;"><a href="/education">Patient Education</a></div>
    <div class="goalsoutline" style="width:150px;"><a href="/resources">Provider Resources</a></div>
    <div class="goalsoutline" style="width:150px;"><a href="/related">Related Pathways</a></div>
  </div>

  <div class="outline" style="position:absolute; top:20px; left:300px; width:220px; height:24px;">
    Child presenting with fever
  </div>

  <div class="arrow-line__vertical--solid" style="position:absolute; top:48px; left:408px; height:24px;"></div>
  <div class="arrow-head__down" style="position:absolute; top:72px; left:404px; width:8px; height:8px;"></div>

  <div class="outline" style="position:absolute; top:86px; left:300px; width:220px; height:24px;">
    Assess for source of infection
  </div>

  <div class="arrow-line__vertical--solid" style="position:absolute; top:114px; left:408px; height:24px;"></div>
  <div class="arrow-head__down" style="position:absolute; top:138px; left:404px; width:8px; height:8px;"></div>

  <div class="outline critical" style="position:absolute; top:154px; left:300px; width:220px; height:20px;">
    Source identified
  </div>
  <div class="nooutline" style="position:absolute; top:176px; left:300px; width:220px;">
    Treat the identified infection.
    <a href="/antibiotics">Antibiotic guidance</a>
  </div>
</div>
</body></html>
`;

describe('HTML pathway extraction', () => {
  const result = extractHtmlPathway(PAGE, BASE);

  it('finds the pathway container', () => {
    expect(result).not.toBeNull();
  });

  it('reads boxes as steps and ignores navigation chrome', () => {
    const texts = result!.graph.nodes.map((n) => n.text.replace(/\s+/g, ' '));
    expect(texts.some((t) => t.includes('Child presenting with fever'))).toBe(true);
    expect(texts.some((t) => t.includes('Assess for source of infection'))).toBe(true);
    // The goals/education/resources block is navigation, not a step.
    expect(texts.some((t) => t.includes('Goals and Metrics'))).toBe(false);
  });

  it('merges a title bar into the body beneath it', () => {
    const merged = result!.graph.nodes.find((n) => n.text.includes('Source identified'));
    expect(merged?.text).toContain('Treat the identified infection');
  });

  it('carries acuity from the class rather than a colour', () => {
    // `critical` is the document's own word for the most severe band.
    const critical = result!.graph.nodes.find((n) => n.text.includes('Source identified'));
    expect(critical?.stroke).not.toBeNull();
  });

  it('follows arrowheads in the direction their class names', () => {
    const byText = (needle: string) =>
      result!.graph.nodes.find((n) => n.text.includes(needle))?.id;
    const start = byText('Child presenting with fever');
    const assess = byText('Assess for source of infection');
    const source = byText('Source identified');

    const has = (from?: string, to?: string) =>
      Boolean(from && to && result!.graph.edges.some((e) => e.from === from && e.to === to));

    expect(has(start, assess)).toBe(true);
    expect(has(assess, source)).toBe(true);
    // ...and never backwards, which nearest-box matching would have produced.
    expect(has(assess, start)).toBe(false);
  });

  it('makes links absolute so they survive leaving the site', () => {
    const treat = result!.graph.nodes.find((n) => n.text.includes('Treat the identified'));
    expect(treat?.links.some((l) => l.url === 'https://example.org/antibiotics')).toBe(true);
  });

  it('tags nodes in the fragment so the viewer can measure them', () => {
    for (const node of result!.graph.nodes) {
      expect(result!.fragment).toContain(`data-pathway-node="${node.id}"`);
    }
  });
});

describe('fragment sanitisation', () => {
  const hostile = `
    <div class="pathway">
      <div class="outline" style="position:absolute; top:0; left:0; width:200px; height:20px;"
           onclick="alert(1)">A step</div>
      <script>alert('xss')</script>
      <iframe src="https://evil.example"></iframe>
      <a href="javascript:alert(1)">bad link</a>
    </div>`;

  const result = extractHtmlPathway(hostile, BASE);

  it('strips scripts and frames from markup that will render in our origin', () => {
    expect(result!.fragment).not.toContain('<script');
    expect(result!.fragment).not.toContain('<iframe');
  });

  it('strips event handlers and javascript: URLs', () => {
    expect(result!.fragment).not.toContain('onclick');
    expect(result!.fragment.toLowerCase()).not.toContain('javascript:');
  });

  it('makes surviving links open away from the app', () => {
    expect(result!.fragment).toContain('rel="noopener noreferrer nofollow"');
  });
});
