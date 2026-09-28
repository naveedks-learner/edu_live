import { describe, it, expect } from "vitest";
import { buildTransactionTrace, estimateTokens } from "../src/transactionTrace";
import type { JevScoredChunk } from "../src/jev";

function chunk(overrides: Partial<JevScoredChunk> = {}): JevScoredChunk {
  return {
    text: "some passage",
    page: 1,
    pageEnd: 1,
    source: "a.pdf",
    chunkId: 0,
    cosineScore: 0.6,
    rerankScore: 0.7,
    jevRelevance: 2.5,
    jevBlocked: false,
    ...overrides,
  };
}

describe("estimateTokens", () => {
  it("estimates roughly 4 characters per token, rounding up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("buildTransactionTrace", () => {
  const base = {
    question: "what is reflection of light",
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct-fp8",
    pathTaken: "pdf_only" as const,
    llmInput: "Question: what is reflection of light\n\nContext:\nsome passage",
    llmOutput: "Reflection of light is...",
    jevEnabled: true,
    jevCostUsd: 0.002,
  };

  it("marks chunks present in keptKeys as kept and everything else as discarded", () => {
    const kept = chunk({ source: "a.pdf", chunkId: 0 });
    const discarded = chunk({ source: "a.pdf", chunkId: 1, jevRelevance: 0.5 });

    const trace = buildTransactionTrace({
      ...base,
      jevAnnotated: [kept, discarded],
      keptKeys: new Set(["a.pdf::0"]),
    });

    expect(trace.retrieval).toEqual([
      { rank: 1, source: "a.pdf", page: 1, chunkId: 0, cosineScore: 0.6, rerankScore: 0.7, jevRelevance: 2.5, status: "kept" },
      { rank: 2, source: "a.pdf", page: 1, chunkId: 1, cosineScore: 0.6, rerankScore: 0.7, jevRelevance: 0.5, status: "discarded" },
    ]);
  });

  it("sets jevInput/jevOutput to null when JEV is disabled", () => {
    const trace = buildTransactionTrace({
      ...base,
      jevEnabled: false,
      jevCostUsd: 0,
      jevAnnotated: [chunk()],
      keptKeys: new Set(["a.pdf::0"]),
    });

    expect(trace.jevInput).toBeNull();
    expect(trace.jevOutput).toBeNull();
  });

  it("uses the top chunk's rerankScore as confidence when present", () => {
    const trace = buildTransactionTrace({
      ...base,
      jevAnnotated: [chunk({ rerankScore: 0.85, cosineScore: 0.5 })],
      keptKeys: new Set(["a.pdf::0"]),
    });

    expect(trace.confidence).toBe(0.85);
  });

  it("falls back to cosineScore for confidence when rerankScore is null", () => {
    const trace = buildTransactionTrace({
      ...base,
      jevAnnotated: [chunk({ rerankScore: null, cosineScore: 0.42 })],
      keptKeys: new Set(["a.pdf::0"]),
    });

    expect(trace.confidence).toBe(0.42);
  });

  it("sets confidence to null when there are no retrieved chunks", () => {
    const trace = buildTransactionTrace({ ...base, jevAnnotated: [], keptKeys: new Set() });

    expect(trace.confidence).toBeNull();
    expect(trace.retrieval).toEqual([]);
  });

  it("records the path taken and estimated token counts", () => {
    const trace = buildTransactionTrace({
      ...base,
      pathTaken: "web_fallback",
      jevAnnotated: [],
      keptKeys: new Set(),
    });

    expect(trace.pathTaken).toBe("web_fallback");
    expect(trace.inputTokens).toBe(estimateTokens(base.llmInput));
    expect(trace.outputTokens).toBe(estimateTokens(base.llmOutput));
  });
});
