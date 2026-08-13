# Pathway Mapper

**Ask a clinical question in plain language. Get turn-by-turn directions through a
clinical pathway — the route drawn on the pathway document itself, not just the
answer at the end of it.**

A clinician types *"5-week-old, brief apnoeic episode, first event, no CPR, well
appearing"* and the tool walks the published pathway one decision at a time,
lighting each step on the original document, showing the factor that drove each
turn, and stopping to ask where the document leaves the choice open. The
recommended step is still there at the end — but it arrives as the last stop on a
route you watched being built, not as a verdict you have to take on faith.

It is not a summary of the pathway, and not a chatbot that has read it. The route
is drawn on the source.

## Why this exists

A clinical pathway is not an answer key. It is a piece of *reasoning* — laid out
step by step, the product of enormous committee effort, so a clinician can follow
the logic from presentation to disposition. That stepwise structure is the whole
point: it shows which factors matter, in what order, and where the decision could
reasonably go a different way.

Those pathways are genuinely good, and also hard to use at the moment of care: you
have to find the right one and trace the right line through it while holding a
specific patient in your head. The obvious thing to do with an LLM is to remove
that friction by collapsing the pathway into a question-and-answer box — type the
patient, get the recommended step. It works. It also throws away the most valuable
part.

**What gets lost is the work.** The user is handed a destination with no route.
They can't see *how* the answer was reached, which factors drove it, or whether a
different, equally defensible path was available. And when the answer is one they
might disagree with, they have no view of where they would have turned off. Asking
the model to "show its work" after the fact doesn't fix this — a fluent model will
narrate a plausible-sounding rationale that may not be what actually produced the
answer.

**Think of navigation software.** If it only ever told you the destination, you
would have no way to judge whether the route was sensible, no view of the
alternatives, and no ability to say *"not that way — take this road instead."* The
route is what earns your trust. Seeing it turn by turn is what lets you follow it,
question it, and override it.

Pathway Mapper applies that idea to clinical pathways. Instead of collapsing the
pathway into an answer, it draws the **route**: each decision lit in order on the
original document, the factor behind each turn shown beside it, and the branch
points where the clinician could reasonably choose to go another way left visible.
The document stays the source of truth, and the reasoning stays inspectable —
because the route you see *is* the computation, validated step by step against the
document, not a story told about it afterwards.

## How it works

The document is read the way a person reads a flowchart — boxes, arrows, and the
words inside them — into a graph. A question is then routed through that graph one
legal hop at a time. Four properties are what make the visible reasoning
trustworthy rather than decorative:

- **It cannot invent a step.** Routing may only follow arrows measured off the
  page; every hop is validated against the real graph. A route is by construction
  a sequence of turns the document actually draws — so the steps you see are the
  steps that happened.
- **It shows the document's words.** Node text is verbatim. Model-written prose
  appears only in the short "why this turn" note beside each step, kept visually
  separate from the pathway's own language.
- **It asks instead of guessing.** When a fact a branch depends on is missing, the
  tool stops and asks for exactly that fact rather than picking for you. Asking is
  a success state — it keeps a real decision point visible instead of papering over
  it.
- **The dangerous decisions aren't left to a model.** Where a branch is
  safety-critical, the criteria are transcribed by hand into a rule table, tested
  case by case, and given authority to overrule everything else. (On the CHOP
  suicide-risk pathway the C-SSRS acuity bands work this way: a model reads the
  facts, the table decides the band.)

Because it reads what institutions already publish, the same code works across
hospitals with no pathway-specific logic. Pathways are published either as PDFs or
as web pages, and both are supported: a PDF is rendered to canvas; an HTML pathway
is re-rendered from the institution's own (sanitised) markup. Either way the route
lands on the real boxes. Where a reading is uncertain, the viewer carries a "how
this was read" note listing anything the extractor could not resolve.

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
  against the document itself. Its purpose is to make the reasoning visible, not to
  make the decision for you.
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
