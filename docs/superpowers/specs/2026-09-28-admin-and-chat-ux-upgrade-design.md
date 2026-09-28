# Admin & Chat UX Upgrade — Design

## Purpose

Two related upgrades requested after the first observability dashboard shipped:

1. **Chat UI**: a visible "working on it" indicator while `/chat` is in
   flight, plus enterprise-grade visual polish (currently plain/prototype-
   looking).
2. **Admin dashboard v2**: surface LLM/JEV model names, collapse the three
   transactions into an expandable tree, show actual chunk text for the
   most-recently-indexed PDFs, add a Settings tab for runtime config
   (confidence threshold, top-K, RAG-vs-web mode, hard-fail-on-no-document)
   that takes effect without a redeploy, plus matching visual polish.

## Non-goals

- No real backend progress streaming for the chat "thinking" indicator —
  Workers AI's `ai.run()` call is not streamed in this codebase today, and
  adding SSE/streaming is a separate, larger change. The indicator is a UX
  cue (animated, rotating status text on a timer), not a live trace of what
  the pipeline is actually doing at that instant.
- No "restart required" mechanism. Cloudflare Workers have no persistent
  process to restart — every request reads fresh state, so a runtime config
  change in D1 takes effect on the very next request. The Settings tab
  labels this plainly instead of building unneeded machinery.
- No health-check panel, error-log viewer, or transaction search/export in
  this pass. Flagged as future ideas, not built, to keep this change to the
  scope actually requested.
- No change to `GUARDRAIL_ENABLED`'s keyword/embedding logic itself, only
  to where its on/off flag is read from (config table instead of a
  `wrangler.toml` var).

## Architecture

```
New D1 table `config` (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)
  Seeded with current defaults on first read (see getRuntimeConfig below).

chat.ts:
  getRuntimeConfig(env) -> reads all rows from `config`, applies typed
  defaults for any missing key, returns a plain object. Called once per
  /chat request (no caching - D1 reads are cheap, correctness first).
  TOP_K, CONFIDENCE_THRESHOLD, WEB_SEARCH_MODE, HARD_FAIL_NO_DOCUMENT,
  JEV_ENABLED, GUARDRAIL_ENABLED all come from this instead of hardcoded
  constants / env vars.

  New behavior: after JEV filtering, if the top remaining chunk's
  confidence is below CONFIDENCE_THRESHOLD, treat docSources as empty
  (same as "nothing relevant found") before deciding on web fallback.
  If WEB_SEARCH_MODE is "rag_only", never call webSearch regardless of
  docSources.length. If HARD_FAIL_NO_DOCUMENT is true and both docSources
  and webSources end up empty, skip generation and return a fixed
  "I don't have enough information to answer that" message instead of
  asking the LLM to answer with "No context found."

admin.ts:
  GET /admin/config -> current effective config (typed, with defaults
  filled in).
  PUT /admin/config -> upserts one or more key/value pairs into `config`.
  handleAdminDocuments -> unchanged fields, plus a new `chunks` field per
  document: null for all but the 3 most-recently-indexed (by indexedAt)
  documents that have a chunkCount in customMetadata. For those three,
  reconstructs chunk ids via chunkVectorId(source, 0..chunkCount-1) and
  calls VECTORIZE.getByIds(ids), returning [{chunkId, page, text}] sorted
  by chunkId.
  handleAdminTransactions -> adds jevModel (the JEV model id string when
  the transaction ran with JEV enabled, else null) to each row.

transactionTrace.ts: TransactionTrace gains `jevModel: string | null`.
D1 `transactions` table gains a `jev_model` column (migration 0002).

frontend/dashboard.html/js/css:
  New "Settings" tab: form fields for TOP_K (number), CONFIDENCE_THRESHOLD
  (number 0-1), WEB_SEARCH_MODE (radio: RAG only / RAG + web fallback),
  HARD_FAIL_NO_DOCUMENT (checkbox), JEV_ENABLED (checkbox), GUARDRAIL_ENABLED
  (checkbox). Save button -> PUT /admin/config. Success/error banner.
  Fixed label under the form: "Changes apply to the next question asked -
  Cloudflare Workers have no long-running process to restart."
  PDFs & Chunks tab: summary stats row (document count, total chunks) above
  the table; each of the 3 most-recent documents gets an expandable chunk
  list under its row, with a banner: "Chunk text shown for the 3 most
  recently indexed documents only."
  TransactionTracker tab: each transaction card becomes a closed-by-default
  `<details>` whose summary shows question/timestamp/path/confidence, and
  whose body is the existing retrieval table + LLM/JEV blocks (now also
  showing the JEV model name next to "JEV input").
  Visual polish: dashboard.css already has a defined color system
  (`--brand-start`/`--brand-end`/etc) - no changes needed there beyond
  what the new components use.

frontend/index.html/app.js/style.css:
  New color system matching dashboard.css's tokens (extracted into
  style.css directly - no shared file, to keep each page's assets
  self-contained per this codebase's existing pattern of independent
  frontend pages).
  Chat: on submit, show an animated assistant message ("Thinking" +
  animated dots) whose text cycles through a small fixed set of phrases
  ("Searching your notes...", "Checking sources...", "Composing an
  answer...") on a ~1.2s timer, replaced by the real answer when the
  response arrives (or an error message on failure). Timer is cleared in
  both the success and error paths.
```

