# Cloudflare RAG migration — design

Status: approved by user, pending implementation plan.
Repo: `edu_live` (fresh project; old Python app lives on in `edukripa_edutech`, untouched).

## Goal

Replace the local Python/Streamlit/ChromaDB RAG stack with a Cloudflare-native
equivalent (free-tier: Workers, Vectorize, Workers AI, R2, Pages) and prove it
actually works end-to-end (upload a PDF, then chat about it) before iterating
further. This is a full rewrite, not a port of the Python code — the Python
app stays available for reference/fallback in `edukripa_edutech` but is not
being kept in this repo.

## Explicit non-goals for this pass

- No multi-turn agentic tool-calling loop (the model deciding whether to call
  `search_documents`/`web_search` across iterations, as `query_engine.py`
  does today). This version runs a **fixed pipeline** instead: retrieve →
  rerank → JEV filter → (web fallback if needed) → generate. The agentic
  loop is a known, deliberate cut — carry it forward as a follow-up once the
  fixed pipeline is proven working. (Noted for future-session memory.)
- No full observability dashboard port (`observability.py` +
  `observability_dashboard.py`'s SQLite-backed UI). `wrangler tail` /
  Cloudflare's own logs are enough to verify this pass is working.
  Revisit richer observability options once the pipeline works — user
  wants more options considered here later, not decided yet.
- No response-style features (simple/elaborate answers, sentence-count
  options, question-paper generation, etc.) — captured in the handwritten
  requirements notes but explicitly deferred by the user; not designed for
  here beyond keeping the API surface loosely extensible.
- No detailed config-management redesign — `wrangler.toml` `[vars]` +
  `wrangler secret put` for now; user wants to revisit config logic later.

## Repo shape

```
edu_live/
  worker/           # Cloudflare Worker (TypeScript) - the API
    src/
      index.ts               # router: POST /ingest, POST /chat
      ingestion.ts
      chat.ts
      guardrail.ts            # ported query_scope_and_age_guardrail.py logic
      chunker.ts               # ported chunker.py logic
      pdf.ts                    # PDF text extraction (unpdf)
      jev.ts                     # JEV HTTP client
      webSearch.ts                 # DuckDuckGo fetch, no API key
    wrangler.toml
    package.json
  frontend/         # Cloudflare Pages static site
    index.html
    chat.js
    upload.js
```

Two separate deploy targets (Worker for the API, Pages for the static
frontend) per the user's stated preference — not a combined Pages Functions
project.

## Data flow — ingestion (`POST /ingest`)

1. Client uploads a PDF (multipart/form-data).
2. Worker stores the raw file in R2, keyed by filename. If that key already
   exists, skip re-indexing (mirrors `store.py`'s per-source skip).
3. Extract text via `unpdf` (PDF.js-based, runs natively in the Workers JS
   runtime — no Pyodide/Python involved; this was the one piece Cloudflare's
   own write-up flagged as awkward, and unpdf is the way around it).
4. Chunk the extracted text using the same word-count-with-overlap algorithm
   as `chunker.py`, ported directly to TS (pure algorithmic code, no
   behavior change).
5. Embed each chunk via `env.AI.run("@cf/baai/bge-base-en-v1.5", {text})`.
6. Upsert each chunk's vector + metadata (source filename, page, chunk text,
   chunk id) into `env.VECTORIZE`.

## Data flow — chat (`POST /chat`)

Fixed pipeline, no agentic loop (see non-goals):

1. **Guardrail** (`guardrail.ts`) — embed the incoming question via Workers
   AI (`@cf/baai/bge-base-en-v1.5`, same model as ingestion so vectors are
   comparable); compare cosine similarity against in-scope
   (science/maths) and out-of-scope reference example sets, same policy
   logic as `query_scope_and_age_guardrail.py`'s `decide_guardrail_outcome`
   (ported 1:1 — pure function, no I/O). Combined with the same keyword
   hard-block list. Blocked → return the refusal immediately; nothing below
   runs. Toggle: `GUARDRAIL_ENABLED` (default true).
2. **Retrieve** — embed the question (reuse guardrail's embedding call's
   model, but this is a separate `env.AI.run` call since the guardrail may
   be disabled), query `env.VECTORIZE` for top-k candidates.
3. **Rerank** — pass (question, candidate) pairs through Cloudflare
   Workers AI's reranker model (exact model id to be confirmed against
   Workers AI's current catalog at implementation time — this is the
   direct port of `reranker.py`'s cross-encoder role: fixes the same
   "cosine similarity isn't well-calibrated for relevance" problem its
   docstring describes). Never raises — falls back to cosine order if the
   call fails, same fallback philosophy as `reranker.py`.
