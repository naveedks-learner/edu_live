# Admin & Chat UX Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runtime-configurable settings tab, an expandable chunk browser for the newest PDFs, a collapsible transaction tree, model-name visibility, and enterprise-style visual polish to the admin dashboard; add a "thinking" indicator and matching visual polish to the chat UI.

**Architecture:** A new D1 `config` table drives runtime behavior (`getRuntimeConfig`/`setRuntimeConfig` in a new `worker/src/config.ts`), read fresh by `chat.ts` on every request (Workers have no persistent process, so there is no "restart" concept - a config change takes effect on the very next request). Two new admin routes (`GET`/`PUT /admin/config`) expose it. `handleAdminDocuments` gains a chunk-preview field for the 3 most-recently-indexed documents, reconstructed via `VECTORIZE.getByIds` using the existing deterministic `chunkVectorId` scheme. The dashboard and chat frontends get matching visual/interaction upgrades with no new backend dependency.

**Tech Stack:** Same as the existing project - Cloudflare Workers (TypeScript), D1, R2, Vectorize, vitest, plain HTML/CSS/JS frontend.

**Spec:** `docs/superpowers/specs/2026-09-28-admin-and-chat-ux-upgrade-design.md`

## Global Constraints

- `getRuntimeConfig` must never throw - on any D1 failure it logs and returns hardcoded defaults, so a config outage degrades to "behaves like before this feature existed," not a broken chat pipeline.
- Config defaults must match today's actual behavior exactly: `topK=5`, `confidenceThreshold=0` (never gates anything until an admin raises it), `webSearchMode="rag_web_fallback"`, `hardFailNoDocument=false`, `jevEnabled=true`, `guardrailEnabled=true`.
- `PUT /admin/config` validates every field server-side before writing anything - a bad value in one field must not partially corrupt other fields.
- No "restart required" UI - Cloudflare Workers have no long-running process; every setting takes effect on the next request. State this in the Settings tab's copy instead of building unneeded machinery.
- Frontend has no test framework in this repo (confirmed for both prior dashboard changes) - frontend tasks are verified by manual checks (syntax check + a description of what to click and expect), not automated tests.

## Review Focus

- `CONFIDENCE_THRESHOLD=0` (the default) must not change today's behavior for any existing query - a query whose top score is exactly `0` must still pass the gate (`>=`, not `>`).
- `WEB_SEARCH_MODE="rag_only"` with zero retrieved chunks must return an answer built from "No context found." (or the hard-fail message), never silently call `webSearch` anyway.
- `HARD_FAIL_NO_DOCUMENT=true` must still run the full trace-recording path (so the dashboard shows these queries too), not skip transaction logging just because generation was skipped.
- A PDF whose R2 object has `chunkCount` but where `VECTORIZE.getByIds` returns fewer vectors than expected (a chunk was never indexed or was deleted) must render the chunks it got, not throw or return `chunks: null` for the whole document.
- `PUT /admin/config` with a completely invalid body (not JSON, or JSON but not an object) must 400 with a clear error, not throw an uncaught exception past the existing `adminErrorResponse` pattern.

---

## File Structure

**Worker (`worker/src/`):**
- `config.ts` — **create**: `RuntimeConfig` type, defaults, `parseConfigRows`, `validateConfigUpdate`, `getRuntimeConfig`, `setRuntimeConfig`.
- `chat.ts` — **modify**: reads `RuntimeConfig` instead of hardcoded `TOP_K`/`env.JEV_ENABLED`/`env.GUARDRAIL_ENABLED`; adds confidence gate, web-search-mode gate, hard-fail branch; adds `jevModel` to the trace.
- `jev.ts` — **modify**: export the JEV model id constant so `chat.ts` can put it in the trace.
- `transactionTrace.ts` — **modify**: `TransactionTrace` gains `jevModel: string | null`.
- `admin.ts` — **modify**: adds `handleAdminGetConfig`, `handleAdminPutConfig`; `handleAdminDocuments` gains chunk previews for the 3 newest documents; `handleAdminTransactions` includes `jevModel`.
- `index.ts` — **modify**: wires the two new config routes; `Env` unchanged (no new bindings needed - `EDU_LIVE_DB` and `VECTORIZE` already exist).
- `cors.ts` — **modify**: allow `PUT`.
- `worker/migrations/0002_create_config.sql` — **create**.
- `worker/migrations/0003_add_transactions_jev_model.sql` — **create**.

**Worker tests (`worker/test/`):**
- `config.test.ts` — **create**.
- `chat.test.ts` — **modify**: confidence gate, web-search-mode gate, hard-fail branch.
- `admin.test.ts` — **modify**: config routes, chunk previews, `jevModel` field.

**Frontend (`frontend/`):**
- `dashboard.html` — **modify**: add "Settings" tab button/panel.
- `dashboard.js` — **modify**: Settings tab load/save; Documents tab chunk browser + stats banner; TransactionTracker collapsible cards; `jevModel` display.
- `dashboard.css` — **modify**: styles for the new form, chunk list, and collapsible summary.
- `index.html` — **modify**: link the new stylesheet variables (kept self-contained, no shared file - matches this repo's existing per-page pattern).
- `app.js` — **modify**: "thinking" indicator with cycling phrases, cleaned up via `finally`.
- `style.css` — **modify**: enterprise visual polish matching `dashboard.css`'s token system.

---

### Task 1: `config.ts` — runtime config core

**Files:**
- Create: `worker/src/config.ts`
- Test: `worker/test/config.test.ts`

**Interfaces:**
- Produces: `RuntimeConfig` (type), `DEFAULT_CONFIG: RuntimeConfig`, `parseConfigRows(rows: {key: string; value: string}[]): RuntimeConfig`, `validateConfigUpdate(input: Record<string, unknown>): {field: string; message: string}[]`, `getRuntimeConfig(env: Env): Promise<RuntimeConfig>`, `setRuntimeConfig(env: Env, updates: Record<string, unknown>): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `worker/test/config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseConfigRows, validateConfigUpdate, getRuntimeConfig, DEFAULT_CONFIG } from "../src/config";
import type { Env } from "../src/index";

describe("parseConfigRows", () => {
  it("returns all defaults when there are no rows", () => {
    expect(parseConfigRows([])).toEqual(DEFAULT_CONFIG);
  });

  it("parses each stored value to its typed form, overriding only what's present", () => {
    const result = parseConfigRows([
      { key: "topK", value: "8" },
      { key: "confidenceThreshold", value: "0.35" },
      { key: "webSearchMode", value: "rag_only" },
      { key: "hardFailNoDocument", value: "true" },
      { key: "jevEnabled", value: "false" },
      { key: "guardrailEnabled", value: "false" },
    ]);

    expect(result).toEqual({
      topK: 8,
      confidenceThreshold: 0.35,
      webSearchMode: "rag_only",
      hardFailNoDocument: true,
      jevEnabled: false,
      guardrailEnabled: false,
    });
  });

  it("ignores unknown keys and keeps defaults for missing ones", () => {
    const result = parseConfigRows([{ key: "somethingElse", value: "x" }, { key: "topK", value: "3" }]);
    expect(result.topK).toBe(3);
    expect(result.confidenceThreshold).toBe(DEFAULT_CONFIG.confidenceThreshold);
  });
});

