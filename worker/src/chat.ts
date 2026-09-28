import type { Env } from "./index";
import { checkQueryInScopeAndAgeAppropriate } from "./guardrailCheck";
import { rerank, workersAiScoreFn, type RetrievedChunk } from "./rerank";
import { callJev } from "./jev";
import { webSearch, formatWebResultsAsContext } from "./webSearch";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
// @cf/meta/llama-3.1-8b-instruct was deprecated by Cloudflare (2026-05-30);
// -fp8 is the closest available replacement (same 8B model, fp8-quantized)
// per `wrangler ai models` against the live catalog.
const GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const TOP_K = 5;

const SYSTEM_PROMPT = `You are a helpful research assistant and teacher for 16-17 year old students.

Audience and scope:
- Only help with science and maths topics. If a question is outside that scope, politely decline.
- Keep language and content age-appropriate.

Policy:
- Answer only from the context provided below (documents and/or web results).
- If the context doesn't answer the question, say so clearly instead of guessing.
- Name the source document (with page number) or web page you used.
- Keep answers concise unless the question needs detail.`;

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();

  if (!question) {
    return Response.json({ error: "Expected JSON body with a 'question' field" }, { status: 400 });
  }

  if (env.GUARDRAIL_ENABLED === "true") {
    const decision = await checkQueryInScopeAndAgeAppropriate(question, env.AI);
    if (!decision.allowed) {
      const status = decision.reason === "guardrail_error" ? 503 : 200;
      return Response.json(
        { answer: decision.refusalMessage, reason: decision.reason, docSources: [], webSources: [] },
        { status }
      );
    }
  }

  const embedResponse = await env.AI.run(EMBEDDING_MODEL, { text: [question] });
  const questionVector = (embedResponse as { data: number[][] }).data[0];

  const matches = await env.VECTORIZE.query(questionVector, { topK: TOP_K, returnMetadata: true });
  const retrieved: RetrievedChunk[] = matches.matches.map((m) => ({
    text: String(m.metadata?.text ?? ""),
    page: Number(m.metadata?.page ?? 0),
    pageEnd: Number(m.metadata?.pageEnd ?? 0),
    source: String(m.metadata?.source ?? ""),
    chunkId: Number(m.metadata?.chunkId ?? 0),
    cosineScore: m.score,
  }));

  const reranked = await rerank(question, retrieved, workersAiScoreFn(env.AI));

  const jevFiltered =
    env.JEV_ENABLED === "true"
      ? await callJev(question, reranked, env.OPENROUTER_API_KEY)
      : reranked.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }));

  let docSources = jevFiltered;
  let webSources: Awaited<ReturnType<typeof webSearch>> = [];

  if (docSources.length === 0) {
    webSources = await webSearch(question);
  }

  const documentContext = docSources.map((c) => `[${c.source} p.${c.page}]\n${c.text}`).join("\n\n");
  const webContext = webSources.length > 0 ? formatWebResultsAsContext(webSources) : "";
  const context = [documentContext, webContext].filter(Boolean).join("\n\n---\n\n") || "No context found.";

  const generateResponse = await env.AI.run(GENERATION_MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Question: ${question}\n\nContext:\n${context}` },
    ],
  });
  const answer = (generateResponse as { response: string }).response;

  return Response.json({
    answer,
    docSources: docSources.map((c) => ({ source: c.source, page: c.page, pageEnd: c.pageEnd, text: c.text })),
    webSources,
  });
}
