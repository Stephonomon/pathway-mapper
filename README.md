# Pathway Mapper

**Ask a clinical question in plain language. Get turn-by-turn directions through a
clinical pathway, drawn on the pathway document itself.**

A clinician types *"5-week-old, brief apnoeic episode, first event, no CPR, well
appearing"* and the tool walks the published pathway one decision at a time —
lighting each step on the original document, taking the step where the document
determines the answer, and stopping to ask where it doesn't. The page underneath
is the approved PDF (or the institution's own pathway web page), unchanged.

It is not a summary, and not a chatbot that has read the pathway. The route is
drawn on the source.

## The problem

Every children's hospital publishes clinical pathways as flowchart PDFs — the
product of enormous committee effort, and genuinely good. They are also hard to
use at the moment of care: you have to find the right one and trace the right line
through it while holding a specific patient in your head.

The usual fix is to rebuild each pathway inside the EHR as order sets and alerts,
which costs a build cycle per pathway — so most pathways never get one, and the
PDF stays static. Pathway Mapper turns the published document itself into the
interface. Nothing is rebuilt and nothing is replaced; the approved document stays
the source of truth.

## How it works

The document is read the way a person reads a flowchart — boxes, arrows, and the
words inside them — into a graph. A question is then routed through that graph one
legal hop at a time. Four properties make the route trustworthy:

- **It cannot invent a step.** Routing may only follow arrows measured off the
  page; every hop is validated against the real graph, so a route is by
  construction a sequence of turns the document draws.
- **It shows the document's words.** Node text is verbatim. Model-written prose
  appears only in the "why this turn" note, kept visually separate.
- **It asks instead of guessing.** When a fact a branch depends on is missing, the
  tool stops and asks for exactly that fact. Asking is a success state, not a
  failure.
- **The dangerous decisions aren't left to a model.** Where a branch is
  safety-critical, the criteria are transcribed by hand into a rule table, tested
  case by case, and given authority to overrule everything else. (On the CHOP
  suicide-risk pathway the C-SSRS acuity bands work this way: a model reads the
  facts, the table decides the band.)

Because it reads what institutions already publish, the same code works across
hospitals with no pathway-specific logic — it has been run on pathways from
several institutions that each draw their flowcharts differently. Pathways are
published either as PDFs or as web pages, and both are supported: a PDF is
rendered to canvas; an HTML pathway is re-rendered from the institution's own
(sanitised) markup. Either way the route lands on the real boxes. Where a reading
is uncertain, the viewer carries a "how this was read" note listing what the
extractor could not resolve.

## Getting started

Requires Node.js 20+ and an Anthropic API key.

```bash
npm install
cp .env.example .env    # then add your ANTHROPIC_API_KEY
```

Ingest a pathway straight from a link — the PDF itself, or the page it sits on
(the PDF is found for you):

```bash
npm run ingest -- "https://<institution>/path/to/pathway.pdf"
```

A local file works too:

```bash
npm run ingest -- ./path/to/pathway.pdf --doc-id my-pathway
```

No API key yet? Extraction alone still produces a usable document:

```bash
npm run ingest -- ./path/to/pathway.pdf --no-label
```

Then start the app:

```bash
npm run dev
```

- `/` — the pathway library; add one by link or by file
- `/p/<docId>` — the viewer; ask a question and watch the route draw

Run the tests (deterministic, no API key needed — the extraction suites skip when
no local pathway files are present, so a fresh clone runs green):

```bash
npm test
```

## Trying it on a real pathway

**This repository ships no clinical pathway documents.** They are other
organisations' published material, and there is no reason for a tool that reads
them to redistribute them — `data/` and `Resources/` are gitignored, so anything
you ingest stays local.

Point it at any institution that publishes pathways openly. A few to start with:

| Institution | Where |
|---|---|
| Children's Hospital of Philadelphia | [chop.edu/clinical-pathways](https://www.chop.edu/clinical-pathways) |
| Children's Mercy Kansas City | [childrensmercy.org — evidence-based practice](https://www.childrensmercy.org/health-care-providers/evidence-based-practice/) |
| Johns Hopkins All Children's | [hopkinsallchildrens.org — clinical pathways](https://www.hopkinsallchildrens.org/Health-Professionals/Clinical-Pathways) |
| Seattle Children's | [seattlechildrens.org — clinical standard work](https://www.seattlechildrens.org/healthcare-professionals/gateway/pathways/) |
| Cincinnati Children's | [cincinnatichildrens.org — evidence-based care](https://www.cincinnatichildrens.org/service/j/anderson-center/evidence-based-care) |

## Limitations

- **Not medical advice, and not triage.** This is a reference tool for navigating
  an approved document. It does not replace clinical judgement; verify every step
  against the document itself.
- **No patient data.** No EHR integration and no PHI — a clinician types what they
  know, and questions aren't stored (the audit log keeps only a hash, the graph
  version, and the node sequence). This deliberate scope choice keeps it a
  reference tool rather than a regulated clinical decision support system.
- **Vector PDFs only.** Scanned or photographed pathways would need an OCR/layout
  pass that isn't built.
- **HTML pathways aren't pixel-faithful.** The author's stylesheet isn't fetched,
  so typography and spacing differ from the original — but positions are measured
  at render time, so routes still land on the correct boxes.
- **No handoffs between pathways yet.** A document that links out to another
  pathway can't yet follow that link.
- **Safety rules are per-pathway.** Hand-written criteria (such as the C-SSRS
  acuity table) apply only to the document they were written for; adding a new
  safety-critical branch is a deliberate half-day of transcription and tests.

## For contributors

[`docs/extraction-notes.md`](docs/extraction-notes.md) describes how these PDFs are
drawn and which assumptions the extractor depends on — start there when onboarding
a pathway that reads badly. Two helper scripts make that quicker:

```bash
npm run diagnose -- ./path/to/pathway.pdf   # what drawing vocabulary it uses
npm run extract  -- ./path/to/pathway.pdf   # box/arrow counts plus a debug SVG
```

## License

Copyright © 2026 The Children's Hospital of Philadelphia. Made available under a
dual license — free for academic and non-profit research and educational use;
commercial use requires a separate written license. See [LICENSE.md](LICENSE.md).