describe("validateConfigUpdate", () => {
  it("accepts a valid partial update", () => {
    expect(validateConfigUpdate({ topK: 10, confidenceThreshold: 0.5 })).toEqual([]);
  });

  it("rejects a non-positive or non-integer topK", () => {
    expect(validateConfigUpdate({ topK: 0 }).length).toBeGreaterThan(0);
    expect(validateConfigUpdate({ topK: 2.5 }).length).toBeGreaterThan(0);
  });

  it("rejects a confidenceThreshold outside [0,1]", () => {
    expect(validateConfigUpdate({ confidenceThreshold: -0.1 }).length).toBeGreaterThan(0);
    expect(validateConfigUpdate({ confidenceThreshold: 1.1 }).length).toBeGreaterThan(0);
  });

  it("accepts confidenceThreshold at the boundaries 0 and 1", () => {
    expect(validateConfigUpdate({ confidenceThreshold: 0 })).toEqual([]);
    expect(validateConfigUpdate({ confidenceThreshold: 1 })).toEqual([]);
  });

  it("rejects an unrecognized webSearchMode", () => {
    expect(validateConfigUpdate({ webSearchMode: "bogus" }).length).toBeGreaterThan(0);
  });

  it("rejects a non-boolean for a boolean field", () => {
    expect(validateConfigUpdate({ jevEnabled: "true" }).length).toBeGreaterThan(0);
  });
});

describe("getRuntimeConfig", () => {
  it("returns defaults when the config table is empty", async () => {
    const env = { EDU_LIVE_DB: { prepare: () => ({ all: async () => ({ results: [] }) }) } } as unknown as Env;
    expect(await getRuntimeConfig(env)).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults (never throws) when D1 is unavailable", async () => {
    const env = {
      EDU_LIVE_DB: { prepare: () => ({ all: async () => { throw new Error("D1 down"); } }) },
    } as unknown as Env;
    expect(await getRuntimeConfig(env)).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults (never throws) when EDU_LIVE_DB itself is missing", async () => {
    const env = {} as unknown as Env;
    expect(await getRuntimeConfig(env)).toEqual(DEFAULT_CONFIG);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/config.test.ts`
Expected: FAIL — `../src/config` does not exist.

- [ ] **Step 3: Create `worker/src/config.ts`**

```typescript
import type { Env } from "./index";

export type WebSearchMode = "rag_only" | "rag_web_fallback";

export interface RuntimeConfig {
  topK: number;
  confidenceThreshold: number;
  webSearchMode: WebSearchMode;
  hardFailNoDocument: boolean;
  jevEnabled: boolean;
  guardrailEnabled: boolean;
}

// Must match the pre-existing hardcoded behavior exactly, so shipping this
// feature with an empty config table changes nothing until an admin acts.
export const DEFAULT_CONFIG: RuntimeConfig = {
  topK: 5,
  confidenceThreshold: 0,
  webSearchMode: "rag_web_fallback",
  hardFailNoDocument: false,
  jevEnabled: true,
  guardrailEnabled: true,
};

export function parseConfigRows(rows: { key: string; value: string }[]): RuntimeConfig {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    topK: map.has("topK") ? parseInt(map.get("topK")!, 10) : DEFAULT_CONFIG.topK,
    confidenceThreshold: map.has("confidenceThreshold")
      ? Number(map.get("confidenceThreshold"))
      : DEFAULT_CONFIG.confidenceThreshold,
    webSearchMode: (map.get("webSearchMode") as WebSearchMode | undefined) ?? DEFAULT_CONFIG.webSearchMode,
    hardFailNoDocument: map.has("hardFailNoDocument")
      ? map.get("hardFailNoDocument") === "true"
      : DEFAULT_CONFIG.hardFailNoDocument,
    jevEnabled: map.has("jevEnabled") ? map.get("jevEnabled") === "true" : DEFAULT_CONFIG.jevEnabled,
    guardrailEnabled: map.has("guardrailEnabled")
      ? map.get("guardrailEnabled") === "true"
      : DEFAULT_CONFIG.guardrailEnabled,
  };
}

export function validateConfigUpdate(input: Record<string, unknown>): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];

  if ("topK" in input) {
    const v = input.topK;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      errors.push({ field: "topK", message: "topK must be a positive integer" });
    }
  }
  if ("confidenceThreshold" in input) {
    const v = input.confidenceThreshold;
    if (typeof v !== "number" || v < 0 || v > 1) {
      errors.push({ field: "confidenceThreshold", message: "confidenceThreshold must be a number between 0 and 1" });
    }
  }
  if ("webSearchMode" in input) {
    if (input.webSearchMode !== "rag_only" && input.webSearchMode !== "rag_web_fallback") {
      errors.push({ field: "webSearchMode", message: "webSearchMode must be 'rag_only' or 'rag_web_fallback'" });
    }
  }
  for (const field of ["hardFailNoDocument", "jevEnabled", "guardrailEnabled"] as const) {
    if (field in input && typeof input[field] !== "boolean") {
      errors.push({ field, message: `${field} must be a boolean` });
    }
  }

  return errors;
}

export async function getRuntimeConfig(env: Env): Promise<RuntimeConfig> {
  try {
    const result = await env.EDU_LIVE_DB.prepare("SELECT key, value FROM config").all<{
      key: string;
      value: string;
    }>();
    return parseConfigRows(result.results);
  } catch (err) {
    console.error("failed to load runtime config, using defaults", err);
    return { ...DEFAULT_CONFIG };
  }
}

export async function setRuntimeConfig(env: Env, updates: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const statements = Object.entries(updates).map(([key, value]) =>
    env.EDU_LIVE_DB.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, String(value), now)
  );
  await env.EDU_LIVE_DB.batch(statements);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/config.ts worker/test/config.test.ts
git commit -m "Add runtime config core (defaults, parsing, validation, D1 read)"
```

---

### Task 2: D1 migrations — `config` table and `transactions.jev_model` column

Infra-only task, no unit test - verified by direct inspection, same pattern as the first dashboard change's Task 3.

**Files:**
- Create: `worker/migrations/0002_create_config.sql`
- Create: `worker/migrations/0003_add_transactions_jev_model.sql`

- [ ] **Step 1: Write the migrations**

`worker/migrations/0002_create_config.sql`:

```sql
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`worker/migrations/0003_add_transactions_jev_model.sql`:

```sql
ALTER TABLE transactions ADD COLUMN jev_model TEXT;
```

- [ ] **Step 2: Apply locally and remotely**

Run: `cd worker && npx wrangler d1 migrations apply edu-live-db --local`
Run: `npx wrangler d1 migrations apply edu-live-db --remote`

- [ ] **Step 3: Verify**

Run: `npx wrangler d1 execute edu-live-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`
Expected: output includes `config` alongside `transactions`.

