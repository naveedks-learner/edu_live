import type { Env } from "./index";
import { extractPdfPages } from "./pdf";
import { chunkText } from "./chunker";
import { chunkVectorId } from "./vectorId";
import { enrichPdfToMarkdown } from "./ingestionEnrichment";
import { capturePageScreenshot, launchScreenshotBrowser } from "./pageScreenshot";
import { getRuntimeConfig } from "./config";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  // Without this, anyone who finds the public Worker URL (hardcoded in the
  // public frontend bundle) could push arbitrary PDFs into the corpus
  // shown to students - the vector store has no other access control.
  // Optional: only enforced when INGEST_API_KEY is actually configured, so
  // local dev without a configured key still works.
  if (env.INGEST_API_KEY && request.headers.get("x-ingest-key") !== env.INGEST_API_KEY) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");

  if (!formData || !(file instanceof File)) {
    return Response.json({ error: "Expected multipart/form-data with a 'file' field" }, { status: 400 });
  }
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return Response.json({ error: "Only PDF files are supported" }, { status: 400 });
  }

  const existing = await env.PDF_BUCKET.head(file.name);
  if (existing) {
    return Response.json({ status: "skipped", reason: "already indexed", source: file.name });
  }

  const pdfBytes = await file.arrayBuffer();

  // Everything below is validated/prepared BEFORE anything is written to
  // R2 or Vectorize, and the R2 write happens last (only after a
  // successful Vectorize upsert). This is deliberate: writing the raw PDF
  // to R2 first (as an earlier version of this code did) meant any later
  // failure left a file in R2 with zero indexed vectors, and the dedup
  // check above would then permanently skip every retry - the filename
  // was "poisoned". Validating and writing last means a failed ingest
  // leaves nothing behind, so a retry starts clean.
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
  // enrichPdfToMarkdown returns the exact fallbackPages reference on any
  // failure (never throws, per its own contract) and a freshly-built array
  // on success - comparing references (rather than adding a second return
  // value) is enough to know whether enrichment actually took effect, for
  // the R2 customMetadata.enriched flag surfaced in /admin/documents.
  let enrichmentApplied = false;
  if (config.ingestionEnrichmentEnabled) {
    const enrichedPages = await enrichPdfToMarkdown(pdfBytes, pages, env, config);
    enrichmentApplied = enrichedPages !== pages;
    pages = enrichedPages;
  }

  const pageImageKeys = new Map<number, string>();
  const figurePages = pages.filter((p) => p.text.includes("[Figure:")).map((p) => p.page);
  if (figurePages.length > 0) {
    const browser = await launchScreenshotBrowser(env);
    if (browser) {
      try {
        for (const pageNumber of figurePages) {
          const screenshot = await capturePageScreenshot(browser, pdfBytes, pageNumber);
          if (!screenshot) continue;
          const key = `page-images/${file.name}/${pageNumber}.png`;
          await env.PDF_BUCKET.put(key, screenshot, { httpMetadata: { contentType: "image/png" } });
          pageImageKeys.set(pageNumber, key);
        }
      } finally {
        await browser.close().catch(() => {});
      }
    }
  }

  const chunks = chunkText(pages, file.name);

  try {
    const embedResponse = await env.AI.run(EMBEDDING_MODEL, {
      text: chunks.map((c) => c.text),
    });
    const vectors = (embedResponse as { data: number[][] }).data;

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

    await env.PDF_BUCKET.put(file.name, pdfBytes, {
      customMetadata: {
        chunkCount: String(chunks.length),
        pageCount: String(pages.length),
        indexedAt: new Date().toISOString(),
        enriched: String(enrichmentApplied),
      },
    });
  } catch (err) {
    console.error("Ingestion failed after validation", err);
    return Response.json({ error: "Failed to index this document - please try again" }, { status: 502 });
  }

  return Response.json({ status: "indexed", source: file.name, chunkCount: chunks.length });
}
