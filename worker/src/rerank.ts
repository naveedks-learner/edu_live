export interface RetrievedChunk {
  text: string;
  page: number;
  pageEnd: number;
  source: string;
  chunkId: number;
  cosineScore: number;
}

export interface RerankedChunk extends RetrievedChunk {
  rerankScore: number | null;
}

export type ScoreFn = (query: string, candidates: RetrievedChunk[]) => Promise<number[]>;

/**
 * Cross-encoder-style reranking: re-scores each (query, chunk) pair
 * jointly instead of relying on cosine similarity alone. Never throws -
 * if scoreFn fails (model unavailable, network error), candidates come
 * back in their original cosine order with rerankScore=null, same
 * fallback philosophy as the Python app's reranker.py.
 */
export async function rerank(
  query: string,
  candidates: RetrievedChunk[],
  scoreFn: ScoreFn
): Promise<RerankedChunk[]> {
  if (candidates.length === 0) return [];

  try {
    const scores = await scoreFn(query, candidates);
    return candidates
      .map((c, i) => ({ ...c, rerankScore: scores[i] }))
      .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  } catch (err) {
    console.error("rerank failed, falling back to cosine order", err);
    return candidates.map((c) => ({ ...c, rerankScore: null }));
  }
}

/**
 * Real scoreFn backed by Cloudflare Workers AI's reranker model. Model id
 * to be confirmed against Workers AI's current catalog at deploy time -
 * "@cf/baai/bge-reranker-base" is the expected name as of this writing.
 */
export function workersAiScoreFn(ai: Ai): ScoreFn {
  return async (query, candidates) => {
    // @cloudflare/workers-types doesn't include this model id in its typed
    // run() overloads yet (the model id itself is unconfirmed against the
    // live catalog - see the note above); cast through unknown for this call.
    const run = ai.run.bind(ai) as unknown as (model: string, input: unknown) => Promise<unknown>;
    const response = await run("@cf/baai/bge-reranker-base", {
      query,
      contexts: candidates.map((c) => ({ text: c.text })),
    });
    const results = (response as { response: { id: number; score: number }[] }).response;
    const scoreById = new Map(results.map((r) => [r.id, r.score]));
    return candidates.map((_, i) => scoreById.get(i) ?? 0);
  };
}