Run: `npx wrangler d1 execute edu-live-db --remote --command "PRAGMA table_info(transactions)"`
Expected: output includes a `jev_model` column.

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/0002_create_config.sql worker/migrations/0003_add_transactions_jev_model.sql
git commit -m "Add config table and transactions.jev_model migrations"
```

---

### Task 3: Wire runtime config into `chat.ts`

**Files:**
- Modify: `worker/src/chat.ts`
- Modify: `worker/src/jev.ts` (export the model id)
- Modify: `worker/src/transactionTrace.ts` (`jevModel` field)
- Test: `worker/test/chat.test.ts`
- Test: `worker/test/transactionTrace.test.ts`

**Interfaces:**
- Consumes: `getRuntimeConfig` (Task 1).
- Produces: `TransactionTrace.jevModel: string | null`; `JEV_MODEL_ID` exported from `jev.ts`.

- [ ] **Step 1: Export the JEV model id**

In `worker/src/jev.ts`, change:

```typescript
const JEV_MODEL = "~typesafe/jev-latest";
```

to:

```typescript
export const JEV_MODEL_ID = "~typesafe/jev-latest";
```

and update its one other use in that file (`model: JEV_MODEL,` inside `scoreChunkWithJev`'s fetch body) to `model: JEV_MODEL_ID,`.

- [ ] **Step 2: Write the failing test for `transactionTrace.ts`**

Add to `worker/test/transactionTrace.test.ts`, inside the existing `describe("buildTransactionTrace", ...)` block:

```typescript
  it("includes the JEV model id when JEV is enabled, and null when it isn't", () => {
    const withJev = buildTransactionTrace({
      ...base,
      jevEnabled: true,
      jevModel: "~typesafe/jev-latest",
      jevAnnotated: [],
      keptKeys: new Set(),
    });
    expect(withJev.jevModel).toBe("~typesafe/jev-latest");

    const withoutJev = buildTransactionTrace({
      ...base,
      jevEnabled: false,
      jevModel: null,
      jevAnnotated: [],
      keptKeys: new Set(),
    });
    expect(withoutJev.jevModel).toBeNull();
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd worker && npx vitest run test/transactionTrace.test.ts`
Expected: FAIL — `buildTransactionTrace` doesn't accept/return `jevModel` yet (TypeScript error surfaces as a test failure since `jevModel` param is unknown, or the assertion fails with `undefined`).

- [ ] **Step 4: Update `worker/src/transactionTrace.ts`**

Add `jevModel: string | null;` to the `TransactionTrace` interface, add `jevModel: string | null;` to `buildTransactionTrace`'s params type, and add `jevModel: params.jevModel,` to the returned object (alongside the existing `jevInput`/`jevOutput` lines).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd worker && npx vitest run test/transactionTrace.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing tests for `chat.ts`**

Add to `worker/test/chat.test.ts`:

```typescript
describe("handleChat runtime config", () => {
  function envWithConfig(rows: { key: string; value: string }[], overrides: Partial<Env> = {}): Env {
    return makeEnv({
      EDU_LIVE_DB: {
        prepare: (sql: string) => {
          if (sql.startsWith("SELECT key, value FROM config")) {
            return { all: async () => ({ results: rows }) };
          }
          return { bind: () => ({ run: async () => ({}) }) };
        },
      } as unknown as D1Database,
      ...overrides,
    });
  }

  it("falls back to web search when the top confidence is below confidenceThreshold, even with a kept chunk", async () => {
    const webSearchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("duckduckgo") || url.includes("bing") || url.includes("search")) {
        webSearchCalls.push(url);
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    try {
      const env = envWithConfig([{ key: "confidenceThreshold", value: "0.99" }], {
        JEV_ENABLED: "false",
        VECTORIZE: {
          query: async () => ({
            matches: [{ score: 0.5, metadata: { text: "low confidence passage", page: 1, pageEnd: 1, source: "notes.pdf", chunkId: 0 } }],
          }),
        },
      });

      const response = await handleChat(makeChatRequest("what is reflection of light"), env, noopCtx());
      const body = (await response.json()) as { docSources: unknown[] };

      expect(response.status).toBe(200);
      expect(body.docSources.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("never calls webSearch when webSearchMode is rag_only, even with no retrieved chunks", async () => {
    let webSearchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      webSearchCalled = true;
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const env = envWithConfig([{ key: "webSearchMode", value: "rag_only" }], {
        JEV_ENABLED: "false",
        VECTORIZE: { query: async () => ({ matches: [] }) },
      });

      const response = await handleChat(makeChatRequest("what is reflection of light"), env, noopCtx());

      expect(response.status).toBe(200);
      expect(webSearchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a fixed message without calling the generation model when hardFailNoDocument is true and nothing was found", async () => {
    let generationCalled = false;
    const env = envWithConfig(
      [
        { key: "webSearchMode", value: "rag_only" },
        { key: "hardFailNoDocument", value: "true" },
      ],
      {
        JEV_ENABLED: "false",
        VECTORIZE: { query: async () => ({ matches: [] }) },
        AI: {
          run: async (model: string) => {
            if (model === "@cf/baai/bge-base-en-v1.5") return { data: [[0.1, 0.2]] };
            generationCalled = true;
            return { response: "should not be called" };
          },
        },
      }
    );

    const response = await handleChat(makeChatRequest("what is reflection of light"), env, noopCtx());
    const body = (await response.json()) as { answer: string };

    expect(response.status).toBe(200);
    expect(generationCalled).toBe(false);
    expect(body.answer).toMatch(/don't have enough information/i);
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/chat.test.ts`
Expected: FAIL — none of this gating logic exists yet (confidence gate absent, `rag_only` mode not read, hard-fail branch absent).

- [ ] **Step 8: Modify `worker/src/chat.ts`**

```typescript
import type { Env } from "./index";
import { checkQueryInScopeAndAgeAppropriate } from "./guardrailCheck";
import { rerank, workersAiScoreFn, type RetrievedChunk } from "./rerank";
import { scoreChunksWithJev, filterJevScored, JEV_MODEL_ID, type JevScoredChunk } from "./jev";
import { webSearch, formatWebResultsAsContext } from "./webSearch";
import { buildTransactionTrace, type TransactionTrace } from "./transactionTrace";
import { getRuntimeConfig } from "./config";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
// @cf/meta/llama-3.1-8b-instruct was deprecated by Cloudflare (2026-05-30);
// -fp8 is the closest available replacement (same 8B model, fp8-quantized)
// per `wrangler ai models` against the live catalog.
const GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const HARD_FAIL_MESSAGE =
  "I don't have enough information in the indexed documents (or the web) to answer that question.";

const SYSTEM_PROMPT = `You are a helpful research assistant and teacher for 16-17 year old students.

Audience and scope:
- Only help with science and maths topics. If a question is outside that scope, politely decline.
- Keep language and content age-appropriate.

Policy:
- Answer only from the context provided below (documents and/or web results).
- If the context doesn't answer the question, say so clearly instead of guessing.
- Name the source document (with page number) or web page you used.
- Keep answers concise unless the question needs detail.`;

async function recordTransaction(env: Env, trace: TransactionTrace): Promise<void> {
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
    console.error("failed to record transaction trace", err);
  }
}

export async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();

  if (!question) {
    return Response.json({ error: "Expected JSON body with a 'question' field" }, { status: 400 });
  }

  const config = await getRuntimeConfig(env);

  if (config.guardrailEnabled) {
    const decision = await checkQueryInScopeAndAgeAppropriate(question, env.AI);
    if (!decision.allowed) {
      const status = decision.reason === "guardrail_error" ? 503 : 200;
      return Response.json(
        { answer: decision.refusalMessage, reason: decision.reason, docSources: [], webSources: [] },
        { status }
      );
    }
  }

  try {
    const embedResponse = await env.AI.run(EMBEDDING_MODEL, { text: [question] });
    const questionVector = (embedResponse as { data: number[][] }).data[0];

    const matches = await env.VECTORIZE.query(questionVector, { topK: config.topK, returnMetadata: true });
    const retrieved: RetrievedChunk[] = matches.matches.map((m) => ({
      text: String(m.metadata?.text ?? ""),
      page: Number(m.metadata?.page ?? 0),
      pageEnd: Number(m.metadata?.pageEnd ?? 0),
      source: String(m.metadata?.source ?? ""),
      chunkId: Number(m.metadata?.chunkId ?? 0),
      cosineScore: m.score,
    }));

    const reranked = await rerank(question, retrieved, workersAiScoreFn(env.AI));

    const jevEnabled = config.jevEnabled;
    const jevResult = jevEnabled
      ? await scoreChunksWithJev(question, reranked, env.OPENROUTER_API_KEY)
      : {
          chunks: reranked.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }) as JevScoredChunk),
          costUsd: 0,
          success: true,
        };

    // Only filter by relevance when JEV actually ran and produced real
    // scores. If JEV failed, jevResult.chunks all carry jevRelevance=null -
    // filtering on that would discard every chunk, which is worse than not
    // running JEV at all.
    const jevDocSources = jevEnabled && jevResult.success ? filterJevScored(jevResult.chunks) : jevResult.chunks;
    const keptKeys = new Set(jevDocSources.map((c) => `${c.source}::${c.chunkId}`));

    // Confidence gate: even a JEV-kept chunk can be too weak a match to
    // trust. Uses >= so the default threshold of 0 never changes behavior.
    const topConfidence = jevDocSources[0] ? jevDocSources[0].rerankScore ?? jevDocSources[0].cosineScore : null;
    const passesConfidenceGate = topConfidence === null || topConfidence >= config.confidenceThreshold;
    const docSources = passesConfidenceGate ? jevDocSources : [];

    let webSources: Awaited<ReturnType<typeof webSearch>> = [];
    if (docSources.length === 0 && config.webSearchMode !== "rag_only") {
      webSources = await webSearch(question);
    }

    const documentContext = docSources.map((c) => `[${c.source} p.${c.page}]\n${c.text}`).join("\n\n");
    const webContext = webSources.length > 0 ? formatWebResultsAsContext(webSources) : "";
    const context = [documentContext, webContext].filter(Boolean).join("\n\n---\n\n") || "No context found.";
    const llmInput = `Question: ${question}\n\nContext:\n${context}`;

    const jevModel = jevEnabled ? JEV_MODEL_ID : null;

    let answer: string;
    if (config.hardFailNoDocument && docSources.length === 0 && webSources.length === 0) {
      answer = HARD_FAIL_MESSAGE;
    } else {
      const generateResponse = await env.AI.run(GENERATION_MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: llmInput },
        ],
      });
      answer = (generateResponse as { response: string }).response;
    }

    const trace = buildTransactionTrace({
      question,
      provider: "workers-ai",
      model: GENERATION_MODEL,
      pathTaken: webSources.length > 0 ? "web_fallback" : "pdf_only",
      jevAnnotated: jevResult.chunks,
      keptKeys,
      llmInput,
      llmOutput: answer,
      jevEnabled,
      jevModel,
      jevCostUsd: jevResult.costUsd,
    });
    ctx.waitUntil(recordTransaction(env, trace));

    return Response.json({
      answer,
      docSources: docSources.map((c) => ({ source: c.source, page: c.page, pageEnd: c.pageEnd, text: c.text })),
      webSources,
    });
  } catch (err) {
    console.error("chat pipeline failed", err);
    return Response.json(
      { error: "Something went wrong answering this question - please try again." },
      { status: 502 }
    );
  }
}
```

Note: `TOP_K` constant is removed (replaced by `config.topK`); `env.JEV_ENABLED`/`env.GUARDRAIL_ENABLED` are no longer read here (the `Env` fields stay defined for now - harmless, and other code doesn't reference them).

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/chat.test.ts test/transactionTrace.test.ts test/jev.test.ts`
Expected: PASS. If the pre-existing "records a transaction" test's inserted-args assertion only checks `inserted.length`, it stays green; if any test asserts on the exact bound argument count/order for the INSERT, update it for the new trailing `jev_model` parameter.

- [ ] **Step 10: Run the full suite**

Run: `cd worker && npx vitest run`
Expected: PASS — all files green.

- [ ] **Step 11: Commit**

```bash
git add worker/src/chat.ts worker/src/jev.ts worker/src/transactionTrace.ts worker/test/chat.test.ts worker/test/transactionTrace.test.ts
git commit -m "Wire runtime config into chat.ts: confidence gate, web-search mode, hard-fail, JEV model in trace"
```

---

### Task 4: `GET`/`PUT /admin/config` routes

**Files:**
- Modify: `worker/src/admin.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/cors.ts`
- Test: `worker/test/admin.test.ts`
- Test: `worker/test/cors.test.ts`

**Interfaces:**
- Consumes: `getRuntimeConfig`, `setRuntimeConfig`, `validateConfigUpdate` (Task 1).
- Produces: `handleAdminGetConfig(env: Env): Promise<Response>`, `handleAdminPutConfig(request: Request, env: Env): Promise<Response>`.

- [ ] **Step 1: Write the failing tests**

Add to `worker/test/admin.test.ts`:

```typescript
import { handleAdminGetConfig, handleAdminPutConfig } from "../src/admin";
// (add to the existing import line from "../src/admin" instead of a new import statement)
```

```typescript
describe("handleAdminGetConfig", () => {
  it("returns the current effective config", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: { prepare: () => ({ all: async () => ({ results: [{ key: "topK", value: "8" }] }) }) } as unknown as Env["EDU_LIVE_DB"],
    });

    const response = await handleAdminGetConfig(env);
    const body = (await response.json()) as { config: { topK: number } };

    expect(body.config.topK).toBe(8);
  });
});

describe("handleAdminPutConfig", () => {
  it("rejects an invalid update without writing anything", async () => {
    let wrote = false;
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          all: async () => ({ results: [] }),
          bind: () => ({ run: async () => { wrote = true; } }),
        }),
        batch: async () => { wrote = true; return []; },
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const request = new Request("https://worker.example/admin/config", {
      method: "PUT",
      body: JSON.stringify({ topK: -1 }),
    });
    const response = await handleAdminPutConfig(request, env);

    expect(response.status).toBe(400);
    expect(wrote).toBe(false);
  });

  it("rejects a non-object body", async () => {
    const env = makeEnv();
    const request = new Request("https://worker.example/admin/config", { method: "PUT", body: "not json" });
    const response = await handleAdminPutConfig(request, env);
    expect(response.status).toBe(400);
  });

  it("writes a valid update and returns the resulting config", async () => {
    const written: Record<string, unknown>[] = [];
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({ all: async () => ({ results: [{ key: "topK", value: "7" }] }) }),
        batch: async (statements: unknown[]) => {
          written.push(...(statements as Record<string, unknown>[]));
          return [];
        },
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const request = new Request("https://worker.example/admin/config", {
      method: "PUT",
      body: JSON.stringify({ topK: 7 }),
    });
    const response = await handleAdminPutConfig(request, env);
    const body = (await response.json()) as { config: { topK: number } };

    expect(response.status).toBe(200);
    expect(written.length).toBe(1);
    expect(body.config.topK).toBe(7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/admin.test.ts`
Expected: FAIL — `handleAdminGetConfig`/`handleAdminPutConfig` don't exist.

- [ ] **Step 3: Modify `worker/src/admin.ts`**

Add the import and two new exported functions:

```typescript
import { getRuntimeConfig, setRuntimeConfig, validateConfigUpdate } from "./config";
```

```typescript
export async function handleAdminGetConfig(env: Env): Promise<Response> {
  try {
    const config = await getRuntimeConfig(env);
    return Response.json({ config });
  } catch (err) {
    return adminErrorResponse("/admin/config", err);
  }
}

export async function handleAdminPutConfig(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Expected a JSON object body" }, { status: 400 });
    }

    const errors = validateConfigUpdate(body);
    if (errors.length > 0) {
      return Response.json({ error: "Invalid config update", details: errors }, { status: 400 });
    }

    await setRuntimeConfig(env, body);
    const config = await getRuntimeConfig(env);
    return Response.json({ config });
  } catch (err) {
    return adminErrorResponse("/admin/config", err);
  }
}
```

- [ ] **Step 4: Wire the routes into `worker/src/index.ts`**

Add to the import line and the routing chain:

```typescript
import {
  isAdminAuthorized,
  handleAdminDocuments,
  handleAdminTransactions,
  handleAdminCosting,
  handleAdminGetConfig,
  handleAdminPutConfig,
} from "./admin";
```

```typescript
    if (request.method === "GET" && url.pathname === "/admin/config") {
      if (!isAdminAuthorized(request, env)) return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
      return withCors(await handleAdminGetConfig(env));
    }
    if (request.method === "PUT" && url.pathname === "/admin/config") {
      if (!isAdminAuthorized(request, env)) return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }));
      return withCors(await handleAdminPutConfig(request, env));
    }
```

(Add these alongside the existing three `/admin/*` blocks, before the final `return withCors(new Response("Not found"...`.)

- [ ] **Step 5: Add the failing CORS test, then fix**

Add to `worker/test/cors.test.ts`:

```typescript
  it("allows PUT alongside GET and POST", () => {
    const response = withCors(Response.json({ ok: true }));
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
  });
```

Run: `cd worker && npx vitest run test/cors.test.ts` — expect FAIL (no `PUT` in the header yet).

In `worker/src/cors.ts`, change:

```typescript
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
```

to:

```typescript
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
```

- [ ] **Step 6: Run the full suite**

Run: `cd worker && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/src/admin.ts worker/src/index.ts worker/src/cors.ts worker/test/admin.test.ts worker/test/cors.test.ts
git commit -m "Add GET/PUT /admin/config routes"
```

---

### Task 5: Chunk preview for the 3 most-recently-indexed documents

**Files:**
- Modify: `worker/src/admin.ts`
- Test: `worker/test/admin.test.ts`

**Interfaces:**
- Consumes: `chunkVectorId` (existing, `worker/src/vectorId.ts`), `env.VECTORIZE.getByIds`.
- Produces: each document in `/admin/documents`'s response gains `chunks: {chunkId: number; page: number; text: string}[] | null`.

- [ ] **Step 1: Write the failing tests**

Add to `worker/test/admin.test.ts`, inside `describe("handleAdminDocuments", ...)`:

```typescript
  it("includes chunk previews only for the 3 most-recently-indexed documents", async () => {
    const docs = [
      { key: "oldest.pdf", size: 100, customMetadata: { chunkCount: "2", pageCount: "1", indexedAt: "2026-09-24T00:00:00.000Z" } },
      { key: "second.pdf", size: 100, customMetadata: { chunkCount: "1", pageCount: "1", indexedAt: "2026-09-25T00:00:00.000Z" } },
      { key: "third.pdf", size: 100, customMetadata: { chunkCount: "1", pageCount: "1", indexedAt: "2026-09-26T00:00:00.000Z" } },
      { key: "newest.pdf", size: 100, customMetadata: { chunkCount: "1", pageCount: "1", indexedAt: "2026-09-27T00:00:00.000Z" } },
    ];
    const requestedIds: string[] = [];
    const env = makeEnv({
      PDF_BUCKET: { list: async () => ({ objects: docs }) } as unknown as Env["PDF_BUCKET"],
      VECTORIZE: {
        getByIds: async (ids: string[]) => {
          requestedIds.push(...ids);
          return ids.map((id) => ({ id, metadata: { page: 1, text: `text for ${id}` } }));
        },
      } as unknown as Env["VECTORIZE"],
    });

    const response = await handleAdminDocuments(env);
    const body = (await response.json()) as { documents: { name: string; chunks: unknown[] | null }[] };

    const byName = Object.fromEntries(body.documents.map((d) => [d.name, d.chunks]));
    expect(byName["oldest.pdf"]).toBeNull();
    expect(byName["second.pdf"]).not.toBeNull();
    expect(byName["third.pdf"]).not.toBeNull();
    expect(byName["newest.pdf"]).not.toBeNull();
  });

  it("renders whatever chunks getByIds actually returns, even if fewer than chunkCount", async () => {
    const env = makeEnv({
      PDF_BUCKET: {
        list: async () => ({
          objects: [{ key: "recent.pdf", size: 100, customMetadata: { chunkCount: "3", pageCount: "1", indexedAt: "2026-09-28T00:00:00.000Z" } }],
        }),
      } as unknown as Env["PDF_BUCKET"],
      VECTORIZE: {
        getByIds: async (ids: string[]) => [{ id: ids[0], metadata: { page: 1, text: "only chunk 0 exists" } }],
      } as unknown as Env["VECTORIZE"],
    });

    const response = await handleAdminDocuments(env);
    const body = (await response.json()) as { documents: { chunks: { chunkId: number; text: string }[] }[] };

    expect(body.documents[0].chunks?.length).toBe(1);
    expect(body.documents[0].chunks?.[0].chunkId).toBe(0);
  });

  it("falls back to chunks: null for a document if getByIds throws", async () => {
    const env = makeEnv({
      PDF_BUCKET: {
        list: async () => ({
          objects: [{ key: "recent.pdf", size: 100, customMetadata: { chunkCount: "1", pageCount: "1", indexedAt: "2026-09-28T00:00:00.000Z" } }],
        }),
      } as unknown as Env["PDF_BUCKET"],
      VECTORIZE: {
        getByIds: async () => { throw new Error("Vectorize unavailable"); },
      } as unknown as Env["VECTORIZE"],
    });

    const response = await handleAdminDocuments(env);
    const body = (await response.json()) as { documents: { chunks: unknown }[] };

    expect(response.status).toBe(200);
    expect(body.documents[0].chunks).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/admin.test.ts`
Expected: FAIL — no `chunks` field exists yet on the response.

- [ ] **Step 3: Modify `handleAdminDocuments` in `worker/src/admin.ts`**

Add the import:

```typescript
import { chunkVectorId } from "./vectorId";
```

Replace the function body:

```typescript
export async function handleAdminDocuments(env: Env): Promise<Response> {
  try {
    const listed = await env.PDF_BUCKET.list({ include: ["customMetadata"] });

    const documents = listed.objects.map((obj) => ({
      name: obj.key,
      sizeBytes: obj.size,
      indexedAt: obj.customMetadata?.indexedAt ?? null,
      chunkCount: obj.customMetadata?.chunkCount ? Number(obj.customMetadata.chunkCount) : null,
      pageCount: obj.customMetadata?.pageCount ? Number(obj.customMetadata.pageCount) : null,
    }));

    const eligible = documents.filter((d) => d.indexedAt && d.chunkCount);
    const newest = [...eligible].sort((a, b) => (b.indexedAt! > a.indexedAt! ? 1 : -1)).slice(0, 3);
    const newestNames = new Set(newest.map((d) => d.name));

    const documentsWithChunks = await Promise.all(
      documents.map(async (doc) => {
        if (!newestNames.has(doc.name) || !doc.chunkCount) {
          return { ...doc, chunks: null as { chunkId: number; page: number; text: string }[] | null };
        }
        const ids = Array.from({ length: doc.chunkCount }, (_, i) => chunkVectorId(doc.name, i));
        const idToChunkId = new Map(ids.map((id, i) => [id, i]));
        try {
          const vectors = await env.VECTORIZE.getByIds(ids);
          const chunks = vectors
            .map((v) => ({
              chunkId: idToChunkId.get(v.id) ?? 0,
              page: Number(v.metadata?.page ?? 0),
              text: String(v.metadata?.text ?? ""),
            }))
            .sort((a, b) => a.chunkId - b.chunkId);
          return { ...doc, chunks };
        } catch (err) {
          console.error(`failed to fetch chunk preview for ${doc.name}`, err);
          return { ...doc, chunks: null as { chunkId: number; page: number; text: string }[] | null };
        }
      })
    );

    return Response.json({ documents: documentsWithChunks, chunkPreviewCount: newest.length });
  } catch (err) {
    return adminErrorResponse("/admin/documents", err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd worker && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/admin.ts worker/test/admin.test.ts
git commit -m "Show chunk previews for the 3 most-recently-indexed documents"
```

---

### Task 6: Expose `jevModel` on `/admin/transactions`

**Files:**
- Modify: `worker/src/admin.ts`
- Test: `worker/test/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `worker/test/admin.test.ts`'s `handleAdminTransactions` block, extending the existing "parses JSON columns..." test's row fixture with `jev_model: "~typesafe/jev-latest"` and adding:

```typescript
  it("includes jevModel from the stored row", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [
                {
                  id: 1, timestamp: "t", question: "q", provider: "p", model: "m", path_taken: "pdf_only",
                  confidence: 0.5, retrieval_json: "[]", llm_input: "in", llm_output: "out",
                  jev_input_json: null, jev_output_json: null, input_tokens: 1, output_tokens: 1,
                  jev_cost_usd: 0, llm_cost_usd: 0, jev_model: "~typesafe/jev-latest",
                },
              ],
            }),
          }),
        }),
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const response = await handleAdminTransactions(req(), env);
    const body = (await response.json()) as { transactions: { jevModel: string | null }[] };

    expect(body.transactions[0].jevModel).toBe("~typesafe/jev-latest");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/admin.test.ts`
Expected: FAIL — `jevModel` is `undefined` on the mapped row.

- [ ] **Step 3: Add the field in `handleAdminTransactions`**

In `worker/src/admin.ts`, add `jevModel: row.jev_model,` to the mapped transaction object (alongside `jevOutput`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/admin.ts worker/test/admin.test.ts
git commit -m "Expose jevModel on /admin/transactions"
```

