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

function makeEnv(overrides: Partial<Env> = {}): Env {
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
    GUARDRAIL_ENABLED: "false",
    JEV_ENABLED: "false",
    OPENROUTER_API_KEY: "",
    INGEST_API_KEY: "",
    ADMIN_API_KEY: "",
    ...overrides,
  } as unknown as Env;
}

describe("handleChat error handling", () => {
  it("returns a JSON 502, not an uncaught exception, when a downstream call throws", async () => {
    const throwingEnv = {
      AI: { run: async () => { throw new Error("Workers AI is down"); } },
      VECTORIZE: {},
      PDF_BUCKET: {},
      GUARDRAIL_ENABLED: "false",
      JEV_ENABLED: "false",
      OPENROUTER_API_KEY: "",
    } as unknown as Env;

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
      const env = makeEnv({
        JEV_ENABLED: "true",
        OPENROUTER_API_KEY: "fake-key",
        VECTORIZE: {
          query: async () => ({
            matches: [
              { score: 0.9, metadata: { text: "a passage about light", page: 1, pageEnd: 1, source: "notes.pdf", chunkId: 0 } },
            ],
          }),
        },
      });

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

describe("handleChat transaction tracing", () => {
  it("records a transaction via EDU_LIVE_DB after a successful response, without delaying the response", async () => {
    const inserted: unknown[] = [];
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              inserted.push(args);
              return {};
            },
          }),
        }),
      } as unknown as D1Database,
    });
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;

    const response = await handleChat(makeChatRequest("what is reflection of light"), env, ctx);
    await Promise.all(tasks);

    expect(response.status).toBe(200);
    expect(inserted.length).toBe(1);
  });

  it("does not fail the chat response when the D1 insert throws", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              throw new Error("D1 unavailable");
            },
          }),
        }),
      } as unknown as D1Database,
    });
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;

    const response = await handleChat(makeChatRequest("what is reflection of light"), env, ctx);
    await Promise.allSettled(tasks);

    expect(response.status).toBe(200);
  });
});
