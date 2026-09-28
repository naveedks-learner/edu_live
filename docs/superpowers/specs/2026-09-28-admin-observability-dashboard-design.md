# Admin Observability Dashboard — Design

## Purpose

Give whoever operates this deployment the same visibility they had in the
original (pre-Cloudflare) project: which PDFs are indexed and how they were
chunked, what happened inside the pipeline for the last few chat queries
(retrieval, reranking, JEV, generation), and rough token/cost usage. This is
an operator/debugging tool, not a student-facing feature — it ships as its
own page, with no chat UI embedded in it.

## Non-goals

- No auth system beyond a shared-secret header (matches the existing
  `INGEST_API_KEY` pattern) — this is a single-operator tool, not
  multi-tenant admin.
- No historical retention policy beyond what fits comfortably in D1 for this
  project's scale (no pruning job in v1).
- No exact Workers AI dollar-cost accounting — Workers AI is neuron-billed,
  not token-billed, so its "cost" is out of scope; only OpenRouter/JEV calls
  get a real dollar figure.

## Architecture

```
Ingest flow (existing, extended):
  POST /ingest -> extract -> chunk -> embed -> Vectorize.upsert
                                             -> R2.put(file, bytes, {customMetadata: chunkCount, pageCount})

Chat flow (existing, extended):
  POST /chat -> guardrail -> embed -> Vectorize.query -> rerank -> JEV -> (web fallback?) -> generate
                    |             |          |              |       |                            |
                    +-------------+----------+--------------+-------+----------------------------+
                                              v
                                    trace object assembled inline
                                              v
                                   D1.insert("transactions", trace)   (best-effort, never blocks response)

Dashboard (new):
  GET /admin/documents      -> R2.list() + customMetadata
  GET /admin/transactions   -> D1 SELECT ... ORDER BY timestamp DESC LIMIT N
  GET /admin/costing        -> D1 SELECT SUM(...) ... WHERE timestamp > now - range

  frontend/dashboard.html + dashboard.js  (new static page, 3 tabs, no chat)
```

## Components

### 1. D1 database + `transactions` table

New D1 binding on the worker (e.g. `EDU_LIVE_DB`). Schema:

```sql
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,          -- ISO 8601
  question TEXT NOT NULL,
  provider TEXT NOT NULL,           -- e.g. "workers-ai"
  model TEXT NOT NULL,              -- generation model id
  path_taken TEXT NOT NULL,         -- "pdf_only" | "web_fallback" | "refused"
  confidence REAL,                  -- top retrieval confidence (post-rerank) or NULL
  threshold REAL,                   -- confidence threshold in effect, or NULL if not applicable
  retrieval_json TEXT NOT NULL,     -- JSON array, see below
  llm_input TEXT NOT NULL,
  llm_output TEXT NOT NULL,
  jev_input_json TEXT,              -- JSON array of {source, chunkId, query, passage} or NULL if JEV disabled
  jev_output_json TEXT,             -- JSON array of {source, chunkId, relevance, injectionBlocked} or NULL
  input_tokens INTEGER NOT NULL,    -- estimated, chars/4
  output_tokens INTEGER NOT NULL,   -- estimated, chars/4
  jev_cost_usd REAL NOT NULL DEFAULT 0,
  llm_cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_transactions_timestamp ON transactions(timestamp);
```

`retrieval_json` element shape (one per candidate chunk, in original
cosine-rank order):

```json
{
  "rank": 1,
  "source": "light notes.pdf",
  "page": 1,
  "chunkId": 0,
  "cosineScore": 0.8642,
  "rerankScore": 0.8545,
  "jevRelevance": 3,
  "status": "kept"   // "kept" | "discarded_by_rerank" | "discarded_by_jev"
}
```

### 2. `chat.ts` instrumentation

`handleChat` already computes every value above during the normal pipeline
run (cosine score on `RetrievedChunk`, rerank score on `RerankedChunk`, JEV
relevance on `JevScoredChunk`) — today it discards everything except the
kept chunks' source/page/text before responding. The change is additive:

- Track the pre-JEV-filter reranked list (not just the post-filter
  `docSources`) so discarded chunks can be shown with their `status`.
- Estimate `input_tokens`/`output_tokens` from `(llm_input.length +
  llm_output.length) / 4`, split proportionally, or more simply: estimate
  each side separately as `text.length / 4`.