---

### Task 7: Dashboard Settings tab

**Files:**
- Modify: `frontend/dashboard.html`
- Modify: `frontend/dashboard.js`
- Modify: `frontend/dashboard.css`

No test framework for the frontend - verified manually in Step 4.

- [ ] **Step 1: Add the tab button and panel in `frontend/dashboard.html`**

In the `<nav class="tabs">` block, after the Costing button:

```html
    <button class="tab-btn" data-tab="settings" role="tab" aria-selected="false">Settings</button>
```

In `<main class="dash-main">`, after the costing section:

```html
    <section id="tab-settings" class="tab-panel"></section>
```

- [ ] **Step 2: Add the Settings tab logic to `frontend/dashboard.js`**

Add a new section (near the other tab functions) and register it in `tabLoaders`:

```javascript
// --- Tab: Settings ---

async function loadSettingsTab() {
  const el = document.getElementById("tab-settings");
  renderLoading(el);
  try {
    const { config } = await fetchAdmin("/admin/config");
    el.innerHTML = `
      <div class="card">
        <h2>Runtime settings</h2>
        <p class="txn-meta">Changes apply to the next question asked - Cloudflare Workers have no long-running process to restart.</p>
        <form id="settings-form" class="settings-form">
          <label>Top K chunks retrieved
            <input type="number" name="topK" min="1" step="1" value="${config.topK}" />
          </label>
          <label>Confidence threshold (0-1)
            <input type="number" name="confidenceThreshold" min="0" max="1" step="0.01" value="${config.confidenceThreshold}" />
          </label>
          <fieldset>
            <legend>Web search mode</legend>
            <label><input type="radio" name="webSearchMode" value="rag_only" ${config.webSearchMode === "rag_only" ? "checked" : ""} /> RAG only</label>
            <label><input type="radio" name="webSearchMode" value="rag_web_fallback" ${config.webSearchMode === "rag_web_fallback" ? "checked" : ""} /> RAG + web fallback</label>
          </fieldset>
          <label class="checkbox-row"><input type="checkbox" name="hardFailNoDocument" ${config.hardFailNoDocument ? "checked" : ""} /> Hard fail when no document found</label>
          <label class="checkbox-row"><input type="checkbox" name="jevEnabled" ${config.jevEnabled ? "checked" : ""} /> JEV relevance filtering enabled</label>
          <label class="checkbox-row"><input type="checkbox" name="guardrailEnabled" ${config.guardrailEnabled ? "checked" : ""} /> Guardrail enabled</label>
          <button type="submit">Save</button>
        </form>
        <p id="settings-status" class="txn-meta"></p>
      </div>`;

    document.getElementById("settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("settings-status");
      const update = {
        topK: Number(form.topK.value),
        confidenceThreshold: Number(form.confidenceThreshold.value),
        webSearchMode: form.webSearchMode.value,
        hardFailNoDocument: form.hardFailNoDocument.checked,
        jevEnabled: form.jevEnabled.checked,
        guardrailEnabled: form.guardrailEnabled.checked,
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
  } catch (err) {
    renderError(el, err.message);
  }
}
```

