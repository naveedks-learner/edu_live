import type { Env } from "./index";
import { checkQueryInScopeAndAgeAppropriate } from "./guardrailCheck";
import { rerank, workersAiScoreFn, type RetrievedChunk } from "./rerank";
import { scoreChunksWithJev, filterJevScored, JEV_MODEL_ID, type JevScoredChunk } from "./jev";
import { webSearch, formatWebResultsAsContext } from "./webSearch";
import { buildTransactionTrace, type TransactionTrace } from "./transactionTrace";
import { getRuntimeConfig } from "./config";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
// @cf/meta/llama-3.1-8b-instruct was deprecated by Cloudflare (2026-05-30);
// -fp8 is the closest available replacement (same 8B model, fp8-quantized)
// per `wrangler ai models` against the live catalog.
const GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const HARD_FAIL_MESSAGE =
  "I don't have enough information in the indexed documents (or the web) to answer that question.";

const SYSTEM_PROMPT = `You are a helpful research assistant and teacher for 16-17 year old students.

Audience and scope:
- Only help with science and maths topics. If a question is outside that scope, politely decline.
- Keep language and content age-appropriate.

Policy:
- Answer only from the context provided below (documents and/or web results).
- If the context doesn't answer the question, say so clearly instead of guessing.
- Name the source document (with page number) or web page you used.
- Keep answers concise unless the question needs detail.`;

async function recordTransaction(env: Env, trace: TransactionTrace): Promise<void> {
  try {
    await env.EDU_LIVE_DB.prepare(
      `INSERT INTO transactions
        (timestamp, question, provider, model, path_taken, confidence, retrieval_json,
         llm_input, llm_output, jev_input_json, jev_output_json, input_tokens, output_tokens,
         jev_cost_usd, llm_cost_usd, jev_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        trace.timestamp,
        trace.question,
        trace.provider,
        trace.model,
        trace.pathTaken,
        trace.confidence,
        JSON.stringify(trace.retrieval),
        trace.llmInput,
        trace.llmOutput,
        trace.jevInput ? JSON.stringify(trace.jevInput) : null,
        trace.jevOutput ? JSON.stringify(trace.jevOutput) : null,
        trace.inputTokens,
        trace.outputTokens,
        trace.jevCostUsd,
        trace.llmCostUsd,
        trace.jevModel
      )
      .run();
  } catch (err) {
    console.error("failed to record transaction trace", err);
  }
}

export async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();

  if (!question) {
    return Response.json({ error: "Expected JSON body with a 'question' field" }, { status: 400 });
  }

  const config = await getRuntimeConfig(env);

  if (config.guardrailEnabled) {
    const decision = await checkQueryInScopeAndAgeAppropriate(question, env.AI);
    if (!decision.allowed) {
      const status = decision.reason === "guardrail_error" ? 503 : 200;
      return Response.json(
        { answer: decision.refusalMessage, reason: decision.reason, docSources: [], webSources: [] },
        { status }
      );
    }
  }

  try {
    const embedResponse = await env.AI.run(EMBEDDING_MODEL, { text: [question] });
    const questionVector = (embedResponse as { data: number[][] }).data[0];

    const matches = await env.VECTORIZE.query(questionVector, { topK: config.topK, returnMetadata: true });
    const retrieved: RetrievedChunk[] = matches.matches.map((m) => ({
      text: String(m.metadata?.text ?? ""),
      page: Number(m.metadata?.page ?? 0),
      pageEnd: Number(m.metadata?.pageEnd ?? 0),
      source: String(m.metadata?.source ?? ""),
      chunkId: Number(m.metadata?.chunkId ?? 0),
      cosineScore: m.score,
    }));

    const reranked = await rerank(question, retrieved, workersAiScoreFn(env.AI));

    const jevEnabled = config.jevEnabled;
    const jevResult = jevEnabled
      ? await scoreChunksWithJev(question, reranked, env.OPENROUTER_API_KEY)
      : {
          chunks: reranked.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }) as JevScoredChunk),
          costUsd: 0,
          success: true,
        };

    // Only filter by relevance when JEV actually ran and produced real
    // scores. If JEV failed, jevResult.chunks all carry jevRelevance=null -
    // filtering on that would discard every chunk, which is worse than not
    // running JEV at all.
    const jevDocSources = jevEnabled && jevResult.success ? filterJevScored(jevResult.chunks) : jevResult.chunks;

    // Confidence gate: even a JEV-kept chunk can be too weak a match to
    // trust. The reranker's score scale is not guaranteed to be
    // non-negative (it may return raw cross-encoder logits), so a
    // threshold of 0 (the default) skips the gate entirely rather than
    // comparing with >= - that guarantees the default never changes
    // existing behavior regardless of the underlying score range.
    const topConfidence = jevDocSources[0] ? jevDocSources[0].rerankScore ?? jevDocSources[0].cosineScore : null;
    const passesConfidenceGate =
      config.confidenceThreshold <= 0 || topConfidence === null || topConfidence >= config.confidenceThreshold;
    const docSources = passesConfidenceGate ? jevDocSources : [];
    // keptKeys drives the dashboard's kept/discarded status per chunk - it
    // must reflect what actually survived ALL gates (JEV + confidence), or
    // a chunk the confidence gate just dropped would still show as "kept".
    const keptKeys = new Set(docSources.map((c) => `${c.source}::${c.chunkId}`));

    let webSources: Awaited<ReturnType<typeof webSearch>> = [];
    if (docSources.length === 0 && config.webSearchMode !== "rag_only") {
      webSources = await webSearch(question);
    }

    const documentContext = docSources.map((c) => `[${c.source} p.${c.page}]\n${c.text}`).join("\n\n");
    const webContext = webSources.length > 0 ? formatWebResultsAsContext(webSources) : "";
    const context = [documentContext, webContext].filter(Boolean).join("\n\n---\n\n") || "No context found.";
    const llmInput = `Question: ${question}\n\nContext:\n${context}`;

    const jevModel = jevEnabled ? JEV_MODEL_ID : null;

    let answer: string;
    if (config.hardFailNoDocument && docSources.length === 0 && webSources.length === 0) {
      answer = HARD_FAIL_MESSAGE;
    } else {
      const generateResponse = await env.AI.run(GENERATION_MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: llmInput },
        ],
      });
      answer = (generateResponse as { response: string }).response;
    }

    const trace = buildTransactionTrace({
      question,
      provider: "workers-ai",
      model: GENERATION_MODEL,
      pathTaken: webSources.length > 0 ? "web_fallback" : "pdf_only",
      jevAnnotated: jevResult.chunks,
      keptKeys,
      llmInput,
      llmOutput: answer,
      jevEnabled,
      jevModel,
      jevCostUsd: jevResult.costUsd,
    });
    ctx.waitUntil(recordTransaction(env, trace));

    return Response.json({
      answer,
      docSources: docSources.map((c) => ({ source: c.source, page: c.page, pageEnd: c.pageEnd, text: c.text })),
      webSources,
    });
  } catch (err) {
    console.error("chat pipeline failed", err);
    return Response.json(
      { error: "Something went wrong answering this question - please try again." },
      { status: 502 }
    );
  }
}
