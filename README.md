# Edukripa RAG (Cloudflare)

Cloudflare-native RAG chatbot for science/maths Q&A, aimed at 16-17 year old
students. Free-tier stack: Workers, Vectorize, Workers AI, R2, Pages.

- `worker/` — the API: `POST /ingest` (upload + index a PDF), `POST /chat`
  (ask a question). Pipeline: guardrail → retrieve → rerank → JEV filter →
  web fallback → generate. See
  `docs/superpowers/specs/2026-09-28-cloudflare-rag-migration-design.md`
  for the full design and
  `docs/superpowers/plans/2026-09-28-cloudflare-rag-migration.md` for how
  it was built.
- `frontend/` — a static Pages site: a PDF upload form and a chat box.

## Prerequisites

- A Cloudflare account.
- `wrangler login` (run inside `worker/` or `frontend/` — both use the same
  account).
- An OpenRouter API key (used to call the JEV relevance-filtering model)
  if you want JEV actually filtering chunks rather than passing everything
  through. Without one, the pipeline still works — JEV calls fail auth and
  fall back to "pass chunks through unfiltered," logged as
  `JEV call failed, passing chunks through unfiltered`.

## First-time setup

```bash
cd worker
npm install
npx wrangler vectorize create edu-live-chunks --dimensions=768 --metric=cosine
npx wrangler r2 bucket create edu-live-pdfs
npx wrangler secret put OPENROUTER_API_KEY   # paste your OpenRouter key when prompted
```

## Local development

```bash
cd worker
npx wrangler dev --persist-to=.wrangler/state
```

Note: `wrangler dev --local` cannot emulate Vectorize or Workers AI — both
always hit the real (free-tier) Cloudflare services, so `wrangler.toml`
sets `remote = true` on the Vectorize binding and Workers AI is remote by
default. Expect real (if small) usage against your account even in dev.

In a separate terminal, serve the frontend:

```bash
cd frontend
npx serve .
```

`frontend/app.js`'s `WORKER_URL` constant points at whatever URL the
Worker is reachable at — update it to your local `wrangler dev` URL (or
the deployed Worker URL) as needed.

## Tests

```bash
cd worker
npx vitest run     # pure-logic unit tests (chunker, guardrail, rerank, JEV filter, web search formatting)
npx tsc --noEmit   # type-check
```

Binding-dependent behavior (ingestion, chat pipeline) is verified manually
via `wrangler dev` + curl, not automated — see the plan doc for the exact
commands used.

## Deploy

```bash
cd worker
npx wrangler deploy
```

Update `WORKER_URL` in `frontend/app.js` to the deployed Worker's URL,
then:

```bash
cd ../frontend
npx wrangler deploy
```

## Known follow-ups

- No multi-turn agentic tool-calling loop yet — the chat pipeline is a
  fixed sequence (retrieve → rerank → JEV → web fallback → generate), not
  the model deciding when to re-search.
- Observability is `wrangler tail`/`console.log` only for now; no
  persistent dashboard.
- The generation model (`@cf/meta/llama-3.1-8b-instruct-fp8`) and reranker
  model (`@cf/baai/bge-reranker-base`) were confirmed against Workers AI's
  live catalog as of 2026-09-28 — re-check `npx wrangler ai models` if
  either starts erroring, since Cloudflare deprecates models over time
  (this already happened once during development).