Update the `tabLoaders` object:

```javascript
const tabLoaders = {
  documents: loadDocumentsTab,
  transactions: loadTransactionsTab,
  costing: () => loadCostingTab(),
  settings: loadSettingsTab,
};
```

- [ ] **Step 3: Add form styling to `frontend/dashboard.css`**

```css
.settings-form { display: flex; flex-direction: column; gap: 1rem; max-width: 420px; }
.settings-form label { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.9rem; color: var(--text-muted); }
.settings-form input[type="number"] { padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.95rem; color: var(--text); }
.settings-form fieldset { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; }
.settings-form fieldset legend { padding: 0 0.4rem; font-size: 0.8rem; color: var(--text-muted); }
.settings-form .checkbox-row { flex-direction: row; align-items: center; gap: 0.5rem; }
.settings-form button {
  align-self: flex-start;
  background: linear-gradient(120deg, var(--brand-start), var(--brand-end));
  color: white;
  border: none;
  padding: 0.55rem 1.25rem;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
}
```

- [ ] **Step 4: Manual verification**

Run: `cd frontend && npx serve .`, open `dashboard.html`, click the Settings tab.
Expected: form renders with current values (defaults if `/admin/config` hasn't been hit yet - the worker call will fail without a live backend at this point in local testing, so confirm the tab's error state renders cleanly instead of a blank page; full round-trip is verified in Task 9's deploy step).

- [ ] **Step 5: Commit**

```bash
git add frontend/dashboard.html frontend/dashboard.js frontend/dashboard.css
git commit -m "Add Settings tab to the observability dashboard"
```

---

### Task 8: Documents tab — chunk browser + summary stats

**Files:**
- Modify: `frontend/dashboard.js`
- Modify: `frontend/dashboard.css`

- [ ] **Step 1: Update `loadDocumentsTab` in `frontend/dashboard.js`**

Replace the function:

```javascript
async function loadDocumentsTab() {
  const el = document.getElementById("tab-documents");
  renderLoading(el);
  try {
    const { documents, chunkPreviewCount } = await fetchAdmin("/admin/documents");
    if (documents.length === 0) {
      el.innerHTML = `<div class="card empty-state">No documents indexed yet.</div>`;
      return;
    }

    const totalChunks = documents.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);

    const rows = documents
      .map((doc) => {
        const chunkSection = doc.chunks
          ? `<details class="io-block chunk-preview">
               <summary>View ${doc.chunks.length} chunk(s)</summary>
               ${doc.chunks
                 .map(
                   (c) => `<div class="chunk-item"><div class="chunk-meta">Chunk ${c.chunkId} · page ${c.page}</div><pre>${escapeHtml(c.text)}</pre></div>`
                 )
                 .join("")}
             </details>`
          : `<span class="txn-meta">Chunks not shown for this document</span>`;

        return `
        <tr>
          <td>${escapeHtml(doc.name)}</td>
          <td>${(doc.sizeBytes / 1024).toFixed(1)} KB</td>
          <td>${doc.indexedAt ? new Date(doc.indexedAt).toLocaleString() : "—"}</td>
          <td>${doc.pageCount ?? "—"}</td>
          <td>${doc.chunkCount ?? "—"}</td>
        </tr>
        <tr class="chunk-row"><td colspan="5">${chunkSection}</td></tr>`;
      })
      .join("");

    el.innerHTML = `
      <div class="card">
        <div class="metric-row">
          <div class="metric"><div class="label">Documents</div><div class="value">${documents.length}</div></div>
          <div class="metric"><div class="label">Total chunks</div><div class="value">${totalChunks}</div></div>
        </div>
      </div>
      <div class="card">
        <h2>Indexed documents</h2>
        <p class="txn-meta">Chunk text shown for the ${chunkPreviewCount ?? 0} most recently indexed document(s) only.</p>
        <table>
          <thead><tr><th>File</th><th>Size</th><th>Indexed</th><th>Pages</th><th>Chunks</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    renderError(el, err.message);
  }
}
```

- [ ] **Step 2: Add chunk-preview styling to `frontend/dashboard.css`**

```css
.chunk-row td { padding-top: 0; padding-bottom: 0.75rem; border-bottom: none; }
.chunk-preview { margin-top: 0.4rem; }
.chunk-item { margin: 0.5rem 0; }
.chunk-item .chunk-meta { font-size: 0.78rem; color: var(--text-muted); margin-bottom: 0.25rem; }
.chunk-item pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: #fafafc;
  padding: 0.6rem;
  border-radius: 6px;
  font-size: 0.8rem;
  max-height: 200px;
  overflow: auto;
  margin: 0;
}
```

- [ ] **Step 3: Manual verification**

Run: `cd frontend && npx serve .`, confirm `node --check dashboard.js` passes, open the page and confirm the Documents tab layout doesn't break with the two-row-per-document table structure (visually inspect against the empty-state case, since no live backend is available for this step in isolation).

Run: `node --check frontend/dashboard.js`
Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add frontend/dashboard.js frontend/dashboard.css
git commit -m "Add chunk browser and summary stats to the Documents tab"
```

