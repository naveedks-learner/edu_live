# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare-native RAG chatbot for science/maths Q&A, aimed at 16-17 year old students. Free-tier stack: Workers, Vectorize, Workers AI, R2, D1, Pages. Two independently deployed pieces:

- `worker/` — the API (one Cloudflare Worker, `edu-live-worker`): `POST /ingest` (upload + index a PDF), `POST /chat` (ask a question), `GET /images/:key` (serve a captured page screenshot), and `/admin/*` (dashboard data + config).
- `frontend/` — two independent static Cloudflare Pages sites, deployed separately:
  - `index.html`/`app.js`/`style.css` — the student-facing chat app. No upload UI.
  - `dashboard.html`/`dashboard.js`/`dashboard.css` — the admin-only operator dashboard (Data Ingestion Dashboard / TransactionTracker / Costing / Settings tabs). PDF uploads happen here, not on the chat page.

## Commands

All commands run from `worker/` unless noted.

```bash
npm install                 # installs @cloudflare/puppeteer, unpdf, etc.
npx wrangler login           # once per machine; same account for worker/ and frontend/

npx vitest run                              # full test suite
npx vitest run test/chat.test.ts            # single test file
npx vitest run test/chat.test.ts -t "name"  # single test by name substring
npx tsc --noEmit                            # type-check (test/chat.test.ts has known
                                             # pre-existing mock-type errors unrelated to
                                             # real code — confirmed present on main;
                                             # any OTHER file erroring is a real regression)

npx wrangler dev --persist-to=.wrangler/state   # local dev — cannot emulate Vectorize,
                                                 # Workers AI, or Browser Rendering; all
                                                 # three hit the real free-tier services
                                                 # even in local dev
npx wrangler deploy                             # deploy the worker
npx wrangler tail --format pretty               # stream live production logs

npx wrangler secret put OPENROUTER_API_KEY   # chat generation (default provider) + JEV + PDF enrichment
npx wrangler secret put ADMIN_API_KEY        # protects /admin/*
npx wrangler secret put INGEST_API_KEY       # protects /ingest (optional)
```

From `frontend/`:

```bash
npx serve .          # local static serving; app.js's WORKER_URL const must point at
                      # a reachable worker (local wrangler dev or deployed)
npx wrangler deploy   # deploy the frontend (deploys BOTH index.html and dashboard.html —
                      # there's only one frontend wrangler.jsonc/deploy target)
```

**There are two separate deploy targets** (`worker/` and `frontend/`) and no CI/CD — a change to worker code needs `npx wrangler deploy` from `worker/`, a frontend change needs it from `frontend/`. Neither auto-deploys on merge to `main`.

Binding-dependent behavior (ingestion, chat pipeline, screenshot capture) is covered by unit tests with mocked bindings; there is no integration test suite against real Vectorize/Workers AI/Browser Rendering — verify those manually via `wrangler tail` + the deployed app after a deploy.

## Architecture

### Request flow

`worker/src/index.ts` is the sole entry point — a flat `if` chain routing by method+path, wrapping every response in CORS (`cors.ts`). It defines the `Env` interface: every binding and secret the worker has (`AI`, `VECTORIZE`, `PDF_BUCKET`, `EDU_LIVE_DB`, `BROWSER`, `OPENROUTER_API_KEY`, `INGEST_API_KEY`, `ADMIN_API_KEY`).

### Ingestion (`POST /ingest`, `ingestion.ts`)

