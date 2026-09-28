import { describe, it, expect } from "vitest";
import {
  isAdminAuthorized,
  handleAdminDocuments,
  handleAdminTransactions,
  handleAdminCosting,
  handleAdminGetConfig,
  handleAdminPutConfig,
} from "../src/admin";
import type { Env } from "../src/index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_API_KEY: "admin-secret",
    PDF_BUCKET: { list: async () => ({ objects: [] }) },
    EDU_LIVE_DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [] }), first: async () => null }),
      }),
    },
    ...overrides,
  } as unknown as Env;
}

function req(headers: Record<string, string> = {}) {
  return new Request("https://worker.example/admin/documents", { headers });
}

describe("isAdminAuthorized", () => {
  it("rejects a request with no key when one is configured", () => {
    expect(isAdminAuthorized(req(), makeEnv())).toBe(false);
  });

  it("rejects a request with the wrong key", () => {
    expect(isAdminAuthorized(req({ "x-admin-key": "wrong" }), makeEnv())).toBe(false);
  });

  it("accepts a request with the correct key", () => {
    expect(isAdminAuthorized(req({ "x-admin-key": "admin-secret" }), makeEnv())).toBe(true);
  });

  it("allows requests through unauthenticated when ADMIN_API_KEY is not configured", () => {
    expect(isAdminAuthorized(req(), makeEnv({ ADMIN_API_KEY: "" }))).toBe(true);
  });
});

describe("handleAdminDocuments", () => {
  it("returns an empty list when no documents are indexed", async () => {
    const response = await handleAdminDocuments(makeEnv());
    expect(await response.json()).toEqual({ documents: [], chunkPreviewCount: 0 });
  });

  it("requests customMetadata from R2, without which real buckets omit it from list results", async () => {
    let receivedOptions: unknown;
    const env = makeEnv({
      PDF_BUCKET: {
        list: async (options: unknown) => {
          receivedOptions = options;
          return { objects: [] };
        },
      } as unknown as Env["PDF_BUCKET"],
    });

    await handleAdminDocuments(env);

    expect(receivedOptions).toEqual({ include: ["customMetadata"] });
  });

  it("renders null for missing customMetadata fields (pre-migration PDFs)", async () => {
    const env = makeEnv({
      PDF_BUCKET: {
        list: async () => ({
          objects: [{ key: "old-notes.pdf", size: 1234, customMetadata: undefined }],
        }),
      } as unknown as Env["PDF_BUCKET"],
    });

    const response = await handleAdminDocuments(env);
    const body = (await response.json()) as { documents: { chunkCount: number | null }[] };

    expect(body.documents[0]).toMatchObject({
      name: "old-notes.pdf",
      sizeBytes: 1234,
      chunkCount: null,
      pageCount: null,
      indexedAt: null,
    });
  });

  it("parses numeric customMetadata fields for documents ingested after this change", async () => {
    const env = makeEnv({
      PDF_BUCKET: {
        list: async () => ({
          objects: [
            {
              key: "notes.pdf",
              size: 5000,
              customMetadata: { chunkCount: "12", pageCount: "3", indexedAt: "2026-09-28T00:00:00.000Z" },
            },
          ],
        }),
      } as unknown as Env["PDF_BUCKET"],
    });

    const response = await handleAdminDocuments(env);
    const body = (await response.json()) as { documents: { chunkCount: number; pageCount: number }[] };

    expect(body.documents[0].chunkCount).toBe(12);
    expect(body.documents[0].pageCount).toBe(3);
  });

  it("returns a JSON 500, not an uncaught exception, when R2 throws", async () => {
    const env = makeEnv({
      PDF_BUCKET: {
        list: async () => {
          throw new Error("R2 unavailable");
        },
      } as unknown as Env["PDF_BUCKET"],
    });

    const response = await handleAdminDocuments(env);

    expect(response.status).toBe(500);
    expect(await response.json()).toHaveProperty("error");
  });

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
});

describe("handleAdminTransactions", () => {
  it("returns an empty list when there are no transactions", async () => {
    const response = await handleAdminTransactions(req(), makeEnv());
    expect(await response.json()).toEqual({ transactions: [] });
  });

  it("returns a JSON 500, not an uncaught exception, when D1 throws", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error("D1 unavailable");
            },
          }),
        }),
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const response = await handleAdminTransactions(req(), env);

    expect(response.status).toBe(500);
    expect(await response.json()).toHaveProperty("error");
  });

  it("parses JSON columns back into objects and defaults limit to 3", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            all: async () => {
              expect(sql).toContain("LIMIT");
              expect(args[0]).toBe(3);
              return {
                results: [
                  {
                    id: 1,
                    timestamp: "2026-09-28T00:00:00.000Z",
                    question: "q",
                    provider: "workers-ai",
                    model: "m",
                    path_taken: "pdf_only",
                    confidence: 0.8,
                    retrieval_json: "[]",
                    llm_input: "in",
                    llm_output: "out",
                    jev_input_json: null,
                    jev_output_json: null,
                    input_tokens: 10,
                    output_tokens: 5,
                    jev_cost_usd: 0,
                    llm_cost_usd: 0,
                  },
                ],
              };
            },
          }),
        }),
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const response = await handleAdminTransactions(req(), env);
    const body = (await response.json()) as { transactions: { retrieval: unknown[]; jevInput: null }[] };

    expect(body.transactions[0].retrieval).toEqual([]);
    expect(body.transactions[0].jevInput).toBeNull();
  });
});

describe("handleAdminCosting", () => {
  it("returns a zeroed summary when there is no data", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
          }),
        }),
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const response = await handleAdminCosting(new Request("https://worker.example/admin/costing?range=1d"), env);
    const body = (await response.json()) as { range: string; lastTransaction: null };

    expect(body.range).toBe("1d");
    expect(body.lastTransaction).toBeNull();
  });

  it("returns a JSON 500, not an uncaught exception, when D1 throws", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              throw new Error("D1 unavailable");
            },
          }),
        }),
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const response = await handleAdminCosting(new Request("https://worker.example/admin/costing"), env);

    expect(response.status).toBe(500);
    expect(await response.json()).toHaveProperty("error");
  });

  it("defaults to a 1d range without throwing when no range query param is given", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
          }),
        }),
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const response = await handleAdminCosting(new Request("https://worker.example/admin/costing"), env);
    const body = (await response.json()) as { range: string };

    expect(response.status).toBe(200);
    expect(body.range).toBe("1d");
  });

  it("falls back to 1d for an unrecognized range value instead of throwing", async () => {
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => null,
          }),
        }),
      } as unknown as Env["EDU_LIVE_DB"],
    });

    const response = await handleAdminCosting(new Request("https://worker.example/admin/costing?range=bogus"), env);
    const body = (await response.json()) as { range: string };

    expect(response.status).toBe(200);
    expect(body.range).toBe("1d");
  });
});

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
    const written: unknown[][] = [];
    const env = makeEnv({
      EDU_LIVE_DB: {
        prepare: () => ({
          all: async () => ({ results: [{ key: "topK", value: "7" }] }),
          bind: (...args: unknown[]) => ({ __boundArgs: args }),
        }),
        batch: async (statements: { __boundArgs: unknown[] }[]) => {
          written.push(...statements.map((s) => s.__boundArgs));
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