---

### Task 9: TransactionTracker collapsible tree + JEV model display

**Files:**
- Modify: `frontend/dashboard.js`
- Modify: `frontend/dashboard.css`

- [ ] **Step 1: Update `renderTransactionCard` in `frontend/dashboard.js`**

Replace the function to wrap the whole card in a closed-by-default `<details>`:

```javascript
function renderTransactionCard(txn) {
  return `
    <details class="card txn-card">
      <summary class="txn-summary">
        <span class="txn-summary-question">${escapeHtml(txn.question)}</span>
        <span class="txn-summary-meta">Query #${txn.id} · ${new Date(txn.timestamp).toLocaleString()} · ${escapeHtml(txn.pathTaken)} · confidence ${txn.confidence != null ? txn.confidence.toFixed(2) : "—"}</span>
      </summary>
      <div class="txn-meta">
        <strong>${escapeHtml(txn.provider)} / ${escapeHtml(txn.model)}</strong>${txn.jevModel ? ` · JEV: <strong>${escapeHtml(txn.jevModel)}</strong>` : ""}
      </div>
      <h4>Retrieval results</h4>
      ${renderRetrievalTable(txn.retrieval)}
      <details class="io-block"><summary>LLM input</summary><pre>${escapeHtml(txn.llmInput)}</pre></details>
      <details class="io-block"><summary>LLM output</summary><pre>${escapeHtml(txn.llmOutput)}</pre></details>
      ${
        txn.jevInput
          ? `<details class="io-block"><summary>JEV input</summary><pre>${escapeHtml(JSON.stringify(txn.jevInput, null, 2))}</pre></details>
             <details class="io-block"><summary>JEV output</summary><pre>${escapeHtml(JSON.stringify(txn.jevOutput, null, 2))}</pre></details>`
          : ""
      }
    </details>`;
}
```

