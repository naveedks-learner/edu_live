import { describe, it, expect } from "vitest";
import { formatWebResultsAsContext, type WebResult } from "../src/webSearch";

describe("formatWebResultsAsContext", () => {
  it("formats results as markdown-linked title + snippet blocks", () => {
    const results: WebResult[] = [
      { title: "Newton's Laws", url: "https://example.com/newton", snippet: "Three laws of motion." },
    ];

    const text = formatWebResultsAsContext(results);

    expect(text).toContain("[Newton's Laws](https://example.com/newton)");
    expect(text).toContain("Three laws of motion.");
  });

  it("returns a clear no-results message for an empty list", () => {
    expect(formatWebResultsAsContext([])).toBe("No web results found.");
  });
});
