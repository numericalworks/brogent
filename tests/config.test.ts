import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT, normalizeConfig, type AppConfig } from "../src/lib/types";

const legacy = (value: Record<string, unknown>) => value as unknown as Partial<AppConfig>;

describe("normalizeConfig", () => {
  test("returns defaults when nothing is stored", () => {
    expect(normalizeConfig()).toEqual({ ...DEFAULT_CONFIG, providers: {} });
    expect(normalizeConfig(null)).toEqual({ ...DEFAULT_CONFIG, providers: {} });
  });

  test("keeps a provider map untouched", () => {
    const config = normalizeConfig({
      provider: "openai",
      providers: { openai: { apiKey: "sk-test", model: "gpt-5" } },
      temperature: 0.7,
      maxSteps: 9,
      confirmScripts: false,
    });

    expect(config.provider).toBe("openai");
    expect(config.providers.openai).toEqual({ apiKey: "sk-test", model: "gpt-5" });
    expect(config.temperature).toBe(0.7);
    expect(config.maxSteps).toBe(9);
    expect(config.confirmScripts).toBe(false);
  });

  test("migrates the legacy flat Ollama config", () => {
    const config = normalizeConfig(legacy({ baseUrl: "http://localhost:11434", apiKey: "", model: "llama3.1:8b" }));

    expect(config.provider).toBe("ollama");
    expect(config.providers.ollama).toEqual({
      baseUrl: "http://localhost:11434",
      apiKey: "",
      model: "llama3.1:8b",
    });
    expect((config as unknown as Record<string, unknown>).baseUrl).toBeUndefined();
  });

  test("migrates a legacy Ollama Cloud config", () => {
    const config = normalizeConfig(legacy({ baseUrl: "https://ollama.com", apiKey: "key", model: "gpt-oss:120b-cloud" }));
    expect(config.provider).toBe("ollama-cloud");
    expect(config.providers["ollama-cloud"]).toMatchObject({ apiKey: "key" });
  });

  test("ignores unknown provider ids and entries", () => {
    const config = normalizeConfig(legacy({
      provider: "not-a-provider",
      providers: { openai: { apiKey: "sk" }, bogus: { apiKey: "nope" } },
    }));

    expect(config.provider).toBe("ollama");
    expect(config.providers.openai).toEqual({ apiKey: "sk" });
    expect((config.providers as Record<string, unknown>).bogus).toBeUndefined();
  });

  test("repairs invalid numeric values and empty prompts", () => {
    const config = normalizeConfig({
      maxSteps: 0,
      temperature: Number.NaN,
      systemPrompt: "   ",
    });

    expect(config.maxSteps).toBe(DEFAULT_CONFIG.maxSteps);
    expect(config.temperature).toBe(DEFAULT_CONFIG.temperature);
    expect(config.chatFontSize).toBe(DEFAULT_CONFIG.chatFontSize);
    expect(config.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("clamps numeric values", () => {
    expect(normalizeConfig({ maxSteps: 99 }).maxSteps).toBe(20);
    expect(normalizeConfig({ maxSteps: -4 }).maxSteps).toBe(DEFAULT_CONFIG.maxSteps);
    expect(normalizeConfig({ temperature: 4 }).temperature).toBe(2);
    expect(normalizeConfig({ temperature: -1 }).temperature).toBe(0);
    expect(normalizeConfig({ chatFontSize: 99 }).chatFontSize).toBe(20);
    expect(normalizeConfig({ chatFontSize: 4 }).chatFontSize).toBe(11);
    expect(normalizeConfig({ chatFontSize: Number.NaN }).chatFontSize).toBe(DEFAULT_CONFIG.chatFontSize);
  });
});
