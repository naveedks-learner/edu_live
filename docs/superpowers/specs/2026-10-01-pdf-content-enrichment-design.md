# PDF content enrichment layer (formulas, tables, images)

**Status:** Draft — awaiting user review
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
notation), tables (as Markdown tables), and images/diagrams (as a text
description precise enough to answer a question about them) — so retrieval
and generation can work with that content the same way they work with plain
prose today.

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

None of these block writing the implementation plan — I've picked reasonable
defaults for all three and will proceed on that basis unless you say
otherwise.
