import { describe, it, expect } from "vitest";
import { parseConfigRows, validateConfigUpdate, getRuntimeConfig, DEFAULT_CONFIG } from "../src/config";
import type { Env } from "../src/index";

describe("parseConfigRows", () => {
  it("returns all defaults when there are no rows", () => {
    expect(parseConfigRows([])).toEqual(DEFAULT_CONFIG);
  });

  it("parses each stored value to its typed form, overriding only what's present", () => {
    const result = parseConfigRows([
      { key: "topK", value: "8" },
      { key: "confidenceThreshold", value: "0.35" },
      { key: "webSearchMode", value: "rag_only" },
      { key: "hardFailNoDocument", value: "true" },
      { key: "jevEnabled", value: "false" },
      { key: "guardrailEnabled", value: "false" },
    ]);

    expect(result).toEqual({
      topK: 8,
      confidenceThreshold: 0.35,
      webSearchMode: "rag_only",
      hardFailNoDocument: true,
      jevEnabled: false,
      guardrailEnabled: false,
    });
  });

  it("ignores unknown keys and keeps defaults for missing ones", () => {
    const result = parseConfigRows([{ key: "somethingElse", value: "x" }, { key: "topK", value: "3" }]);
    expect(result.topK).toBe(3);
    expect(result.confidenceThreshold).toBe(DEFAULT_CONFIG.confidenceThreshold);
  });
});

describe("validateConfigUpdate", () => {
  it("accepts a valid partial update", () => {
    expect(validateConfigUpdate({ topK: 10, confidenceThreshold: 0.5 })).toEqual([]);
  });

  it("rejects a non-positive or non-integer topK", () => {
    expect(validateConfigUpdate({ topK: 0 }).length).toBeGreaterThan(0);
    expect(validateConfigUpdate({ topK: 2.5 }).length).toBeGreaterThan(0);
  });

  it("rejects a topK above the sane upper bound, to stop one bad save from 502-ing every chat request", () => {
    expect(validateConfigUpdate({ topK: 1000 }).length).toBeGreaterThan(0);
    expect(validateConfigUpdate({ topK: 50 })).toEqual([]);
  });

  it("rejects an unrecognized config key so a typo can't silently write garbage", () => {
    expect(validateConfigUpdate({ topk: 10 }).length).toBeGreaterThan(0);
  });

  it("rejects a confidenceThreshold outside [0,1]", () => {
    expect(validateConfigUpdate({ confidenceThreshold: -0.1 }).length).toBeGreaterThan(0);
    expect(validateConfigUpdate({ confidenceThreshold: 1.1 }).length).toBeGreaterThan(0);
  });

  it("accepts confidenceThreshold at the boundaries 0 and 1", () => {
    expect(validateConfigUpdate({ confidenceThreshold: 0 })).toEqual([]);
    expect(validateConfigUpdate({ confidenceThreshold: 1 })).toEqual([]);
  });

  it("rejects an unrecognized webSearchMode", () => {
    expect(validateConfigUpdate({ webSearchMode: "bogus" }).length).toBeGreaterThan(0);
  });

  it("rejects a non-boolean for a boolean field", () => {
    expect(validateConfigUpdate({ jevEnabled: "true" }).length).toBeGreaterThan(0);
  });
});

describe("getRuntimeConfig", () => {
  it("returns defaults when the config table is empty", async () => {
    const env = { EDU_LIVE_DB: { prepare: () => ({ all: async () => ({ results: [] }) }) } } as unknown as Env;
    expect(await getRuntimeConfig(env)).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults (never throws) when D1 is unavailable", async () => {
    const env = {
      EDU_LIVE_DB: { prepare: () => ({ all: async () => { throw new Error("D1 down"); } }) },
    } as unknown as Env;
    expect(await getRuntimeConfig(env)).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults (never throws) when EDU_LIVE_DB itself is missing", async () => {
    const env = {} as unknown as Env;
    expect(await getRuntimeConfig(env)).toEqual(DEFAULT_CONFIG);
  });
});