- [ ] **Step 2: Add styling for the summary row in `frontend/dashboard.css`**

```css
.txn-card summary.txn-summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.txn-card summary.txn-summary::-webkit-details-marker { display: none; }
.txn-card summary.txn-summary::before {
  content: "▸";
  display: inline-block;
  margin-right: 0.5rem;
  color: var(--text-muted);
  transition: transform 0.15s ease;
}
.txn-card[open] summary.txn-summary::before { transform: rotate(90deg); }
.txn-summary-question { font-weight: 600; font-size: 1rem; }
.txn-summary-meta { font-size: 0.82rem; color: var(--text-muted); }
```

- [ ] **Step 3: Manual verification**

Run: `node --check frontend/dashboard.js`
Expected: no output (syntax OK).

Open the dashboard against live data (deferred fully to Task 11's deploy step) and confirm each transaction card is collapsed by default and expands/collapses on click, showing the retrieval table and JEV model line.

- [ ] **Step 4: Commit**

```bash
git add frontend/dashboard.js frontend/dashboard.css
git commit -m "Make transaction cards collapsible and show the JEV model name"
```

---

### Task 10: Chat UI — thinking indicator + enterprise visual polish

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`
- Modify: `frontend/style.css`

- [ ] **Step 1: Restyle `frontend/index.html`**

Replace the file:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Edukripa</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <header class="app-header">
    <div class="app-header-inner">
      <h1>Edukripa</h1>
      <p class="app-subtitle">Ask questions about your uploaded notes.</p>
    </div>
  </header>

  <main class="app-main">
    <section class="card" id="upload-section">
      <h2>Upload notes (PDF)</h2>
      <div class="upload-row">
        <input type="file" id="file-input" accept="application/pdf" />
        <button id="upload-btn">Upload</button>
      </div>
      <p id="upload-status" class="status-text"></p>
    </section>

    <section class="card" id="chat-section">
      <h2>Ask a question</h2>
      <div id="chat-log"></div>
      <form id="chat-form">
        <input type="text" id="question-input" placeholder="Ask a science or maths question..." required />
        <button type="submit">Send</button>
      </form>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Restyle `frontend/style.css`**

Replace the file:

```css
:root {
  --bg: #f5f6fa;
  --surface: #ffffff;
  --border: #e2e4ea;
  --text: #1a1d29;
  --text-muted: #666a7a;
  --brand-start: #4f46e5;
  --brand-end: #14b8a6;
  --radius: 10px;
  --shadow: 0 1px 3px rgba(20, 20, 40, 0.08), 0 1px 2px rgba(20, 20, 40, 0.06);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
}

.app-header {
  background: linear-gradient(120deg, var(--brand-start), var(--brand-end));
  color: white;
  padding: 2rem 1.5rem;
}
.app-header-inner { max-width: 720px; margin: 0 auto; }
.app-header h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
.app-subtitle { margin: 0; opacity: 0.9; font-size: 0.95rem; }

.app-main { max-width: 720px; margin: 0 auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1.25rem; }

.card {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 1.25rem;
}
.card h2 { margin-top: 0; font-size: 1.1rem; }

.upload-row { display: flex; gap: 0.5rem; align-items: center; }
.upload-row input[type="file"] { flex: 1; font-size: 0.9rem; }
.status-text { font-size: 0.85rem; color: var(--text-muted); min-height: 1.2em; }

button {
  background: linear-gradient(120deg, var(--brand-start), var(--brand-end));
  color: white;
  border: none;
  padding: 0.55rem 1.25rem;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
}
button:disabled { opacity: 0.6; cursor: default; }

#chat-log {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  min-height: 220px;
  max-height: 420px;
  overflow-y: auto;
  margin-bottom: 1rem;
  background: #fafafc;
}
.message { margin-bottom: 0.85rem; max-width: 85%; }
.message.user { font-weight: 600; margin-left: auto; text-align: right; color: var(--brand-start); }
.message.assistant { white-space: pre-wrap; }
.message.assistant.thinking { color: var(--text-muted); font-style: italic; }

