import { describe, it, expect } from "vitest";
import { containsBlockedKeyword, decideGuardrailOutcome } from "../src/guardrail";

describe("containsBlockedKeyword", () => {
  it("flags a clear self-harm phrase", () => {
    expect(containsBlockedKeyword("how do I hurt myself")).toBe(true);
  });

  it("does not flag a biology question about drug interactions", () => {
    expect(containsBlockedKeyword("what are drug interactions in the human body")).toBe(false);
  });

  it("does not flag a biology question about sexual reproduction", () => {
    expect(containsBlockedKeyword("explain sexual reproduction in flowering plants")).toBe(false);
  });

  it("flags an explicit request to buy illegal drugs", () => {
    expect(containsBlockedKeyword("where can I buy illegal drugs")).toBe(true);
  });

  it("does not flag a physics question about rockets getting high enough to reach orbit", () => {
    expect(containsBlockedKeyword("how does a rocket get high enough to reach orbit")).toBe(false);
  });

  it("does not flag a student asking how to get higher marks", () => {
    expect(containsBlockedKeyword("how do I get higher marks in physics")).toBe(false);
  });

  it("flags getting high on drugs", () => {
    expect(containsBlockedKeyword("how do people get high on drugs")).toBe(true);
  });

  it("does not flag the word heroine (contains heroin as a substring, not a whole word)", () => {
    expect(containsBlockedKeyword("who is the heroine of this novel")).toBe(false);
  });

  it("still flags heroin as a whole word", () => {
    expect(containsBlockedKeyword("where can I buy heroin")).toBe(true);
  });
});

describe("decideGuardrailOutcome", () => {
  it("blocks when a keyword hit occurs regardless of similarity", () => {
    const d = decideGuardrailOutcome(true, 0.9, 0.1, 0.35);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("age_inappropriate");
  });

  it("allows when in-scope similarity dominates", () => {
    const d = decideGuardrailOutcome(false, 0.72, 0.3, 0.35);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeNull();
  });

  it("blocks when out-of-scope similarity dominates", () => {
    const d = decideGuardrailOutcome(false, 0.4, 0.65, 0.35);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("out_of_scope");
  });

  it("blocks when in-scope similarity is below the minimum even if higher than out-of-scope", () => {
    const d = decideGuardrailOutcome(false, 0.2, 0.1, 0.35);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("out_of_scope");
  });
});
