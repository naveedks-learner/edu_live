# PDF Content Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before chunking, send each uploaded PDF through a vision-capable OpenRouter model that returns structured Markdown (LaTeX formulas, Markdown tables, captioned figures) per page, so that content survives into retrieval instead of being dropped by today's plain-text-only `unpdf` extraction. **Additionally**, capture an actual screenshot of any page flagged as containing a figure, so students get the real image back at query time, not just a text description.

**Architecture:** A new module (`ingestionEnrichment.ts`) sends the whole PDF as a base64 file attachment in one OpenRouter chat-completion call, prompting the model to emit each page's content delimited by `<<<PAGE n>>>` markers. The response is parsed back into the same `PageText[]` shape `chunker.ts` already consumes, so chunking/embedding/Vectorize storage are unchanged. On any failure (call error, unparseable response, missing pages in the response), it fails open per-page to the existing `unpdf` plain-text extraction — the document is never blocked from being indexed. Toggleable via `RuntimeConfig` (admin dashboard), same pattern as `jevEnabled`/`llmProvider`. Separately, a second module (`pageScreenshot.ts`) uses Cloudflare's Browser Rendering binding to screenshot any page whose enriched text contains a `[Figure: ...]` marker, storing the PNG in R2 and threading its key through Vectorize chunk metadata → `/chat`'s `docSources` → the frontend, which renders it as an `<img>` alongside the answer.

**Tech Stack:** TypeScript, Cloudflare Workers, `unpdf` (existing text fallback), OpenRouter chat-completions API (`fetch`), `@cloudflare/puppeteer` (Browser Rendering), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-pdf-content-enrichment-design.md`

## Global Constraints

- No PDF page rasterization in-Worker (no Canvas/DOM) — the whole PDF is sent as one file attachment to a PDF-capable OpenRouter model; pages are never rendered to images by our code.
- `enrichPdfToMarkdown` must **never throw** — same fail-open contract as `scoreChunksWithJev` in `jev.ts`. Any failure (network, non-OK response, unparseable output, partially missing pages) degrades to the `unpdf` fallback for the affected page(s), never blocks ingestion.
- New `RuntimeConfig` fields default to values that change today's behavior deliberately (`ingestionEnrichmentEnabled: true` is a new default, not preserved-old-behavior) — this mirrors how `llmProvider` defaulted to `"openrouter"` in the prior branch, so document this explicitly in code comments, not silently.
- Default ingestion model: `google/gemini-2.5-flash` (separate config key from the chat `llmModelSlug` — different job, different model requirements).
- Follow the existing validate-before-write ordering in `handleIngest` — enrichment happens before chunking/embedding, same as today's `extractPdfPages` call; nothing about the R2-write-last ordering changes.

## Review Focus

- A PDF where the model returns fewer `<<<PAGE n>>>` markers than actual pages (e.g. it merges two pages, or skips a blank page) — must fall back to the `unpdf` page text for every page number that has no corresponding marker, not silently drop those pages from the document.
- OpenRouter returns a non-200 (rate limit, bad model slug, auth failure) — must fall back to the full `unpdf` page set, not throw and fail the whole `/ingest` request (today's `handleIngest` has no code path that expects an extraction-adjacent call to throw past the `extractPdfPages` try/catch).
- `ingestionEnrichmentEnabled` is `false` — enrichment must be skipped entirely (not called, not even attempted), so disabling it via the dashboard has zero latency/cost impact, not just "ignored output."
- An empty or all-whitespace PDF (today's existing "No extractable text found" 400 check) — this check must still fire from the `unpdf` output *before* any enrichment call is attempted, so we don't spend an OpenRouter call on a PDF that was already going to be rejected.
- A model response that includes `<<<PAGE n>>>` markers with page numbers that don't match `fallbackPages` at all (e.g. off-by-one, or a page range outside what was uploaded) — must not crash the parser or produce `PageText` entries with bogus page numbers; any marker whose page number isn't in `fallbackPages`'s page range is discarded, and the corresponding fallback page's plain text is used for that page number instead.

## File Structure

- Create: `worker/src/ingestionEnrichment.ts` — the new enrichment module (`enrichPdfToMarkdown`, prompt builder, response parser, base64 helper).
- Create: `worker/test/ingestionEnrichment.test.ts` — unit tests for the new module.
- Modify: `worker/src/config.ts` — add `ingestionEnrichmentEnabled` / `ingestionModelSlug` to `RuntimeConfig`.
- Modify: `worker/test/config.test.ts` — cover the two new fields.
- Modify: `worker/src/ingestion.ts` — call `enrichPdfToMarkdown` (behind the config flag) before chunking; capture flagged-page screenshots and attach `pageImageKey` to Vectorize metadata.
- Modify: `worker/test/ingestion.test.ts` — mock the new module, add wiring tests.
- Modify: `frontend/dashboard.js` — add an "Ingestion enrichment" card to the Settings tab.
- Create: `worker/src/pageScreenshot.ts` — captures a PDF page screenshot via the Browser Rendering binding.
- Create: `worker/test/pageScreenshot.test.ts` — unit tests mocking `@cloudflare/puppeteer`.
- Create: `worker/src/images.ts` — `GET /images/:key` handler, serves a PNG from `PDF_BUCKET`.
- Create: `worker/test/images.test.ts` — unit tests for the route.
- Modify: `worker/wrangler.toml` — add the `[browser]` binding.
- Modify: `worker/package.json` — add `@cloudflare/puppeteer` dependency.
- Modify: `worker/src/index.ts` — add the `Env.BROWSER` type and the `GET /images/:key` route.
- Modify: `worker/src/rerank.ts` — add `pageImageKey: string | null` to `RetrievedChunk`.
- Modify: `worker/src/chat.ts` — read `pageImageKey` from Vectorize match metadata, include it in `docSources`.
- Modify: `worker/test/chat.test.ts` — cover `pageImageKey` flowing through to `docSources`.
- Modify: `frontend/app.js` — render an `<img>` for any `docSource` with a `pageImageKey`.

---

### Task 1: Add `ingestionEnrichmentEnabled` / `ingestionModelSlug` to RuntimeConfig

**Files:**
- Modify: `worker/src/config.ts`
- Test: `worker/test/config.test.ts`

**Interfaces:**
- Produces: `RuntimeConfig.ingestionEnrichmentEnabled: boolean`, `RuntimeConfig.ingestionModelSlug: string`, both readable via the existing `getRuntimeConfig(env): Promise<RuntimeConfig>` and writable via the existing `setRuntimeConfig`/`validateConfigUpdate`.

- [ ] **Step 1: Write the failing tests**

Add to `worker/test/config.test.ts`, inside the existing `parseConfigRows` "parses each stored value" test (extend the rows array and the expected object) and add new standalone tests:

```ts
// inside the existing "parses each stored value to its typed form" test, add to the rows array:
      { key: "ingestionEnrichmentEnabled", value: "false" },
      { key: "ingestionModelSlug", value: "some/vision-model" },

