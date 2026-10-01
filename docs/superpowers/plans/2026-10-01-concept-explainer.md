# Concept Explainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `POST /explain` worker endpoint and a frontend "Concept Explainer" mode that gives students a structured, grade-appropriate explanation (simple language, steps, formula/definition, optional table/example/image/video link) for any concept, grounded in ingested PDFs where possible.

**Architecture:** New `worker/src/explain.ts` reuses the existing chat retrieval pipeline (embed → Vectorize query → rerank → JEV → confidence gate, all unchanged) and the existing `generateChatCompletion`/`buildTransactionTrace` machinery, but with its own system prompt and a structured JSON response contract instead of chat's free-text answer. Two new `RuntimeConfig` fields (`explainRetrievalMode`, `conceptExplainerEnabled`) make retrieval behavior and the whole feature's visibility admin-configurable, mirroring every existing config field's pattern exactly. Frontend adds a Chat/Concept Explainer toggle to the existing chat page that posts to the new endpoint and renders the structured response.

**Tech Stack:** Cloudflare Workers (TypeScript), Vitest, vanilla JS/HTML/CSS frontend (no framework), D1, Vectorize, Workers AI, OpenRouter.

**Spec:** `docs/superpowers/specs/2026-10-01-concept-explainer-design.md`

## Global Constraints

- Every `RuntimeConfig` field change must touch all four of: `DEFAULT_CONFIG`, `parseConfigRows`, `KNOWN_FIELDS`, `validateConfigUpdate` in `worker/src/config.ts` — missing one silently breaks admin config round-tripping.
- `explainRetrievalMode` default: `"rag_plus_llm"`. `conceptExplainerEnabled` default: `true`.
- System prompt must pin register to "Class 10 student (age 15-16)" and cap total output at **10-15 sentences across 2-3 paragraphs/sections** (a ceiling, not a target), backed by a `max_tokens` numeric cap as the hard backstop — same two-layer pattern as `ANSWER_STYLE_MAX_TOKENS` in `worker/src/chat.ts`.
- Every response field except `concept` and `simpleExplanation` is optional (`null` when not applicable) and the frontend must skip-render any section whose value is null/empty — never show an empty heading or box.
- Guardrail check fails **closed** (blocks on error). JEV call fails **open** (unfiltered passthrough on error) — reuse `scoreChunksWithJev`/`filterJevScored` unchanged, do not reimplement this logic.
- `generateChatCompletion` failures must propagate (throw → 502), never silently fall back to a different provider.
- `videoSearchUrl` is always present in a successful response, built server-side with no external API call: `https://www.youtube.com/results?search_query=<urlencode(concept + " explained")>`.
- No database migration needed — `transactions.path_taken` has no CHECK constraint, so a new value (`"concept_explainer"`) is safe to insert.

## Review Focus

- **Malformed/partial JSON from the LLM** (missing fence, truncated response, valid JSON but wrong shape, e.g. `steps` as a string instead of an array) — must degrade to a raw-text fallback response, never throw or return a 500. Reasonable expectation: a bad model output degrades the answer quality, it does not break the request.
- **Empty `concept` field, or a `concept` that's just whitespace** — must return 400 like chat's missing-`question` case, not proceed into an empty-string embedding call.
- **`conceptExplainerEnabled: false` with a request still arriving at `/explain`** (stale frontend tab, direct API call, or the toggle hidden but someone hits the endpoint anyway) — must return 404, not silently answer or 500.
- **Zero retrieved chunks in `rag_fallback` mode** — must produce a real general-knowledge explanation with `groundedIn: "general_knowledge"`, not an empty/error response (this is the explicit fallback the mode name promises).
- **Concept string containing characters that break a URL when building `videoSearchUrl`** (ampersands, quotes, non-ASCII/unicode concepts like a Hindi-script term) — must be correctly percent-encoded via `encodeURIComponent`, not concatenated raw.

---

## File Structure

- **Create `worker/src/explain.ts`** — the `/explain` route handler: body parsing, config/feature-flag check, guardrail call, retrieval pipeline reuse, retrieval-mode branching, system prompt, LLM call, response JSON parsing (with fallback), transaction trace recording. Mirrors `chat.ts`'s shape and size.
- **Create `worker/test/explain.test.ts`** — mirrors `chat.test.ts` conventions and mock helpers.
- **Modify `worker/src/config.ts`** — add `explainRetrievalMode` and `conceptExplainerEnabled` to `RuntimeConfig`, `DEFAULT_CONFIG`, `parseConfigRows`, `KNOWN_FIELDS`, `validateConfigUpdate`.
- **Modify `worker/src/transactionTrace.ts`** — widen `PathTaken` to include `"concept_explainer"`.
- **Modify `worker/src/index.ts`** — add the `POST /explain` route.
- **Modify `worker/test/config.test.ts`** — add cases for the two new fields.
- **Modify `frontend/dashboard.js`** — add a "Concept Explainer" settings card (mode select + enabled checkbox) to `loadSettingsTab`, and `title` tooltips on every settings `<label>` (new and pre-existing).
- **Modify `frontend/index.html`** — add the Chat/Concept Explainer mode toggle UI elements.
- **Modify `frontend/app.js`** — add mode-switch handling, `/explain` POST, and structured-response rendering.
- **Modify `frontend/style.css`** — minimal styling for the new mode toggle and structured explanation sections (reusing existing card/message classes as the base).

---

## Task 1: Config fields — `explainRetrievalMode` and `conceptExplainerEnabled`

**Files:**
- Modify: `worker/src/config.ts`
- Test: `worker/test/config.test.ts`

**Interfaces:**
- Produces: `RuntimeConfig.explainRetrievalMode: "rag_fallback" | "rag_plus_llm"`, `RuntimeConfig.conceptExplainerEnabled: boolean`, both read via `getRuntimeConfig(env)` exactly like every other field.

- [ ] **Step 1: Write the failing tests**

