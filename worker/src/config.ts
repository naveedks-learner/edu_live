import type { Env } from "./index";

export type WebSearchMode = "rag_only" | "rag_web_fallback";

export interface RuntimeConfig {
  topK: number;
  confidenceThreshold: number;
  webSearchMode: WebSearchMode;
  hardFailNoDocument: boolean;
  jevEnabled: boolean;
  guardrailEnabled: boolean;
}

// Must match the pre-existing hardcoded behavior exactly, so shipping this
// feature with an empty config table changes nothing until an admin acts.
export const DEFAULT_CONFIG: RuntimeConfig = {
  topK: 5,
  confidenceThreshold: 0,
  webSearchMode: "rag_web_fallback",
  hardFailNoDocument: false,
  jevEnabled: true,
  guardrailEnabled: true,
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
  };
}

export function validateConfigUpdate(input: Record<string, unknown>): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];

  if ("topK" in input) {
    const v = input.topK;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      errors.push({ field: "topK", message: "topK must be a positive integer" });
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
