import { extractText, getDocumentProxy } from "unpdf";
import type { PageText } from "./types";

/**
 * Extracts per-page text from a PDF's raw bytes using unpdf (PDF.js-based,
 * runs natively in the Workers JS runtime - no Pyodide/Python involved).
 */
export async function extractPdfPages(pdfBytes: ArrayBuffer): Promise<PageText[]> {
  const doc = await getDocumentProxy(new Uint8Array(pdfBytes));
  const { totalPages, text } = await extractText(doc, { mergePages: false });

  const pages: PageText[] = [];
  const pageTexts = Array.isArray(text) ? text : [text];
  for (let i = 0; i < totalPages; i++) {
    pages.push({ page: i + 1, text: pageTexts[i] ?? "" });
  }
  return pages;
}
