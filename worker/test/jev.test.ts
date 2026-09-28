import { describe, it, expect } from "vitest";
import { annotateWithJevScores, filterJevScored, scoreChunksWithJev } from "../src/jev";
import type { RerankedChunk } from "../src/rerank";

const chunks: RerankedChunk[] = [
  { text: "relevant", page: 1, pageEnd: 1, source: "a.pdf", chunkId: 0, cosineScore: 0.7, rerankScore: 0.8 },
  { text: "irrelevant", page: 2, pageEnd: 2, source: "a.pdf", chunkId: 1, cosineScore: 0.6, rerankScore: 0.4 },
  { text: "hostile injection attempt", page: 3, pageEnd: 3, source: "a.pdf", chunkId: 2, cosineScore: 0.5, rerankScore: 0.3 },
];

describe("annotateWithJevScores", () => {
  it("tags every chunk without dropping any, using the injection threshold to set jevBlocked", () => {
    const scores = [
      { relevance: 2.5, injection: 0.1 },
      { relevance: 1.0, injection: 0.1 },
      { relevance: 2.0, injection: 0.9 },
    ];

    const result = annotateWithJevScores(chunks, scores, 0.5);

    expect(result.length).toBe(3);
    expect(result[0]).toMatchObject({ jevRelevance: 2.5, jevBlocked: false });
    expect(result[1]).toMatchObject({ jevRelevance: 1.0, jevBlocked: false });
    expect(result[2]).toMatchObject({ jevRelevance: 2.0, jevBlocked: true });
  });
});

describe("filterJevScored", () => {
  it("keeps only chunks at/above relMin and not blocked", () => {
    const annotated = annotateWithJevScores(
      chunks,
      [
        { relevance: 2.5, injection: 0.1 },
        { relevance: 1.0, injection: 0.1 },
        { relevance: 2.0, injection: 0.9 },
      ],
      0.5
    );

    const result = filterJevScored(annotated, 2);

    expect(result.map((c) => c.text)).toEqual(["relevant"]);
  });

  it("uses the default relMin (2) when not specified", () => {
    const annotated = annotateWithJevScores(chunks.slice(0, 2), [
      { relevance: 2.0, injection: 0.1 },
      { relevance: 1.9, injection: 0.1 },
    ]);

    expect(filterJevScored(annotated).map((c) => c.text)).toEqual(["relevant"]);
  });
});

describe("scoreChunksWithJev", () => {
  it("returns every chunk annotated (not filtered) and never throws when the JEV request fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network unreachable"); };

    try {
      const result = await scoreChunksWithJev("query", chunks, "fake-key");

      expect(result.chunks.length).toBe(chunks.length);
      expect(result.chunks.every((c) => c.jevRelevance === null && c.jevBlocked === false)).toBe(true);
      expect(result.costUsd).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns an empty result for an empty chunk list without calling fetch", async () => {
    const result = await scoreChunksWithJev("query", [], "fake-key");
    expect(result).toEqual({ chunks: [], costUsd: 0 });
  });
});
