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

vi.mock("../src/ingestionEnrichment", () => ({
  enrichPdfToMarkdown: vi.fn(async (_pdfBytes: ArrayBuffer, fallbackPages: unknown) => fallbackPages),
}));

vi.mock("../src/pageScreenshot", () => ({
  launchScreenshotBrowser: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
  capturePageScreenshot: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
}));

import { enrichPdfToMarkdown } from "../src/ingestionEnrichment";
import { capturePageScreenshot, launchScreenshotBrowser } from "../src/pageScreenshot";

type ConfigRow = { key: string; value: string };

function makeMockDb(configRows: ConfigRow[]): D1Database {
  return {
    prepare: (sql: string) => {
      if (sql.startsWith("SELECT key, value FROM config")) {
        return { all: async () => ({ results: configRows }) };
      }
      return { bind: () => ({ run: async () => ({}) }) };
    },
  } as unknown as D1Database;
}

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

describe("handleIngest enrichment wiring", () => {
  it("calls enrichPdfToMarkdown with the extracted pages when ingestionEnrichmentEnabled is true (the default)", async () => {
    vi.mocked(enrichPdfToMarkdown).mockClear();
    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "true" }]),
    });

    await handleIngest(makeUploadRequest(), env);

    expect(enrichPdfToMarkdown).toHaveBeenCalledTimes(1);
    const [, fallbackPagesArg] = vi.mocked(enrichPdfToMarkdown).mock.calls[0];
    expect(fallbackPagesArg).toEqual([
      { page: 1, text: "Light reflects off a mirror at an equal angle." },
      { page: 2, text: "The angle of incidence equals the angle of reflection." },
    ]);
  });

  it("does not call enrichPdfToMarkdown when ingestionEnrichmentEnabled is false", async () => {
    vi.mocked(enrichPdfToMarkdown).mockClear();
    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "false" }]),
    });

    const response = await handleIngest(makeUploadRequest(), env);

    expect(response.status).toBe(200);
    expect(enrichPdfToMarkdown).not.toHaveBeenCalled();
  });

  it("rejects an all-empty-text PDF with 400 before ever calling enrichPdfToMarkdown", async () => {
    vi.mocked(enrichPdfToMarkdown).mockClear();
    vi.resetModules();
    vi.doMock("../src/pdf", () => ({
      extractPdfPages: async () => [{ page: 1, text: "   " }],
    }));
    const { handleIngest: handleIngestFreshImport } = await import("../src/ingestion");

    const env = makeEnv({ INGEST_API_KEY: "" });
    const response = await handleIngestFreshImport(makeUploadRequest(), env);

    expect(response.status).toBe(400);
    expect(enrichPdfToMarkdown).not.toHaveBeenCalled();
  });
});

