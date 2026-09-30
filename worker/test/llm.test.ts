import { describe, it, expect } from "vitest";
import { generateChatCompletion, DEFAULT_OPENROUTER_MODEL } from "../src/llm";
import type { Env } from "../src/index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => ({ response: "workers-ai answer" }) },
    OPENROUTER_API_KEY: "test-key",
    ...overrides,
  } as unknown as Env;
}

describe("generateChatCompletion", () => {
  it("calls OpenRouter's chat-completions endpoint with the configured model and returns its content", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedAuth: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
      capturedBody = JSON.parse(String(init?.body));
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      return new Response(JSON.stringify({ choices: [{ message: { content: "openrouter answer" } }] }), {
        status: 200,
      });
    };

    try {
      const env = makeEnv();
      const result = await generateChatCompletion(
        [{ role: "user", content: "hello" }],
        100,
        env,
        { llmProvider: "openrouter", llmModelSlug: "qwen/some-model" }
      );

      expect(result).toEqual({ text: "openrouter answer", provider: "openrouter", model: "qwen/some-model" });
      expect(capturedBody).toMatchObject({ model: "qwen/some-model", max_tokens: 100 });
      expect(capturedAuth).toBe("Bearer test-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the default Qwen model when llmModelSlug is empty", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(DEFAULT_OPENROUTER_MODEL);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    };

    try {
      const env = makeEnv();
      await generateChatCompletion([{ role: "user", content: "hi" }], 50, env, {
        llmProvider: "openrouter",
        llmModelSlug: "",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws (does not silently fall back) when OpenRouter returns a non-OK response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 });

    try {
      const env = makeEnv();
      await expect(
        generateChatCompletion([{ role: "user", content: "hi" }], 50, env, {
          llmProvider: "openrouter",
          llmModelSlug: "qwen/some-model",
        })
      ).rejects.toThrow(/OpenRouter chat completion failed \(401\)/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("routes to Workers AI when llmProvider is workers-ai", async () => {
    const env = makeEnv({ AI: { run: async () => ({ response: "workers-ai answer" }) } as unknown as Ai });
    const result = await generateChatCompletion([{ role: "user", content: "hi" }], 50, env, {
      llmProvider: "workers-ai",
      llmModelSlug: "unused",
    });

    expect(result.text).toBe("workers-ai answer");
    expect(result.provider).toBe("workers-ai");
  });
});
