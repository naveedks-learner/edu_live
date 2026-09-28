import type { Env } from "./index";
import { extractPdfPages } from "./pdf";
import { chunkText } from "./chunker";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export async function handleIngest(request: Request, env: Env): Promise<Response> {
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
  await env.PDF_BUCKET.put(file.name, pdfBytes);

  const pages = await extractPdfPages(pdfBytes);
  if (pages.every((p) => p.text.trim() === "")) {
    return Response.json({ error: "No extractable text found in PDF" }, { status: 400 });
  }

  const chunks = chunkText(pages, file.name);

  const embedResponse = await env.AI.run(EMBEDDING_MODEL, {
    text: chunks.map((c) => c.text),
  });
  const vectors = (embedResponse as { data: number[][] }).data;

  await env.VECTORIZE.upsert(
    chunks.map((chunk, i) => ({
      id: `${chunk.source}::${chunk.chunkId}`,
      values: vectors[i],
      metadata: {
        text: chunk.text,
        source: chunk.source,
        page: chunk.page,
        pageEnd: chunk.pageEnd,
        chunkId: chunk.chunkId,
      },
    }))
  );

  return Response.json({ status: "indexed", source: file.name, chunkCount: chunks.length });
}
