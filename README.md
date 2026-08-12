# Pathway Mapper

**Ask a clinical question in plain language. Get turn-by-turn directions through
a clinical pathway, drawn on the pathway document itself.**

Not a summary of the pathway. Not a chatbot that has read it. The route: each
decision node lit in order, each arrow traced, everything off-route dimmed, and a
panel showing the document's own words for every step. The page underneath is the
original approved PDF.

---

## The problem

Every children's hospital publishes clinical pathways as flowchart PDFs. They
represent enormous committee effort and they are genuinely good. They are also
hard to use at the moment of care: you have to find the right one, then trace the
right line through it, holding a specific patient in your head.

The standard response is to rebuild the pathway inside the EHR as order sets and
alerts. That works, and it costs a build cycle per pathway, so most pathways never
get one. The published PDF stays the only artifact, and it stays static.

## What this does differently

It reads the PDF the way a person reads a flowchart — boxes, arrows, and the words
inside them — and turns the published document itself into the interface.

A clinician types *"5-week-old, brief apnoeic episode, first event, no CPR, well
appearing"* and the tool walks the pathway one decision at a time, lighting each
step on the page. Where the document determines the answer, it takes the step.
Where it doesn't, it stops and asks.

**Nothing is rebuilt, and nothing is replaced.** The approved document remains the
source of truth and the audit surface, which is exactly the property that makes
this defensible to a governance committee.

## Why it holds up

Four properties, in the order a reviewer usually asks about them:

**It cannot invent a step.** Routing may only follow arrows that were measured off
the page. The server validates every hop against real adjacency, so a route is by
construction a sequence of turns the document draws.

**It shows the document's words.** Node text is verbatim. Model-written prose
appears only in the "why this turn" note, kept visually separate.

**It asks instead of guessing.** When a fact needed for a branch is missing, the
tool stops and requests exactly that fact. Stopping to ask is a success state, not
a failure.

**The dangerous decisions aren't left to a model.** Where a branch is
safety-critical, the criteria are transcribed by hand into a rule table, tested
case by case, and given authority to overrule everything else. On the CHOP suicide
risk pathway, the C-SSRS acuity bands work this way — a model reads the facts, the
table decides the band.

Where the reading is uncertain, the pathway says so — the viewer carries a "how
this was read" note listing anything the extractor could not resolve.

## It already works across institutions

Three pathways, three hospitals, three completely different ways of drawing a
flowchart — and **no pathway-specific code**:

| Pathway | Institution | What made it different |
|---|---|---|
| Suicide risk assessment | CHOP | Connectors are filled rectangles; grey arrowheads |
| Brief Resolved Unexplained Event | Johns Hopkins All Children's | Connectors are single block-arrow polygons |
| Febrile infant | Upstate | Stroked polylines; decision diamonds and rounded boxes |
| Abdominal pain | Children's Mercy | Added from a URL; needed non-embedded font metrics |
| Physical abuse, ED | CHOP | **Not a PDF at all** — read from the page's own HTML |

Getting there required generalising the reader, not writing three readers — and
the two bugs that mattered were only visible *because* there were three documents.
One was a graphics-state bug that made arrows invisible. The other was a safety
leak: acuity was being inferred from box colour, and BRUE colours its
higher/lower-risk boxes red and green, which was enough to make a febrile-infant
pathway ask a clinician about suicidal ideation. Colour is a visual convention and
does not travel between institutions. Hand-written rules are now scoped by what a
document actually says.

A **fourth** — Children's Mercy's abdominal pain algorithm — was added later
straight from a URL, and read 30 steps and 19 connections with no code change at
all. Adding a pathway is a couple of minutes of automated preparation. There is
no programming step.

### Two readers, one pipeline

Institutions publish pathways as PDFs or as web pages, so there are two readers:

| | PDF | HTML |
|---|---|---|
| Boxes | stroked/filled shapes, classified by geometry | elements whose class says `outline` |
| Acuity | inferred from stroke colour | named in the class (`urgent`, `critical`) |
| Arrows | triangles and shafts, direction from geometry | class names the direction outright |
| Display | rendered to canvas by pdf.js | the institution's own markup, sanitised |

The HTML reader is the simpler of the two — the markup says what things are,
where vector geometry has to be measured and guessed at. Both emit the same
candidate graph, so labeling, decision compilation, routing and the overlay are
shared and neither knows where the graph came from.

