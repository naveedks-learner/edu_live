import { describe, it, expect } from "vitest";
import { handleIngest } from "../src/ingestion";
import type { Env } from "../src/index";

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
