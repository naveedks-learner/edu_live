import { describe, it, expect } from "vitest";
import { handleChat } from "../src/chat";
import type { Env } from "../src/index";

function makeRequest(body: unknown): Request {
  return new Request("https://worker.example/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleChat error handling", () => {
  it("returns a JSON 502, not an uncaught exception, when a downstream call throws", async () => {
    const throwingEnv = {
      AI: { run: async () => { throw new Error("Workers AI is down"); } },
      VECTORIZE: {},
      PDF_BUCKET: {},
      GUARDRAIL_ENABLED: "false",
      JEV_ENABLED: "false",
      OPENROUTER_API_KEY: "",
    } as unknown as Env;

    const response = await handleChat(makeRequest({ question: "What is Newton's second law?" }), throwingEnv);

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});
