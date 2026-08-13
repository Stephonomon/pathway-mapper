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

## 🎥 Video Demo
[docs/path_mapper_image.png](https://youtu.be/0SLkzHFWGb0)


## Why this exists

Clinical pathways are built to guide **diagnostic and process reasoning** in a
stepwise, methodical way. The step-by-step structure is not incidental — it *is*
the pathway. It shows which factors matter, in what order, and where a decision
could reasonably go another way.

There is growing interest in pointing an LLM at these documents so a user can type
a question and get an answer directly. The problem is what that loses: **the
step-by-step process and reasoning the model used to reach the answer.** If you put
a pathway straight into an LLM, it can certainly attempt to answer — but you have
no true indication that it actually *followed the reasoning steps in the pathway*
to get there. And asking the model to "show its work" after the fact doesn't
settle it, because a fluent model can narrate a plausible account that isn't what
actually drove the answer.

This project is a mock-up of a way to **show those reasoning steps** — a visual,
turn-by-turn trace through the pathway, with the factor behind each decision
surfaced alongside it, so a user can see not just the recommendation but the
factors that led to it. That matters most when a user disagrees: to override the
algorithm sensibly, they need to see where it turned, and what other turn was on
offer.

**The inspiration is navigation software.** If you are only ever given the
destination, you have no way to judge whether the route was efficient, and no
awareness of the alternative routes you might take instead. You are left unable to
question the route, and unaware of the other paths you could choose if you wanted
to override it. Showing the route, turn by turn, is what lets a user follow it,
question it, and knowingly go a different way.

Crucially, this provides that transparency **without destroying the source
document.** The pathway is not flattened into rules or absorbed into a model; it
stays intact and on screen, and the same reader works across different pathways
because it reads what institutions already publish rather than a re-encoding of it.

That fidelity is becoming a practical concern. As organisations move to bring their
local pathways into LLM-based clinical decision support — embedded in the EHR or
alongside it — the worry is losing exactly what the pathway was for: the reasoning
steps that illustrate *why* a decision is made, not just *what* it is. Keeping the
route visible, and anchored to the original document, is one way to bring pathways
into these systems without giving that up.

## How it works

The document is read the way a person reads a flowchart — boxes, arrows, and the
words inside them — into a graph. A question is then routed through that graph one
legal hop at a time. Four properties are what let you trust that the route reflects
the pathway's own reasoning, and not the model's improvisation:

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
