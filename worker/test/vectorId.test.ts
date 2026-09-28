import { describe, it, expect } from "vitest";
import { chunkVectorId } from "../src/vectorId";

describe("chunkVectorId", () => {
  it("stays well under Vectorize's 64-byte id limit for a long filename", () => {
    const longName = "Class 10 Science Chapter 6 Life Processes Notes Final Revision Edition.pdf";
    const id = chunkVectorId(longName, 12);

    expect(new TextEncoder().encode(id).length).toBeLessThan(64);
  });

  it("is deterministic for the same source and chunkId", () => {
    expect(chunkVectorId("a.pdf", 3)).toBe(chunkVectorId("a.pdf", 3));
  });

  it("differs for different chunkIds of the same source", () => {
    expect(chunkVectorId("a.pdf", 1)).not.toBe(chunkVectorId("a.pdf", 2));
  });

  it("differs for different sources with the same chunkId", () => {
    expect(chunkVectorId("a.pdf", 1)).not.toBe(chunkVectorId("b.pdf", 1));
  });
});