Find the existing test file and add these cases (match the file's existing `describe`/`it` structure and mock-row helper — read the file first to match its exact helper names before writing):

```typescript
describe("explainRetrievalMode and conceptExplainerEnabled", () => {
  it("defaults explainRetrievalMode to rag_plus_llm and conceptExplainerEnabled to true when absent from D1", () => {
    const config = parseConfigRows([]);
    expect(config.explainRetrievalMode).toBe("rag_plus_llm");
    expect(config.conceptExplainerEnabled).toBe(true);
  });

  it("parses explainRetrievalMode and conceptExplainerEnabled from D1 rows", () => {
    const config = parseConfigRows([
      { key: "explainRetrievalMode", value: "rag_fallback" },
      { key: "conceptExplainerEnabled", value: "false" },
    ]);
    expect(config.explainRetrievalMode).toBe("rag_fallback");
    expect(config.conceptExplainerEnabled).toBe(false);
  });

  it("rejects an invalid explainRetrievalMode value", () => {
    const errors = validateConfigUpdate({ explainRetrievalMode: "not_a_mode" });
    expect(errors.some((e) => e.field === "explainRetrievalMode")).toBe(true);
  });

  it("rejects a non-boolean conceptExplainerEnabled value", () => {
    const errors = validateConfigUpdate({ conceptExplainerEnabled: "yes" });
    expect(errors.some((e) => e.field === "conceptExplainerEnabled")).toBe(true);
  });

  it("accepts a valid explainRetrievalMode and conceptExplainerEnabled update", () => {
    const errors = validateConfigUpdate({ explainRetrievalMode: "rag_plus_llm", conceptExplainerEnabled: true });
    expect(errors.length).toBe(0);
  });
});
```

Add the necessary `parseConfigRows`/`validateConfigUpdate` imports at the top of the test file if not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `worker/`): `npx vitest run test/config.test.ts -t "explainRetrievalMode"`
Expected: FAIL — `explainRetrievalMode`/`conceptExplainerEnabled` are `undefined`, and `validateConfigUpdate` doesn't flag them as unrecognized/invalid yet (will actually currently flag them as `Unrecognized config field`, which is also a failure relative to the "accepts a valid update" case).

- [ ] **Step 3: Implement the config fields**

In `worker/src/config.ts`:

```typescript
export type WebSearchMode = "rag_only" | "rag_web_fallback";
export type LlmProvider = "openrouter" | "workers-ai";
export type ExplainRetrievalMode = "rag_fallback" | "rag_plus_llm";

export interface RuntimeConfig {
  topK: number;
  confidenceThreshold: number;
  webSearchMode: WebSearchMode;
  hardFailNoDocument: boolean;
  jevEnabled: boolean;
  guardrailEnabled: boolean;
  llmProvider: LlmProvider;
  llmModelSlug: string;
  jevRelevanceThreshold: number;
  ingestionEnrichmentEnabled: boolean;
  ingestionModelSlug: string;
  explainRetrievalMode: ExplainRetrievalMode;
  conceptExplainerEnabled: boolean;
}
```

Add to `DEFAULT_CONFIG`:

```typescript
  explainRetrievalMode: "rag_plus_llm",
  conceptExplainerEnabled: true,
```

Add to `parseConfigRows`'s returned object:

```typescript
    explainRetrievalMode:
      (map.get("explainRetrievalMode") as ExplainRetrievalMode | undefined) ?? DEFAULT_CONFIG.explainRetrievalMode,
    conceptExplainerEnabled: map.has("conceptExplainerEnabled")
      ? map.get("conceptExplainerEnabled") === "true"
      : DEFAULT_CONFIG.conceptExplainerEnabled,
```

Add to `KNOWN_FIELDS`:

```typescript
  "explainRetrievalMode",
  "conceptExplainerEnabled",
```

Add to `validateConfigUpdate`:

```typescript
  if ("explainRetrievalMode" in input) {
    if (input.explainRetrievalMode !== "rag_fallback" && input.explainRetrievalMode !== "rag_plus_llm") {
      errors.push({
        field: "explainRetrievalMode",
        message: "explainRetrievalMode must be 'rag_fallback' or 'rag_plus_llm'",
      });
    }
  }
  if ("conceptExplainerEnabled" in input && typeof input.conceptExplainerEnabled !== "boolean") {
    errors.push({ field: "conceptExplainerEnabled", message: "conceptExplainerEnabled must be a boolean" });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, all cases including pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add worker/src/config.ts worker/test/config.test.ts
git commit -m "Add explainRetrievalMode and conceptExplainerEnabled config fields"
```

---

## Task 2: Widen `PathTaken` for the Concept Explainer transaction path

**Files:**
- Modify: `worker/src/transactionTrace.ts`

**Interfaces:**
- Produces: `PathTaken = "pdf_only" | "web_fallback" | "concept_explainer"`.

- [ ] **Step 1: Make the change**

In `worker/src/transactionTrace.ts`, line 3:

```typescript
export type PathTaken = "pdf_only" | "web_fallback" | "concept_explainer";
```

- [ ] **Step 2: Verify nothing else breaks**

