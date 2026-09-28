import type { PageText, Chunk } from "./types";

/**
 * Splits extracted page text into overlapping word-count chunks. Direct
 * port of chunker.py's chunk_text: chunking flows across the whole
 * document (not restarted per page) so page boundaries don't produce
 * weak, small chunks.
 */
export function chunkText(
  pages: PageText[],
  source: string,
  chunkSize = 300,
  overlap = 50
): Chunk[] {
  if (overlap >= chunkSize) {
    throw new Error("overlap must be smaller than chunkSize");
  }

  const words: string[] = [];
  const wordPages: number[] = [];
  for (const page of pages) {
    const pageWords = page.text.split(/\s+/).filter(Boolean);
    words.push(...pageWords);
    wordPages.push(...new Array(pageWords.length).fill(page.page));
  }

  if (words.length === 0) {
    return [];
  }

  const chunks: Chunk[] = [];
  let chunkId = 0;
  let start = 0;

  while (start < words.length) {
    const end = start + chunkSize;
    const chunkWords = words.slice(start, end);
    const wordEnd = Math.min(end, words.length);

    chunks.push({
      text: chunkWords.join(" "),
      page: wordPages[start],
      pageEnd: wordPages[wordEnd - 1],
      chunkId,
      source,
      wordStart: start,
      wordEnd,
      chunkSize,
      overlap,
    });
    chunkId += 1;

    if (end >= words.length) break;
    start = end - overlap;
  }

  return chunks;
}