Because the page is re-rendered without its author's stylesheet, an HTML pathway
looks close to but not exactly like the original. Positions come out right — the
viewer measures the real layout rather than trusting the server's arithmetic — so
the route always lands on the correct boxes, but typography and spacing differ.
Third-party markup is stripped of scripts, event handlers and frames before it is
ever stored.

## Where this sits in the literature

Informaticists will recognise the shape of this. It is close to a subset of
**GLIF** — the GuideLine Interchange Format (Ohno-Machado et al., *JAMIA* 1998)
and its execution engine GLEE (Wang et al., *JBI* 2004) — and the vocabulary here
follows theirs deliberately: *data items*, *criteria for proceeding*, *execution
trace*, and GLEE's **"system suggests, user controls"** posture.

The difference is where the work goes. GLIF's seven-stage lifecycle assumes a human
expert encodes the guideline at stage 2; GLEE serves stages 6–7. **That encoding
step is the bottleneck that kept computable guidelines from scaling** — GLIF,
Arden, PROforma, Asbru, EON and SAGE all specified well and were expensive to
populate. This attacks stage 2: derive the representation from the published
artifact rather than having a person author it. What changed since 2004 isn't the
model — it's the cost of filling it in. (Checking a derived reading is a much
smaller job than encoding one from scratch, though this MVP leaves that check to
the reader rather than building a workflow for it.)

GLIF also required institutions to adopt a shared format upstream. This reads what
they already publish, which is why three hospitals worked without anyone agreeing
on anything.

**GLIF's 1998 finding, reproduced.** That paper's central result was that two
independent encoders of the same guideline produced substantially different
representations. `npm run variability` measures the same thing here. It reproduces
— but localised: everything anchored to the document is stable (topology, entry
point, node roles, printed labels), and the divergence is confined to data-item
naming and rule decomposition, the two sources the 1998 paper named specifically.
Behaviourally, encodings largely agree. That is the argument for *measuring* a
guideline rather than encoding it: it doesn't eliminate encoder variability, it
relocates it somewhere a behavioural test can police.

Three of the four limitations GLIF named in 1998 show up here too. Temporal
representation and uncertainty in patient data are handled (timing is baked into
data-item values; "unknown" is a first-class answer that triggers a question).
Controlled vocabulary binding is not — data items are ad-hoc keys with no
SNOMED/LOINC codes, which would matter a great deal if this ever pulled facts from
a chart.

## Scope, honestly

This does **not** touch patient data. No EHR integration, no PHI, nothing at rest.
A clinician types what they know; questions aren't stored. That is a deliberate
scope choice, and it makes this a clinical *reference* tool rather than a
regulated decision support system.

Also not built: scanned or photographed pathways (it needs a real vector PDF), and
handoffs between pathways — the CHOP document links out to two others, and
following those links is the most obvious next step.

## Where it could go

Clinical pathways are published documents. A tool that navigates them without
touching patient data has no particular reason to stay inside one hospital — the
Johns Hopkins and Upstate pathways above were read with code written for CHOP's.
A shared, searchable layer over the pathways institutions already publish is a
realistic target, and the marginal cost per pathway is minutes rather than a build
cycle.

## No pathway documents are stored here

This repository contains **no clinical pathway PDFs**. They are other
organisations' published material, and there is no reason for a tool that reads
them to also redistribute them. `Resources/` and `data/` are gitignored; point
the tool at a link, or drop a local file in and it stays local.

Institutions that publish pathways openly, if you want something to try it on:

| Institution | Where |
|---|---|
| Children's Hospital of Philadelphia | [chop.edu/clinical-pathways](https://www.chop.edu/clinical-pathways) |
| Children's Mercy Kansas City | [childrensmercy.org — evidence-based practice](https://www.childrensmercy.org/health-care-providers/evidence-based-practice/) |
| Johns Hopkins All Children's | [hopkinsallchildrens.org — clinical pathways](https://www.hopkinsallchildrens.org/Health-Professionals/Clinical-Pathways) |
| Seattle Children's | [seattlechildrens.org — clinical standard work](https://www.seattlechildrens.org/healthcare-professionals/gateway/pathways/) |
| Cincinnati Children's | [cincinnatichildrens.org — evidence-based recommendations](https://www.cincinnatichildrens.org/service/j/anderson-center/evidence-based-care) |
| Upstate Golisano Children's | [upstate.edu](https://www.upstate.edu/golisano/) |

The extraction tests read documents from `Resources/`. They **skip** when the
files are not there, so a fresh clone runs green; download a couple of the above
into `Resources/` and they light up.

---

## Quick start

```bash
npm install
```

