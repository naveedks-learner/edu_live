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
