# Edukripa — Project Overview

A RAG (retrieval-augmented generation) chatbot for 16-17 year old students, restricted to science/maths, running entirely on Cloudflare's free-tier stack (Workers, Vectorize, Workers AI, R2, D1, Pages). Students upload their own PDF notes; the bot answers questions grounded in that content, falling back to web search when nothing relevant is indexed. A separate admin dashboard gives visibility into what's indexed, what happened on each query, token/cost usage, and lets an operator change pipeline behavior (top-K, confidence threshold, RAG-only vs. web fallback, etc.) without redeploying.

---

## 1. File-by-file reference

### `worker/src/` — the backend (one Cloudflare Worker, `edu-live-worker`)

| File | Business functionality |
|---|---|
| **`index.ts`** | The Worker's entry point. Routes every incoming request by method+path to the right handler (`/ingest`, `/chat`, `/admin/*`), wraps every response in CORS headers, and answers `OPTIONS` preflight requests directly. Defines the `Env` interface — every binding/secret the Worker has access to (AI, Vectorize, R2, D1, API keys). |
| **`pdf.ts`** | Extracts per-page plain text from a raw PDF's bytes, using `unpdf` (a PDF.js-based library that runs natively in the Workers JS runtime — no Python involved). Input: PDF bytes. Output: `{page, text}[]`. |
| **`chunker.ts`** | Splits a document's extracted page text into overlapping ~300-word chunks (50-word overlap), flowing continuously across page boundaries rather than restarting per page — this is a direct port of the original Python prototype's `chunker.py`. Each chunk records its own source page range. This is what actually gets embedded and searched later. |
| **`vectorId.ts`** | Builds the deterministic ID Vectorize uses to store/retrieve each chunk (`hash(source)::chunkId`). Hashing the filename keeps IDs under Vectorize's 64-byte cap regardless of how long a PDF's filename is, while staying reproducible — re-ingesting the same file overwrites its old vectors instead of duplicating them. This determinism is also what lets the admin dashboard reconstruct a document's chunk IDs later to fetch its text back out of Vectorize for the chunk browser. |
| **`ingestion.ts`** | Handles `POST /ingest`: the PDF upload endpoint. Auth-checks an optional shared secret (`x-ingest-key`), rejects non-PDF/empty files, extracts text (`pdf.ts`) → chunks it (`chunker.ts`) → embeds each chunk via Workers AI → upserts the vectors into Vectorize → only then writes the raw PDF bytes to R2 (with chunk/page counts and an indexed timestamp as R2 metadata). Writing R2 last is deliberate: if anything upstream fails, nothing is left behind to "poison" a retry. |
| **`rerank.ts`** | Re-scores the chunks Vectorize's cosine search already found, using Workers AI's cross-encoder reranker model — a rerank score is a much better relevance signal than raw cosine similarity alone. Fails soft: if the reranker call errors, chunks keep their original cosine-similarity order instead of the whole request failing. |
| **`jev.ts`** | Calls JEV (OpenRouter's "typed decision" API, model `~typesafe/jev-latest`) to independently score each retrieved chunk's relevance to the question and check for prompt-injection attempts embedded in document text. Annotates every candidate (so discarded ones are still visible to the dashboard) and separately filters to the kept subset. Fails **open**: if the JEV call itself fails, chunks pass through unfiltered rather than all being treated as irrelevant. |
| **`guardrail.ts`** | Pure decision logic for whether a question is appropriate to answer at all: a hard keyword blocklist (self-harm, drugs, explicit content — checked as whole-word phrases, not substrings) plus a threshold on embedding-similarity to reference in-scope vs. out-of-scope example questions. |
| **`guardrailCheck.ts`** | The "wired-up" version of `guardrail.ts` — embeds the incoming question and the reference question sets via Workers AI, computes cosine similarities, and calls into `guardrail.ts`'s pure logic to get a decision. Fails **closed**: any error here (Workers AI unreachable, etc.) blocks the question rather than letting it through. |
| **`webSearch.ts`** | Scrapes DuckDuckGo's HTML search results (no API key needed) as a fallback source when nothing relevant is found in the indexed PDFs. Never throws — returns an empty result list on any failure so the chat pipeline degrades gracefully instead of erroring. |
| **`config.ts`** | The runtime-configuration system. Defines the typed `RuntimeConfig` (topK, confidenceThreshold, webSearchMode, hardFailNoDocument, jevEnabled, guardrailEnabled) and its production-matching defaults, reads/validates/writes it against a D1 `config` key-value table. `getRuntimeConfig` never throws — any D1 problem falls back to the hardcoded defaults, so a config outage degrades to "behaves like the feature never shipped," not a broken chatbot. This is what lets an admin change pipeline behavior from the dashboard without a redeploy (Workers have no long-running process to restart — a config change takes effect on literally the next request). |
| **`transactionTrace.ts`** | Pure function that assembles one full "trace" record of everything that happened during a `/chat` call — every candidate chunk's cosine/rerank/JEV scores and kept/discarded status, the exact LLM prompt and answer, the JEV model used, estimated token counts. This is the data model the observability dashboard is built on. |
| **`chat.ts`** | The heart of the app — handles `POST /chat`. Orchestrates the full pipeline end to end (see the flow diagram below), and after responding, persists a `transactionTrace` to D1 via `ctx.waitUntil` (fire-and-forget, so a slow/failed trace write never delays or breaks the answer the student sees). |
| **`admin.ts`** | All `/admin/*` routes: `isAdminAuthorized` (shared-secret check), `handleAdminDocuments` (lists indexed PDFs + chunk-text preview for the 3 most recent), `handleAdminTransactions` (last N full traces), `handleAdminCosting` (token/cost rollups by time range), `handleAdminGetConfig`/`handleAdminPutConfig` (read/write runtime config with server-side validation). Every handler catches its own errors and returns a JSON 500 rather than an uncaught exception. |
| **`cors.ts`** | Adds the CORS headers every response needs (the dashboard/chat frontend and the Worker are different origins) and answers `OPTIONS` preflight requests. |
| **`types.ts`** | Shared plain data types (`PageText`, `Chunk`) used across the PDF/chunking pipeline. |

### `frontend/` — two independent static pages (Cloudflare Worker with static assets, `frontend`)

| File | Business functionality |
|---|---|
| **`index.html` / `app.js` / `style.css`** | The **student-facing chat app**: an Auto/1-2 Marks/5 Marks answer-style selector and a chat box (calls `/chat`). No upload UI — PDF upload is admin-only, now in the dashboard. Shows an animated "Thinking..." indicator with cycling status text while waiting for an answer (not real backend telemetry — there's no streaming — just a UX cue). |
| **`dashboard.html` / `dashboard.js` / `dashboard.css`** | The **operator/admin dashboard**, no chat UI. Four tabs: **PDFs & Chunks** (indexed documents, chunk-text browser for the 3 newest), **TransactionTracker** (last 3 queries as a collapsible tree — retrieval table, JEV/LLM input-output, model names), **Costing** (token/cost usage by range), **Settings** (edit runtime config; changes apply on the next question, no restart needed). Admin key is entered once and cached in the browser's `localStorage`. |

---

## 2. End-to-end flow: PDF ingestion

```
Student/operator uploads a PDF
        │
        ▼
POST /ingest  (worker/src/ingestion.ts)
        │  auth check (x-ingest-key, optional)
        │  reject if not a PDF / empty
        ▼
extractPdfPages()        (pdf.ts)      → [{page, text}, ...]
        ▼
chunkText()               (chunker.ts)  → overlapping ~300-word chunks
        ▼
Workers AI embeds each chunk's text     → one vector per chunk
        ▼
Vectorize.upsert()   — id = chunkVectorId(filename, chunkId)   (vectorId.ts)
        ▼
R2.put(filename, pdfBytes, {customMetadata: chunkCount, pageCount, indexedAt})
        │   (R2 write is LAST - a failure earlier leaves nothing behind)
        ▼
Response: {status: "indexed", chunkCount}
```

## 3. End-to-end flow: a chat question

```
Student asks a question in the chat box
        │
        ▼
POST /chat   (worker/src/chat.ts)
        │
        ▼
getRuntimeConfig()                       (config.ts)
        │  reads topK / confidenceThreshold / webSearchMode /
        │  hardFailNoDocument / jevEnabled / guardrailEnabled from D1
        ▼
guardrailEnabled? ──yes──► checkQueryInScopeAndAgeAppropriate()  (guardrailCheck.ts)
        │                          │  keyword blocklist + embedding similarity
        │                          ▼
        │                   blocked? ──yes──► return refusal message, STOP
        │no / passed
        ▼
Workers AI embeds the question
        ▼
Vectorize.query(topK)                    → candidate chunks + cosine scores
        ▼
rerank()                                  (rerank.ts)
        │  Workers AI cross-encoder rescoring (falls back to cosine order on failure)
        ▼
jevEnabled? ──yes──► scoreChunksWithJev()  (jev.ts)
        │                  │  relevance + injection-attempt scoring via OpenRouter
        │                  │  fails OPEN (network/API error → chunks pass through unfiltered)
        │                  ▼
        │           filterJevScored()      → drop low-relevance / injection-flagged chunks
        │no
        ▼
confidenceThreshold gate                  (chat.ts)
        │  if threshold > 0 and top chunk's score is below it → treat as "nothing found"
        │  (threshold = 0, the default, never gates — score scale isn't guaranteed non-negative)
        ▼
docSources empty AND webSearchMode ≠ "rag_only"?
        │yes                                      │no
        ▼                                         ▼
webSearch()  (webSearch.ts)              skip web search
   DuckDuckGo scrape, never throws
        │
        ▼
Build context = doc chunks + web results (or "No context found.")
        │
        ▼
hardFailNoDocument=true AND still nothing found?
        │yes                                      │no
        ▼                                         ▼
Fixed "I don't have enough              Workers AI generates the answer
information..." message                  (llama-3.1-8b-instruct, given
  (skips the LLM call entirely)           system prompt + context)
        │                                         │
        └──────────────────┬──────────────────────┘
                            ▼
              buildTransactionTrace()   (transactionTrace.ts)
                 full record: every chunk's scores + kept/discarded status,
                 LLM prompt/answer, JEV model, estimated tokens
                            ▼
              ctx.waitUntil(INSERT INTO transactions)   — fire-and-forget,
                 never delays or breaks the response the student sees
                            ▼
              Response: {answer, docSources, webSources}  → shown in chat
```

## 4. End-to-end flow: the admin dashboard

```
Operator opens dashboard.html, enters admin key (cached in localStorage)
        │
        ├─ PDFs & Chunks tab ──► GET /admin/documents
        │     R2.list() + customMetadata → doc list with size/pages/chunk count
        │     for the 3 most-recently-indexed docs: reconstruct chunk ids via
        │     chunkVectorId() → VECTORIZE.getByIds() → real chunk text shown
        │
        ├─ TransactionTracker tab ──► GET /admin/transactions?limit=3
        │     reads the `transactions` D1 table written by chat.ts,
        │     renders each as a collapsible card (retrieval table → JEV
        │     input/output → LLM input/output)
        │
        ├─ Costing tab ──► GET /admin/costing?range=1h|1d|7d
        │     D1 aggregate: query count, token totals, JEV cost, LLM cost,
        │     labeled with which LLM/JEV model produced them
        │
        └─ Settings tab ──► GET /admin/config  (load current values)
              operator edits topK / confidenceThreshold / webSearchMode /
              hardFailNoDocument / jevEnabled / guardrailEnabled
                        │
                        ▼
              PUT /admin/config  (server-side validated, e.g. topK ≤ 50)
                        │
                        ▼
              written to D1 `config` table → takes effect on the NEXT
              /chat request (Workers have no process to restart)
```

## 5. Data storage summary

| Store | What lives there |
|---|---|
| **R2** (`edu-live-pdfs`) | The raw PDF bytes, plus `chunkCount`/`pageCount`/`indexedAt` as custom metadata. |
| **Vectorize** (`edu-live-chunks`) | One vector per chunk, with the chunk's text/page/source as metadata. IDs are deterministic (`vectorId.ts`), which is what lets the dashboard fetch chunk text back out without a separate index. |
| **D1** (`edu-live-db`) | Two tables: `transactions` (one row per `/chat` call — the full trace) and `config` (key/value runtime settings). |

## 6. Auth model

Three independent shared-secret headers, each optional (unset = unauthenticated, for local dev):
- `x-ingest-key` → `POST /ingest`
- `x-admin-key` → all `/admin/*` routes
- (Chat itself, `POST /chat`, has no auth — it's the public student-facing endpoint.)