```bash
cp .env.example .env   # then add ANTHROPIC_API_KEY
```

Read a pathway straight from a link — either the PDF itself, or the page it sits
on (the PDF will be found for you):

```bash
npm run ingest -- "https://www.childrensmercy.org/siteassets/media-documents-for-depts-section/documents-for-health-care-providers/block-clinical-practice-guidelines/mobileview/abdominal-pain-community-providers-algorithm.pdf"
```

A landing page works too. If it links a PDF, that wins — it is the authoritative
artifact. If it has no PDF at all and renders the pathway as markup, as CHOP's
own pathway pages do, the markup is read instead:

```bash
npm run ingest -- "https://www.chop.edu/clinical-pathway/abuse-physical-clinical-pathway"
```

Or from a local file:

```bash
npm run ingest -- path/to/pathway.pdf --doc-id my-pathway
```

No API key yet? Extraction alone still gives you a usable document:

```bash
npm run ingest -- path/to/pathway.pdf --no-label
```

Then:

```bash
npm run dev
```

- `/` — pathway library; add one by link or by file
- `/p/<docId>` — viewer: ask a question, watch the route draw

## Using the viewer

Route playback follows the shape a navigation app uses:

| Phase | What the camera does |
|---|---|
| `routing` | Holds the whole page while turns stream in and light up |
| `touring` | Walks the turns one at a time, zoomed in, ~2.2s each |
| `overview` | Pulls back to frame the entire path |

Transport controls sit top-left of the document (prev / play-pause / next, then
**Replay**). Framing controls sit bottom-right: a pan pad whose centre button fits
the page, zoom with a live percentage, and a **frame the route** button. Any manual
pan or zoom pauses the tour rather than fighting it. Clicking any box jumps to it.

Starter cases under the question box are generated per pathway during ingest, so
they always match the document you are looking at.

## Onboarding a new pathway

```bash
npm run diagnose -- path/to/pathway.pdf   # what drawing vocabulary does it use?
npm run extract  -- path/to/pathway.pdf   # counts plus a debug SVG to eyeball
```

`diagnose` prints how the document is actually drawn — stroked versus filled,
colours, triangle and thin-rect counts. Start there when a document reads badly,
rather than guessing. `extract` writes a picture of every box and arrow found; if
that lines up with the page, everything downstream is on solid ground.

Expect geometry to find most edges and the labeling pass to fill a few gaps. On
the Upstate pathway it recovered three real connectors the geometry missed and
flagged two more as needing verification — that is the system working, not failing.

For a branch where being wrong is genuinely dangerous, do what was done for
acuity: transcribe the criteria by hand, write tests, and let them overrule
everything else. That is a deliberate half-day per critical branch.


---

# Architecture and implementation

## Why it's built this way

The obvious approach — show a model the flowchart and ask "what's the path?" —
fails the only test that matters for a document like a suicide risk pathway: you
cannot audit it, and a plausible-but-wrong edge produces a plausible-but-wrong
acuity. So the work is split by what each part is actually good at:

| Concern | Owner |
|---|---|
| Where the boxes and arrows are | Deterministic geometry (`lib/pdf/`) |
| What the boxes mean | The model, once, offline (`lib/llm/label.ts`) |
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
URL or PDF ─▶ extract ─▶ classify ─▶ infer ─▶ label ─▶ compile ─▶ graph.json
             vectors,    boxes,      nodes,   kinds,   data items
             text,       arrowheads, edges    labels,  + decision
             links       shafts               branches   table

question ─▶ traverse ─▶ Route{steps} ─▶ overlay: spotlight, trace, pan/zoom
            one legal hop at a time
```

## Tests and evals

```bash
npm test
```

Deterministic, no API key. The acuity and decision-table suites always run; the
extraction suites need pathway PDFs in `Resources/` and skip without them.

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

## Scope, in implementation terms

Vector PDFs only. Scanned pathways would need an OCR/layout pass (Docling or
similar) feeding the same `CandidateGraph` shape — the seam is there, the
implementation is not. Multi-pathway handoffs would use the link annotations
already extracted per node; nothing consumes them yet.

## Safety posture

A reference tool for navigating an approved document. Not triage, not medical
advice. Node text is always shown verbatim — the model's
prose appears only in the "why this turn" rationale, visually separated. Question
text is never persisted; the audit log records a hash, the graph version, and the
node sequence.

See [docs/extraction-notes.md](docs/extraction-notes.md) for how these PDFs are
drawn and which assumptions the extractor depends on.
