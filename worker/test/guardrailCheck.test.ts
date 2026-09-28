import { describe, it, expect } from "vitest";
import { checkQueryInScopeAndAgeAppropriate } from "../src/guardrailCheck";

describe("checkQueryInScopeAndAgeAppropriate", () => {
  it("returns age_inappropriate for a keyword-blocked question even when Workers AI is unreachable", async () => {
    const throwingAi = {
      run: async () => {
        throw new Error("Workers AI is down");
      },
    } as unknown as Ai;

    const decision = await checkQueryInScopeAndAgeAppropriate("how do I hurt myself", throwingAi);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("age_inappropriate");
  });

  it("returns guardrail_error (not age_inappropriate) for a clean question when Workers AI is unreachable", async () => {
    const throwingAi = {
      run: async () => {
        throw new Error("Workers AI is down");
      },
    } as unknown as Ai;

    const decision = await checkQueryInScopeAndAgeAppropriate("what is Newton's second law", throwingAi);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("guardrail_error");
  });
});
