# Pathway Mapper

Ask a question in plain language; get turn-by-turn directions through a clinical
pathway, drawn on the pathway document itself.

The Google Maps analogy is load-bearing. You don't get a destination — you get
the route: each decision node lit in order, each arrow traced, and a panel
telling you why the pathway sent you down that branch. Everything off-route dims.
The document underneath is the original, unmodified PDF.

## Why it's built this way

The obvious approach — show a model the flowchart and ask "what's the path?" —
fails the only test that matters for a document like a suicide risk pathway: you
cannot audit it, and a plausible-but-wrong edge produces a plausible-but-wrong
acuity. So the work is split by what each part is actually good at:

| Concern | Owner |
|---|---|
| Where the boxes and arrows are | Deterministic geometry (`lib/pdf/`) |
| What the boxes mean | The model, once, offline (`lib/llm/label.ts`) |
| Whether that reading is correct | A human, once, in `/review/[docId]` |
| Which branch this patient takes | The model, one legal hop at a time (`lib/llm/traverse.ts`) |
| Acuity | A decision table, not the model (`lib/rules/acuity.ts`) |

**The graph owns the topology.** At each hop the model sees only the current
node's verbatim text and the edges that actually leave it, and returns one edge
id. The server validates it against real adjacency and rejects anything else. A
route is therefore, by construction, a sequence of turns the document draws.

**Ambiguity produces a question, not a guess.** `needs_input` is a success state.

**Acuity is not a model decision.** The C-SSRS bands in this pathway are a
literal decision table. The model's only role is reading structured facts out of
free text; the table decides the band, and a contradicting choice is overridden
with the discrepancy recorded on the route.

A decisive band constrains the whole *upstream* route, not just the fork where
the bands appear: branches from which the required acuity box is no longer
reachable are removed before the model chooses. That is what stops "15yo with an
overdose attempt six weeks ago, currently denies any ideation" from being routed
out at "negative screen" — behavior within 3 months is high acuity regardless of
current ideation. The override deliberately stops at the band entry: the choices
*below* it (this pathway labels them "Standard" and "Enhanced") are clinical
judgement the document leaves open, and forcing those would be overstepping.

## What is precomputed, and why it matters

Everything that can be done once per document is done once per document. At
ingest a pathway gets extracted, labeled, **and compiled into a decision table**;
at query time the router extracts facts and looks things up.

| Stage | When | Cost |
|---|---|---|
| PDF → geometry → nodes/edges | ingest | deterministic, ~300ms |
| Labeling (kinds, conditions, entry) | ingest | one reasoning call |
| **Decision-table compilation** | ingest | one reasoning call |
| Graph load at query time | cached in memory | ~0.3ms |
| Fact extraction | per question | two concurrent fast-model calls |
| Fork resolution | per question | table lookup, no model |

The compile step is the one that matters. A pathway's forks are decision tables:
what varies per patient is a small set of facts, and which branch those facts
imply is fixed by the document and identical for every user forever. So
`lib/decisions/compile.ts` derives, per pathway, the variables it branches on and
a rule table per fork — and `lib/decisions/evaluate.ts` then resolves forks with
no model in the loop.

It also marks forks the document *does not* determine (this pathway's "Standard"
vs "Enhanced") as `judgementCall`, with the question and options precomputed. So
a fork that needs a human costs zero model calls to discover — and the answer
selects the edge directly.

Measured on the reference pathway, `"16yo … thinking about taking all of his
mother's pills … intends to do it"`:

| | before | after |
|---|---|---|
| time to first step | 9,578ms | **8ms** |
| full route | 16,070ms | **1,351ms** |
| resuming after an answer | — | **1,707ms** |
| reasoning-model calls per query | 1–4 | **0** |

### Why fact extraction is two calls, not one

`lib/decisions/extract.ts` is a single API returning a single result, but it
issues two concurrent requests: one for the compiled variables, one for the
canonical C-SSRS block that the acuity verifier reads.

Merging them into one schema is the obvious consolidation, and it was tried and
measured. It costs accuracy: on the `factbench` vignettes Haiku scored 7/7 on the
C-SSRS schema alone, but **7/7, 6/7, 5/7** across three runs of the merged
schema — and the recurring failure was an under-triage, not a safe "ask". Filling
pathway-specific variables and the C-SSRS block in one pass makes the model worse
at both. Separated and run concurrently, it is 7/7 three runs out of three.

Wall clock is `max(a, b)`, not `a + b`, so the only thing merging would have saved
is one cheap request — at the price of the safety-critical read.

### Who decides acuity

