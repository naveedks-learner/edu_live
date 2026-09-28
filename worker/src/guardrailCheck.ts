import {
  containsBlockedKeyword,
  decideGuardrailOutcome,
  IN_SCOPE_EXAMPLE_QUESTIONS,
  OUT_OF_SCOPE_EXAMPLE_QUESTIONS,
  REFUSAL_AGE_INAPPROPRIATE,
  REFUSAL_GUARDRAIL_ERROR,
  type GuardrailDecision,
} from "./guardrail";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

function meanCosineSimilarity(vector: number[], referenceVectors: number[][]): number {
  const sims = referenceVectors.map((ref) => cosineSimilarity(vector, ref));
  return sims.reduce((a, b) => a + b, 0) / sims.length;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let cachedReferenceEmbeddings: { inScope: number[][]; outScope: number[][] } | null = null;

async function getReferenceEmbeddings(ai: Ai) {
  if (cachedReferenceEmbeddings) return cachedReferenceEmbeddings;

  const inScopeResp = await ai.run(EMBEDDING_MODEL, { text: IN_SCOPE_EXAMPLE_QUESTIONS });
  const outScopeResp = await ai.run(EMBEDDING_MODEL, { text: OUT_OF_SCOPE_EXAMPLE_QUESTIONS });

  cachedReferenceEmbeddings = {
    inScope: (inScopeResp as { data: number[][] }).data,
    outScope: (outScopeResp as { data: number[][] }).data,
  };
  return cachedReferenceEmbeddings;
}

/**
 * The real, wired-up guardrail gate: keyword hard-block plus Workers-AI
 * embedding similarity against reference question sets. Fails CLOSED -
 * any error (Workers AI unreachable, malformed response, etc.) blocks the
 * question with a distinct "guardrail_error" reason/message rather than
 * silently letting it through or looking like a normal policy refusal.
 */
export async function checkQueryInScopeAndAgeAppropriate(
  question: string,
  ai: Ai
): Promise<GuardrailDecision> {
  // Checked before any AI call, and returned immediately if true: a
  // keyword-blocked question (e.g. a self-harm phrase) must never depend
  // on Workers AI being reachable to be blocked, and must never receive
  // the generic "guardrail_error" message instead of the age-inappropriate
  // refusal just because an embedding call happened to fail first.
  if (containsBlockedKeyword(question)) {
    return { allowed: false, reason: "age_inappropriate", refusalMessage: REFUSAL_AGE_INAPPROPRIATE };
  }

  try {
    const { inScope, outScope } = await getReferenceEmbeddings(ai);
    const questionResp = await ai.run(EMBEDDING_MODEL, { text: [question] });
    const questionVector = (questionResp as { data: number[][] }).data[0];

    const inScopeSimilarity = meanCosineSimilarity(questionVector, inScope);
    const outScopeSimilarity = meanCosineSimilarity(questionVector, outScope);

    return decideGuardrailOutcome(false, inScopeSimilarity, outScopeSimilarity);
  } catch (err) {
    console.error("guardrail_error", err);
    return { allowed: false, reason: "guardrail_error", refusalMessage: REFUSAL_GUARDRAIL_ERROR };
  }
}
