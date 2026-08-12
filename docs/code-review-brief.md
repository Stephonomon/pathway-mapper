# Brief for a code reviewer

Read this before reviewing. It says what the invariants are, where the risk is
concentrated, and what is deliberately out of scope — so the review lands on real
problems instead of restating the MVP's known shape.

## What this is

A tool that reads a published clinical pathway (a flowchart PDF, or a page whose
markup *is* the flowchart), turns it into a graph, and gives a clinician
turn-by-turn directions through it in response to a plain-language question — the
route drawn on the original document.

~6,800 lines of TypeScript. Next.js App Router, Zod, AI SDK (Anthropic),
pdfjs-dist, node-html-parser. 77 tests, `npm test`.

## Verify it still works

```bash
npm install && npm run typecheck && npm test && npm run build
```

`npm test` needs no API key. 25 of the 77 tests read pathway PDFs from
`Resources/`, which is gitignored — they **skip** when it is empty, which is
expected on a fresh clone, not a failure.

Needs an `ANTHROPIC_API_KEY` and an ingested pathway:

```bash
npm run eval -- <docId>   # 8 clinical vignettes end to end
npm run factbench         # extraction accuracy by model
npm run variability       # how much two encodings of one document differ
```

## The five invariants

A change that breaks one of these is a serious finding regardless of how it
looks. They are what makes the tool defensible rather than a chatbot with a PDF.

1. **The graph owns the topology.** Routing may only follow edges that were
   measured off the document. `lib/llm/traverse.ts` validates every hop against
   real adjacency and rejects anything else. A model must never be able to
   describe a jump the document does not draw.
2. **Node text is verbatim.** Model prose appears only in the "why this turn"
   rationale, visually separated. Nothing paraphrases clinical content.
3. **Ambiguity produces a question, not a guess.** `needs_input` is a success
   state. An unknown fact must never look like a decision — see
   `lib/decisions/evaluate.ts`, which asks when a rule is *blocked* by a missing
   fact rather than committing to a branch that merely happens to fire.
4. **Acuity is decided by a hand-written table, not a model.**
   `lib/rules/acuity.ts` transcribes the C-SSRS criteria; `verifyAcuity` in
   `traverse.ts` has the last word and can override the compiled table. If it
   cannot rule out a more severe band, nobody advances.
5. **Hand-written rules are scoped by document content, not appearance.**
   `lib/rules/registry.ts`. This exists because acuity was once inferred from box
   colour, and an infant apnoea pathway (whose risk boxes are red and green) began
   asking clinicians about suicidal ideation.

## Where the risk actually is

Ranked. Start at the top; a fast shallow pass over everything is worth less than
a careful look at these.

1. **`lib/fetchPathway.ts`** — takes a user-supplied URL and fetches it
   server-side. Guards: HTTPS only, private/loopback rejected, 30MB cap, timeout,
   redirects re-validated per hop. **Known gap I would like a view on:** the DNS
   check and the actual fetch are separate, so a rebinding attack is not
   prevented. Is that worth fixing at MVP scope, and what else is missing?
2. **`lib/html/extract.ts` — the `sanitize` function.** Third-party markup is
   stored and later rendered inside our origin via `innerHTML` in a shadow root
   (`components/HtmlPathwayStage.tsx`). It strips script/iframe/object/embed/form,
   `on*` handlers, and `javascript:` URLs. **Is that sufficient?** I have not
   thought hard about `<svg>`, `data:` URLs, `srcset`, or CSS-based vectors.
3. **`lib/llm/traverse.ts` (642 lines)** — the largest and most intricate file.
   The interaction between the compiled decision table, the acuity verifier and
   the model fallback is the part most likely to hide a logic error. Specifically:
   can any path advance through an acuity fork *without* `verifyAcuity` having
   agreed or abstained?
4. **`lib/pdf/primitives.ts` and `lib/pdf/infer.ts`** — heuristics tuned against
   four institutions' documents. Look for thresholds that are load-bearing but
   arbitrary, and for places where a shape from a fifth institution would be
   silently misclassified rather than reported.
5. **`components/PathwayViewer.tsx` (604 lines)** — viewport maths, a phase
   machine, and streaming state. Two bugs already found here: an effect that
   snatched back manual pans, and a measurement loop that hit React's update
   limit. Look for more of that shape.
6. **`lib/store.ts`** — module-level `graphCache` is unbounded and never evicted.
   Fine for four pathways, not for a library.

## Known-silent failure modes

These are the bugs this codebase has actually had. They share a property: the
pipeline still produces a plausible result, so nothing looks wrong.

- **Coordinate-space flips.** PDF operator-list paths are bottom-left origin;
  text and annotations are top-left. Get it wrong and boxes still look fine, they
  just contain the wrong text. Pinned by a test asserting the low-acuity box
  contains "Wish to Be Dead".
- **Graphics-state leakage.** `q`/`Q` restore colour as well as transform.
  Tracking only the CTM produced arrows filled white on a white page, which were
  then discarded as "not ink" — silently dropping every connector in one document.
- **Cross-pathway contamination.** Content or rules written for one document
  leaking onto another. This has happened twice: once in the acuity rules, once in
  the UI (suicide-risk prompts and the 988 crisis line appearing on a febrile
  infant pathway). Worth actively hunting for a third instance.
- **Post-transform measurement.** `getBoundingClientRect()` includes ancestor
  transforms; the viewer scales its stage. Forgetting to divide that out scaled
  geometry twice.

## Deliberately out of scope — please do not flag

- **No patient data, no EHR integration, no auth.** Chosen scope. It is a
  reference tool, not a regulated CDS system.
- **Filesystem store rather than a database.** A pathway graph is a small,
  readable artifact; `data/` is gitignored.
- **No human review/sign-off workflow.** It existed and was deliberately removed
  as MVP scope. Do not suggest reinstating it.
- **No pathway documents in the repo.** Other organisations' material, removed on
  purpose. Tests skip without them.
- **HTML pathway rendering is not pixel-faithful.** The author's stylesheet is
  not fetched, so typography and spacing differ from the original. Positions are
  measured at render time, so routes land correctly; this is a known trade-off,
  documented in the README.
- **Prompt wording**, unless it can produce an unsafe outcome.

## What a good finding looks like

A concrete failure: an input, the wrong behaviour it produces, and why it
matters. Ranked by whether a clinician could be misled. Highest value is anything
that breaks one of the five invariants, or a third instance of cross-pathway
contamination.

Lowest value is style, naming, or restating the scope decisions above.
