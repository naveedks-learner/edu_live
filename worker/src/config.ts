import type { Env } from "./index";
import { DEFAULT_OPENROUTER_MODEL } from "./llm";

export type WebSearchMode = "rag_only" | "rag_web_fallback";
export type LlmProvider = "openrouter" | "workers-ai";

export interface RuntimeConfig {
  topK: number;
  confidenceThreshold: number;
  webSearchMode: WebSearchMode;
  hardFailNoDocument: boolean;
  jevEnabled: boolean;
  guardrailEnabled: boolean;
  llmProvider: LlmProvider;
  llmModelSlug: string;
  jevRelevanceThreshold: number;
}

// Must match the pre-existing hardcoded behavior exactly, so shipping this
// feature with an empty config table changes nothing until an admin acts.
// Exceptions (explicit product decisions, not preserved defaults):
// - llmProvider/llmModelSlug default to OpenRouter/Qwen - generation moves
//   off Workers AI by default, toggle back via the admin Settings tab.
// - jevRelevanceThreshold defaults to 1.5 (was hardcoded at 2 / "Relevant")
//   because the stricter threshold was rejecting valid simple answers.
export const DEFAULT_CONFIG: RuntimeConfig = {
  topK: 5,
  confidenceThreshold: 0,
  webSearchMode: "rag_web_fallback",
  hardFailNoDocument: false,
  jevEnabled: true,
  guardrailEnabled: true,
  llmProvider: "openrouter",
  llmModelSlug: DEFAULT_OPENROUTER_MODEL,
  jevRelevanceThreshold: 1.5,
};

export function parseConfigRows(rows: { key: string; value: string }[]): RuntimeConfig {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    topK: map.has("topK") ? parseInt(map.get("topK")!, 10) : DEFAULT_CONFIG.topK,
    confidenceThreshold: map.has("confidenceThreshold")
      ? Number(map.get("confidenceThreshold"))
      : DEFAULT_CONFIG.confidenceThreshold,
    webSearchMode: (map.get("webSearchMode") as WebSearchMode | undefined) ?? DEFAULT_CONFIG.webSearchMode,
    hardFailNoDocument: map.has("hardFailNoDocument")
      ? map.get("hardFailNoDocument") === "true"
      : DEFAULT_CONFIG.hardFailNoDocument,
    jevEnabled: map.has("jevEnabled") ? map.get("jevEnabled") === "true" : DEFAULT_CONFIG.jevEnabled,
    guardrailEnabled: map.has("guardrailEnabled")
      ? map.get("guardrailEnabled") === "true"
      : DEFAULT_CONFIG.guardrailEnabled,
    llmProvider: (map.get("llmProvider") as LlmProvider | undefined) ?? DEFAULT_CONFIG.llmProvider,
    llmModelSlug: map.get("llmModelSlug") ?? DEFAULT_CONFIG.llmModelSlug,
    jevRelevanceThreshold: map.has("jevRelevanceThreshold")
      ? Number(map.get("jevRelevanceThreshold"))
      : DEFAULT_CONFIG.jevRelevanceThreshold,
  };
}

const KNOWN_FIELDS = new Set([
  "topK",
  "confidenceThreshold",
  "webSearchMode",
  "hardFailNoDocument",
  "jevEnabled",
  "guardrailEnabled",
  "llmProvider",
  "llmModelSlug",
  "jevRelevanceThreshold",
]);

// Cloudflare Vectorize rejects a query above its own topK ceiling, and a
// value that large would also multiply paid JEV calls per question - this
// cap stops one bad save from breaking every /chat request until reverted.
const MAX_TOP_K = 50;

export function validateConfigUpdate(input: Record<string, unknown>): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];

  for (const field of Object.keys(input)) {
    if (!KNOWN_FIELDS.has(field)) {
      errors.push({ field, message: `Unrecognized config field: ${field}` });
    }
  }

  if ("topK" in input) {
    const v = input.topK;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_TOP_K) {
      errors.push({ field: "topK", message: `topK must be a positive integer no greater than ${MAX_TOP_K}` });
    }
  }
  if ("confidenceThreshold" in input) {
    const v = input.confidenceThreshold;
    if (typeof v !== "number" || v < 0 || v > 1) {
      errors.push({ field: "confidenceThreshold", message: "confidenceThreshold must be a number between 0 and 1" });
    }
  }
  if ("webSearchMode" in input) {
    if (input.webSearchMode !== "rag_only" && input.webSearchMode !== "rag_web_fallback") {
      errors.push({ field: "webSearchMode", message: "webSearchMode must be 'rag_only' or 'rag_web_fallback'" });
    }
  }
  for (const field of ["hardFailNoDocument", "jevEnabled", "guardrailEnabled"] as const) {
    if (field in input && typeof input[field] !== "boolean") {
      errors.push({ field, message: `${field} must be a boolean` });
    }
  }
  if ("llmProvider" in input) {
    if (input.llmProvider !== "openrouter" && input.llmProvider !== "workers-ai") {
      errors.push({ field: "llmProvider", message: "llmProvider must be 'openrouter' or 'workers-ai'" });
    }
  }
  if ("llmModelSlug" in input) {
    const v = input.llmModelSlug;
    if (typeof v !== "string" || v.trim().length === 0) {
      errors.push({ field: "llmModelSlug", message: "llmModelSlug must be a non-empty string" });
    }
  }
  if ("jevRelevanceThreshold" in input) {
    const v = input.jevRelevanceThreshold;
    if (typeof v !== "number" || v < 0 || v > 3) {
      errors.push({
        field: "jevRelevanceThreshold",
        message: "jevRelevanceThreshold must be a number between 0 and 3 (JEV's relevance scale)",
      });
    }
  }

  return errors;
}

export async function getRuntimeConfig(env: Env): Promise<RuntimeConfig> {
  try {
    const result = await env.EDU_LIVE_DB.prepare("SELECT key, value FROM config").all<{
      key: string;
      value: string;
    }>();
    return parseConfigRows(result.results);
  } catch (err) {
    console.error("failed to load runtime config, using defaults", err);
    return { ...DEFAULT_CONFIG };
  }
}

export async function setRuntimeConfig(env: Env, updates: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const statements = Object.entries(updates).map(([key, value]) =>
    env.EDU_LIVE_DB.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, String(value), now)
  );
  await env.EDU_LIVE_DB.batch(statements);
}