// and to the expected object:
      ingestionEnrichmentEnabled: false,
      ingestionModelSlug: "some/vision-model",
```

```ts
describe("ingestion enrichment config", () => {
  it("defaults ingestionEnrichmentEnabled to true and ingestionModelSlug to the Gemini default", () => {
    expect(DEFAULT_CONFIG.ingestionEnrichmentEnabled).toBe(true);
    expect(DEFAULT_CONFIG.ingestionModelSlug).toBe("google/gemini-2.5-flash");
  });

  it("rejects a non-boolean ingestionEnrichmentEnabled", () => {
    expect(validateConfigUpdate({ ingestionEnrichmentEnabled: "true" }).length).toBeGreaterThan(0);
  });

  it("rejects an empty ingestionModelSlug", () => {
    expect(validateConfigUpdate({ ingestionModelSlug: "" }).length).toBeGreaterThan(0);
    expect(validateConfigUpdate({ ingestionModelSlug: "   " }).length).toBeGreaterThan(0);
  });

  it("accepts a valid ingestion enrichment update", () => {
    expect(
      validateConfigUpdate({ ingestionEnrichmentEnabled: false, ingestionModelSlug: "x/y" })
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/config.test.ts`
Expected: FAIL — `ingestionEnrichmentEnabled`/`ingestionModelSlug` not on `RuntimeConfig`/`DEFAULT_CONFIG`, `validateConfigUpdate` doesn't reject them (falls through as unrecognized field errors, or doesn't error at all for the "accepts" case).

- [ ] **Step 3: Implement**

In `worker/src/config.ts`, add to the `RuntimeConfig` interface (after `llmModelSlug: string;`):

```ts
  jevRelevanceThreshold: number;
  ingestionEnrichmentEnabled: boolean;
  ingestionModelSlug: string;
}
```

Add to `DEFAULT_CONFIG` (after `jevRelevanceThreshold: 1.5,`), and extend the comment above it:

```ts
// - ingestionEnrichmentEnabled defaults to true, ingestionModelSlug to a
//   PDF-capable OpenRouter model - new ingestion-time behavior, not a
//   preserved default (unpdf-only extraction was the only option before).
export const DEFAULT_CONFIG: RuntimeConfig = {
  topK: 5,
  confidenceThreshold: 0,
  webSearchMode: "rag_web_fallback",
  hardFailNoDocument: false,
  jevEnabled: true,
  guardrailEnabled: true,
  llmProvider: "openrouter",
  llmModelSlug: DEFAULT_OPENROUTER_MODEL,
  jevRelevanceThreshold: 1.5,
  ingestionEnrichmentEnabled: true,
  ingestionModelSlug: "google/gemini-2.5-flash",
};
```

Add to `parseConfigRows`'s returned object (after `jevRelevanceThreshold: ...`):

```ts
    ingestionEnrichmentEnabled: map.has("ingestionEnrichmentEnabled")
      ? map.get("ingestionEnrichmentEnabled") === "true"
      : DEFAULT_CONFIG.ingestionEnrichmentEnabled,
    ingestionModelSlug: map.get("ingestionModelSlug") ?? DEFAULT_CONFIG.ingestionModelSlug,
```

Add to `KNOWN_FIELDS`:

```ts
  "ingestionEnrichmentEnabled",
  "ingestionModelSlug",
```

Add to `validateConfigUpdate` (after the `llmModelSlug` block):

```ts
  if ("ingestionEnrichmentEnabled" in input && typeof input.ingestionEnrichmentEnabled !== "boolean") {
    errors.push({ field: "ingestionEnrichmentEnabled", message: "ingestionEnrichmentEnabled must be a boolean" });
  }
  if ("ingestionModelSlug" in input) {
    const v = input.ingestionModelSlug;
    if (typeof v !== "string" || v.trim().length === 0) {
      errors.push({ field: "ingestionModelSlug", message: "ingestionModelSlug must be a non-empty string" });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/config.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add worker/src/config.ts worker/test/config.test.ts
git commit -m "Add ingestionEnrichmentEnabled/ingestionModelSlug to RuntimeConfig"
```

---

### Task 2: `enrichPdfToMarkdown` — the enrichment module

**Files:**
- Create: `worker/src/ingestionEnrichment.ts`
- Test: `worker/test/ingestionEnrichment.test.ts`

**Interfaces:**
- Consumes: `Env` (from `./index`, needs `OPENROUTER_API_KEY`), `PageText` (from `./types`, `{ page: number; text: string }`).
- Produces: `enrichPdfToMarkdown(pdfBytes: ArrayBuffer, fallbackPages: PageText[], env: Env, config: { ingestionModelSlug: string }): Promise<PageText[]>` — same length and page numbers as `fallbackPages`, never throws.
- Produces (exported for tests): `DEFAULT_INGESTION_MODEL = "google/gemini-2.5-flash"`, `parseEnrichedPages(responseText: string, fallbackPages: PageText[]): PageText[]` (pure function, easiest to unit test the parsing logic in isolation).

- [ ] **Step 1: Write the failing tests**

Create `worker/test/ingestionEnrichment.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/ingestionEnrichment.test.ts`
Expected: FAIL — module `../src/ingestionEnrichment` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `worker/src/ingestionEnrichment.ts`:

```ts
import type { Env } from "./index";
import type { PageText } from "./types";

// PDF-capable OpenRouter model - separate from the chat llmModelSlug since
// document understanding and chat generation have different model
// requirements (native PDF/vision input is not universal across models).
export const DEFAULT_INGESTION_MODEL = "google/gemini-2.5-flash";

const PAGE_MARKER = /<<<PAGE (\d+)>>>/g;

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function buildPrompt(): string {
  return (
    "You will be given a PDF document. For EVERY page in the document, output its content as " +
    "Markdown, preserving meaning precisely:\n" +
    "- Mathematical formulas and equations: write as LaTeX, delimited with $...$ (inline) or $$...$$ (block).\n" +
    "- Tables: reproduce as Markdown tables (with header row and alignment row).\n" +
    "- Images, diagrams, charts, or figures: describe their content in enough detail to answer a " +
    "question about them, prefixed with '[Figure: '.\n" +
    "- All other text: reproduce as close to verbatim as possible.\n\n" +
    "Separate each page's output with a line containing exactly <<<PAGE n>>> where n is the 1-indexed " +
    "page number, immediately before that page's content. Do not add any other commentary, headers, or " +
    "summary text outside of what the page itself contains."
  );
}

/**
 * Parses the model's <<<PAGE n>>>-delimited response into PageText[]. Pure
 * function (no I/O) so parsing edge cases can be tested without mocking
 * fetch. Any page number from fallbackPages with no matching marker in the
 * response - or any marker whose page number isn't in fallbackPages at all -
 * falls back to that page's plain-text content, so a partially-broken
 * response never loses a page outright.
 */
export function parseEnrichedPages(responseText: string, fallbackPages: PageText[]): PageText[] {
  const fallbackPageNumbers = new Set(fallbackPages.map((p) => p.page));
  const parsed = new Map<number, string>();

  const matches = [...responseText.matchAll(PAGE_MARKER)];
  for (let i = 0; i < matches.length; i++) {
    const pageNum = Number(matches[i][1]);
    if (!fallbackPageNumbers.has(pageNum)) continue; // discard out-of-range markers
    const contentStart = matches[i].index! + matches[i][0].length;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index! : responseText.length;
    const text = responseText.slice(contentStart, contentEnd).trim();
    parsed.set(pageNum, text);
  }

  return fallbackPages.map((fallback) => ({
    page: fallback.page,
    text: parsed.get(fallback.page) ?? fallback.text,
  }));
}

/**
 * Sends the whole PDF to a PDF-capable OpenRouter model and returns
 * per-page enriched Markdown. Never throws: any failure (network error,
 * non-OK response, unparseable output) returns fallbackPages unchanged, so
 * ingestion always has text to chunk even when enrichment doesn't work.
 */
export async function enrichPdfToMarkdown(
  pdfBytes: ArrayBuffer,
  fallbackPages: PageText[],
  env: Env,
  config: { ingestionModelSlug: string }
): Promise<PageText[]> {
  try {
    const base64Pdf = base64FromArrayBuffer(pdfBytes);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.ingestionModelSlug,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt() },
              { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${base64Pdf}` } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`ingestion enrichment failed (${response.status}), falling back to plain text`);
      return fallbackPages;
    }

    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      console.error("ingestion enrichment returned no content, falling back to plain text");
      return fallbackPages;
    }

    return parseEnrichedPages(content, fallbackPages);
  } catch (err) {
    console.error("ingestion enrichment call failed, falling back to plain text", err);
    return fallbackPages;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/ingestionEnrichment.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingestionEnrichment.ts worker/test/ingestionEnrichment.test.ts
git commit -m "Add enrichPdfToMarkdown: whole-PDF vision extraction via OpenRouter"
```

---

### Task 3: Wire enrichment into `handleIngest`

**Files:**
- Modify: `worker/src/ingestion.ts`
- Test: `worker/test/ingestion.test.ts`

**Interfaces:**
- Consumes: `enrichPdfToMarkdown` (from Task 2), `getRuntimeConfig` (from `./config`, already used by `chat.ts` the same way).

- [ ] **Step 1: Write the failing tests**

In `worker/test/ingestion.test.ts`, add a mock for the new module right after the existing `vi.mock("../src/pdf", ...)` block, and a D1 config-row helper mirroring the one in `chat.test.ts`:

```ts
vi.mock("../src/ingestionEnrichment", () => ({
  enrichPdfToMarkdown: vi.fn(async (_pdfBytes: ArrayBuffer, fallbackPages: unknown) => fallbackPages),
}));
```

Add the import at the top: `import { enrichPdfToMarkdown } from "../src/ingestionEnrichment";`

Add a D1 mock helper and extend `makeEnv` to accept config rows (keep the default `makeEnv()` behavior identical to today by defaulting `ingestionEnrichmentEnabled` to `"true"` via `DEFAULT_CONFIG`, matching production - no `EDU_LIVE_DB` override needed for existing tests since `getRuntimeConfig` already falls back to `DEFAULT_CONFIG` when `EDU_LIVE_DB` is absent):

```ts
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
```

Add a new describe block at the bottom of the file:

```ts
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
```

Note: the last test re-mocks `../src/pdf` with `vi.doMock` + a fresh dynamic `import()` because the file-level `vi.mock("../src/pdf", ...)` at the top of this file is hoisted and shared by every other test in the suite - overriding it per-test requires `vi.doMock` (not hoisted, applies to the next `import()` only) rather than changing the shared mock.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/ingestion.test.ts`
Expected: FAIL — `handleIngest` doesn't call `enrichPdfToMarkdown` at all yet, so both new tests fail (`toHaveBeenCalledTimes(1)` sees 0; the "not called" test would trivially pass, but confirm via the first test failing).

- [ ] **Step 3: Implement**

In `worker/src/ingestion.ts`, add imports and call the new module between extraction and chunking:

```ts
import type { Env } from "./index";
import { extractPdfPages } from "./pdf";
import { chunkText } from "./chunker";
import { chunkVectorId } from "./vectorId";
import { enrichPdfToMarkdown } from "./ingestionEnrichment";
import { getRuntimeConfig } from "./config";
```

Replace the section from `let pages;` through the "No extractable text" check with:

```ts
  let pages;
  try {
    pages = await extractPdfPages(pdfBytes);
  } catch (err) {
    console.error("PDF extraction failed", err);
    return Response.json({ error: "Could not parse this file as a PDF" }, { status: 400 });
  }
  if (pages.every((p) => p.text.trim() === "")) {
    return Response.json({ error: "No extractable text found in PDF" }, { status: 400 });
  }

  const config = await getRuntimeConfig(env);
  if (config.ingestionEnrichmentEnabled) {
    pages = await enrichPdfToMarkdown(pdfBytes, pages, env, config);
  }

  const chunks = chunkText(pages, file.name);
```

(The empty-PDF check runs on the raw `unpdf` output *before* enrichment is attempted, per the Review Focus item above - no OpenRouter call is spent on a PDF that was always going to be rejected.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/ingestion.test.ts`
Expected: PASS, all tests in the file (including the pre-existing ones - the mocked `enrichPdfToMarkdown` passes `fallbackPages` straight through, so today's assertions on chunk/metadata content are unaffected).

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingestion.ts worker/test/ingestion.test.ts
git commit -m "Wire PDF enrichment into handleIngest behind ingestionEnrichmentEnabled"
```

---

### Task 4: Admin dashboard controls

**Files:**
- Modify: `frontend/dashboard.js`

**Interfaces:**
- Consumes: `GET /admin/config` / `PUT /admin/config` (already exist, already return/accept the new `RuntimeConfig` fields as of Task 1 - no backend route changes needed).

- [ ] **Step 1: Add the card's HTML**

In `frontend/dashboard.js`, inside `loadSettingsTab()`, after the closing `</div>` of the "LLM provider" card (added in the previous branch) and before the final closing backtick, add:

```js
      <div class="card">
        <h2>Ingestion enrichment</h2>
        <p class="txn-meta">Extracts formulas, tables, and figures from uploaded PDFs via a vision-capable model before chunking. Applies to documents uploaded after this is enabled - existing documents need re-upload to benefit.</p>
        <form id="ingestion-form" class="settings-form">
          <label class="checkbox-row"><input type="checkbox" name="ingestionEnrichmentEnabled" ${config.ingestionEnrichmentEnabled ? "checked" : ""} /> Enrichment enabled</label>
          <label>Model (slug)
            <input type="text" name="ingestionModelSlug" value="${escapeHtml(config.ingestionModelSlug)}" placeholder="google/gemini-2.5-flash" />
          </label>
          <button type="submit">Save</button>
        </form>
        <p id="ingestion-status" class="txn-meta"></p>
      </div>`;
```

(This replaces whatever the previous last line of the template literal was - check the current file for the exact closing backtick location before editing, since the LLM provider card from the prior branch may have changed it.)

- [ ] **Step 2: Add the submit handler**

Immediately after the existing `llm-form` submit handler's closing `});`, add:

```js
    document.getElementById("ingestion-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const status = document.getElementById("ingestion-status");
      const update = {
        ingestionEnrichmentEnabled: form.ingestionEnrichmentEnabled.checked,
        ingestionModelSlug: form.ingestionModelSlug.value.trim(),
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
        status.textContent = "Saved - applies to documents uploaded from now on.";
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });
```

- [ ] **Step 3: Manual verification**

No automated frontend test suite exists in this repo (vanilla JS, no test runner configured for `frontend/`) - same as the LLM provider card added previously. Verify by running `npx wrangler dev` in `frontend/` locally, opening the dashboard's Settings tab, and confirming the new card renders with the current config values and saves successfully.

- [ ] **Step 4: Commit**

```bash
git add frontend/dashboard.js
git commit -m "Add ingestion enrichment controls to admin Settings tab"
```

---

### Task 5b: Add Browser Rendering binding and `capturePageScreenshot`

**Files:**
- Modify: `worker/wrangler.toml`
- Modify: `worker/package.json`
- Create: `worker/src/pageScreenshot.ts`
- Test: `worker/test/pageScreenshot.test.ts`

**Interfaces:**
- Consumes: `Env.BROWSER` (new binding, type `Fetcher`).
- Produces: `capturePageScreenshot(pdfBytes: ArrayBuffer, pageNumber: number, env: Env): Promise<ArrayBuffer | null>` — `null` (never throws) on any failure.

- [ ] **Step 1: Add the binding and dependency**

In `worker/wrangler.toml`, append:

```toml
[browser]
binding = "BROWSER"
```

In `worker/src/index.ts`, add to the `Env` interface (after `ADMIN_API_KEY: string;`):

```ts
  // Cloudflare Browser Rendering - used to screenshot PDF pages containing
  // figures, so the actual image (not just a text description) can be
  // shown back to students. See worker/src/pageScreenshot.ts.
  BROWSER: Fetcher;
```

Run: `cd worker && npm install @cloudflare/puppeteer`
Expected: adds the package to `worker/package.json` dependencies and `package-lock.json`.

- [ ] **Step 2: Write the failing tests**

Create `worker/test/pageScreenshot.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const mockPage = {
  goto: vi.fn(async () => {}),
  screenshot: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  close: vi.fn(async () => {}),
};
const mockBrowser = {
  newPage: vi.fn(async () => mockPage),
  close: vi.fn(async () => {}),
};

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: vi.fn(async () => mockBrowser) },
}));

import puppeteer from "@cloudflare/puppeteer";
import { capturePageScreenshot } from "../src/pageScreenshot";
import type { Env } from "../src/index";

function makeEnv(): Env {
  return { BROWSER: {} } as unknown as Env;
}

describe("capturePageScreenshot", () => {
  it("launches the browser, navigates to the PDF page, and returns the screenshot bytes", async () => {
    mockPage.goto.mockClear();
    mockPage.screenshot.mockClear();
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    const result = await capturePageScreenshot(pdfBytes, 3, makeEnv());

    expect(result).not.toBeNull();
    expect(new Uint8Array(result as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(mockPage.goto).toHaveBeenCalledTimes(1);
    const [url] = mockPage.goto.mock.calls[0];
    expect(url).toContain("data:application/pdf;base64,");
    expect(url).toContain("#page=3");
  });

  it("returns null (never throws) when the browser launch fails", async () => {
    vi.mocked(puppeteer.launch).mockRejectedValueOnce(new Error("no browser sessions available"));
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    const result = await capturePageScreenshot(pdfBytes, 1, makeEnv());

    expect(result).toBeNull();
  });

  it("returns null (never throws) when navigation or screenshot fails", async () => {
    mockPage.goto.mockRejectedValueOnce(new Error("navigation timeout"));
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake").buffer;

    const result = await capturePageScreenshot(pdfBytes, 1, makeEnv());

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/pageScreenshot.test.ts`
Expected: FAIL — module `../src/pageScreenshot` doesn't exist yet.

- [ ] **Step 4: Implement**

Create `worker/src/pageScreenshot.ts`:

```ts
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Screenshots one page of a PDF using Cloudflare Browser Rendering -
 * Chromium's built-in PDF viewer renders the page (including any embedded
 * image, even one nested inside a table cell) exactly as laid out, so we
 * never have to solve PDF rasterization ourselves. Never throws: any
 * failure (no browser session available, navigation timeout, screenshot
 * error) returns null, since a failed screenshot must not block ingestion -
 * the page's Markdown-enriched text (with its [Figure: ...] description) is
 * still indexed either way.
 */
export async function capturePageScreenshot(
  pdfBytes: ArrayBuffer,
  pageNumber: number,
  env: Env
): Promise<ArrayBuffer | null> {
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    const dataUrl = `data:application/pdf;base64,${base64FromArrayBuffer(pdfBytes)}#page=${pageNumber}`;
    await page.goto(dataUrl);
    const screenshot = await page.screenshot();
    return screenshot as ArrayBuffer;
  } catch (err) {
    console.error(`page screenshot failed for page ${pageNumber}`, err);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/pageScreenshot.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

```bash
git add worker/wrangler.toml worker/package.json worker/package-lock.json worker/src/index.ts worker/src/pageScreenshot.ts worker/test/pageScreenshot.test.ts
git commit -m "Add capturePageScreenshot via Cloudflare Browser Rendering"
```

---

### Task 6b: `GET /images/:key` route

**Files:**
- Create: `worker/src/images.ts`
- Test: `worker/test/images.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Produces: `handleGetImage(key: string, env: Env): Promise<Response>` — 200 with the PNG bytes and `Content-Type: image/png` on success, 404 if the key doesn't exist in `PDF_BUCKET`.

- [ ] **Step 1: Write the failing tests**

Create `worker/test/images.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { handleGetImage } from "../src/images";
import type { Env } from "../src/index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PDF_BUCKET: {
      get: async () => null,
    },
    ...overrides,
  } as unknown as Env;
}

describe("handleGetImage", () => {
  it("returns the PNG bytes with an image/png content type when the key exists", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]).buffer;
    const env = makeEnv({
      PDF_BUCKET: {
        get: async (key: string) => {
          expect(key).toBe("page-images/notes.pdf/3.png");
          return { arrayBuffer: async () => pngBytes } as unknown as R2ObjectBody;
        },
      } as unknown as R2Bucket,
    });

    const response = await handleGetImage("page-images/notes.pdf/3.png", env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(pngBytes));
  });

  it("returns 404 when the key doesn't exist", async () => {
    const env = makeEnv({ PDF_BUCKET: { get: async () => null } as unknown as R2Bucket });
    const response = await handleGetImage("page-images/missing.pdf/1.png", env);
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/images.test.ts`
Expected: FAIL — module `../src/images` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `worker/src/images.ts`:

```ts
import type { Env } from "./index";

export async function handleGetImage(key: string, env: Env): Promise<Response> {
  const object = await env.PDF_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(await object.arrayBuffer(), {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" },
  });
}
```

In `worker/src/index.ts`, add the import:

```ts
import { handleGetImage } from "./images";
```

Add the route (after the `/chat` route, before the `/admin/*` routes):

```ts
    if (request.method === "GET" && url.pathname.startsWith("/images/")) {
      const key = decodeURIComponent(url.pathname.slice("/images/".length));
      return withCors(await handleGetImage(key, env));
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/images.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add worker/src/images.ts worker/test/images.test.ts worker/src/index.ts
git commit -m "Add GET /images/:key route to serve captured page screenshots"
```

---

### Task 7b: Wire screenshot capture into `handleIngest`, thread `pageImageKey` through Vectorize metadata

**Files:**
- Modify: `worker/src/ingestion.ts`
- Test: `worker/test/ingestion.test.ts`

**Interfaces:**
- Consumes: `capturePageScreenshot` (Task 5b).
- Produces: Vectorize chunk metadata gains an optional `pageImageKey: string` field.

- [ ] **Step 1: Write the failing tests**

Add to `worker/test/ingestion.test.ts`, alongside the other `vi.mock` calls at the top:

```ts
vi.mock("../src/pageScreenshot", () => ({
  capturePageScreenshot: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
}));
```

Add the import: `import { capturePageScreenshot } from "../src/pageScreenshot";`

Add a new describe block:

```ts
describe("handleIngest page screenshot capture", () => {
  it("captures a screenshot for any page whose enriched text contains a [Figure: marker, and stores it in R2", async () => {
    vi.mocked(capturePageScreenshot).mockClear();
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

    expect(capturePageScreenshot).toHaveBeenCalledTimes(1);
    const [, pageArg] = vi.mocked(capturePageScreenshot).mock.calls[0];
    expect(pageArg).toBe(2);

    // second put call is the page-image write (first is the source PDF write)
    const imagePut = putCalls.find(([key]) => String(key).startsWith("page-images/"));
    expect(imagePut).toBeDefined();
  });

  it("does not capture any screenshot when no page contains a [Figure: marker", async () => {
    vi.mocked(capturePageScreenshot).mockClear();
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

    expect(capturePageScreenshot).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/ingestion.test.ts`
Expected: FAIL — `handleIngest` doesn't call `capturePageScreenshot` at all yet.

- [ ] **Step 3: Implement**

In `worker/src/ingestion.ts`, add the import:

```ts
import { capturePageScreenshot } from "./pageScreenshot";
```

After the enrichment block and before `const chunks = chunkText(pages, file.name);`, add:

```ts
  const pageImageKeys = new Map<number, string>();
  const figurePages = pages.filter((p) => p.text.includes("[Figure:")).map((p) => p.page);
  for (const pageNumber of figurePages) {
    const screenshot = await capturePageScreenshot(pdfBytes, pageNumber, env);
    if (!screenshot) continue;
    const key = `page-images/${file.name}/${pageNumber}.png`;
    await env.PDF_BUCKET.put(key, screenshot, { httpMetadata: { contentType: "image/png" } });
    pageImageKeys.set(pageNumber, key);
  }
```

(Sequential, not `Promise.all` - deliberate, per the spec's note that Browser Rendering caps concurrent sessions more tightly than plain `fetch`.)

In the Vectorize `upsert` call, add `pageImageKey` to each chunk's metadata - find any page in `[chunk.page, chunk.pageEnd]` that has a captured image:

```ts
    await env.VECTORIZE.upsert(
      chunks.map((chunk, i) => {
        let pageImageKey: string | undefined;
        for (let p = chunk.page; p <= chunk.pageEnd; p++) {
          if (pageImageKeys.has(p)) {
            pageImageKey = pageImageKeys.get(p);
            break;
          }
        }
        return {
          id: chunkVectorId(chunk.source, chunk.chunkId),
          values: vectors[i],
          metadata: {
            text: chunk.text,
            source: chunk.source,
            page: chunk.page,
            pageEnd: chunk.pageEnd,
            chunkId: chunk.chunkId,
            ...(pageImageKey ? { pageImageKey } : {}),
          },
        };
      })
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/ingestion.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingestion.ts worker/test/ingestion.test.ts
git commit -m "Capture and store page screenshots for figure pages during ingestion"
```

---

### Task 8b: Thread `pageImageKey` through `/chat`'s `docSources`

**Files:**
- Modify: `worker/src/rerank.ts`
- Modify: `worker/src/chat.ts`
- Test: `worker/test/chat.test.ts`

**Interfaces:**
- Modifies: `RetrievedChunk` gains `pageImageKey: string | null`.
- Modifies: `/chat`'s JSON response - each `docSources[i]` gains `pageImageKey: string | null`.

- [ ] **Step 1: Write the failing test**

Add to `worker/test/chat.test.ts`, a new describe block:

```ts
describe("handleChat pageImageKey passthrough", () => {
  it("includes pageImageKey in docSources when the matched chunk's metadata has one", async () => {
    const env = makeEnv({
      VECTORIZE: {
        query: async () => ({
          matches: [
            {
              score: 0.9,
              metadata: {
                text: "a passage with a diagram",
                page: 2,
                pageEnd: 2,
                source: "notes.pdf",
                chunkId: 0,
                pageImageKey: "page-images/notes.pdf/2.png",
              },
            },
          ],
        }),
      },
    });

    const response = await handleChat(makeChatRequest("what does the diagram show"), env, noopCtx());
    const body = (await response.json()) as { docSources: { pageImageKey: string | null }[] };

    expect(body.docSources[0].pageImageKey).toBe("page-images/notes.pdf/2.png");
  });

  it("sets pageImageKey to null when the matched chunk's metadata has none", async () => {
    const env = makeEnv({
      VECTORIZE: {
        query: async () => ({
          matches: [
            { score: 0.9, metadata: { text: "plain passage", page: 1, pageEnd: 1, source: "notes.pdf", chunkId: 0 } },
          ],
        }),
      },
    });

    const response = await handleChat(makeChatRequest("a plain question"), env, noopCtx());
    const body = (await response.json()) as { docSources: { pageImageKey: string | null }[] };

    expect(body.docSources[0].pageImageKey).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/chat.test.ts`
Expected: FAIL — `docSources[i].pageImageKey` is `undefined`, not present/`null`.

- [ ] **Step 3: Implement**

In `worker/src/rerank.ts`, add to `RetrievedChunk`:

```ts
export interface RetrievedChunk {
  text: string;
  page: number;
  pageEnd: number;
  source: string;
  chunkId: number;
  cosineScore: number;
  pageImageKey: string | null;
}
```

In `worker/src/chat.ts`, in the `matches.map` that builds `retrieved`, add:

```ts
    const retrieved: RetrievedChunk[] = matches.matches.map((m) => ({
      text: String(m.metadata?.text ?? ""),
      page: Number(m.metadata?.page ?? 0),
      pageEnd: Number(m.metadata?.pageEnd ?? 0),
      source: String(m.metadata?.source ?? ""),
      chunkId: Number(m.metadata?.chunkId ?? 0),
      cosineScore: m.score,
      pageImageKey: m.metadata?.pageImageKey ? String(m.metadata.pageImageKey) : null,
    }));
```

In the final `Response.json` call, add `pageImageKey` to the `docSources` mapping:

```ts
      docSources: docSources.map((c) => ({
        source: c.source,
        page: c.page,
        pageEnd: c.pageEnd,
        text: c.text,
        pageImageKey: c.pageImageKey,
      })),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npx vitest run test/chat.test.ts`
Expected: PASS, all tests in the file. (Pre-existing tests construct `metadata` objects without `pageImageKey` - the `m.metadata?.pageImageKey ? ... : null` fallback means they still pass unchanged.)

- [ ] **Step 5: Commit**

```bash
git add worker/src/rerank.ts worker/src/chat.ts worker/test/chat.test.ts
git commit -m "Thread pageImageKey from Vectorize metadata through to /chat docSources"
```

---

### Task 9b: Render the captured image in the chat UI

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Implement**

In `frontend/app.js`, change the fetch handler to render images alongside the answer text. Replace:

```js
    thinkingEl.classList.remove("thinking");
    thinkingEl.textContent = result.answer ?? `Error: ${result.error}`;
```

with:

```js
    thinkingEl.classList.remove("thinking");
    thinkingEl.textContent = result.answer ?? `Error: ${result.error}`;

    const imageKeys = (result.docSources ?? [])
      .map((s) => s.pageImageKey)
      .filter((key, index, all) => key && all.indexOf(key) === index); // dedupe, drop nulls

    for (const key of imageKeys) {
      const img = document.createElement("img");
      img.src = `${WORKER_URL}/images/${encodeURIComponent(key)}`;
      img.className = "answer-source-image";
      img.alt = "Source page image";
      thinkingEl.appendChild(document.createElement("br"));
      thinkingEl.appendChild(img);
    }
```

- [ ] **Step 2: Add minimal styling**

In `frontend/style.css`, add:

```css
.answer-source-image {
  max-width: 100%;
  margin-top: 8px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #ccc);
}
```

(Check the existing `style.css` for the actual CSS variable name used for border color in this codebase before adding - use whatever the file's existing convention is rather than inventing a new one.)

- [ ] **Step 3: Manual verification**

No frontend test runner exists in this repo. Verify by running `npx wrangler dev` in `frontend/`, asking a question whose answer cites a page with a captured figure, and confirming the image renders below the answer text.

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js frontend/style.css
git commit -m "Render captured page images alongside chat answers"
```

---

### Task 10: Full suite verification and spec status update

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-pdf-content-enrichment-design.md`

- [ ] **Step 1: Run the full worker test suite**

Run: `cd worker && npx vitest run`
Expected: PASS, all test files (should include all previously-passing tests plus the new `ingestionEnrichment.test.ts` and the new cases in `config.test.ts`/`ingestion.test.ts`).

- [ ] **Step 2: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: Only the pre-existing `test/chat.test.ts` mock-type errors that predate this branch (confirmed in the prior OpenRouter LLM layer branch to already exist on `main`) - no NEW errors introduced by this plan's changes. If new errors appear in `ingestionEnrichment.ts`, `ingestion.ts`, or `config.ts`, fix them before proceeding.

- [ ] **Step 3: Update the spec's status line**

In `docs/superpowers/specs/2026-10-01-pdf-content-enrichment-design.md`, change:

```
**Status:** Draft — awaiting user review
```

to:

```
**Status:** Implemented on branch `feature/pdf-content-enrichment`
```

Also add a short note under "Chosen approach" documenting the one scope simplification made during implementation (no page-range batching in v1 - the whole PDF is sent in a single call; batching is a fast-follow if a document's page count causes output-length issues in practice):

```
**Implementation note:** v1 sends the whole PDF in a single OpenRouter call
(no page-range batching) and fails open for the whole document if that call
fails, rather than per-batch. This is a deliberate scope reduction - batching
adds complexity (splitting PDF byte ranges isn't possible without a PDF-writing
library) for a problem (model output-length limits) not yet confirmed to
occur on this app's real documents. Revisit if a real textbook PDF hits
output-length limits in the deployed app.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-pdf-content-enrichment-design.md
git commit -m "Mark PDF content enrichment spec as implemented"
```

- [ ] **Step 5: Push the branch**

```bash
git push origin feature/pdf-content-enrichment
```
