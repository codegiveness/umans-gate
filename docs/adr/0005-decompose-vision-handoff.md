# Decompose VisionHandoff into focused collaborators

`VisionHandoff` (`src/vision/handoff.ts`) had grown to 1605 lines and mixed about 6 responsibilities: catalog gating, image detection, batch triage, per-image lifecycle (transcode + cache + vision call + inflight dedup + DB write + sink), body rewriting, and background-mode fire-and-forget. Pure helpers (`detect.ts`, `wrapper.ts`, `triage.ts`, `craft.ts`, `decompose.ts`, `cache.ts`, `transcode.ts`, `sink.ts`, `persistent-cache.ts`) were already extracted as modules, but the orchestration of those helpers was inlined as three ~200-line methods inside `VisionHandoff`.

## Decision

The proxy will decompose `VisionHandoff` incrementally into focused collaborators, keeping the public API (`processBody` / `processBodyCacheOnly`) unchanged so the 5 source-file callers and 15 test files need no changes during migration.

**Extraction steps (in order, each independently shippable):**

1. **Move `replaceImageBlocks` into `vision/wrapper.ts`**: it is a
   pure body-walking function that belongs next to `wrapDescription`
   and `applyMaxImagesPolicy`. `VisionHandoff` imports it.

2. **Extract `VisionImageProcessor`**: a new class owning the
   per-image lifecycle: cache lookup → inflight dedup → transcode →
   DB insert → vision call (`callVisionRecorded`) → cache store → DB
   update → sink record. Dependencies (cache, gate, db, sink, transcode
   fn, config) are injected. `VisionHandoff` delegates the per-image
   loop to it.

3. **`VisionHandoff` becomes thin**: after steps 1-2, it is just:
   catalog gate → cheap signal → extract parts → max-images policy →
   batch triage → delegate to `VisionImageProcessor` → delegate to
   `VisionBodyRewriter` (the `wrapper.ts` functions).

**NOT extracting:** the 4 strategy branches (generic/slotted/crafted/
decomposed) inside `callVisionRecorded` stay as inline branches. A
`switch` over 4 stable cases is readable, and the strategies map to
cache keys so changing them is a breaking change by design. Extracting
a `VisionRequestBuilder` strategy pattern would be premature.

## Alternatives considered

- **Big-bang refactor**: extract everything in one PR. Rejected
  because the 15-test blast radius makes the diff unreviewable and
  blocks the whole refactor if any test breaks.
- **Strangler pattern with a new `VisionPipeline` facade**: add a
  parallel class and migrate callers one at a time. Rejected as
  overkill for a single-repo, single-author project.
- **Strategy pattern for `callVisionRecorded`**: 4 builder classes
  implementing a `VisionRequestBuilder` interface. Rejected as
  premature abstraction for 4 stable branches.

## Consequences

- `handoff.ts` shrinks from ~1605 to ~638 lines; the extracted logic
  lives in `wrapper.ts` (pure functions, already exists) and a new
  `vision/image-processor.ts` (~400 lines).
- The public API is unchanged; `proxy.ts`, `index.ts`, `viewer.ts`,
  `db.ts`, and `vision/sink.ts` keep importing `VisionHandoff`.
- The 15 existing tests serve as a regression net at each extraction
  step: if a step breaks a test, the blast radius is one extraction,
  not the whole refactor.
