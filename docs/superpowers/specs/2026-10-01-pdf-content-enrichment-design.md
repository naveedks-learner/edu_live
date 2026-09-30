# PDF content enrichment layer (formulas, tables, images)

**Status:** Implemented on branch `feature/pdf-content-enrichment`
**Author:** Claude (drafted while user was away, per explicit instruction to prepare a ready-to-build design)

## Problem

`worker/src/pdf.ts` extracts PDF text via `unpdf` (PDF.js-based), page by page,
text-only. Formulas, tables, and diagrams/figures are either dropped entirely
or come through as garbled/incomplete text (PDF.js text extraction flattens
table layout and cannot represent formulas or images at all). This directly
hurts answer quality on questions that depend on that content — the user
specifically flagged 5-mark questions, which often require reproducing a
formula, a labeled diagram, or tabulated data.

There is currently **no** image/table/formula handling, no OCR, and no
layout awareness anywhere in the ingestion pipeline (confirmed by code
search — zero hits beyond incidental text matches).

## Goal

Before chunking, convert each uploaded PDF's content into a text
representation that *preserves* formulas (as LaTeX or clearly-delimited
notation) and tables (as Markdown tables) — so retrieval and generation can
work with that content the same way they work with plain prose today.

**Additionally**, when a page contains a figure/diagram/photo (including one
embedded inside a table cell — confirmed present in real source PDFs, e.g. a
molecular structure GIF embedded within a nomenclature table), the actual
image must be reproducible to the student asking the question, not just
described in text. A text-only chat model cannot emit back the original
image bytes it was shown, so this requires capturing the real pixels from
the PDF and serving them to the frontend — see "Image capture and serving"
below, which is additive to the Markdown-enrichment approach, not a
replacement for it.

## Constraints that shape the design

- **Cloudflare Workers runtime**: no native binaries, no Canvas/DOM (so no
  in-Worker PDF page rasterization — this is why the existing code uses
  `unpdf`, a pure-JS/PDF.js text extractor, instead of poppler/pdf2image-style
  tools). 128MB memory ceiling, CPU-time cap per request (but **CPU time does
  not include time spent awaiting an external `fetch`**, which matters a lot
  here — see below).
- No Queues, no Durable Objects currently in this codebase. Ingestion today
  runs synchronously inside one `POST /ingest` request.
- Ingestion is an **admin-only, low-frequency** action (document upload), not
  a per-user-question hot path — unlike the chat LLM call, it can tolerate
  materially higher latency and per-call cost without users noticing.
- We already have an OpenRouter integration (`worker/src/llm.ts`, shipped in
  the previous branch) with a runtime-configurable provider/model, which this
  design reuses rather than inventing a second provider-abstraction.

## Chosen approach: whole-document vision-language extraction via OpenRouter

Several OpenRouter-available models (e.g. Google Gemini 2.5 Flash/Pro, and
some Claude/GPT variants) accept a **PDF file directly** as an input part in
their chat-completion request (base64-encoded, `type: "file"` content block —
OpenRouter normalizes this across providers that support native PDF input).
This sidesteps the Workers rasterization problem entirely: we never need to
render a PDF page to an image ourselves. The model reads the PDF (pages,
layout, embedded images) and we prompt it to return structured Markdown per
page: prose as-is, tables as Markdown tables, formulas as LaTeX
(`$...$`/`$$...$$`), and images/diagrams/figures as a captioned description
(`[Figure: ...]`) precise enough to be chunked and retrieved like any other
text.

This output — enriched per-page Markdown — replaces `unpdf`'s plain text as
the input to the existing `chunker.ts`. Chunking, embedding, and Vectorize
storage are **unchanged**.

**Implementation note:** v1 sends the whole PDF in a single OpenRouter call
(no page-range batching) and fails open for the whole document if that call
fails, rather than per-batch. This is a deliberate scope reduction - batching
adds complexity (splitting PDF byte ranges isn't possible without a PDF-writing
library) for a problem (model output-length limits) not yet confirmed to
occur on this app's real documents. Revisit if a real textbook PDF hits
output-length limits in the deployed app.

### Why this over the alternatives

1. **Per-page rasterize + vision model** (render each PDF page to a PNG, send
   images to a vision model) — rejected as the primary approach because
   Workers cannot rasterize PDF pages natively (no Canvas). It would require
   either bundling a WASM PDF renderer of uncertain Workers-compatibility, or
   an external rendering service (extra infra, extra cost, extra failure
   mode) for no benefit over sending the PDF directly to a model that already
   accepts PDF input natively.
