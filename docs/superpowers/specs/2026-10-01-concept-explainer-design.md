# Concept Explainer — Design

## Problem / intent

Students (16-17, i.e. roughly Class 10-11 level) using the chat app can ask
questions and get answers, but there's no dedicated surface for "explain this
concept to me properly" — simple language, step-by-step, formula/definition
called out, with a table or image if that helps. This is the core pain point
EdukripaLive exists to solve (teachers not explaining well), and today the
chat pipeline's answer format (short/auto/detailed free text) doesn't serve
it well.

Success: a student can switch into "Concept Explainer" mode on the existing
chat page, type a concept, and get a structured, grade-appropriate
explanation — grounded in ingested course material where possible, filled
out with general knowledge where the material is thin, with an optional
real-world example, an optional reused page screenshot, an optional table,
and a "watch a video" search link.

## Scope

**In v1:**
- New `POST /explain` worker endpoint, structured JSON response.
- Reuses existing retrieval pipeline (embed → Vectorize query → rerank →
  JEV → confidence gate) as library functions — no changes to `chat.ts`.
- Two retrieval modes, admin-configurable: `rag_fallback` / `rag_plus_llm`.
- Response fields: concept, simpleExplanation, steps, formula, definition,
  table, realWorldExample, pageImageKey (reused from existing
  ingestion screenshot pipeline), videoSearchUrl, docSources, groundedIn.
  Every field except `concept`/`simpleExplanation` is optional and may be
  omitted by the model when not applicable.
- Grade-level and length discipline baked into the system prompt + a
  `max_tokens` backstop, same two-layer pattern `answerStyle` already uses
  in `chat.ts`.
- Frontend: a Chat / Concept Explainer mode toggle on the existing chat
  page (`index.html`/`app.js`), sharing the question input.
- Global admin feature flag `conceptExplainerEnabled` (default `true`) —
  masks the entire feature (endpoint + frontend toggle) when off. This is
  the seam for a future paid-tier gate; no per-user entitlement system
  exists or is built here.
- All config fields (new and pre-existing) get a short `title` tooltip in
  the admin Settings tab explaining what they do.

**Explicitly deferred (not v1):**
- LLM-generated diagrams (cost/latency/new failure mode) — fast-follow
  once v1 is validated.
- Auto-detection of "explain X" phrasing in plain chat to auto-switch mode
  — nice-to-have, not required for v1.
- Curated or YouTube-Data-API-sourced video (only a search-query link in
  v1 — zero cost, zero new failure mode).
- Per-user / per-paid-tier gating — requires a student identity system
  that doesn't exist today. The global flag is the seam to build on later.

## Architecture

### New endpoint: `POST /explain`

Added to the flat routing chain in `worker/src/index.ts`, same pattern as
`/chat`. Implementation in new `worker/src/explain.ts`, following
`chat.ts`'s shape closely:

1. Parse body: `{ concept: string }`. 400 if empty.
2. Load `config` via `getRuntimeConfig(env)`.
3. If `!config.conceptExplainerEnabled` → 404 (feature masked; frontend
   won't show the entry point either, but the backend must not silently
   behave as if nothing is wrong — a 404 is the honest signal to any
   direct caller).
4. Guardrail check — reuse `checkQueryInScopeAndAgeAppropriate` exactly as
   `chat.ts` does. Fails closed (blocks on error), same as chat.
5. Retrieval: embed the concept string, `VECTORIZE.query`, `rerank`,
   `scoreChunksWithJev` + `filterJevScored`, confidence gate — **all reused
   verbatim from the functions `chat.ts` already imports** (`rerank.ts`,
   `jev.ts`), not reimplemented. `explain.ts` imports the same functions
   `chat.ts` does.