The compiled table proposes a band; `verifyAcuity` in `lib/llm/traverse.ts`
checks it against the hand-written criteria and has the last word:

- **agrees** → the step is recorded with the criteria as its rationale
- **disagrees** → the route is overridden to the correct band and the
  discrepancy is written into `route.notes`
- **cannot rule out a more severe band** → nobody advances; the clinician is
  asked, starting with whatever would rule out the *most severe* band

Compiled rules are validated hard before storage: a rule may only reference edges
that leave its own fork, variables that were declared, and values those variables
can take. Anything else is dropped with a warning. And the compiled table is
explicitly **not** allowed to route acuity — `lib/rules/acuity.ts` is
hand-written and hand-tested against the printed C-SSRS criteria, and keeps
exclusive control of that fork.

## Pipeline

```
PDF ─▶ extract ─▶ classify ─▶ infer ─▶ label ─▶ review ─▶ graph.json
      vectors,    boxes,      nodes,   kinds,   human
      text,       arrowheads, edges    labels,  signoff
      links       shafts               branches

question ─▶ traverse ─▶ Route{steps} ─▶ overlay: spotlight, trace, pan/zoom
            one legal hop at a time
```

## Quick start

```bash
npm install
```

```bash
cp .env.example .env   # then add ANTHROPIC_API_KEY
```

Ingest the sample pathway (this runs extraction *and* labeling):

```bash
npm run ingest -- "Suicide Risk Assessment and Care Planning Clinical Pathway – Outpatient _ Children's Hospital of Philadelphia.pdf" --doc-id suicide-risk-outpatient
```

No API key yet? Extraction alone still gives you a usable document:

```bash
npm run ingest -- path/to/pathway.pdf --no-label
```

Then:

```bash
npm run dev
```

- `/` — pathway library and upload
- `/p/<docId>` — viewer: ask a question, watch the route draw
- `/review/<docId>` — inspect and correct the extraction, then sign off

## Using the viewer

Route playback follows the shape a navigation app uses, in three phases:

| Phase | What the camera does |
|---|---|
| `routing` | Holds the whole page while turns stream in and light up — you watch the route get built |
| `touring` | Walks the turns one at a time, zoomed in, ~2.2s each |
| `overview` | Pulls back to frame the entire path |

Transport controls sit top-left of the document: prev / play-pause / next, and
**Replay** once the tour has finished. Clicking a step in the side panel jumps
the camera to that turn.

Framing and manual controls sit bottom-right: a pan pad (its centre button fits
the whole page), zoom in/out with a live percentage, and a **frame the route**
button. Any manual pan or zoom pauses the tour rather than fighting it — the
camera stops chasing you until you press play again.

Clicking any box on the document jumps to it, whether or not it is on the route.

## Verifying extraction on a new document

The debug SVG is the fastest way to judge whether a new pathway extracted
cleanly:

```bash
npm run extract -- path/to/pathway.pdf data/debug
```

It prints the node/edge summary and writes `data/debug/page-1.svg` with every
detected box and traced arrow. On the reference document you should see:

```
page 1: 22 nodes, 21 edges, 0 unresolved arrowheads
```

## Tests and evals

```bash
npm test
```

Deterministic, no API key: the extraction golden test (which catches the
coordinate-space flip that is otherwise silent) and the full acuity decision
table.

```bash
npm run factbench
```

Compares models on fact-extraction accuracy and latency across the C-SSRS
vignettes. This is how `DEFAULT_FAST_MODEL` was chosen: Haiku 4.5 scored 7/7 at
~1.3s, matching Opus's accuracy at a quarter of the latency, while Sonnet 5
scored 6/7.

```bash
npm run eval -- suicide-risk-outpatient
```

Calls the model and costs money. Eight clinical vignettes covering negative
screen, all three acuity bands, and two deliberately underspecified cases that
must return `needs_input`. Run it on every prompt or guardrail change.

## Scope

Vector PDFs only. Scanned pathways would need an OCR/layout pass (Docling or
similar) feeding the same `CandidateGraph` shape — the seam is there, the
implementation is not.

Also not built: multi-pathway handoffs (this document links out to the Depression
and Behavioral Health ED pathways), and any Epic/SMART-on-FHIR patient context.

## Safety posture

Clinician-facing decision support for navigating an approved document. Not
triage, not medical advice. Node text is always shown verbatim — the model's
prose appears only in the "why this turn" rationale, visually separated. Question
text is never persisted; the audit log records a hash, the graph version, and the
node sequence.

See [docs/extraction-notes.md](docs/extraction-notes.md) for how these PDFs are
drawn and which assumptions the extractor depends on.
