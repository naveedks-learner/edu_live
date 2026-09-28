import { describe, it, expect } from "vitest";
import { chunkText } from "../src/chunker";

describe("chunkText", () => {
  it("splits words across pages with overlap, continuous across page breaks", () => {
    const pages = [
      { page: 1, text: Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ") },
      { page: 2, text: Array.from({ length: 300 }, (_, i) => `word${400 + i}`).join(" ") },
    ];

    const chunks = chunkText(pages, "fake.pdf", 300, 50);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].wordStart).toBe(0);
    expect(chunks[0].wordEnd).toBe(300);
    expect(chunks[0].page).toBe(1);
    // second chunk starts at 300 - 50 = 250 (overlap re-included)
    expect(chunks[1].wordStart).toBe(250);
    // total words = 700, so this chunk straddles the page 1/2 boundary (word 400)
    expect(chunks[1].page).toBe(1);
    expect(chunks[1].pageEnd).toBe(2);
  });

  it("returns an empty array for pages with no extractable text", () => {
    expect(chunkText([{ page: 1, text: "" }], "empty.pdf")).toEqual([]);
  });

  it("throws when overlap is not smaller than chunkSize", () => {
    expect(() => chunkText([{ page: 1, text: "a b c" }], "x.pdf", 10, 10)).toThrow();
  });
});