describe("handleIngest page screenshot capture", () => {
  it("captures a screenshot for any page whose enriched text contains a [Figure: marker, and stores it in R2", async () => {
    vi.mocked(capturePageScreenshot).mockClear();
    vi.mocked(launchScreenshotBrowser).mockClear();
    vi.mocked(enrichPdfToMarkdown).mockResolvedValueOnce([
      { page: 1, text: "Plain prose, no figures here." },
      { page: 2, text: "Some text.\n[Figure: a labeled diagram of the eye]\nMore text." },
    ]);

    const putCalls: unknown[] = [];
    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      PDF_BUCKET: {
        head: async () => null,
        put: async (...args: unknown[]) => {
          putCalls.push(args);
        },
      } as unknown as R2Bucket,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "true" }]),
    });

    await handleIngest(makeUploadRequest(), env);

    expect(launchScreenshotBrowser).toHaveBeenCalledTimes(1);
    expect(capturePageScreenshot).toHaveBeenCalledTimes(1);
    const [, , pageArg] = vi.mocked(capturePageScreenshot).mock.calls[0];
    expect(pageArg).toBe(2);

    // second put call is the page-image write (first is the source PDF write)
    const imagePut = putCalls.find((call) => String((call as unknown[])[0]).startsWith("page-images/"));
    expect(imagePut).toBeDefined();
  });

  it("launches the browser only once even with multiple figure pages", async () => {
    vi.mocked(capturePageScreenshot).mockClear();
    vi.mocked(launchScreenshotBrowser).mockClear();
    vi.mocked(enrichPdfToMarkdown).mockResolvedValueOnce([
      { page: 1, text: "Some text.\n[Figure: diagram one]\nMore text." },
      { page: 2, text: "Some text.\n[Figure: diagram two]\nMore text." },
    ]);

    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "true" }]),
    });

    await handleIngest(makeUploadRequest(), env);

    expect(launchScreenshotBrowser).toHaveBeenCalledTimes(1);
    expect(capturePageScreenshot).toHaveBeenCalledTimes(2);
  });

  it("records enriched=false in R2 customMetadata when enrichPdfToMarkdown falls back unchanged", async () => {
    vi.mocked(enrichPdfToMarkdown).mockImplementationOnce(async (_pdfBytes, fallbackPages) => fallbackPages);

    const putCalls: unknown[] = [];
    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      PDF_BUCKET: {
        head: async () => null,
        put: async (...args: unknown[]) => {
          putCalls.push(args);
        },
      } as unknown as R2Bucket,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "true" }]),
    });

    await handleIngest(makeUploadRequest(), env);

    const sourcePut = putCalls.find((call) => (call as unknown[])[0] === "notes.pdf") as [
      string,
      ArrayBuffer,
      { customMetadata: Record<string, string> }
    ];
    expect(sourcePut[2].customMetadata.enriched).toBe("false");
  });

  it("records enriched=true in R2 customMetadata when enrichPdfToMarkdown returns different content", async () => {
    vi.mocked(enrichPdfToMarkdown).mockResolvedValueOnce([
      { page: 1, text: "Enriched markdown for page one." },
      { page: 2, text: "Enriched markdown for page two." },
    ]);

    const putCalls: unknown[] = [];
    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      PDF_BUCKET: {
        head: async () => null,
        put: async (...args: unknown[]) => {
          putCalls.push(args);
        },
      } as unknown as R2Bucket,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "true" }]),
    });

    await handleIngest(makeUploadRequest(), env);

    const sourcePut = putCalls.find((call) => (call as unknown[])[0] === "notes.pdf") as [
      string,
      ArrayBuffer,
      { customMetadata: Record<string, string> }
    ];
    expect(sourcePut[2].customMetadata.enriched).toBe("true");
  });

  it("stores the enriched per-page text as a standalone cleaned/<name>.md artifact when enrichment applied", async () => {
    vi.mocked(enrichPdfToMarkdown).mockResolvedValueOnce([
      { page: 1, text: "Enriched markdown for page one." },
      { page: 2, text: "Enriched markdown for page two." },
    ]);

    const putCalls: unknown[] = [];
    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      PDF_BUCKET: {
        head: async () => null,
        put: async (...args: unknown[]) => {
          putCalls.push(args);
        },
      } as unknown as R2Bucket,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "true" }]),
    });

    await handleIngest(makeUploadRequest(), env);

    const cleanedPut = putCalls.find((call) => (call as unknown[])[0] === "cleaned/notes.pdf.md") as [
      string,
      string,
      { httpMetadata?: { contentType?: string } }
    ];
    expect(cleanedPut).toBeDefined();
    expect(cleanedPut[1]).toContain("Enriched markdown for page one.");
    expect(cleanedPut[1]).toContain("Enriched markdown for page two.");
    expect(cleanedPut[2]?.httpMetadata?.contentType).toBe("text/markdown");
  });

  it("does not store a cleaned/<name>.md artifact when enrichment did not apply (fell back to plain text)", async () => {
    vi.mocked(enrichPdfToMarkdown).mockImplementationOnce(async (_pdfBytes, fallbackPages) => fallbackPages);

    const putCalls: unknown[] = [];
    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      PDF_BUCKET: {
        head: async () => null,
        put: async (...args: unknown[]) => {
          putCalls.push(args);
        },
      } as unknown as R2Bucket,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "true" }]),
    });

    await handleIngest(makeUploadRequest(), env);

    const cleanedPut = putCalls.find((call) => (call as unknown[])[0] === "cleaned/notes.pdf.md");
    expect(cleanedPut).toBeUndefined();
  });

  it("does not launch a browser or capture any screenshot when no page contains a [Figure: marker", async () => {
    vi.mocked(capturePageScreenshot).mockClear();
    vi.mocked(launchScreenshotBrowser).mockClear();
    vi.mocked(enrichPdfToMarkdown).mockResolvedValueOnce([
      { page: 1, text: "Plain prose." },
      { page: 2, text: "More plain prose." },
    ]);

    const env = makeEnv({
      INGEST_API_KEY: "",
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) } as unknown as Ai,
      EDU_LIVE_DB: makeMockDb([{ key: "ingestionEnrichmentEnabled", value: "true" }]),
    });

    await handleIngest(makeUploadRequest(), env);

    expect(launchScreenshotBrowser).not.toHaveBeenCalled();
    expect(capturePageScreenshot).not.toHaveBeenCalled();
  });
});