2. **Heuristic hybrid** (keep `unpdf` for plain pages, only invoke a vision
   model for pages that look like they contain a table/figure, detected via
   some heuristic) — rejected for v1 as premature optimization: it adds
   detection-accuracy risk (false negatives silently keep losing formulas)
   for a cost saving that doesn't matter much given ingestion is low-frequency
   and admin-only. Worth revisiting later if per-document cost becomes a
   real concern.
3. **External OCR/table-extraction service** (e.g. a dedicated
   table-extraction API) — rejected: adds a second vendor/integration for
   narrower coverage (tables only, still nothing for formulas or general
   figure description) when one VLM call handles all three content types at
   once.

### Sequencing and fallback

- Large PDFs may need to be split into page-range batches (e.g. 20 pages per
  model call) if a single call risks the model's context/output limits —
  exact batch size is an implementation detail to tune, not a design
  decision. Calls for different batches can run concurrently (`Promise.all`),
  bounded by the CPU-time-excludes-fetch-wait property above.
- **Fail-open per batch, same pattern as `jev.ts`**: if a batch's
  enrichment call fails (timeout, bad response, model error), that batch
  falls back to `unpdf`'s plain-text extraction for those pages rather than
  failing the whole ingestion. The document still gets indexed — with the
  enrichment gap isolated to the pages that failed, not blocking everything
  the way a hard failure would.
- The existing "validate before writing anything" ordering in
  `handleIngest` (embed → upsert → R2 write last) is preserved.

### Config and toggles

Reuse the existing `RuntimeConfig` (D1-backed, admin Settings tab) pattern:

- `ingestionEnrichmentEnabled: boolean` (default `true`) — lets you disable
  enrichment and fall back to today's plain `unpdf` extraction instantly,
  without a redeploy, if the new path misbehaves.
- `ingestionModelSlug: string` (default a PDF-capable OpenRouter model, e.g.
  `google/gemini-2.5-flash`) — separate from the chat `llmModelSlug`, since
  document understanding and chat generation are different jobs with
  different model requirements (vision/document support is not universal).

### New module

`worker/src/ingestionEnrichment.ts` — analogous in shape to `llm.ts`:

```ts
export async function enrichPdfToMarkdown(
  pdfBytes: ArrayBuffer,
  fallbackPages: PageText[],  // unpdf output, used per-batch on failure
  env: Env,
  config: { ingestionModelSlug: string }
): Promise<PageText[]>  // same shape chunker.ts already consumes
```

`ingestion.ts` calls `extractPdfPages` (unchanged, still needed as the
fallback source) and, if `config.ingestionEnrichmentEnabled`, also calls
`enrichPdfToMarkdown`, passing the unpdf output as the fallback. The rest of
the pipeline (`chunkText`, embed, Vectorize upsert, R2 write) is untouched.

### Observability

Extend the admin dashboard's document view (`/admin/documents` already
shows per-document chunk previews) to flag which pages/chunks came from
enrichment vs. the plain-text fallback — reuses the existing
success/failure-visibility pattern from JEV (`jevBlocked`/`jevRelevance`
shown per chunk today).

### Testing

- Unit tests for `ingestionEnrichment.ts` mocking the OpenRouter fetch call
  (same style as `llm.test.ts`): verifies request shape (file content block,
  correct model), successful parse into `PageText[]`, and fallback-on-failure
  behavior per batch.
- Update `ingestion.test.ts` (if present) / add coverage for the new call
  being wired into `handleIngest` behind the config flag, with the flag
  disabled falling back to exactly today's behavior (regression safety).
- Unit tests for the page-screenshot step mocking the `browser` binding
  (Puppeteer's API surface is mockable the same way `env.AI`/`fetch` are
  elsewhere in this codebase), the new `GET /images/:key` route, and the
  `pageImageKey` field flowing through `/chat`'s `docSources`.

## Image capture and serving (actual images, not just descriptions)

### The core constraint, again

Workers have no Canvas/DOM, so we still cannot rasterize a PDF page
ourselves. Extracting the *literal embedded image bytes* from a PDF's
internal object structure (the theoretically most surgical option — pull
out just the one embedded GIF/JPEG, not the whole page) depends on
`pdf.js` internals that `unpdf` doesn't expose as a stable public API, and
is uncertain to work reliably across the range of ways a PDF can embed an
image (standalone figure vs. nested inside a table cell's content stream,
as confirmed present in real source documents). This is not something to
gamble the whole feature on.

### Chosen approach: Cloudflare Browser Rendering, whole-page screenshots

[Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/)
is a real, documented Cloudflare Workers product: a `browser` binding
(`@cloudflare/puppeteer`) that gives a Worker a headless-Chromium instance to
drive. A real browser can render a PDF natively (Chromium has a built-in PDF
viewer) and take a screenshot — so instead of us solving PDF rasterization,
we delegate it to infrastructure that already solves it correctly, including
the table-with-embedded-image case, since a screenshot captures the page
exactly as laid out regardless of how the image is nested in the PDF's
internal structure.

**Flow:**
1. During ingestion, after the Markdown-enrichment pass (above) produces
   per-page text containing `[Figure: ...]` markers, collect the page
   numbers that contain at least one marker.
2. For each such page, use the `browser` binding to open the PDF (as a data
   URL or via a short-lived R2-served URL) at that page, and screenshot it
   to PNG.
3. Store the PNG in `PDF_BUCKET` (same bucket as the source PDFs) under a
   distinct key prefix: `page-images/{source}/{page}.png`.
4. Record the image key in the Vectorize chunk metadata for any chunk whose
   page range includes that page (new metadata field: `pageImageKey`).
5. At chat time, `docSources` in the `/chat` response already carry
   `source`/`page`/`pageEnd` per cited chunk — add `pageImageKey` (nullable)
   to that same object when present.
6. New route `GET /images/:key` serves the PNG from `PDF_BUCKET` (public,
   unauthenticated — same trust level as the rest of the publicly-served
   chat API; the frontend needs to load it directly as an `<img src>`).
7. Frontend (`frontend/app.js`) renders an `<img>` for any `docSource` that
   has a `pageImageKey`, alongside the existing citation text.

**Trade-off to accept**: this captures the whole page as one image, not a
tight crop of just the figure. For a page that's mostly prose with one
small diagram, the student sees the full page rather than an isolated
crop. This is the pragmatic v1 trade-off — cropping to just the figure's
bounding box would need either (a) coordinates from the vision model (some
models can return bounding boxes, not guaranteed reliable) plus in-browser
cropping via Puppeteer's screenshot `clip` option, which is a reasonable
fast-follow once whole-page screenshots are proven to work, or (b) the
embedded-object-extraction approach revisited later if whole-page proves
insufficient.

### New infrastructure required

- Add the Browser Rendering binding to `worker/wrangler.toml`:
  ```toml
  [browser]
  binding = "BROWSER"
  ```
- Add `@cloudflare/puppeteer` as a worker dependency.
- **Cost/availability**: Browser Rendering is metered separately from
  Workers AI/OpenRouter — billed per browser session/duration on Cloudflare's
  own pricing (check your account's current plan before relying on this in
  production; free-tier limits may be tight for a textbook with many
  figure-pages in one ingestion run). This is the one piece of this design
  not yet confirmed against your actual Cloudflare account limits — worth a
  quick check before the branch is merged, not before it's built.
- Screenshot calls happen during ingestion (same low-frequency, admin-only
  context as the Markdown enrichment call), sequentially per flagged page to
  avoid running many concurrent browser sessions at once (Browser Rendering
  typically caps concurrent sessions per account more tightly than plain
  `fetch` concurrency).

### Fallback behavior

If the `browser` binding call fails for a given page (timeout, rendering
error, session limit hit), that page simply has no `pageImageKey` — the
Markdown-enriched text (including its `[Figure: ...]` description) is still
indexed and answerable in text form. Image capture failure never blocks
ingestion, same fail-open principle as the rest of this design.

## Open questions for you (not blocking design write-up, but need your call before/while building)

1. **Existing indexed documents** don't benefit from this until re-ingested.
   Do you want a one-off admin action to re-ingest everything already in
   `PDF_BUCKET`, or is re-uploading manually through `/ingest` fine for now?
2. **Model choice**: I've defaulted to `google/gemini-2.5-flash` via
   OpenRouter (cheap, fast, native PDF input, large context) as a starting
   point — open to swapping for whatever you've had good luck with, same as
   the chat model slug is editable without a redeploy.
3. **Batch size / page-range tuning** — I'll pick a conservative default
   (e.g. 15-20 pages/call) and we can tune after seeing it run against a real
   textbook PDF; flag if you already know your PDFs run much longer per
   chapter and want a different starting point.
4. **Browser Rendering availability on your Cloudflare account/plan** — I
   cannot check your account's limits/pricing tier from here. Before this
   branch is merged, confirm the `browser` binding is available and its
   limits are acceptable for your expected ingestion volume (number of
   figure-pages per document × documents uploaded). If it turns out to be
   unavailable or too costly, the fallback is descriptions-only (drop the
   "Image capture and serving" section, keep everything else) — flag this
   early if you'd rather check first before I build against it.

None of these block writing the implementation plan — I've picked reasonable
defaults for all four and will proceed on that basis unless you say
otherwise.
