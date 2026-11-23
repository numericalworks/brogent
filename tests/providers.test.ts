import { describe, expect, test } from "bun:test";
import { getProvider, isProviderId, pickDefaultModel, resolveProvider } from "../src/lib/providers";
import { normalizeConfig } from "../src/lib/types";

describe("provider registry", () => {
  test("resolves provider defaults", () => {
    const resolved = resolveProvider(normalizeConfig({ provider: "openai" }));

    expect(resolved.definition.label).toBe("OpenAI");
    expect(resolved.definition.protocol).toBe("openai");
    expect(resolved.definition.apiKeyRequired).toBe(true);
    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.apiKey).toBe("");
    expect(resolved.model).toBe("");
  });

  test("uses saved overrides per provider", () => {
    const config = normalizeConfig({
      provider: "groq",
      providers: {
        groq: { baseUrl: "http://localhost:9000/v1", apiKey: "k", model: "llama-3.3-70b" },
        openai: { apiKey: "sk", model: "gpt-5" },
      },
    });

    const resolved = resolveProvider(config);
    expect(resolved.baseUrl).toBe("http://localhost:9000/v1");
    expect(resolved.apiKey).toBe("k");
    expect(resolved.model).toBe("llama-3.3-70b");
    expect(config.providers.openai?.apiKey).toBe("sk");
  });

  test("local and custom providers have the expected base URLs", () => {
    expect(resolveProvider(normalizeConfig({ provider: "ollama" })).baseUrl).toBe("http://localhost:11434");
    expect(resolveProvider(normalizeConfig({ provider: "lmstudio" })).baseUrl).toBe("http://localhost:1234/v1");
    expect(resolveProvider(normalizeConfig({ provider: "custom" })).baseUrl).toBe("");
  });

  test("keeps an empty model until one is chosen", () => {
    expect(resolveProvider(normalizeConfig({ provider: "anthropic" })).model).toBe("");
  });

  test("validates provider ids", () => {
    expect(isProviderId("openai")).toBe(true);
    expect(isProviderId("not-real")).toBe(false);
    expect(getProvider("not-real").id).toBe("ollama");
  });
});

describe("pickDefaultModel", () => {
  test("returns nothing for an empty list", () => {
    expect(pickDefaultModel([])).toBe("");
  });

  test("skips embedding and media models", () => {
    expect(
      pickDefaultModel(["text-embedding-3-large", "whisper-1", "gpt-image-1", "gpt-5"]),
    ).toBe("gpt-5");
  });

  test("prefers the unsuffixed flagship", () => {
    expect(pickDefaultModel(["gpt-5-mini", "gpt-5"])).toBe("gpt-5");
    expect(pickDefaultModel(["gemini-2.5-flash", "gemini-2.5-pro"])).toBe("gemini-2.5-pro");
    expect(pickDefaultModel(["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"])).toBe("claude-sonnet-4-5");
  });

  test("falls back to the full list when everything looks non-chat", () => {
    expect(pickDefaultModel(["only-embed"])).toBe("only-embed");
  });
});
