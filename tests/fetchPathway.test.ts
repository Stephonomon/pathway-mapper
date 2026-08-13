/**
 * URL resolution: a pathway page that renders its own diagram must be read as
 * HTML, even when it cites a third-party PDF. Before the same-site rule, a CHOP
 * asthma page that links the NHLBI guideline PDF ingested the NHLBI document
 * instead of the CHOP pathway — the wrong document, silently.
 */

import { describe, expect, it } from 'vitest';
import {
  findPdfLinks,
  hasPathwayMarkup,
  isSameSite,
  registrableDomain,
} from '@/lib/fetchPathway';

describe('registrableDomain / isSameSite', () => {
  it('treats subdomains of one institution as the same site', () => {
    expect(registrableDomain('media.chop.edu')).toBe('chop.edu');
    expect(isSameSite(new URL('https://media.chop.edu/a.pdf'), new URL('https://www.chop.edu/x'))).toBe(
      true,
    );
  });

  it('separates a third-party host from the pathway host', () => {
    expect(isSameSite(new URL('https://www.nhlbi.nih.gov/g.pdf'), new URL('https://www.chop.edu/x'))).toBe(
      false,
    );
  });
});

describe('CHOP asthma page shape', () => {
  const base = new URL('https://www.chop.edu/clinical-pathway/asthma-emergent-care-clinical-pathway');
  const page = `
    <html><body>
      <div class="pathway">
        <div class="outline" style="position:absolute; top:0; left:0; width:200px; height:20px;">Assess severity</div>
      </div>
      <a href="https://www.nhlbi.nih.gov/sites/default/files/media/docs/12-5075.pdf">NHLBI asthma guidelines</a>
    </body></html>`;

  it('still finds the cited PDF', () => {
    expect(findPdfLinks(page, base)).toContain(
      'https://www.nhlbi.nih.gov/sites/default/files/media/docs/12-5075.pdf',
    );
  });

  it('but the cited PDF is off-site, so the page markup wins', () => {
    const candidates = findPdfLinks(page, base);
    const sameSite = candidates.filter((c) => isSameSite(new URL(c), base));
    expect(sameSite).toHaveLength(0); // nothing on chop.edu to override the page
    expect(hasPathwayMarkup(page)).toBe(true); // …and the page is itself the pathway
  });
});

describe('a page that links its own PDF', () => {
  const base = new URL('https://www.example.org/clinical-pathway/sepsis');
  const page = `
    <a href="/media/sepsis-algorithm.pdf">Sepsis algorithm (PDF)</a>
    <a href="https://cdn.other.org/reference.pdf">Background reference</a>`;

  it('prefers the same-site PDF over an off-site one', () => {
    const candidates = findPdfLinks(page, base);
    const sameSite = candidates.filter((c) => isSameSite(new URL(c), base));
    expect(sameSite).toEqual(['https://www.example.org/media/sepsis-algorithm.pdf']);
  });
});
