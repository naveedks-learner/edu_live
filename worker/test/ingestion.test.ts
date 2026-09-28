import { describe, it, expect, vi } from "vitest";
import { handleIngest } from "../src/ingestion";
import type { Env } from "../src/index";

// extractPdfPages depends on a real PDF byte structure (via unpdf); the
// customMetadata test below only cares about what handleIngest does with
// the pages/chunks it gets back, so the PDF parsing step itself is mocked
// out rather than requiring a real PDF fixture.
vi.mock("../src/pdf", () => ({
  extractPdfPages: async () => [
    { page: 1, text: "Light reflects off a mirror at an equal angle." },
    { page: 2, text: "The angle of incidence equals the angle of reflection." },
  ],
}));

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => ({ data: [] }) },
    VECTORIZE: { upsert: async () => ({}) },
    PDF_BUCKET: { head: async () => null, put: async () => {} },
    GUARDRAIL_ENABLED: "false",
    JEV_ENABLED: "false",
    OPENROUTER_API_KEY: "",
    INGEST_API_KEY: "secret-key",
    ...overrides,
  } as unknown as Env;
}

function makeUploadRequest(headers: Record<string, string> = {}): Request {
  const formData = new FormData();
  formData.append("file", new File(["not a real pdf"], "notes.pdf", { type: "application/pdf" }));
  return new Request("https://worker.example/ingest", { method: "POST", body: formData, headers });
}

describe("handleIngest auth", () => {
  it("rejects a request with no ingest key when one is configured", async () => {
    const response = await handleIngest(makeUploadRequest(), makeEnv());
    expect(response.status).toBe(401);
  });

  it("rejects a request with the wrong ingest key", async () => {
    const response = await handleIngest(
      makeUploadRequest({ "x-ingest-key": "wrong-key" }),
      makeEnv()
    );
    expect(response.status).toBe(401);
  });

  it("allows ingestion to proceed past the auth check when the key matches", async () => {
    const response = await handleIngest(
      makeUploadRequest({ "x-ingest-key": "secret-key" }),
      makeEnv()
    );
    // Auth passes; this fake PDF has no real content so extraction is expected
    // to fail with a 400 (not a 401) - proving the auth check let it through.
    expect(response.status).not.toBe(401);
  });

  it("allows requests through unauthenticated when INGEST_API_KEY is not configured", async () => {
    const response = await handleIngest(makeUploadRequest(), makeEnv({ INGEST_API_KEY: "" }));
    expect(response.status).not.toBe(401);
  });
});

describe("handleIngest metadata", () => {
  it("writes chunkCount, pageCount, and indexedAt as R2 customMetadata", async () => {
    const putCalls: unknown[] = [];
    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      VECTORIZE: { upsert: async () => ({}) } as unknown as VectorizeIndex,
      PDF_BUCKET: {
        head: async () => null,
        put: async (...args: unknown[]) => {
          putCalls.push(args);
        },
      } as unknown as R2Bucket,
    });

    const response = await handleIngest(makeUploadRequest(), env);
    expect(response.status).toBe(200);

    expect(putCalls.length).toBe(1);
    const [, , options] = putCalls[0] as [string, ArrayBuffer, { customMetadata: Record<string, string> }];
    expect(options.customMetadata).toHaveProperty("chunkCount");
    expect(options.customMetadata).toHaveProperty("pageCount");
    expect(options.customMetadata).toHaveProperty("indexedAt");
    expect(options.customMetadata.pageCount).toBe("2");
  });
});