Run (from `worker/`): `npx tsc --noEmit`
Expected: no new errors (widening a union is backward compatible; `chat.ts`'s existing `pathTaken: "pdf_only" | "web_fallback"` values still satisfy the wider type).

- [ ] **Step 3: Commit**

```bash
git add worker/src/transactionTrace.ts
git commit -m "Widen PathTaken to include concept_explainer"
```

---

## Task 3: `/explain` endpoint — happy path, both retrieval modes

**Files:**
- Create: `worker/src/explain.ts`
- Create: `worker/test/explain.test.ts`

**Interfaces:**
- Consumes: `rerank(query, candidates, scoreFn)` from `./rerank` (returns `RerankedChunk[]`), `workersAiScoreFn(ai)` from `./rerank`, `scoreChunksWithJev(query, chunks, apiKey)` and `filterJevScored(chunks, relMin)` from `./jev`, `generateChatCompletion(messages, maxTokens, env, config)` returning `{ text, provider, model }` from `./llm`, `getRuntimeConfig(env)` from `./config`, `checkQueryInScopeAndAgeAppropriate(question, ai)` from `./guardrailCheck`, `buildTransactionTrace(params)` from `./transactionTrace`.
- Produces: `handleExplain(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>`, exported for `index.ts` to route to.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { handleExplain } from "../src/explain";
import type { Env } from "../src/index";

function makeRequest(body: unknown): Request {
  return new Request("https://worker.example/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function noopCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

type ConfigRow = { key: string; value: string };

function makeMockDb(configRows: ConfigRow[], onInsert?: (args: unknown[]) => void): D1Database {
  return {
    prepare: (sql: string) => {
      if (sql.startsWith("SELECT key, value FROM config")) {
        return { all: async () => ({ results: configRows }) };
      }
      return {
        bind: (...args: unknown[]) => ({
          run: async () => {
            onInsert?.(args);
            return {};
          },
        }),
      };
    },
  } as unknown as D1Database;
}

const DEFAULT_TEST_ROWS: ConfigRow[] = [
  { key: "guardrailEnabled", value: "false" },
  { key: "jevEnabled", value: "false" },
  { key: "llmProvider", value: "workers-ai" },
  { key: "conceptExplainerEnabled", value: "true" },
];

const VALID_LLM_JSON = JSON.stringify({
  concept: "Newton's second law",
  simpleExplanation: "Force equals mass times acceleration - pushing something harder makes it speed up faster.",
  steps: ["Identify the mass of the object", "Identify the net force acting on it", "Divide force by mass to get acceleration"],
  formula: "F = ma",
  definition: "The acceleration of an object is directly proportional to the net force acting on it.",
  table: null,
  realWorldExample: "Pushing a shopping cart - an empty cart speeds up faster than a full one for the same push.",
});

function makeEnv(overrides: Partial<Env> = {}, configRows: ConfigRow[] = []): Env {
  return {
    AI: {
      run: async (model: string) => {
        if (model === "@cf/baai/bge-base-en-v1.5") return { data: [[0.1, 0.2]] };
        if (model === "@cf/baai/bge-reranker-base") return { response: [] };
        return { response: `\`\`\`json\n${VALID_LLM_JSON}\n\`\`\`` };
      },
    },
    VECTORIZE: { query: async () => ({ matches: [] }) },
    PDF_BUCKET: {},
    OPENROUTER_API_KEY: "",
    INGEST_API_KEY: "",
    ADMIN_API_KEY: "",
    EDU_LIVE_DB: makeMockDb([...DEFAULT_TEST_ROWS, ...configRows]),
    ...overrides,
  } as unknown as Env;
}

describe("handleExplain happy path", () => {
  it("returns a structured explanation with no retrieved chunks (rag_fallback mode, general knowledge)", async () => {
    const env = makeEnv({}, [{ key: "explainRetrievalMode", value: "rag_fallback" }]);

    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), env, noopCtx());
    const body = (await response.json()) as {
      concept: string;
      simpleExplanation: string;
      steps: string[] | null;
      formula: string | null;
      groundedIn: string;
      videoSearchUrl: string;
      docSources: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.concept).toBe("Newton's second law");
    expect(body.simpleExplanation).toContain("Force equals mass");
    expect(body.steps).toHaveLength(3);
    expect(body.formula).toBe("F = ma");
    expect(body.groundedIn).toBe("general_knowledge");
    expect(body.videoSearchUrl).toContain("youtube.com/results");
    expect(body.docSources).toEqual([]);
  });

  it("returns groundedIn=documents when chunks are retrieved in rag_fallback mode", async () => {
    const env = makeEnv(
      {
        VECTORIZE: {
          query: async () => ({
            matches: [
              { score: 0.9, metadata: { text: "Force equals mass times acceleration", page: 4, pageEnd: 4, source: "physics.pdf", chunkId: 2 } },
            ],
          }),
        },
      },
      [{ key: "explainRetrievalMode", value: "rag_fallback" }]
    );

    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), env, noopCtx());
    const body = (await response.json()) as { groundedIn: string; docSources: { source: string }[] };

    expect(response.status).toBe(200);
    expect(body.groundedIn).toBe("documents");
    expect(body.docSources.length).toBe(1);
    expect(body.docSources[0].source).toBe("physics.pdf");
  });

  it("returns groundedIn=both when chunks are retrieved in rag_plus_llm mode", async () => {
    const env = makeEnv(
      {
        VECTORIZE: {
          query: async () => ({
            matches: [
              { score: 0.9, metadata: { text: "Force equals mass times acceleration", page: 4, pageEnd: 4, source: "physics.pdf", chunkId: 2 } },
            ],
          }),
        },
      },
      [{ key: "explainRetrievalMode", value: "rag_plus_llm" }]
    );

    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), env, noopCtx());
    const body = (await response.json()) as { groundedIn: string };

    expect(response.status).toBe(200);
    expect(body.groundedIn).toBe("both");
  });

  it("returns groundedIn=general_knowledge in rag_plus_llm mode with no retrieved chunks", async () => {
    const env = makeEnv({}, [{ key: "explainRetrievalMode", value: "rag_plus_llm" }]);

    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), env, noopCtx());
    const body = (await response.json()) as { groundedIn: string };

    expect(response.status).toBe(200);
    expect(body.groundedIn).toBe("general_knowledge");
  });

  it("records a transaction with pathTaken concept_explainer", async () => {
    let inserted: unknown[] | null = null;
    const env = makeEnv({
      EDU_LIVE_DB: makeMockDb(DEFAULT_TEST_ROWS, (args) => { inserted = args; }),
    });

    await handleExplain(makeRequest({ concept: "Newton's second law" }), env, {
      waitUntil: (p: Promise<unknown>) => p,
    } as unknown as ExecutionContext);

    expect(inserted).not.toBeNull();
    // path_taken is the 5th bound column per the INSERT statement in chat.ts's recordTransaction pattern
    expect((inserted as unknown[])[4]).toBe("concept_explainer");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `worker/`): `npx vitest run test/explain.test.ts`
Expected: FAIL — `../src/explain` does not exist yet.

- [ ] **Step 3: Implement `worker/src/explain.ts`**

```typescript
import type { Env } from "./index";
import { checkQueryInScopeAndAgeAppropriate } from "./guardrailCheck";
import { rerank, workersAiScoreFn, type RetrievedChunk } from "./rerank";
import { scoreChunksWithJev, filterJevScored, JEV_MODEL_ID, type JevScoredChunk } from "./jev";
import { buildTransactionTrace, type TransactionTrace } from "./transactionTrace";
import { getRuntimeConfig, type RuntimeConfig } from "./config";
import { generateChatCompletion } from "./llm";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// Generous enough for a full structured JSON response (explanation + steps +
// formula + definition + table + example) while still bounding a runaway
// generation - the system prompt's "10-15 sentences" instruction is the real
// steering, this is only the backstop, same two-layer pattern as
// ANSWER_STYLE_MAX_TOKENS in chat.ts.
const EXPLAIN_MAX_TOKENS = 700;

const RESPONSE_SCHEMA_INSTRUCTIONS = `Respond with a single fenced \`\`\`json code block and nothing else outside it, matching exactly this shape:
{
  "concept": string,
  "simpleExplanation": string,
  "steps": string[] | null,
  "formula": string | null,
  "definition": string | null,
  "table": { "headers": string[], "rows": string[][] } | null,
  "realWorldExample": string | null
}
Omit (set to null) any field that genuinely does not apply to this concept - do not pad fields with filler to fill them in.`;

function buildSystemPrompt(groundingInstruction: string): string {
  return `You are explaining a concept to a Class 10 student (age 15-16) who is struggling to understand it from their teacher's explanation.

Audience and tone:
- Simple, plain language. Avoid jargon; if a technical term is necessary, define it in the same sentence.
- Age-appropriate for a 15-16 year old studying science or maths.

Length discipline (hard ceiling, not a target):
- The TOTAL explanation across all fields combined must stay within 10-15 sentences across 2-3 paragraphs/sections.
- Shorter is fine and preferred for a simple concept - never pad to reach the ceiling.

${groundingInstruction}

${RESPONSE_SCHEMA_INSTRUCTIONS}`;
}

const RAG_FALLBACK_GROUNDED_INSTRUCTION =
  "Source policy: Base your explanation strictly on the context provided below. Stay close to its wording for facts, formulas, and definitions. Do not add outside facts not present in the context, even ones you know to be true.";

const RAG_FALLBACK_UNGROUNDED_INSTRUCTION =
  "Source policy: No course material was found for this concept. Explain it from your own general knowledge, clearly and accurately.";

const RAG_PLUS_LLM_INSTRUCTION =
  "Source policy: Context from the student's course material is provided below, if any. Treat it as the primary source of truth for facts, formulas, and definitions where it's relevant - but you may and should complete the explanation (steps, plain-language framing, a real-world example) using your own general knowledge where the context doesn't cover it. Do not contradict the provided context.";

export interface ExplainResponseBody {
  concept: string;
  simpleExplanation: string;
  steps: string[] | null;
  formula: string | null;
  definition: string | null;
  table: { headers: string[]; rows: string[][] } | null;
  realWorldExample: string | null;
  pageImageKey: string | null;
  videoSearchUrl: string;
  docSources: Array<{ source: string; page: number; pageEnd: number; text: string; pageImageKey: string | null }>;
  groundedIn: "documents" | "general_knowledge" | "both";
}

function buildVideoSearchUrl(concept: string): string {
  const query = encodeURIComponent(`${concept} explained`);
  return `https://www.youtube.com/results?search_query=${query}`;
}

interface ParsedLlmExplanation {
  concept: string;
  simpleExplanation: string;
  steps: string[] | null;
  formula: string | null;
  definition: string | null;
  table: { headers: string[]; rows: string[][] } | null;
  realWorldExample: string | null;
}

/**
 * Tolerant parser for the LLM's fenced-JSON response. Never throws - a
 * missing fence, truncated response, or valid-JSON-wrong-shape output all
 * fall back to a raw-text-only explanation rather than failing the request,
 * same "never throws" posture as parseEnrichedPages in ingestionEnrichment.ts.
 */
function parseExplainLlmResponse(rawText: string, concept: string): ParsedLlmExplanation {
  const fenceMatch = rawText.match(/```json\s*([\s\S]*?)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : rawText;

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const simpleExplanation = typeof parsed.simpleExplanation === "string" ? parsed.simpleExplanation : rawText.trim();
    return {
      concept: typeof parsed.concept === "string" ? parsed.concept : concept,
      simpleExplanation,
      steps: Array.isArray(parsed.steps) && parsed.steps.every((s) => typeof s === "string") ? (parsed.steps as string[]) : null,
      formula: typeof parsed.formula === "string" ? parsed.formula : null,
      definition: typeof parsed.definition === "string" ? parsed.definition : null,
      table:
        parsed.table &&
        typeof parsed.table === "object" &&
        Array.isArray((parsed.table as { headers?: unknown }).headers) &&
        Array.isArray((parsed.table as { rows?: unknown }).rows)
          ? (parsed.table as { headers: string[]; rows: string[][] })
          : null,
      realWorldExample: typeof parsed.realWorldExample === "string" ? parsed.realWorldExample : null,
    };
  } catch {
    return {
      concept,
      simpleExplanation: rawText.trim(),
      steps: null,
      formula: null,
      definition: null,
      table: null,
      realWorldExample: null,
    };
  }
}

async function recordExplainTransaction(env: Env, trace: TransactionTrace): Promise<void> {
  try {
    await env.EDU_LIVE_DB.prepare(
      `INSERT INTO transactions
        (timestamp, question, provider, model, path_taken, confidence, retrieval_json,
         llm_input, llm_output, jev_input_json, jev_output_json, input_tokens, output_tokens,
         jev_cost_usd, llm_cost_usd, jev_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        trace.timestamp,
        trace.question,
        trace.provider,
        trace.model,
        trace.pathTaken,
        trace.confidence,
        JSON.stringify(trace.retrieval),
        trace.llmInput,
        trace.llmOutput,
        trace.jevInput ? JSON.stringify(trace.jevInput) : null,
        trace.jevOutput ? JSON.stringify(trace.jevOutput) : null,
        trace.inputTokens,
        trace.outputTokens,
        trace.jevCostUsd,
        trace.llmCostUsd,
        trace.jevModel
      )
      .run();
  } catch (err) {
    console.error("failed to record explain transaction trace", err);
  }
}

export async function handleExplain(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { concept?: string } | null;
  const concept = body?.concept?.trim();

  if (!concept) {
    return Response.json({ error: "Expected JSON body with a 'concept' field" }, { status: 400 });
  }

  const config = await getRuntimeConfig(env);

  if (!config.conceptExplainerEnabled) {
    return Response.json({ error: "Concept Explainer is not available right now" }, { status: 404 });
  }

  if (config.guardrailEnabled) {
    const decision = await checkQueryInScopeAndAgeAppropriate(concept, env.AI);
    if (!decision.allowed) {
      const status = decision.reason === "guardrail_error" ? 503 : 200;
      return Response.json(
        {
          concept,
          simpleExplanation: decision.refusalMessage,
          steps: null,
          formula: null,
          definition: null,
          table: null,
          realWorldExample: null,
          pageImageKey: null,
          videoSearchUrl: buildVideoSearchUrl(concept),
          docSources: [],
          groundedIn: "general_knowledge",
        },
        { status }
      );
    }
  }

  try {
    const embedResponse = await env.AI.run(EMBEDDING_MODEL, { text: [concept] });
    const conceptVector = (embedResponse as { data: number[][] }).data[0];

    const matches = await env.VECTORIZE.query(conceptVector, { topK: config.topK, returnMetadata: true });
    const retrieved: RetrievedChunk[] = matches.matches.map((m) => ({
      text: String(m.metadata?.text ?? ""),
      page: Number(m.metadata?.page ?? 0),
      pageEnd: Number(m.metadata?.pageEnd ?? 0),
      source: String(m.metadata?.source ?? ""),
      chunkId: Number(m.metadata?.chunkId ?? 0),
      cosineScore: m.score,
      pageImageKey: m.metadata?.pageImageKey ? String(m.metadata.pageImageKey) : null,
    }));

    const reranked = await rerank(concept, retrieved, workersAiScoreFn(env.AI));

    const jevEnabled = config.jevEnabled;
    const jevResult = jevEnabled
      ? await scoreChunksWithJev(concept, reranked, env.OPENROUTER_API_KEY)
      : {
          chunks: reranked.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }) as JevScoredChunk),
          costUsd: 0,
          success: true,
        };

    const jevDocSources =
      jevEnabled && jevResult.success
        ? filterJevScored(jevResult.chunks, config.jevRelevanceThreshold)
        : jevResult.chunks;

    const topConfidence = jevDocSources[0] ? jevDocSources[0].rerankScore ?? jevDocSources[0].cosineScore : null;
    const passesConfidenceGate =
      config.confidenceThreshold <= 0 || topConfidence === null || topConfidence >= config.confidenceThreshold;
    const docSources = passesConfidenceGate ? jevDocSources : [];
    const keptKeys = new Set(docSources.map((c) => `${c.source}::${c.chunkId}`));

    const documentContext = docSources.map((c) => `[${c.source} p.${c.page}]\n${c.text}`).join("\n\n");
    const hasContext = docSources.length > 0;

    let groundingInstruction: string;
    let groundedIn: ExplainResponseBody["groundedIn"];
    if (config.explainRetrievalMode === "rag_fallback") {
      groundingInstruction = hasContext ? RAG_FALLBACK_GROUNDED_INSTRUCTION : RAG_FALLBACK_UNGROUNDED_INSTRUCTION;
      groundedIn = hasContext ? "documents" : "general_knowledge";
    } else {
      groundingInstruction = RAG_PLUS_LLM_INSTRUCTION;
      groundedIn = hasContext ? "both" : "general_knowledge";
    }

    const llmInput = hasContext
      ? `Concept: ${concept}\n\nContext:\n${documentContext}`
      : `Concept: ${concept}\n\nNo course material context was found for this concept.`;

    const jevModel = jevEnabled ? JEV_MODEL_ID : null;

    const generateResult = await generateChatCompletion(
      [
        { role: "system", content: buildSystemPrompt(groundingInstruction) },
        { role: "user", content: llmInput },
      ],
      EXPLAIN_MAX_TOKENS,
      env,
      config
    );

    const parsed = parseExplainLlmResponse(generateResult.text, concept);
    const pageImageKey = docSources.find((c) => c.pageImageKey)?.pageImageKey ?? null;

    const trace = buildTransactionTrace({
      question: concept,
      provider: generateResult.provider,
      model: generateResult.model,
      pathTaken: "concept_explainer",
      jevAnnotated: jevResult.chunks,
      keptKeys,
      llmInput,
      llmOutput: generateResult.text,
      jevEnabled,
      jevModel,
      jevCostUsd: jevResult.costUsd,
    });
    ctx.waitUntil(recordExplainTransaction(env, trace));

    const responseBody: ExplainResponseBody = {
      concept: parsed.concept,
      simpleExplanation: parsed.simpleExplanation,
      steps: parsed.steps,
      formula: parsed.formula,
      definition: parsed.definition,
      table: parsed.table,
      realWorldExample: parsed.realWorldExample,
      pageImageKey,
      videoSearchUrl: buildVideoSearchUrl(concept),
      docSources: docSources.map((c) => ({
        source: c.source,
        page: c.page,
        pageEnd: c.pageEnd,
        text: c.text,
        pageImageKey: c.pageImageKey,
      })),
      groundedIn,
    };

    return Response.json(responseBody);
  } catch (err) {
    console.error("explain pipeline failed", err);
    return Response.json(
      { error: "Something went wrong explaining this concept - please try again." },
      { status: 502 }
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/explain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/explain.ts worker/test/explain.test.ts
git commit -m "Add POST /explain endpoint with structured concept-explanation response"
```

---

## Task 4: `/explain` error handling, feature-flag gating, and malformed-LLM-output fallback

**Files:**
- Modify: `worker/test/explain.test.ts` (add cases)

**Interfaces:**
- Consumes: `handleExplain` from Task 3 (no signature change).

- [ ] **Step 1: Write the failing tests**

Append to `worker/test/explain.test.ts`:

```typescript
describe("handleExplain error handling", () => {
  it("returns 400 when concept is missing", async () => {
    const env = makeEnv();
    const response = await handleExplain(makeRequest({}), env, noopCtx());
    expect(response.status).toBe(400);
  });

  it("returns 400 when concept is only whitespace", async () => {
    const env = makeEnv();
    const response = await handleExplain(makeRequest({ concept: "   " }), env, noopCtx());
    expect(response.status).toBe(400);
  });

  it("returns 404 when conceptExplainerEnabled is false", async () => {
    const env = makeEnv({}, [{ key: "conceptExplainerEnabled", value: "false" }]);
    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), env, noopCtx());
    expect(response.status).toBe(404);
  });

  it("returns a JSON 502, not an uncaught exception, when a downstream call throws", async () => {
    const throwingEnv = makeEnv({
      AI: { run: async () => { throw new Error("Workers AI is down"); } },
      VECTORIZE: {},
      PDF_BUCKET: {},
    });

    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), throwingEnv, noopCtx());

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });

  it("falls back to raw-text explanation when the LLM response has no JSON fence", async () => {
    const env = makeEnv({
      AI: {
        run: async (model: string) => {
          if (model === "@cf/baai/bge-base-en-v1.5") return { data: [[0.1, 0.2]] };
          if (model === "@cf/baai/bge-reranker-base") return { response: [] };
          return { response: "Force equals mass times acceleration, in plain prose with no JSON at all." };
        },
      },
    });

    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), env, noopCtx());
    const body = (await response.json()) as { simpleExplanation: string; steps: string[] | null; formula: string | null };

    expect(response.status).toBe(200);
    expect(body.simpleExplanation).toContain("Force equals mass");
    expect(body.steps).toBeNull();
    expect(body.formula).toBeNull();
  });

  it("falls back gracefully when the LLM returns valid JSON with the wrong shape", async () => {
    const env = makeEnv({
      AI: {
        run: async (model: string) => {
          if (model === "@cf/baai/bge-base-en-v1.5") return { data: [[0.1, 0.2]] };
          if (model === "@cf/baai/bge-reranker-base") return { response: [] };
          return { response: '```json\n{"steps": "not an array"}\n```' };
        },
      },
    });

    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), env, noopCtx());
    const body = (await response.json()) as { steps: string[] | null; concept: string };

    expect(response.status).toBe(200);
    expect(body.steps).toBeNull();
    expect(body.concept).toBe("Newton's second law");
  });

  it("fails closed on guardrail error (blocks rather than allows through)", async () => {
    const env = makeEnv(
      {
        AI: { run: async () => { throw new Error("embedding model unavailable"); } },
      },
      [{ key: "guardrailEnabled", value: "true" }]
    );

    const response = await handleExplain(makeRequest({ concept: "Newton's second law" }), env, noopCtx());
    const body = (await response.json()) as { simpleExplanation: string };

    expect(response.status).toBe(503);
    expect(body.simpleExplanation).toBeTruthy();
  });

  it("URL-encodes special characters in the concept when building videoSearchUrl", async () => {
    const env = makeEnv();
    const response = await handleExplain(makeRequest({ concept: "Acid & Base reactions" }), env, noopCtx());
    const body = (await response.json()) as { videoSearchUrl: string };

    expect(response.status).toBe(200);
    expect(body.videoSearchUrl).not.toContain("&Base");
    expect(body.videoSearchUrl).toContain(encodeURIComponent("Acid & Base reactions"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/explain.test.ts -t "handleExplain error handling"`
Expected: FAIL for any case not already covered by Task 3's implementation — in particular, confirm which (if any) already pass incidentally; the malformed-JSON and feature-flag cases are new coverage, not new behavior, so most should already pass against Task 3's code. Any genuine failure here means Task 3's implementation has a gap — fix `explain.ts`, not the test.

- [ ] **Step 3: Fix any gaps found**

If a test fails, the most likely gap is in `parseExplainLlmResponse`'s shape-checking (Step 3 of Task 3 already guards `steps` with `Array.isArray(...) && .every(s => typeof s === "string")`, `table` with a headers/rows shape check, etc.) — re-read that function against the failing case and tighten the guard that let bad data through, rather than adding new guard clauses elsewhere.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/explain.test.ts`
Expected: PASS, full file.

- [ ] **Step 5: Commit**

```bash
git add worker/test/explain.test.ts worker/src/explain.ts
git commit -m "Add explain endpoint error-handling and malformed-LLM-output test coverage"
```

---

## Task 5: Wire `/explain` into the router

**Files:**
- Modify: `worker/src/index.ts`

**Interfaces:**
- Consumes: `handleExplain(request, env, ctx)` from `./explain` (Task 3).

- [ ] **Step 1: Add the route**

In `worker/src/index.ts`, add the import alongside the existing ones:

```typescript
import { handleExplain } from "./explain";
```

Add the route after the `/chat` block (around line 48-49):

```typescript
    if (request.method === "POST" && url.pathname === "/explain") {
      return withCors(await handleExplain(request, env, ctx));
    }
```

- [ ] **Step 2: Verify the build**

Run (from `worker/`): `npx tsc --noEmit`
Expected: no new errors.

Run: `npx vitest run`
Expected: full suite passes (confirms routing didn't break anything, though routing itself isn't directly unit-tested here — `index.ts` has no dedicated test file per the existing codebase pattern).

- [ ] **Step 3: Manual smoke check**

Run (from `worker/`): `npx wrangler dev --persist-to=.wrangler/state`, then in a second terminal:

```bash
curl -X POST http://localhost:8787/explain -H "Content-Type: application/json" -d '{"concept":"photosynthesis"}'
```

Expected: a 200 response with the structured JSON shape (this hits real Workers AI/Vectorize/OpenRouter per `CLAUDE.md`'s note that local dev can't emulate these — a real OpenRouter key must be set via `.dev.vars` or secrets for this to fully succeed; a 502 due to missing `OPENROUTER_API_KEY` is an acceptable smoke-test outcome confirming the route is wired, not a failure of this task).

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "Route POST /explain to handleExplain"
```

---

## Task 6: Admin Settings — Concept Explainer config card + tooltips on all settings fields

**Files:**
- Modify: `frontend/dashboard.js`

**Interfaces:**
- Consumes: `config.explainRetrievalMode`, `config.conceptExplainerEnabled` from `GET /admin/config` (Task 1 made these available).
- Consumes existing `fetchAdmin`, `adminHeaders`, `escapeHtml`, `renderLoading`, `renderError` helpers already used by `loadSettingsTab` (read their current signatures in `dashboard.js` before use — do not redeclare them).

- [ ] **Step 1: Add the Concept Explainer settings card**

In `frontend/dashboard.js`, inside `loadSettingsTab`'s template, add a new card after the "Ingestion enrichment" card (before the closing backtick of the `el.innerHTML` template literal):

```javascript
      <div class="card">
        <h2>Concept Explainer</h2>
        <p class="txn-meta">Controls the student-facing Concept Explainer mode on the chat page.</p>
        <form id="explainer-form" class="settings-form">
          <label class="checkbox-row" title="When off, the Concept Explainer endpoint returns 404 and the student-facing toggle is hidden.">
            <input type="checkbox" name="conceptExplainerEnabled" ${config.conceptExplainerEnabled ? "checked" : ""} /> Concept Explainer enabled
          </label>
          <fieldset>
            <legend>Retrieval mode</legend>
            <label class="checkbox-row" title="Explain strictly from retrieved course material; fall back to general knowledge only when nothing relevant was retrieved.">
              <input type="radio" name="explainRetrievalMode" value="rag_fallback" ${config.explainRetrievalMode === "rag_fallback" ? "checked" : ""} /> RAG only, fallback to general knowledge
            </label>
            <label class="checkbox-row" title="Always combine retrieved course material (as the primary source of truth) with general knowledge to complete the explanation. Recommended - retrieved chunks are often too fragmentary alone to fully explain a concept.">
              <input type="radio" name="explainRetrievalMode" value="rag_plus_llm" ${config.explainRetrievalMode === "rag_plus_llm" ? "checked" : ""} /> RAG + general knowledge, consolidated
            </label>
          </fieldset>
          <button type="submit">Save</button>
        </form>
        <p id="explainer-status" class="txn-meta"></p>
      </div>`;
```

Note: this card's closing ``` `; ``` replaces whatever currently terminates the template literal after the ingestion-enrichment card — read the current end of that template literal first and adjust the preceding card's closing to a plain `</div>` (no trailing backtick) before appending this one.

- [ ] **Step 2: Add tooltips to all pre-existing settings labels**

In the same `loadSettingsTab` template, add a `title="..."` attribute to every existing `<label>` that doesn't already have one. Match each to its field's purpose exactly as documented in `worker/src/config.ts`'s comments:

```javascript
          <label title="How many chunks are retrieved from Vectorize per question before reranking and filtering.">Top K chunks retrieved
            <input type="number" name="topK" min="1" step="1" value="${config.topK}" />
          </label>
          <label title="Minimum reranker/cosine score a question's top chunk must reach to be used. 0 disables this gate - the reranker's score scale isn't guaranteed non-negative.">Confidence threshold (0-1)
            <input type="number" name="confidenceThreshold" min="0" max="1" step="0.01" value="${config.confidenceThreshold}" />
          </label>
          <fieldset>
            <legend>Web search mode</legend>
            <label class="checkbox-row" title="Never fall back to a web search when no document chunks are found.">...RAG only</label>
            <label class="checkbox-row" title="Fall back to a DuckDuckGo web search when no document chunks are found.">...RAG + web fallback</label>
          </fieldset>
          <label class="checkbox-row" title="Refuse to answer (instead of using web results or general knowledge) when no document chunks are found.">...Hard fail when no document found</label>
          <label class="checkbox-row" title="Use the JEV relevance/injection check to filter retrieved chunks before answering.">...JEV relevance filtering enabled</label>
          <label title="Minimum JEV relevance score (0-3) a chunk must reach to be kept. Lower = less strict.">JEV relevance threshold (0-3, lower = less strict)
            <input type="number" name="jevRelevanceThreshold" min="0" max="3" step="0.1" value="${config.jevRelevanceThreshold}" />
          </label>
          <label class="checkbox-row" title="Block out-of-scope or age-inappropriate questions before retrieval runs.">...Guardrail enabled</label>
```

(Preserve the existing `${...}` checked/value interpolations exactly as they are today — only add the `title` attribute to each `<label>` opening tag.)

- [ ] **Step 3: Add the explainer-form submit handler**

After the existing `ingestion-form` submit handler (and before the function's closing `} catch (err) { renderError(...) }`), add:

```javascript
    document.getElementById("explainer-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("explainer-status");
      const update = {
        conceptExplainerEnabled: form.conceptExplainerEnabled.checked,
        explainRetrievalMode: form.explainRetrievalMode.value,
      };
      status.textContent = "Saving...";
      try {
        const response = await fetch(`${WORKER_URL}/admin/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...adminHeaders() },
          body: JSON.stringify(update),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
        status.textContent = "Saved - takes effect on the next question.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });
```

- [ ] **Step 4: Manual verification**

Run `npx serve .` from `frontend/` (pointing `WORKER_URL` at a reachable worker, local `wrangler dev` or deployed), open the dashboard, go to Settings, confirm: the new card renders, hovering any settings label shows its tooltip, toggling the checkbox and radio and clicking Save shows "Saved - takes effect on the next question." and a page reload shows the saved value persisted.

- [ ] **Step 5: Commit**

```bash
git add frontend/dashboard.js
git commit -m "Add Concept Explainer settings card and tooltips to admin Settings tab"
```

---

## Task 7: Frontend — Concept Explainer mode toggle and structured rendering

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`
- Modify: `frontend/style.css`

**Interfaces:**
- Consumes: `POST /explain` returning `ExplainResponseBody` (Task 3's shape) — `{ concept, simpleExplanation, steps, formula, definition, table, realWorldExample, pageImageKey, videoSearchUrl, docSources, groundedIn }`, or `{ error: string }` with a non-404/200 status, or a 404 body `{ error: "Concept Explainer is not available right now" }`.

- [ ] **Step 1: Add the mode toggle markup to `index.html`**

In `frontend/index.html`, inside `<section class="card" id="chat-section">`, before the `<h2>Ask a question</h2>`, add:

```html
      <div class="mode-toggle" role="tablist">
        <button type="button" class="mode-btn active" data-mode="chat" role="tab" aria-selected="true">Chat</button>
        <button type="button" class="mode-btn" data-mode="explain" role="tab" aria-selected="false">Concept Explainer</button>
      </div>
```

Change the `<h2>` to have an id so it can be swapped: `<h2 id="chat-section-title">Ask a question</h2>`.

Change the `<input>` placeholder reference: add `id="question-input"` stays the same (already has it) but its `placeholder` will be swapped by JS per mode, so remove the hardcoded placeholder text reliance in markup is unnecessary — leave the HTML attribute as the chat-mode default; JS overrides it on mode switch.

- [ ] **Step 2: Add mode-switching, `/explain` fetch, and structured rendering to `app.js`**

At the top of `frontend/app.js`, after the existing `const chatLog = ...` line, add:

```javascript
const modeButtons = document.querySelectorAll(".mode-btn");
const sectionTitle = document.getElementById("chat-section-title");
let currentMode = "chat";

const MODE_COPY = {
  chat: { title: "Ask a question", placeholder: "Ask a science or maths question..." },
  explain: { title: "Explain a concept", placeholder: "Enter a concept, e.g. Newton's second law" },
};

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentMode = btn.dataset.mode;
    modeButtons.forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-selected", String(b === btn));
    });
    sectionTitle.textContent = MODE_COPY[currentMode].title;
    questionInput.placeholder = MODE_COPY[currentMode].placeholder;
    answerStyleSelect.style.display = currentMode === "chat" ? "" : "none";
  });
});
```

Replace the `chatForm.addEventListener("submit", ...)` handler's body so it branches by `currentMode`. Keep the existing chat-mode logic exactly as-is inside an `if (currentMode === "chat") { ... }` branch, and add an `else` branch for explain mode:

```javascript
chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", question);
  questionInput.value = "";
  const submitBtn = chatForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  const thinkingEl = appendMessage("assistant", `${THINKING_PHRASES[0]}...`, { thinking: true });
  let phraseIndex = 0;
  const timer = setInterval(() => {
    phraseIndex = (phraseIndex + 1) % THINKING_PHRASES.length;
    thinkingEl.textContent = `${THINKING_PHRASES[phraseIndex]}...`;
  }, 1200);

  try {
    if (currentMode === "chat") {
      const response = await fetch(`${WORKER_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, answerStyle: answerStyleSelect.value }),
      });
      const result = await response.json();

      thinkingEl.classList.remove("thinking");
      thinkingEl.textContent = result.answer ?? `Error: ${result.error}`;

      const imageKeys = (result.docSources ?? [])
        .map((s) => s.pageImageKey)
        .filter((key, index, all) => key && all.indexOf(key) === index);

      for (const key of imageKeys) {
        const img = document.createElement("img");
        img.src = `${WORKER_URL}/images/${encodeURIComponent(key)}`;
        img.className = "answer-source-image";
        img.alt = "Source page image";
        thinkingEl.appendChild(document.createElement("br"));
        thinkingEl.appendChild(img);
      }
    } else {
      const response = await fetch(`${WORKER_URL}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept: question }),
      });
      const result = await response.json();

      thinkingEl.classList.remove("thinking");

      if (!response.ok) {
        thinkingEl.textContent =
          response.status === 404
            ? "Concept Explainer isn't available right now."
            : `Error: ${result.error ?? "something went wrong"}`;
      } else {
        renderExplanation(thinkingEl, result);
      }
    }
  } catch (err) {
    thinkingEl.classList.remove("thinking");
    thinkingEl.textContent = `Error: could not reach the server (${err.message})`;
  } finally {
    clearInterval(timer);
    submitBtn.disabled = false;
  }
});

function renderExplanation(container, result) {
  container.textContent = "";

  const addSection = (heading, contentEl) => {
    const section = document.createElement("div");
    section.className = "explain-section";
    if (heading) {
      const h = document.createElement("strong");
      h.textContent = heading;
      section.appendChild(h);
    }
    section.appendChild(contentEl);
    container.appendChild(section);
  };

  const simple = document.createElement("p");
  simple.textContent = result.simpleExplanation;
  addSection(null, simple);

  if (Array.isArray(result.steps) && result.steps.length > 0) {
    const ol = document.createElement("ol");
    result.steps.forEach((step) => {
      const li = document.createElement("li");
      li.textContent = step;
      ol.appendChild(li);
    });
    addSection("Steps", ol);
  }

  if (result.formula || result.definition) {
    const box = document.createElement("div");
    box.className = "formula-box";
    if (result.formula) {
      const f = document.createElement("p");
      f.className = "formula-text";
      f.textContent = result.formula;
      box.appendChild(f);
    }
    if (result.definition) {
      const d = document.createElement("p");
      d.textContent = result.definition;
      box.appendChild(d);
    }
    addSection("Formula & Definition", box);
  }

  if (result.table && Array.isArray(result.table.headers) && Array.isArray(result.table.rows)) {
    const table = document.createElement("table");
    table.className = "explain-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    result.table.headers.forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    result.table.rows.forEach((row) => {
      const tr = document.createElement("tr");
      row.forEach((cell) => {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    addSection("Table", table);
  }

  if (result.realWorldExample) {
    const ex = document.createElement("p");
    ex.textContent = result.realWorldExample;
    addSection("Real-world example", ex);
  }

  if (result.pageImageKey) {
    const img = document.createElement("img");
    img.src = `${WORKER_URL}/images/${encodeURIComponent(result.pageImageKey)}`;
    img.className = "answer-source-image";
    img.alt = "Source page image";
    addSection(null, img);
  }

  if (result.videoSearchUrl) {
    const link = document.createElement("a");
    link.href = result.videoSearchUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Watch a video about this concept";
    addSection(null, link);
  }
}
```

- [ ] **Step 3: Add minimal CSS for the new elements**

In `frontend/style.css`, add (matching the file's existing naming/spacing conventions — read the top of the file first for variable names like spacing/border tokens before hardcoding values):

```css
.mode-toggle {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.mode-btn {
  padding: 0.4rem 0.9rem;
  border-radius: 6px;
  border: 1px solid var(--border-color, #ccc);
  background: transparent;
  cursor: pointer;
}

.mode-btn.active {
  background: var(--accent-color, #2563eb);
  color: #fff;
}

.explain-section {
  margin: 0.75rem 0;
}

.explain-section strong {
  display: block;
  margin-bottom: 0.25rem;
}

.formula-box {
  background: var(--card-bg, #f5f5f5);
  border-left: 3px solid var(--accent-color, #2563eb);
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
}

.formula-text {
  font-family: "IBM Plex Mono", monospace;
  font-weight: 600;
}

.explain-table {
  border-collapse: collapse;
  width: 100%;
}

.explain-table th,
.explain-table td {
  border: 1px solid var(--border-color, #ccc);
  padding: 0.3rem 0.5rem;
  text-align: left;
}
```

If `--border-color`, `--accent-color`, or `--card-bg` don't exist as CSS variables in the file, check what variables the existing `.card`/`.message` rules actually use and substitute those names instead of introducing new ones.

- [ ] **Step 4: Manual verification**

Run `npx serve .` from `frontend/`, open `index.html` in a browser, pointed at a reachable worker:
- Confirm the Chat/Concept Explainer toggle renders and switching modes changes the title, placeholder, and hides the answer-style dropdown in Explainer mode.
- Submit a concept in Explainer mode; confirm the structured sections render (simple explanation always; steps/formula/table/example/image/video link only when present in the response).
- Submit with the worker's `conceptExplainerEnabled` set to `false` (via the dashboard Settings tab from Task 6); confirm the frontend shows "Concept Explainer isn't available right now." instead of erroring.
- Switch back to Chat mode and confirm existing chat behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/app.js frontend/style.css
git commit -m "Add Concept Explainer mode toggle and structured response rendering to chat frontend"
```

---

## Task 8: Deploy and end-to-end verification

**Files:** none (deployment + manual verification only)

- [ ] **Step 1: Deploy the worker**

Run (from `worker/`): `npx wrangler deploy`

- [ ] **Step 2: Deploy the frontend**

Run (from `frontend/`): `npx wrangler deploy`

- [ ] **Step 3: Verify in production**

Open the deployed student chat app, switch to Concept Explainer mode, submit a real concept (e.g. one that matches an already-ingested PDF, and one that doesn't). Confirm:
- A concept matching ingested content returns a `groundedIn: "both"` or `"documents"` explanation (open browser devtools network tab to check the raw response if the UI doesn't surface `groundedIn` directly).
- A concept with no matching content still returns a complete, well-formed explanation (`groundedIn: "general_knowledge"`), not an empty/degraded one.
- The video link opens a real YouTube search for the concept.
- Open the deployed admin dashboard's Settings tab, confirm the Concept Explainer card and tooltips render, toggle `conceptExplainerEnabled` off, confirm the chat app's Explainer mode now shows the unavailable message, then toggle it back on.

- [ ] **Step 4: Tail logs during verification**

Run (from `worker/`): `npx wrangler tail --format pretty` in a separate terminal while performing Step 3, to catch any unexpected server-side errors (e.g. a real OpenRouter response that doesn't match the fenced-JSON format expected, confirming the fallback path works against a real model and not just the test's canned response).
