import type { RerankedChunk } from "./rerank";

export interface JevScoredChunk extends RerankedChunk {
  jevRelevance: number | null;
  jevBlocked: boolean;
}

const DEFAULT_REL_MIN = 2;
const DEFAULT_INJ_MAX = 0.5;

export function filterByJevScores(
  chunks: RerankedChunk[],
  scores: { relevance: number; injection: number }[],
  relMin: number = DEFAULT_REL_MIN,
  injMax: number = DEFAULT_INJ_MAX
): JevScoredChunk[] {
  return chunks
    .map((chunk, i) => ({
      ...chunk,
      jevRelevance: scores[i]?.relevance ?? null,
      jevBlocked: (scores[i]?.injection ?? 0) >= injMax,
    }))
    .filter((c) => (c.jevRelevance ?? 0) >= relMin && !c.jevBlocked);
}

/**
 * Calls JEV to score each chunk's relevance to the query and probe for
 * injected instructions. Never throws - on any failure (network error,
 * bad response, JEV disabled) returns every input chunk unfiltered with
 * jevRelevance=null, jevBlocked=false, so callers degrade to "JEV didn't
 * run" rather than losing the whole request.
 */
export async function callJev(
  query: string,
  chunks: RerankedChunk[],
  apiKey: string
): Promise<JevScoredChunk[]> {
  if (chunks.length === 0) return [];

  try {
    const response = await fetch("https://api.typesafe.ai/v1/jev/score", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        chunks: chunks.map((c) => c.text),
      }),
    });

    if (!response.ok) {
      throw new Error(`JEV returned ${response.status}`);
    }

    const body = (await response.json()) as {
      scores: { relevance: number; injection: number }[];
    };

    return filterByJevScores(chunks, body.scores);
  } catch (err) {
    console.error("JEV call failed, passing chunks through unfiltered", err);
    return chunks.map((c) => ({ ...c, jevRelevance: null, jevBlocked: false }));
  }
}
