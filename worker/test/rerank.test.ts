import { describe, it, expect } from "vitest";
import { rerank, type RetrievedChunk, type ScoreFn } from "../src/rerank";

const candidates: RetrievedChunk[] = [
  { text: "irrelevant passage", page: 1, pageEnd: 1, source: "a.pdf", chunkId: 0, cosineScore: 0.7 },
  { text: "the actually relevant passage", page: 2, pageEnd: 2, source: "a.pdf", chunkId: 1, cosineScore: 0.6 },
];

describe("rerank", () => {
  it("re-sorts candidates by the score function's output, most relevant first", async () => {
    const scoreFn: ScoreFn = async () => [0.2, 0.9];

    const result = await rerank("query", candidates, scoreFn);

    expect(result[0].text).toBe("the actually relevant passage");
    expect(result[0].rerankScore).toBe(0.9);
    expect(result[1].rerankScore).toBe(0.2);
  });

  it("falls back to original cosine order with null rerankScore when the score function throws", async () => {
    const scoreFn: ScoreFn = async () => { throw new Error("Workers AI unreachable"); };

    const result = await rerank("query", candidates, scoreFn);

    expect(result.map((c) => c.text)).toEqual(candidates.map((c) => c.text));
    expect(result.every((c) => c.rerankScore === null)).toBe(true);
  });

  it("returns an empty array unchanged", async () => {
    const scoreFn: ScoreFn = async () => [];
    expect(await rerank("query", [], scoreFn)).toEqual([]);
  });
});
