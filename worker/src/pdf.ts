import { extractText, getDocumentProxy } from "unpdf";
import type { PageText } from "./types";

/**
 * Extracts per-page text from a PDF's raw bytes using unpdf (PDF.js-based,
 * runs natively in the Workers JS runtime - no Pyodide/Python involved).
 *
 * PDF.js transfers (not copies) the Uint8Array it's given to an internal
 * worker port, which detaches the underlying ArrayBuffer - any later read of
 * pdfBytes (or a view over it) throws "Cannot perform Construct on a
 * detached ArrayBuffer". Callers that need pdfBytes again afterward (e.g.
 * handleIngest, which also sends it to enrichment/screenshot capture and
 * writes it to R2) would silently get a detached buffer. Passing a copy
 * here means PDF.js detaches the copy, not the caller's original.
 */
export async function extractPdfPages(pdfBytes: ArrayBuffer): Promise<PageText[]> {
  const doc = await getDocumentProxy(new Uint8Array(pdfBytes.slice(0)));
  const { totalPages, text } = await extractText(doc, { mergePages: false });

  const pages: PageText[] = [];
  const pageTexts = Array.isArray(text) ? text : [text];
  for (let i = 0; i < totalPages; i++) {
    pages.push({ page: i + 1, text: pageTexts[i] ?? "" });
  }
  return pages;
}