4. **JEV filter** (`jev.ts`) — send the reranked chunks + question to the
   JEV API; keep only chunks at/above the relevance threshold, drop any
   flagged for injection. Toggle: `JEV_ENABLED` (default true, per the
   user's original request). Never raises — falls back to the reranked
   list if JEV is unreachable/disabled, logs it, continues.
5. **Web fallback** (`webSearch.ts`) — if JEV leaves zero or weak chunks,
   fall back to a DuckDuckGo search (no API key, same approach as
   `web_search.py`), same document-first-then-web policy as today.
6. **Generate** — call Workers AI's Llama 3.1 8B Instruct
   (`@cf/meta/llama-3.1-8b-instruct`) with the surviving context. System
   prompt carries the age/scope reinforcement (mirrors the addition made to
   `SYSTEM_PROMPT` in the Python app) plus the document-first policy.
   Return `{answer, doc_sources, web_sources}`.

## Error handling

Each stage catches its own failures and degrades gracefully rather than
hard-failing the request — same philosophy the Python app already follows
in `store.py`/`web_search.py`/`reranker.py`:
- Guardrail embedding failure → log it, treat as allowed (fail open) rather
  than blocking legitimate traffic on an infra hiccup. *(Open question for
  plan/review: fail-open vs fail-closed on guardrail errors — flagging
  this explicitly since it's a real product decision, not a code detail.)*
- Rerank failure → fall back to cosine order.
- JEV failure/timeout → skip filtering, use reranked chunks as-is.
- Web search failure → proceed with whatever document chunks exist, or a
  clear "insufficient information" answer if there are none.

## Config & secrets

- `wrangler.toml` `[vars]`: `GUARDRAIL_ENABLED`, `JEV_ENABLED` (both default
  true).
- `wrangler secret put JEV_API_KEY` (and any other required secrets) —
  never committed, same discipline as `.env` today.
- Deeper config-management changes (e.g. per-environment config, more
  granular thresholds) explicitly deferred — user wants to revisit this
  later.

## Observability (MVP-minimal, to be expanded later)

For this pass: `console.log`/`wrangler tail` only, enough to confirm each
stage of the pipeline ran and what it decided (guardrail verdict, retrieval
candidate count, rerank/JEV scores, routing path doc-vs-web). No persistent
dashboard yet. User wants more options considered for a real observability
story later (open item, not designed here).

## Testing approach

- **Pure logic** (guardrail decision function, chunking algorithm): Vitest
  unit tests, TDD — same approach used for the Python guardrail
  (`decide_guardrail_outcome` equivalent tested without any Cloudflare
  bindings or network calls).
- **Binding-dependent logic** (Vectorize, R2, Workers AI, JEV, DuckDuckGo):
  verified by running `wrangler dev` locally and exercising `/ingest` then
  `/chat` with curl against a real test PDF (one of the files currently in
  `data/`) — this is what "test how it's functioning" means for this pass;
  bindings can't be meaningfully mocked without losing the point of the
  test.

## Cleanup as part of this work

Remove the entire Python app from `edu_live` (`src/`, `tests/`,
`requirements.txt`, `chroma_db/` if present, `data/` PDFs get copied into
`worker/test-fixtures/` or similar for the manual smoke test, not left at
the repo root as app data). `README.md`/`docs/`/`plans/` get replaced or
trimmed to reflect the new stack — exact handling left to the implementation
plan.
