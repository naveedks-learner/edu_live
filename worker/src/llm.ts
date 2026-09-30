import type { Env } from "./index";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmResult {
  text: string;
  provider: "openrouter" | "workers-ai";
  model: string;
}

// OpenRouter free-tier Qwen model - editable at runtime via
// RuntimeConfig.llmModelSlug (admin dashboard Settings tab), no redeploy needed.
export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen-2.5-72b-instruct:free";
const WORKERS_AI_GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

async function callOpenRouter(
  messages: ChatMessage[],
  maxTokens: number,
  apiKey: string,
  model: string
): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`OpenRouter chat completion failed (${response.status}): ${bodyText}`);
  }

  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter chat completion returned no content");
  }
  return content;
}

async function callWorkersAi(messages: ChatMessage[], maxTokens: number, ai: Ai): Promise<string> {
  const response = await ai.run(WORKERS_AI_GENERATION_MODEL, { messages, max_tokens: maxTokens });
  return (response as { response: string }).response;
}

/**
 * Single entry point for chat generation. Routes to OpenRouter or Workers AI
 * based on config.llmProvider so the provider can be flipped at runtime
 * (admin Settings tab) without a redeploy. Callers should let failures
 * propagate - falling back silently would hide a bad model slug or an
 * OpenRouter outage and quietly shift cost/quality without anyone noticing.
 */
export async function generateChatCompletion(
  messages: ChatMessage[],
  maxTokens: number,
  env: Env,
  config: { llmProvider: "openrouter" | "workers-ai"; llmModelSlug: string }
): Promise<LlmResult> {
  if (config.llmProvider === "openrouter") {
    const model = config.llmModelSlug || DEFAULT_OPENROUTER_MODEL;
    const text = await callOpenRouter(messages, maxTokens, env.OPENROUTER_API_KEY, model);
    return { text, provider: "openrouter", model };
  }

  const text = await callWorkersAi(messages, maxTokens, env.AI);
  return { text, provider: "workers-ai", model: WORKERS_AI_GENERATION_MODEL };
}