- Compute `jev_cost_usd` from OpenRouter's response if it includes a cost
  field (`callJev`'s HTTP response body should be checked for a `cost` or
  `usage` field — if absent, cost stays 0 and the UI labels it "cost data
  unavailable" rather than showing a false zero as fact).
- After building the response payload, fire an `INSERT` into
  `transactions` wrapped in try/catch; a D1 failure is logged via
  `console.error` and never changes the HTTP response already being sent to
  the chat caller.
- This logic is factored into a small pure function,
  `buildTransactionTrace(...)`, that takes the pipeline's intermediate
  values and returns the row object — testable in isolation like the
  existing `rerank`/`jev` modules, without needing a live D1 binding in
  tests.

### 3. `ingestion.ts` change

At the existing `env.PDF_BUCKET.put(file.name, pdfBytes)` call, add:

```ts
await env.PDF_BUCKET.put(file.name, pdfBytes, {
  customMetadata: {
    chunkCount: String(chunks.length),
    pageCount: String(pages.length),
    indexedAt: new Date().toISOString(),
  },
});
```

This is the only change to the ingest path. No new failure modes: R2
`customMetadata` is best-effort string key/value, same call as today.

### 4. New worker routes

All three require header `x-admin-key` matching a new `ADMIN_API_KEY`
secret (same optional-if-unset pattern as `INGEST_API_KEY`, since local dev
without a configured key should still work).

- `GET /admin/documents` — `PDF_BUCKET.list()`, map each object to
  `{ name, sizeBytes, indexedAt, chunkCount, pageCount }` from
  `customMetadata` (fields absent on PDFs ingested before this change —
  render as "—" in the UI rather than erroring).
- `GET /admin/transactions?limit=3` (default 3, max 10) — `SELECT * FROM
  transactions ORDER BY timestamp DESC LIMIT ?`, parse the JSON columns
  back into objects before returning.
- `GET /admin/costing?range=1d` (`1d` default, also accepts `1h`, `7d`) —
  one query for the single most recent transaction's tokens/cost, one query
  for `COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(jev_cost_usd +
  llm_cost_usd)` over the range.

`cors.ts`'s allowed methods change from `POST, OPTIONS` to `GET, POST,
OPTIONS` (a direct repeat of the bug already hit and fixed once for POST —
call this out explicitly so it isn't missed again).

### 5. Frontend: `frontend/dashboard.html` + `frontend/dashboard.js` + shared CSS

A new static page, linked from (or alongside) the existing `index.html`,
sharing `style.css` where sensible but adding its own dashboard-specific
styles. No chat widget on this page.

**Visual bar:** this is an operator-facing tool but should look
professional and polished, not a bare debug table — clear visual hierarchy,
a proper header/branding band, consistent spacing and typography, color
used purposefully (status badges, confidence bars), good empty/loading/error
states, and no layout breakage on a laptop-width screen. Reference points:
Cloudflare's own dashboard and the screenshots provided (gradient header
band, tabbed navigation, card-based metrics, clean data tables with colored
status pills). Plain, unstyled HTML tables are not acceptable for this
deliverable.

Three tabs, one active at a time (client-side state, no routing library
needed):

**Tab 1 — PDFs & Chunks**
- Table: filename, size, indexed date, page count, chunk count.
- Expandable row (or modal) per PDF is out of scope for v1 — chunk
  *contents* browsing is not required here (that's covered by the
  TransactionTracker's retrieval table, which already shows chunk text
  in-context). If this turns out to be wanted, it's a fast follow, not
  blocking v1.
- Empty state: "No documents indexed yet."

**Tab 2 — TransactionTracker**
- List of the last 2–3 transactions (most recent first), each rendered like
  the reference screenshot: query metadata header (id, timestamp,
  provider/model), path taken, confidence vs threshold, then an expandable
  "Retrieval results" table (rank, source, page, chunk_id, cosine, rerank
  score, JEV relevance, status — with color-coded status pills:
  kept=green, discarded=grey/red), then LLM input/output shown in
  collapsible `<pre>`/code blocks, then JEV input/output the same way.
- Empty state: "No queries yet."

**Tab 3 — Costing**
- "Last transaction" card: input tokens, output tokens, estimated cost.
- "Last N" summary card(s) for the selected range (1h/1d/7d, a simple
  dropdown or segmented control): query count, total input/output tokens,
  total cost, with JEV cost and Workers AI token count broken out
  separately (per the non-goal above, Workers AI shows tokens only, not a
  dollar figure).
- Empty state: "No usage recorded yet."

## Data flow summary

1. Operator uploads a PDF via existing `/ingest` → R2 now also carries
   chunk/page counts as metadata.
2. A student (or the operator, testing) asks a question via `/chat` → the
   existing pipeline runs unchanged in terms of behavior; the only addition
   is that every intermediate value gets assembled into a trace row and
   persisted to D1 after the response is already computed.
3. Operator opens `dashboard.html`, which calls the three `/admin/*`
   endpoints with the admin key and renders the three tabs.

## Error handling

- D1 insert failure: logged, never affects the `/chat` response.
- Missing/wrong `x-admin-key` on any `/admin/*` route: `401 Unauthorized`,
  same shape as the existing `/ingest` 401.
- `/admin/documents` on a PDF ingested before this change (no
  `customMetadata`): render available fields, "—" for the rest — no error.
- JEV/cost data unavailable (OpenRouter response has no cost field): show
  "cost data unavailable" in the UI, don't fabricate a $0.00 that reads as
  a real measurement.
- Dashboard fetch failures (network, 401, 5xx): each tab shows its own
  inline error state, not a blank page.

## Testing

- New unit test `worker/test/transactionTrace.test.ts` for
  `buildTransactionTrace(...)`, covering: JEV enabled/disabled, web
  fallback vs pdf_only, rerank failure (null rerankScore), all-discarded
  case.
- New unit test `worker/test/cors.test.ts` update (existing file) to assert
  GET is now allowed.
- Manual pass after implementation: ingest 2 PDFs, ask 3+ questions
  (including one that triggers web fallback and one with an
  intentionally out-of-scope question to hit the guardrail path), open
  `dashboard.html`, confirm all three tabs populate correctly and that an
  unauthenticated request to any `/admin/*` route 401s.
