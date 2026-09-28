import { describe, it, expect } from "vitest";
import { handleChat } from "../src/chat";
import type { Env } from "../src/index";

function makeRequest(body: unknown): Request {
  return new Request("https://worker.example/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeChatRequest(question: string): Request {
  return makeRequest({ question });
}

function noopCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

type ConfigRow = { key: string; value: string };

// Routes by SQL text so a single mock DB serves both the config read and the
// transaction insert - a test that needs to intercept one must not lose the
// other (losing the config branch silently falls back to production
// defaults, e.g. guardrailEnabled=true, which changes pipeline behavior).
function makeMockDb(configRows: ConfigRow[], onInsert?: (args: unknown[]) => void, insertThrows = false): D1Database {
  return {
    prepare: (sql: string) => {
      if (sql.startsWith("SELECT key, value FROM config")) {
        return { all: async () => ({ results: configRows }) };
      }
      return {
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (insertThrows) throw new Error("D1 unavailable");
            onInsert?.(args);
            return {};
          },
        }),
      };
    },
  } as unknown as D1Database;
}

// Defaults mirror the old env-var defaults (guardrail and JEV off) so
// existing tests that don't care about either keep working unchanged;
// override via `configRows` for tests that do.
const DEFAULT_TEST_ROWS: ConfigRow[] = [
  { key: "guardrailEnabled", value: "false" },
  { key: "jevEnabled", value: "false" },
];

function makeEnv(overrides: Partial<Env> = {}, configRows: ConfigRow[] = []): Env {
  return {
    AI: {
      run: async (model: string) => {
        if (model === "@cf/baai/bge-base-en-v1.5") return { data: [[0.1, 0.2]] };
        if (model === "@cf/baai/bge-reranker-base") return { response: [] };
        return { response: "an answer" };
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

describe("handleChat error handling", () => {
  it("returns a JSON 502, not an uncaught exception, when a downstream call throws", async () => {
    const throwingEnv = makeEnv({
      AI: { run: async () => { throw new Error("Workers AI is down"); } },
      VECTORIZE: {},
      PDF_BUCKET: {},
    });

    const response = await handleChat(makeRequest({ question: "What is Newton's second law?" }), throwingEnv, noopCtx());

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

describe("handleChat JEV failure handling", () => {
  it("passes retrieved chunks through unfiltered (fail-open) when JEV is enabled but the JEV call fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (String(input).includes("openrouter.ai")) throw new Error("JEV unreachable");
      throw new Error(`unexpected fetch to ${input}`);
    };

    try {
      const env = makeEnv(
        {
          OPENROUTER_API_KEY: "fake-key",
          VECTORIZE: {
            query: async () => ({
              matches: [
                { score: 0.9, metadata: { text: "a passage about light", page: 1, pageEnd: 1, source: "notes.pdf", chunkId: 0 } },
              ],
            }),
          },
        },
        [{ key: "jevEnabled", value: "true" }]
      );

      const response = await handleChat(makeChatRequest("what is reflection of light"), env, noopCtx());
      const body = (await response.json()) as { docSources: { source: string }[] };

      expect(response.status).toBe(200);
      expect(body.docSources.length).toBe(1);
      expect(body.docSources[0].source).toBe("notes.pdf");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("handleChat runtime config", () => {
  it("falls back to web search when the top confidence is below confidenceThreshold, even with a kept chunk", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("duckduckgo")) {
        return new Response("<html></html>", { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    try {
      const env = makeEnv(
        {
          VECTORIZE: {
            query: async () => ({
              matches: [{ score: 0.5, metadata: { text: "low confidence passage", page: 1, pageEnd: 1, source: "notes.pdf", chunkId: 0 } }],
            }),
          },
        },
        [{ key: "confidenceThreshold", value: "0.99" }]
      );

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
      return new Response("<html></html>", { status: 200 });
    };

    try {
      const env = makeEnv({ VECTORIZE: { query: async () => ({ matches: [] }) } }, [
        { key: "webSearchMode", value: "rag_only" },
      ]);

      const response = await handleChat(makeChatRequest("what is reflection of light"), env, noopCtx());

      expect(response.status).toBe(200);
      expect(webSearchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a fixed message without calling the generation model when hardFailNoDocument is true and nothing was found", async () => {
    let generationCalled = false;
    const env = makeEnv(
      {
        VECTORIZE: { query: async () => ({ matches: [] }) },
        AI: {
          run: async (model: string) => {
            if (model === "@cf/baai/bge-base-en-v1.5") return { data: [[0.1, 0.2]] };
            generationCalled = true;
            return { response: "should not be called" };
          },
        },
      },
      [
        { key: "webSearchMode", value: "rag_only" },
        { key: "hardFailNoDocument", value: "true" },
      ]
    );

    const response = await handleChat(makeChatRequest("what is reflection of light"), env, noopCtx());
    const body = (await response.json()) as { answer: string };

    expect(response.status).toBe(200);
    expect(generationCalled).toBe(false);
    expect(body.answer).toMatch(/don't have enough information/i);
  });
});

describe("handleChat transaction tracing", () => {
  it("records a transaction via EDU_LIVE_DB after a successful response, without delaying the response", async () => {
    const inserted: unknown[] = [];
    const env = makeEnv({ EDU_LIVE_DB: makeMockDb(DEFAULT_TEST_ROWS, (args) => inserted.push(args)) });
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;

    const response = await handleChat(makeChatRequest("what is reflection of light"), env, ctx);
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(inserted.length).toBe(1);
  });

  it("does not fail the chat response when the D1 insert throws", async () => {
    const env = makeEnv({ EDU_LIVE_DB: makeMockDb(DEFAULT_TEST_ROWS, undefined, true) });
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;

    const response = await handleChat(makeChatRequest("what is reflection of light"), env, ctx);
    await Promise.allSettled(tasks);

    expect(response.status).toBe(200);
  });
});
