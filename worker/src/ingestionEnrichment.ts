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