6. Branch on `config.explainRetrievalMode`:
   - `rag_fallback`: if `docSources.length > 0`, build context from them
     only and instruct the model to explain strictly from that context
     (mirrors chat's source-fidelity instruction). If empty, explain from
     general knowledge, and mark `groundedIn: "general_knowledge"`.
   - `rag_plus_llm` (**default**): always pass whatever `docSources` were
     retrieved (possibly empty) as grounding context, with an instruction
     to use them as the primary source of truth for facts/formulas/
     definitions but to complete the explanation (steps, simple language,
     example) using general knowledge where the retrieved context doesn't
     cover it. `groundedIn` reflects what actually happened:
     `"documents"` (docSources used and sufned the full answer),
     `"general_knowledge"` (no docSources), or `"both"`.
7. Call `generateChatCompletion` (unchanged, reused from `llm.ts`) with the
   Concept Explainer system prompt (see below) and a `max_tokens` cap.
8. Parse the model's fenced JSON response (see Response contract). On
   parse failure, fall back to `{ concept, simpleExplanation: <raw text>,
   steps: null, formula: null, definition: null, table: null,
   realWorldExample: null }` rather than failing the request — same
   "never throws, degrade gracefully" posture as `parseEnrichedPages`.
9. Attach `pageImageKey` from the top docSource that has one (if any),
   `videoSearchUrl` built from the concept string, `docSources` (same
   shape as chat's).
10. Record a transaction trace via the **same** `buildTransactionTrace` /
    `recordTransaction` machinery `chat.ts` uses (fire-and-forget via
    `ctx.waitUntil`), so Concept Explainer calls show up in the existing
    TransactionTracker/Costing dashboard tabs. `pathTaken` gets a new
    value `"concept_explainer"` so transactions are distinguishable from
    `/chat` calls in the trace.

### System prompt

New prompt constant in `explain.ts` (not reusing chat's `SYSTEM_PROMPT` —
different contract and purpose):

- Audience: "You are explaining a concept to a Class 10 student (age
  15-16)." Age-appropriate, simple language, avoid jargon without
  defining it.
- Structure instruction: produce a simple explanation, step-by-step
  breakdown, formula (if the concept has one) and a one-line definition,
  optionally a comparison/data table, optionally one real-world example —
  **omit any field that genuinely doesn't apply** rather than padding.
- Length discipline: total output across all fields must stay within
  **10-15 sentences across 2-3 paragraphs/sections** — a ceiling, not a
  target; shorter is fine for a simple concept.
- Output format: a single fenced ```json block matching the response
  schema below, nothing else outside the fence.
- Source-fidelity instruction scaled by retrieval mode (see step 6 above).

`max_tokens` backstop: a fixed cap (e.g. 700 — generous enough for a
structured multi-field JSON response but still bounding a runaway
generation) is the safety net; the prompt instruction is the real
steering, exactly mirroring the `ANSWER_STYLE_MAX_TOKENS` pattern in
`chat.ts`.

### Response contract

```ts
interface ExplainResponse {
  concept: string;
  simpleExplanation: string;
  steps: string[] | null;
  formula: string | null;
  definition: string | null;
  table: { headers: string[]; rows: string[][] } | null;
  realWorldExample: string | null;
  pageImageKey: string | null;
  videoSearchUrl: string;
  docSources: Array<{
    source: string;
    page: number;
    pageEnd: number;
    text: string;
    pageImageKey: string | null;
  }>;
  groundedIn: "documents" | "general_knowledge" | "both";
}
```

`videoSearchUrl` is always present (built server-side, no external call):
`https://www.youtube.com/results?search_query=<urlencode(concept + " explained")>`.

### Config changes (`worker/src/config.ts`)

New `RuntimeConfig` fields:

```ts
explainRetrievalMode: "rag_fallback" | "rag_plus_llm"; // default "rag_plus_llm"
conceptExplainerEnabled: boolean;                       // default true
```

Added to `DEFAULT_CONFIG`, `parseConfigRows`, `KNOWN_FIELDS`, and
`validateConfigUpdate` (enum check for the mode, boolean check for the
flag), following the exact pattern every existing field already uses.

Every config field (new and existing) gets a short explanatory tooltip in
the admin Settings tab — a `title="..."` attribute on each `<label>` in
`dashboard.js`'s settings render function, since there's no existing
tooltip component to reuse; plain `title` attributes match the current
plain-HTML styling of that tab with no new dependency.

### Frontend

`frontend/index.html` / `frontend/app.js`:

- A small mode toggle (Chat / Concept Explainer) near the existing
  question input, visible only when `conceptExplainerEnabled` is true
  (fetched once from a lightweight public config read — reuse the
  existing `/admin/config` shape is not appropriate since that's
  admin-gated; instead `/explain` 404s and the frontend hides the toggle
  after a failed probe, OR — simpler — the toggle is always rendered and
  a 404 from `/explain` shows a friendly "this feature isn't available
  right now" message inline. **Recommended: the simpler option** — avoids
  a new public config-exposure endpoint for one boolean).
- Explainer mode: same input box, posts to `/explain` with
  `{ concept: <input value> }` instead of `/chat`'s `{ question }`.
- Renders returned sections conditionally — only sections with non-null,
  non-empty content get a heading/box. Order: simple explanation → steps →
  formula/definition (highlighted box) → table → real-world example →
  page image → "Watch a video" link → doc sources (reusing the existing
  doc-source citation UI pattern from chat).

### Error handling

- Malformed/missing `concept` in body → 400, same style as chat's missing
  `question`.
- `conceptExplainerEnabled: false` → 404 from `/explain`.
- Guardrail error → fails closed (blocks), same as chat.
- JEV error → fails open (unfiltered passthrough), reusing existing JEV
  module behavior unchanged.
- LLM call failure (OpenRouter outage, bad model slug) → throws, same as
  chat's `generateChatCompletion` contract — visible failure, not a
  silent degrade, consistent with the project's stated philosophy that
  generation failures must never be invisible.
- Malformed JSON from the LLM → falls back to raw-text-only response
  (never throws), as described in step 8 above.

### Testing

`worker/test/explain.test.ts`, mirroring `chat.test.ts` conventions
(mocked `AI`, `VECTORIZE`, `EDU_LIVE_DB`, `OPENROUTER_API_KEY` env):

- Happy path, `rag_fallback` mode, docSources found.
- Happy path, `rag_fallback` mode, no docSources → general-knowledge
  explanation, `groundedIn: "general_knowledge"`.
- Happy path, `rag_plus_llm` mode, partial docSources → `groundedIn:
  "both"`.
- `conceptExplainerEnabled: false` → 404.
- Guardrail blocks → fails closed, matching chat's existing test.
- Malformed LLM JSON response → graceful fallback, not a thrown error.
- Missing `concept` in body → 400.
- Transaction trace recorded with `pathTaken: "concept_explainer"`.
- `videoSearchUrl` correctly URL-encodes the concept string.

`worker/test/config.test.ts` gets cases for the two new fields (valid/
invalid values, default when absent from D1 rows).

## Open items for implementation plan (not blocking spec approval)

- Exact `max_tokens` cap value — pick empirically from a few manual trial
  generations during implementation, documented as a comment the way
  `ANSWER_STYLE_MAX_TOKENS` is.
- Exact frontend layout/styling of the structured sections — implementation
  detail, not an architectural decision.
