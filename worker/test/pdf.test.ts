import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { extractPdfPages } from "../src/pdf";

function loadFixture(name: string): ArrayBuffer {
  const bytes = readFileSync(join(__dirname, "..", "test-fixtures", name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("extractPdfPages", () => {
  it("does not detach the caller's ArrayBuffer, so it remains usable for later steps (enrichment, R2 write)", async () => {
    const pdfBytes = loadFixture("light-notes.pdf");
    const originalByteLength = pdfBytes.byteLength;

    const pages = await extractPdfPages(pdfBytes);

    expect(pages.length).toBeGreaterThan(0);
    expect(pdfBytes.byteLength).toBe(originalByteLength);
    // Constructing a view over a detached ArrayBuffer throws - this is the
    // real failure mode (unpdf/PDF.js transfers the buffer to a worker port,
    // detaching it), so proving a view still works is the actual assertion.
    expect(() => new Uint8Array(pdfBytes)).not.toThrow();
  });
});