## Data flow

1. Operator opens the Settings tab -> `GET /admin/config` -> form populated
   from D1 (or defaults if the table is empty/unseeded).
2. Operator changes a value, clicks Save -> `PUT /admin/config` -> upserts
   into D1 -> success banner.
3. Next `/chat` request -> `getRuntimeConfig` reads the updated row(s) ->
   new TOP_K/threshold/mode/hard-fail behavior applies immediately.
4. Dashboard's Documents tab -> `GET /admin/documents` -> for the 3 newest
   documents, chunk text is fetched via `VECTORIZE.getByIds` and returned
   inline; older documents get `chunks: null` and the row shows a plain
   "chunks not shown" note instead of a chunk list.
5. Dashboard's TransactionTracker tab -> unchanged endpoint, new `jevModel`
   field flows through to the UI; cards render collapsed, expand on click.

## Error handling

- `GET /admin/config` / `PUT /admin/config`: same try/catch-to-JSON-500
  pattern as the existing three admin routes (established in the previous
  change, `adminErrorResponse` helper reused).
- `PUT /admin/config` validates each field server-side (e.g.
  `CONFIDENCE_THRESHOLD` must be a number in [0,1], `TOP_K` a positive
  integer, `WEB_SEARCH_MODE` one of the two known values) and returns 400
  with a field-specific error message on invalid input, without writing
  anything - a partial/bad write must never corrupt config for other
  fields.
- Chunk reconstruction: if `VECTORIZE.getByIds` returns fewer vectors than
  expected (a chunk was deleted/never indexed), missing chunk ids are
  simply omitted from the response rather than erroring the whole
  `/admin/documents` call.
- Chat "thinking" indicator: if the request errors, the indicator is
  replaced by the existing error message path (unchanged), and the phrase-
  cycling timer is always cleared via `finally`, so a failed request can
  never leave a stale "Thinking..." message animating forever.

## Testing

- `worker/test/config.test.ts` (new): `getRuntimeConfig` defaults when the
  table is empty; typed parsing of stored string values; `handleAdminConfig`
  GET/PUT including the validation-rejects-bad-input cases.
- `worker/test/chat.test.ts` (extend): confidence-threshold fallback to web
  search; `WEB_SEARCH_MODE=rag_only` never calls webSearch even when
  docSources is empty; `HARD_FAIL_NO_DOCUMENT=true` skips generation and
  returns the fixed message.
- `worker/test/admin.test.ts` (extend): chunk reconstruction for the 3
  newest documents only, using a fake `VECTORIZE.getByIds`; documents
  beyond the 3 newest get `chunks: null`; `jevModel` present/absent
  correctly in transaction rows.
- Frontend: no test framework in this repo (confirmed for the first
  dashboard change too) - manual verification pass covering the Settings
  tab round-trip, chunk browser display, transaction tree expand/collapse,
  and the chat "thinking" indicator's timer cleanup on both success and
  error.
