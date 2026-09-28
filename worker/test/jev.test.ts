import { describe, it, expect } from "vitest";
import { filterByJevScores } from "../src/jev";
import type { RerankedChunk } from "../src/rerank";

const chunks: RerankedChunk[] = [
  { text: "relevant", page: 1, pageEnd: 1, source: "a.pdf", chunkId: 0, cosineScore: 0.7, rerankScore: 0.8 },
  { text: "irrelevant", page: 2, pageEnd: 2, source: "a.pdf", chunkId: 1, cosineScore: 0.6, rerankScore: 0.4 },
  { text: "hostile injection attempt", page: 3, pageEnd: 3, source: "a.pdf", chunkId: 2, cosineScore: 0.5, rerankScore: 0.3 },
];

describe("filterByJevScores", () => {
  it("keeps chunks at/above the relevance threshold and below the injection threshold", () => {
    const scores = [
      { relevance: 2.5, injection: 0.1 },
      { relevance: 1.0, injection: 0.1 },
      { relevance: 2.0, injection: 0.9 },
    ];

    const result = filterByJevScores(chunks, scores, 2, 0.5);

    expect(result.map((c) => c.text)).toEqual(["relevant"]);
  });

  it("uses the default thresholds (relMin=2, injMax=0.5) when not specified", () => {
    const scores = [
      { relevance: 2.0, injection: 0.1 },
      { relevance: 1.9, injection: 0.1 },
    ];

    const result = filterByJevScores(chunks.slice(0, 2), scores);

    expect(result.map((c) => c.text)).toEqual(["relevant"]);
  });
});

describe("callJev", () => {
  it("passes chunks through unfiltered (not dropped) when the JEV request fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network unreachable"); };

    try {
      const { callJev } = await import("../src/jev");
      const result = await callJev("query", chunks, "fake-key");

      expect(result.length).toBe(chunks.length);
      expect(result.every((c) => c.jevRelevance === null && c.jevBlocked === false)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
