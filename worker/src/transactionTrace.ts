import type { JevScoredChunk } from "./jev";

export type PathTaken = "pdf_only" | "web_fallback";

export interface RetrievalTraceEntry {
  rank: number;
  source: string;
  page: number;
  chunkId: number;
  cosineScore: number;
  rerankScore: number | null;
  jevRelevance: number | null;
  status: "kept" | "discarded";
}

export interface TransactionTrace {
  timestamp: string;
  question: string;
  provider: string;
  model: string;
  pathTaken: PathTaken;
  confidence: number | null;
  retrieval: RetrievalTraceEntry[];
  llmInput: string;
  llmOutput: string;
  jevInput: { source: string; chunkId: number; passage: string }[] | null;
  jevOutput: { source: string; chunkId: number; relevance: number | null; blocked: boolean }[] | null;
  inputTokens: number;
  outputTokens: number;
  jevCostUsd: number;
  llmCostUsd: number;
}

const CHARS_PER_TOKEN = 4;

/** Workers AI does not return real token usage, so this is a labeled estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function buildTransactionTrace(params: {
  question: string;
  provider: string;
  model: string;
  pathTaken: PathTaken;
  jevAnnotated: JevScoredChunk[];
  keptKeys: Set<string>;
  llmInput: string;
  llmOutput: string;
  jevEnabled: boolean;
  jevCostUsd: number;
}): TransactionTrace {
  const retrieval: RetrievalTraceEntry[] = params.jevAnnotated.map((chunk, i) => ({
    rank: i + 1,
    source: chunk.source,
    page: chunk.page,
    chunkId: chunk.chunkId,
    cosineScore: chunk.cosineScore,
    rerankScore: chunk.rerankScore,
    jevRelevance: chunk.jevRelevance,
    status: params.keptKeys.has(`${chunk.source}::${chunk.chunkId}`) ? "kept" : "discarded",
  }));

  const top = params.jevAnnotated[0];
  const confidence = top ? top.rerankScore ?? top.cosineScore : null;

  return {
    timestamp: new Date().toISOString(),
    question: params.question,
    provider: params.provider,
    model: params.model,
    pathTaken: params.pathTaken,
    confidence,
    retrieval,
    llmInput: params.llmInput,
    llmOutput: params.llmOutput,
    jevInput: params.jevEnabled
      ? params.jevAnnotated.map((c) => ({ source: c.source, chunkId: c.chunkId, passage: c.text }))
      : null,
    jevOutput: params.jevEnabled
      ? params.jevAnnotated.map((c) => ({ source: c.source, chunkId: c.chunkId, relevance: c.jevRelevance, blocked: c.jevBlocked }))
      : null,
    inputTokens: estimateTokens(params.llmInput),
    outputTokens: estimateTokens(params.llmOutput),
    jevCostUsd: params.jevCostUsd,
    llmCostUsd: 0,
  };
}