Admin-only (via the dashboard's upload card), gated by `x-ingest-key`. Sequence:

1. Dedup check: `PDF_BUCKET.head(filename)` — skips if already indexed, unless a `force` form field is set (then the old document's vectors, `page-images/`, and `cleaned/` text are deleted first via the OLD `chunkCount` read from R2 customMetadata, before re-ingesting fresh).
2. `extractPdfPages()` (`pdf.ts`) — plain per-page text via `unpdf` (PDF.js-based, pure JS, no Python). **Copies the input buffer before handing it to PDF.js** — PDF.js transfers (detaches) whatever ArrayBuffer it's given, which would otherwise make `pdfBytes` unusable for every step after it.
3. If `config.ingestionEnrichmentEnabled` (default true): `enrichPdfToMarkdown()` (`ingestionEnrichment.ts`) sends the **whole PDF in one call** to a PDF-capable OpenRouter model (default `google/gemini-2.5-flash`), prompted to re-emit every page as Markdown — formulas as LaTeX, tables as Markdown tables, figures/diagrams tagged `[Figure: description]` — each page prefixed with a `<<<PAGE n>>>` marker using the real page number. `parseEnrichedPages()` is the pure function that merges this back onto the PDF.js page list **by label, not position**: it looks up each real page number in the model's markers, and any page with no matching marker (or a truncated/missing response entirely) silently falls back to that page's plain-text extraction. Never throws; a bad OpenRouter call just means no enrichment for that document.
4. Any page whose (possibly enriched) text contains `[Figure:` gets a real screenshot: `launchScreenshotBrowser()` + `capturePageScreenshot()` (`pageScreenshot.ts`) use Cloudflare Browser Rendering (`@cloudflare/puppeteer`) — one browser launched per ingest, reused across every figure page, PDF viewer toolbar/sidebar hidden via URL params so the capture is just page content. Stored at R2 `page-images/<filename>/<page>.png`. Fails open (no image, not a failure) on any error — known limitation: the `data:` URL approach has a practical ~2MB size ceiling, so very large PDFs may not get images even though text enrichment still works.
5. `chunkText()` (`chunker.ts`) — 300-word chunks, 50-word overlap, continuous across page boundaries (operates on the enriched text when enrichment applied). Each chunk's Vectorize metadata carries `pageImageKey` when its page range includes a captured screenshot.
6. Embed (Workers AI) → `VECTORIZE.upsert()` → **then, only on success**, `R2.put()` the source PDF with `{chunkCount, pageCount, indexedAt, enriched}` customMetadata, and (if enrichment actually changed the content) `R2.put('cleaned/<filename>.md', ...)` the full enriched text as a standalone viewable artifact.

**Why R2/cleaned-text writes happen last, not first**: an earlier version wrote R2 first; a failed retry would find the file "already there" and skip re-indexing forever (a poisoned filename with zero real chunks). Validating and writing last means a failed ingest leaves nothing behind.

### Chat (`POST /chat`, `chat.ts`)

Public, no auth. Fixed pipeline, `config` read fresh from D1 on every call (`config.ts`):

1. **Guardrail** (`guardrailCheck.ts`/`guardrail.ts`, if `guardrailEnabled`) — keyword blocklist + embedding-similarity scope check. **Fails closed** (blocks on error) — the only stage that does.
2. Embed question (Workers AI) → `VECTORIZE.query(topK)`.
3. **Rerank** (`rerank.ts`) — cross-encoder re-score. Falls back to cosine order on failure.
4. **JEV** (`jev.ts`, if `jevEnabled`) — OpenRouter relevance + prompt-injection check per chunk. **Fails open** (passes chunks through unfiltered) on error — a third-party outage shouldn't silently discard every chunk. Kept if relevance `≥ jevRelevanceThreshold` (configurable, default 1.5).
5. Confidence gate — `confidenceThreshold` (default 0 = off, deliberately: the reranker's raw scores aren't guaranteed non-negative, so "≥ 0" wouldn't reliably mean "always pass").
6. Web fallback (`webSearch.ts`, DuckDuckGo scrape, no API key) if `docSources` empty and `webSearchMode ≠ rag_only`. Never throws, degrades to empty results.
7. **Generation** via `generateChatCompletion()` (`llm.ts`) — the single entry point for answer generation, routes to `config.llmProvider`:
   - `openrouter` (**default**) — model from `config.llmModelSlug` (default `qwen/qwen3-235b-a22b:free`). Chosen specifically to reduce reliance on Workers AI's paid tier.
   - `workers-ai` — fixed `@cf/meta/llama-3.1-8b-instruct-fp8`, manual fallback option.
   - **Does not fail open** — a bad model slug or OpenRouter outage throws, so it's immediately visible rather than silently degrading quality/cost. This is deliberately different from every other stage in this pipeline.
   - `answerStyle` (`auto`/`short`/`detailed`) is a prompt fragment appended to one shared `SYSTEM_PROMPT`, not a separate prompt — plus a `max_tokens` cap per style (512/100/500). The system prompt also enforces source-fidelity: quote/closely paraphrase retrieved context, never add outside facts even ones the model "knows" are true.
8. `buildTransactionTrace()` (`transactionTrace.ts`) assembles one full record (every chunk's scores + kept/discarded, LLM I/O, provider/model, JEV model, token estimates) → inserted into D1 via `ctx.waitUntil()` (fire-and-forget, never delays the response).
9. Response includes `docSources` (each with `pageImageKey` when available) — the frontend renders the actual page screenshot as an `<img>` below the answer when present, not just the `[Figure: ...]` text description.

### Admin (`/admin/*`, `admin.ts`)

Gated by `x-admin-key` (optional — unauthenticated if unset, e.g. local dev). Routes: `GET /admin/documents` (lists R2 objects, excluding `page-images/` and `cleaned/` prefixes; includes the `enriched` flag), `GET /admin/documents/cleaned?name=` (fetches one document's enriched text on demand), `GET /admin/transactions`, `GET /admin/costing`, `GET`/`PUT /admin/config`.

### Runtime config (`config.ts`)

D1-backed (`config` table, key/value), typed, validated, with safe defaults if D1 is unreachable. Every field is editable from the dashboard's Settings tab and takes effect on the **next** request — no redeploy (Workers have no long-running process to restart). Fields: `topK`, `confidenceThreshold`, `webSearchMode`, `hardFailNoDocument`, `jevEnabled`, `jevRelevanceThreshold`, `guardrailEnabled`, `llmProvider`, `llmModelSlug`, `ingestionEnrichmentEnabled`, `ingestionModelSlug`.

### Storage

- **R2** `edu-live-pdfs` — three prefixes sharing one bucket: source PDFs (bare filename), `page-images/<filename>/<page>.png` (screenshots), `cleaned/<filename>.md` (enriched text). The latter two are deliberately excluded from `/admin/documents` listing.
- **Vectorize** `edu-live-chunks` — one vector per chunk. Deterministic IDs via `chunkVectorId()` (`vectorId.ts`, hash(filename)::chunkId) — re-ingestion overwrites rather than duplicates, and lets `force` re-ingest delete exactly the old document's chunks by recomputing IDs from its old `chunkCount`.
- **D1** `edu-live-db` — two tables: `transactions` (one row per `/chat` call, audit log) and `config` (runtime settings). Migrations in `worker/migrations/`.

### Failure philosophy (intentional, varies by stage)

Most stages fail open (degrade gracefully): reranker → cosine order, JEV → unfiltered passthrough, web search → empty results, PDF enrichment → plain-text fallback per page, screenshot capture → no image. Two stages are deliberate exceptions: the **guardrail fails closed** (blocks on error — better to over-block than expose a minor to an unchecked question), and the **LLM generation call throws** rather than silently falling back to a different provider (a cost/quality regression should never be invisible).

### Testing conventions

Vitest, mocked `Env` bindings (`AI`, `VECTORIZE`, `PDF_BUCKET`, `EDU_LIVE_DB`, `BROWSER` all stubbed per-test). `worker/test/*.test.ts` mirrors `worker/src/*.ts` one-to-one. Fail-open/fail-closed contracts are the thing most worth testing explicitly when touching any pipeline stage — every stage above has a test asserting its specific failure behavior, not just its happy path.

### Design history

`docs/superpowers/specs/` and `docs/superpowers/plans/` hold the full design rationale and implementation plans for each major feature, in chronological order — useful for "why was this built this way" questions beyond what's summarized above.