#chat-form { display: flex; gap: 0.5rem; }
#question-input {
  flex: 1;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.95rem;
}

@media (max-width: 640px) {
  .app-main { padding: 1rem; }
}
```

- [ ] **Step 3: Add the thinking indicator to `frontend/app.js`**

Replace the `chatForm.addEventListener("submit", ...)` block:

```javascript
const THINKING_PHRASES = ["Thinking", "Searching your notes", "Checking sources", "Composing an answer"];

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;

  appendMessage("user", question);
  questionInput.value = "";
  const submitBtn = chatForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  const thinkingEl = appendMessage("assistant", THINKING_PHRASES[0], { thinking: true });
  let phraseIndex = 0;
  const timer = setInterval(() => {
    phraseIndex = (phraseIndex + 1) % THINKING_PHRASES.length;
    thinkingEl.textContent = `${THINKING_PHRASES[phraseIndex]}...`;
  }, 1200);

  try {
    const response = await fetch(`${WORKER_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const result = await response.json();

    thinkingEl.classList.remove("thinking");
    thinkingEl.textContent = result.answer ?? `Error: ${result.error}`;
  } catch (err) {
    thinkingEl.classList.remove("thinking");
    thinkingEl.textContent = `Error: could not reach the server (${err.message})`;
  } finally {
    clearInterval(timer);
    submitBtn.disabled = false;
  }
});
```

Update `appendMessage` to return the element and accept an options object:

```javascript
function appendMessage(role, text, { thinking = false } = {}) {
  const el = document.createElement("div");
  el.className = `message ${role}${thinking ? " thinking" : ""}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}
```

- [ ] **Step 4: Manual verification**

Run: `node --check frontend/app.js`
Expected: no output (syntax OK).

Open `index.html` locally, submit a question, and confirm: the "Thinking..." message appears immediately and its text visibly cycles; on success it's replaced by the real answer; simulate a failure (e.g. temporarily point `WORKER_URL` at an invalid host) and confirm the message is replaced by the error text and the cycling timer stops (no console errors about a stale interval).

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/style.css frontend/app.js
git commit -m "Add chat 'thinking' indicator and enterprise visual polish"
```

---

### Task 11: Deploy and end-to-end verification

**Files:** none (deployment + manual verification only).

- [ ] **Step 1: Deploy the worker**

Run: `cd worker && npx wrangler deploy`

- [ ] **Step 2: Deploy the frontend**

Run: `cd frontend && npx wrangler pages deploy . --project-name=edu-live-frontend`

- [ ] **Step 3: Verify Settings round-trip**

Using the existing `ADMIN_API_KEY`:
Run: `curl -s -H "x-admin-key: <key>" https://edu-live-worker.naveed-ks.workers.dev/admin/config`
Expected: JSON with the default config values.

Run: `curl -s -X PUT -H "x-admin-key: <key>" -H "Content-Type: application/json" -d '{"topK":3}' https://edu-live-worker.naveed-ks.workers.dev/admin/config`
Expected: JSON echoing `topK: 3`.

Open `dashboard.html`, go to Settings, confirm the form shows `topK=3`, change it back to `5`, save, confirm the status message and a subsequent `GET /admin/config` reflects `5`.

- [ ] **Step 4: Verify chunk browser**

Ingest a fresh PDF via `index.html`'s upload form (or `curl -F file=@...`), then open the Documents tab and confirm: the summary stats row shows the right totals, the newly-ingested PDF's row has an expandable "View N chunk(s)" control showing real chunk text, and the banner correctly states how many documents show chunks.

- [ ] **Step 5: Verify transaction tree + JEV model**

Ask 2-3 questions via `index.html`. Confirm the "Thinking..." indicator cycles and resolves to a real answer. Open the dashboard's TransactionTracker tab and confirm cards are collapsed by default, expand on click, and show the JEV model name (when `JEV_ENABLED=true`).

- [ ] **Step 6: Verify config gating behavior live**

Set `confidenceThreshold` to `0.99` via the Settings tab, ask a question that would normally retrieve a document match, and confirm (via the TransactionTracker) that `pathTaken` is `web_fallback` (or the hard-fail message, if also enabled) even though a document chunk existed - proving the threshold took effect without a redeploy. Reset it back to `0` afterward.

- [ ] **Step 7: Run the full worker test suite one more time**

Run: `cd worker && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit any final fixes found during verification**

If any of the above steps surface a bug, fix it with a regression test (RED→GREEN), re-run the full suite, redeploy, and re-verify - do not leave a live-verification-only fix uncommitted.
