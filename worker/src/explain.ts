import type { Env } from "./index";
import { checkQueryInScopeAndAgeAppropriate } from "./guardrailCheck";
import { rerank, workersAiScoreFn, type RetrievedChunk } from "./rerank";
import { scoreChunksWithJev, filterJevScored, JEV_MODEL_ID, type JevScoredChunk } from "./jev";
import { buildTransactionTrace, type TransactionTrace } from "./transactionTrace";
import { getRuntimeConfig } from "./config";
import { generateChatCompletion } from "./llm";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// Generous enough for a full structured JSON response (explanation + steps +
// formula + definition + table + example) while still bounding a runaway
// generation - the system prompt's "10-15 sentences" instruction is the real
// steering, this is only the backstop, same two-layer pattern as
// ANSWER_STYLE_MAX_TOKENS in chat.ts.
const EXPLAIN_MAX_TOKENS = 700;

const RESPONSE_SCHEMA_INSTRUCTIONS = `Respond with a single fenced \`\`\`json code block and nothing else outside it, matching exactly this shape:
{
  "concept": string,
  "simpleExplanation": string,
  "steps": string[] | null,
  "formula": string | null,
  "definition": string | null,
  "table": { "headers": string[], "rows": string[][] } | null,
  "realWorldExample": string | null
}
Omit (set to null) any field that genuinely does not apply to this concept - do not pad fields with filler to fill them in.`;

function buildSystemPrompt(groundingInstruction: string): string {
  return `You are explaining a concept to a Class 10 student (age 15-16) who is struggling to understand it from their teacher's explanation.

Audience and tone:
- Simple, plain language. Avoid jargon; if a technical term is necessary, define it in the same sentence.
- Age-appropriate for a 15-16 year old studying science or maths.

Length discipline (hard ceiling, not a target):
- The TOTAL explanation across all fields combined must stay within 10-15 sentences across 2-3 paragraphs/sections.
- Shorter is fine and preferred for a simple concept - never pad to reach the ceiling.

${groundingInstruction}

${RESPONSE_SCHEMA_INSTRUCTIONS}`;
}

const RAG_FALLBACK_GROUNDED_INSTRUCTION =
  "Source policy: Base your explanation strictly on the context provided below. Stay close to its wording for facts, formulas, and definitions. Do not add outside facts not present in the context, even ones you know to be true.";

const RAG_FALLBACK_UNGROUNDED_INSTRUCTION =
  "Source policy: No course material was found for this concept. Explain it from your own general knowledge, clearly and accurately.";

const RAG_PLUS_LLM_INSTRUCTION =
  "Source policy: Context from the student's course material is provided below, if any. Treat it as the primary source of truth for facts, formulas, and definitions where it's relevant - but you may and should complete the explanation (steps, plain-language framing, a real-world example) using your own general knowledge where the context doesn't cover it. Do not contradict the provided context.";

export interface ExplainResponseBody {
  concept: string;
  simpleExplanation: string;
  steps: string[] | null;
  formula: string | null;
  definition: string | null;
  table: { headers: string[]; rows: string[][] } | null;
  realWorldExample: string | null;
  pageImageKey: string | null;
  videoSearchUrl: string;
  docSources: Array<{ source: string; page: number; pageEnd: number; text: string; pageImageKey: string | null }>;
  groundedIn: "documents" | "general_knowledge" | "both";
}

function buildVideoSearchUrl(concept: string): string {
  const query = encodeURIComponent(`${concept} explained`);
  return `https://www.youtube.com/results?search_query=${query}`;
}

interface ParsedLlmExplanation {
  concept: string;
  simpleExplanation: string;
  steps: string[] | null;
  formula: string | null;
  definition: string | null;
  table: { headers: string[]; rows: string[][] } | null;
  realWorldExample: string | null;
}

/**
 * Tolerant parser for the LLM's fenced-JSON response. Never throws - a
 * missing fence, truncated response, or valid-JSON-wrong-shape output all
 * fall back to a raw-text-only explanation rather than failing the request,
 * same "never throws" posture as parseEnrichedPages in ingestionEnrichment.ts.
 */
