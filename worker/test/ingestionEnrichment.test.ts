import { describe, it, expect } from "vitest";
import { enrichPdfToMarkdown, parseEnrichedPages, DEFAULT_INGESTION_MODEL } from "../src/ingestionEnrichment";
import type { Env } from "../src/index";
import type { PageText } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { OPENROUTER_API_KEY: "test-key", ...overrides } as unknown as Env;
}

const FALLBACK: PageText[] = [
  { page: 1, text: "plain text page one" },
  { page: 2, text: "plain text page two" },
  { page: 3, text: "plain text page three" },
];

describe("parseEnrichedPages", () => {
  it("splits a well-formed response into one PageText per marker", () => {
    const response = "<<<PAGE 1>>>\nFirst page markdown\n<<<PAGE 2>>>\nSecond page markdown\n<<<PAGE 3>>>\nThird page markdown";
    const result = parseEnrichedPages(response, FALLBACK);
    expect(result).toEqual([
      { page: 1, text: "First page markdown" },
      { page: 2, text: "Second page markdown" },
      { page: 3, text: "Third page markdown" },
    ]);
  });

  it("falls back to the plain-text page for any page number missing a marker", () => {
    const response = "<<<PAGE 1>>>\nFirst page markdown\n<<<PAGE 3>>>\nThird page markdown";
    const result = parseEnrichedPages(response, FALLBACK);
    expect(result).toEqual([
      { page: 1, text: "First page markdown" },
      { page: 2, text: "plain text page two" },
      { page: 3, text: "Third page markdown" },
    ]);
  });

  it("discards a marker whose page number is outside the fallback page range", () => {
    const response = "<<<PAGE 1>>>\nFirst page markdown\n<<<PAGE 99>>>\nBogus page";
    const result = parseEnrichedPages(response, FALLBACK);
    expect(result).toEqual([
      { page: 1, text: "First page markdown" },
      { page: 2, text: "plain text page two" },
      { page: 3, text: "plain text page three" },
    ]);
  });

  it("returns the fallback pages unchanged when no markers are found at all", () => {
    const result = parseEnrichedPages("no markers here, just prose", FALLBACK);
    expect(result).toEqual(FALLBACK);
  });

  it("drops the last page's parsed content (falling back to plain text for it) when truncated=true, since a cut-off response's last page is likely incomplete", () => {
    const response = "<<<PAGE 1>>>\nFirst page markdown\n<<<PAGE 2>>>\nSecond page markdown\n<<<PAGE 3>>>\nThird page cut off mid";
    const result = parseEnrichedPages(response, FALLBACK, true);
    expect(result).toEqual([
      { page: 1, text: "First page markdown" },
      { page: 2, text: "Second page markdown" },
      { page: 3, text: "plain text page three" },
    ]);
  });
});

describe("enrichPdfToMarkdown", () => {
  it("sends the PDF as a base64 file attachment to the configured model and returns parsed pages", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "<<<PAGE 1>>>\nEnriched one\n<<<PAGE 2>>>\nEnriched two\n<<<PAGE 3>>>\nEnriched three" } }],
        }),
        { status: 200 }
      );
    };

    try {
      const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake bytes").buffer;
      const env = makeEnv();
      const result = await enrichPdfToMarkdown(pdfBytes, FALLBACK, env, { ingestionModelSlug: "vendor/model" });

      expect(result).toEqual([
        { page: 1, text: "Enriched one" },
        { page: 2, text: "Enriched two" },
        { page: 3, text: "Enriched three" },
      ]);

      const body = capturedBody as unknown as { model: string; messages: { content: { type: string; file?: { file_data: string } }[] }[] };
      expect(body.model).toBe("vendor/model");
      const fileParts = body.messages[0].content.filter((c) => c.type === "file");
      expect(fileParts.length).toBe(1);
      expect(fileParts[0].file?.file_data.startsWith("data:application/pdf;base64,")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drops the last parsed page and falls back to its plain text when the response is truncated (finish_reason: length)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: { content: "<<<PAGE 1>>>\nEnriched one\n<<<PAGE 2>>>\nEnriched two\n<<<PAGE 3>>>\nEnriched three but cut" },
            },
          ],
        }),
        { status: 200 }
      );

    try {
      const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake bytes").buffer;
      const env = makeEnv();
      const result = await enrichPdfToMarkdown(pdfBytes, FALLBACK, env, { ingestionModelSlug: DEFAULT_INGESTION_MODEL });
      expect(result).toEqual([
        { page: 1, text: "Enriched one" },
        { page: 2, text: "Enriched two" },
        { page: 3, text: "plain text page three" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes an AbortSignal-based timeout to fetch so a hung upstream call doesn't hold the request forever", async () => {
    let capturedInit: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "<<<PAGE 1>>>\nx" } }] }), { status: 200 });
    };

    try {
      const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake bytes").buffer;
      const env = makeEnv();
      await enrichPdfToMarkdown(pdfBytes, FALLBACK, env, { ingestionModelSlug: DEFAULT_INGESTION_MODEL });
      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the plain-text pages (never throws) when OpenRouter returns a non-OK response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });

    try {
      const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake bytes").buffer;
      const env = makeEnv();
      const result = await enrichPdfToMarkdown(pdfBytes, FALLBACK, env, { ingestionModelSlug: DEFAULT_INGESTION_MODEL });
      expect(result).toEqual(FALLBACK);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the plain-text pages (never throws) when fetch itself rejects", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network down"); };

    try {
      const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake bytes").buffer;
      const env = makeEnv();
      const result = await enrichPdfToMarkdown(pdfBytes, FALLBACK, env, { ingestionModelSlug: DEFAULT_INGESTION_MODEL });
      expect(result).toEqual(FALLBACK);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
