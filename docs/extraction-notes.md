# How clinical pathway PDFs are drawn

## The headline: there is no single convention

Three pathways from three institutions use three incompatible drawing
vocabularies. A classifier tuned to one finds **zero edges** in the others — and
fails silently, because the pipeline still produces a graph, just an unusable
one.

| | CHOP | Johns Hopkins (BRUE) | Upstate (febrile infant) |
|---|---|---|---|
| Connectors | thin **filled rects** | 7-point **block-arrow polygons** | **stroked polylines** |
| Arrow heads | grey filled triangles | (part of the block arrow) | black filled triangles |
| Node shapes | rectangles | rectangles | rounded rects + **diamonds** |
| Stroke colour | explicit grey | **null** (PDF default black) | explicit black |
| Link annotations | 103 | 0 | 0 |

`lib/pdf/primitives.ts` therefore runs shape detectors side by side rather than
assuming a convention. `tests/crossInstitution.test.ts` pins all three so
tightening a heuristic for one cannot quietly break the others.

Two general lessons came out of this, both of which cost real debugging time:

1. **`q`/`Q` restore the whole graphics state, not just the transform.** Tracking
   only the CTM leaves colour stale after every restore. The symptom was
   impossible ink — arrows filled white on a white page — and the consequence was
   every connector in the BRUE pathway being discarded as "not ink".
2. **Colour is a visual convention and does not travel.** Acuity bands were being
   detected from stroke colour, and BRUE colours its higher/lower-risk boxes red
   and green. That was enough to engage the C-SSRS ruleset on a febrile-infant
   pathway and ask the clinician about suicidal ideation. Hand-written rulesets
   are now scoped by document *content* — see `lib/rules/registry.ts`.

## Onboarding a new pathway

```bash
npm run diagnose -- path/to/pathway.pdf   # what vocabulary does it use?
npm run extract  -- path/to/pathway.pdf   # counts + a debug SVG to eyeball
```

`diagnose` prints the actual drawing vocabulary — stroked vs filled, colours,
triangle and thin-rect counts, and whether arrowheads might be typographic
glyphs. Start there when a document extracts badly, rather than guessing.

---

# The CHOP reference document in detail

Findings from reverse-engineering
`Suicide Risk Assessment and Care Planning Clinical Pathway – Outpatient`. These
are what the deterministic extractor in `lib/pdf/` keys off, so if extraction
regresses on a new document, start here.

## Document shape

- Single page, **vector** (not scanned), US Letter (612 × 792).
- The content stream's first operator is `cm [0.24, 0, 0, -0.24, 0, 792]` — the
  document is authored in a top-down 2550 × 3300 space and flipped into PDF user
  space by that matrix.

## Coordinate spaces (the one thing that will bite you)

Three sources, two different origins:

| Source | Native space |
|---|---|
| `getOperatorList()` paths | PDF user space, **bottom-left** origin |
| `getTextContent()` items | PDF user space, **bottom-left** origin (baseline at `transform[5]`) |
| `getAnnotations()` rects | PDF user space, **bottom-left** origin |

`lib/pdf/extract.ts` converts all three into a single canonical space:
**top-left origin, page units** — the space `page.getViewport({ scale: 1 })`
renders into, so extracted bboxes drop onto the canvas overlay untouched.

For paths this means seeding the CTM stack with `[1, 0, 0, -1, 0, pageHeight]`
rather than the identity. Getting this wrong is silent: boxes still look
plausible, they just contain the wrong text. The regression test asserts that the
low-acuity box contains "Wish to Be Dead", which only holds in the right space.

## Shape vocabulary

| Element | How it is drawn |
|---|---|
| Node box | Stroked axis-aligned rect + a white fill at the same coords |
| Node title bar | A second stroked rect, same width and colour, stacked flush on top |
| Arrow shaft | **Filled** thin rect (~0.7 units) in connector grey `#ababab` |
| Arrow head | **Filled** 3-point triangle, ~3.7 × 3.7, same grey |
| Hyperlink underline | Filled thin rect in link blue `#858fd9` — ignore |
| Branch label | Loose text beside an arrow, inside **no** box ("Standard", "Enhanced") |

There are **no stroked polylines anywhere**. Connectors are filled rectangles.
An extractor that looks for `stroke`d lines finds zero edges on this document.

Branch labels belong to no node, so node-text assignment never sees them.
`attachEdgeLabels` in `lib/pdf/infer.ts` picks up orphan text runs and attaches
each to the nearest arrow polyline. Without it, the six risk-formulation →
care-plan edges have no stated condition at all, and the router has nothing to
reason about at that fork.

## Acuity encoding

Stroke colour on the acuity boxes carries clinical meaning:

| Colour | RGB | Band |
|---|---|---|
| Green | `0.537, 0.788, 0.475` | Low acuity |
| Yellow | `0.816, 0.812, 0.435` | Intermediate acuity |
| Red | `0.910, 0.694, 0.663` | High acuity |
| Slate | `0.737, 0.788, 0.812` | Ordinary process node |

## Citations come free

103 link annotations anchor `chop.edu/clinical-pathway/...` URLs to specific text
spans (C-SSRS, risk formulation, red flags, case examples, IOP/partial program
lists). Assigning them to nodes by containment gives every node its own citations
with no model involvement.

## Expected extraction result

```
page 1: 22 nodes, 21 edges, 0 unresolved arrowheads
```

with the spine `Patient with Possible Suicide Risk → Screen → Positive/Negative →
C-SSRS → Low/Intermediate/High Acuity → Risk Formulation → Care Plan → Initiate
Care, Maintain Engagement`.