/**
 * Every row must itself be an array of strings - an LLM that emits a row as
 * an object (or any non-array) would otherwise pass the table through to the
 * frontend's row.forEach(cell => ...) renderer, which throws and wipes out
 * the entire rendered explanation, not just the table.
 */
function isValidTable(value: unknown): value is { headers: string[]; rows: string[][] } {
  if (!value || typeof value !== "object") return false;
  const headers = (value as { headers?: unknown }).headers;
  const rows = (value as { rows?: unknown }).rows;
  if (!Array.isArray(headers) || !headers.every((h) => typeof h === "string")) return false;
  if (!Array.isArray(rows)) return false;
  return rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"));
}

/**
 * Strips any ```json / ``` fence markers so a truncated, unlabeled, or
 * otherwise unusable LLM response never shows raw fence syntax to the
 * student - the fallback text should read as prose, not as leaked markup.
 */
function stripFenceMarkers(text: string): string {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function parseExplainLlmResponse(rawText: string, concept: string): ParsedLlmExplanation {
  const fallback = (): ParsedLlmExplanation => ({
    concept,
    simpleExplanation: stripFenceMarkers(rawText),
    steps: null,
    formula: null,
    definition: null,
    table: null,
    realWorldExample: null,
  });

  const fenceMatch = rawText.match(/```json\s*([\s\S]*?)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : rawText;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return fallback();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback();
  }

  const p = parsed as Record<string, unknown>;
  const simpleExplanation = typeof p.simpleExplanation === "string" ? p.simpleExplanation : stripFenceMarkers(rawText);
  return {
    concept: typeof p.concept === "string" ? p.concept : concept,
    simpleExplanation,
    steps: Array.isArray(p.steps) && p.steps.every((s) => typeof s === "string") ? (p.steps as string[]) : null,
    formula: typeof p.formula === "string" ? p.formula : null,
    definition: typeof p.definition === "string" ? p.definition : null,
    table: isValidTable(p.table) ? p.table : null,
    realWorldExample: typeof p.realWorldExample === "string" ? p.realWorldExample : null,
  };
}

async function recordExplainTransaction(env: Env, trace: TransactionTrace): Promise<void> {
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
    console.error("failed to record explain transaction trace", err);
  }
}

export async function handleExplain(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { concept?: unknown } | null;
  const concept = typeof body?.concept === "string" ? body.concept.trim() : undefined;

  if (!concept) {
    return Response.json({ error: "Expected JSON body with a 'concept' field" }, { status: 400 });
  }

  const config = await getRuntimeConfig(env);

  if (!config.conceptExplainerEnabled) {
    return Response.json({ error: "Concept Explainer is not available right now" }, { status: 404 });
  }

  if (config.guardrailEnabled) {
    const decision = await checkQueryInScopeAndAgeAppropriate(concept, env.AI);
    if (!decision.allowed) {
      const status = decision.reason === "guardrail_error" ? 503 : 200;
      return Response.json(
        {
          concept,
          simpleExplanation: decision.refusalMessage,
          steps: null,
          formula: null,
          definition: null,
          table: null,
          realWorldExample: null,
          pageImageKey: null,
          // No video link for a refused concept - surfacing a working
          // "watch a video about this" link for blocked/age-inappropriate
          // content would undo the point of the guardrail.
          videoSearchUrl: "",
          docSources: [],
          groundedIn: "general_knowledge",
        },
        { status }
      );
    }
  }

  try {
    const embedResponse = await env.AI.run(EMBEDDING_MODEL, { text: [concept] });
    const conceptVector = (embedResponse as { data: number[][] }).data[0];

    const matches = await env.VECTORIZE.query(conceptVector, { topK: config.topK, returnMetadata: true });
    const retrieved: RetrievedChunk[] = matches.matches.map((m) => ({
      text: String(m.metadata?.text ?? ""),
      page: Number(m.metadata?.page ?? 0),
      pageEnd: Number(m.metadata?.pageEnd ?? 0),
      source: String(m.metadata?.source ?? ""),
      chunkId: Number(m.metadata?.chunkId ?? 0),
      cosineScore: m.score,
      pageImageKey: m.metadata?.pageImageKey ? String(m.metadata.pageImageKey) : null,
    }));

    const reranked = await rerank(concept, retrieved, workersAiScoreFn(env.AI));

    const jevEnabled = config.jevEnabled;
    const jevResult = jevEnabled
      ? await scoreChunksWithJev(concept, reranked, env.OPENROUTER_API_KEY)
      : {
          chunks: reranked.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }) as JevScoredChunk),
          costUsd: 0,
          success: true,
        };

    const jevDocSources =
      jevEnabled && jevResult.success
        ? filterJevScored(jevResult.chunks, config.jevRelevanceThreshold)
        : jevResult.chunks;

    const topConfidence = jevDocSources[0] ? jevDocSources[0].rerankScore ?? jevDocSources[0].cosineScore : null;
    const passesConfidenceGate =
      config.confidenceThreshold <= 0 || topConfidence === null || topConfidence >= config.confidenceThreshold;
    const docSources = passesConfidenceGate ? jevDocSources : [];
    const keptKeys = new Set(docSources.map((c) => `${c.source}::${c.chunkId}`));

    const documentContext = docSources.map((c) => `[${c.source} p.${c.page}]\n${c.text}`).join("\n\n");
    const hasContext = docSources.length > 0;

    let groundingInstruction: string;
    let groundedIn: ExplainResponseBody["groundedIn"];
    if (config.explainRetrievalMode === "rag_fallback") {
      groundingInstruction = hasContext ? RAG_FALLBACK_GROUNDED_INSTRUCTION : RAG_FALLBACK_UNGROUNDED_INSTRUCTION;
      groundedIn = hasContext ? "documents" : "general_knowledge";
    } else {
      groundingInstruction = RAG_PLUS_LLM_INSTRUCTION;
      groundedIn = hasContext ? "both" : "general_knowledge";
    }

    const llmInput = hasContext
      ? `Concept: ${concept}\n\nContext:\n${documentContext}`
      : `Concept: ${concept}\n\nNo course material context was found for this concept.`;

    const jevModel = jevEnabled ? JEV_MODEL_ID : null;

    const generateResult = await generateChatCompletion(
      [
        { role: "system", content: buildSystemPrompt(groundingInstruction) },
        { role: "user", content: llmInput },
      ],
      EXPLAIN_MAX_TOKENS,
      env,
      config
    );

    const parsed = parseExplainLlmResponse(generateResult.text, concept);
    const pageImageKey = docSources.find((c) => c.pageImageKey)?.pageImageKey ?? null;

    const trace = buildTransactionTrace({
      question: concept,
      provider: generateResult.provider,
      model: generateResult.model,
      pathTaken: "concept_explainer",
      jevAnnotated: jevResult.chunks,
      keptKeys,
      llmInput,
      llmOutput: generateResult.text,
      jevEnabled,
      jevModel,
      jevCostUsd: jevResult.costUsd,
    });
    ctx.waitUntil(recordExplainTransaction(env, trace));

    const responseBody: ExplainResponseBody = {
      concept: parsed.concept,
      simpleExplanation: parsed.simpleExplanation,
      steps: parsed.steps,
      formula: parsed.formula,
      definition: parsed.definition,
      table: parsed.table,
      realWorldExample: parsed.realWorldExample,
      pageImageKey,
      videoSearchUrl: buildVideoSearchUrl(concept),
      docSources: docSources.map((c) => ({
        source: c.source,
        page: c.page,
        pageEnd: c.pageEnd,
        text: c.text,
        pageImageKey: c.pageImageKey,
      })),
      groundedIn,
    };

    return Response.json(responseBody);
  } catch (err) {
    console.error("explain pipeline failed", err);
    return Response.json(
      { error: "Something went wrong explaining this concept - please try again." },
      { status: 502 }
    );
  }
}
