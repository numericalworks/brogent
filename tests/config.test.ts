import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT, normalizeConfig } from "../src/lib/types";

describe("normalizeConfig", () => {
  test("returns defaults when nothing is stored", () => {
    expect(normalizeConfig()).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
  });

  test("repairs empty or invalid values", () => {
    const config = normalizeConfig({
      baseUrl: "   ",
      model: "",
      systemPrompt: "",
      maxSteps: 0,
      temperature: Number.NaN,
    });

    expect(config.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
    expect(config.model).toBe(DEFAULT_CONFIG.model);
    expect(config.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(config.maxSteps).toBe(DEFAULT_CONFIG.maxSteps);
    expect(config.temperature).toBe(DEFAULT_CONFIG.temperature);
  });

  test("keeps values the user set", () => {
    const config = normalizeConfig({
      baseUrl: "https://ollama.com",
      apiKey: "secret",
      model: "qwen3:8b",
      maxSteps: 12,
      confirmScripts: false,
    });

    expect(config).toMatchObject({
      baseUrl: "https://ollama.com",
      apiKey: "secret",
      model: "qwen3:8b",
      maxSteps: 12,
      confirmScripts: false,
    });
  });
});
