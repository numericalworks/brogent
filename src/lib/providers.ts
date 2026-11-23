import { normalizeBaseUrl } from "./llm/http";
import type { ProviderProtocol } from "./llm/types";
import type { AppConfig } from "./types";

export type ProviderId =
  | "ollama"
  | "ollama-cloud"
  | "lmstudio"
  | "llamacpp"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "groq"
  | "mistral"
  | "deepseek"
  | "xai"
  | "moonshot"
  | "dashscope"
  | "together"
  | "fireworks"
  | "cerebras"
  | "cohere"
  | "custom";

export type ProviderGroup = "local" | "cloud" | "custom";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  group: ProviderGroup;
  protocol: ProviderProtocol;
  defaultBaseUrl: string;
  /** The provider rejects requests without a key. */
  apiKeyRequired: boolean;
  modelPlaceholder: string;
  docsUrl?: string;
  hint?: string;
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "ollama",
    label: "Ollama (local)",
    group: "local",
    protocol: "ollama",
    defaultBaseUrl: "http://localhost:11434",
    apiKeyRequired: false,
    modelPlaceholder: "llama3.1:8b",
    docsUrl: "https://ollama.com/download",
    hint: "Runs on your machine. Start it with ollama serve.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    group: "local",
    protocol: "openai",
    defaultBaseUrl: "http://localhost:1234/v1",
    apiKeyRequired: false,
    modelPlaceholder: "loaded-model",
    docsUrl: "https://lmstudio.ai",
    hint: "Enable the local server in LM Studio's Developer tab.",
  },
  {
    id: "llamacpp",
    label: "llama.cpp (local)",
    group: "local",
    protocol: "openai",
    defaultBaseUrl: "http://localhost:8080/v1",
    apiKeyRequired: false,
    modelPlaceholder: "model-name",
    docsUrl: "https://github.com/ggml-org/llama.cpp",
    hint: "Run llama-server and use its OpenAI-compatible endpoint.",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    group: "cloud",
    protocol: "ollama",
    defaultBaseUrl: "https://ollama.com",
    apiKeyRequired: true,
    modelPlaceholder: "gpt-oss:120b-cloud",
    docsUrl: "https://ollama.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyRequired: true,
    modelPlaceholder: "gpt-5",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    group: "cloud",
    protocol: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    apiKeyRequired: true,
    modelPlaceholder: "claude-sonnet-4-5",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    label: "Google Gemini",
    group: "cloud",
    protocol: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyRequired: true,
    modelPlaceholder: "gemini-2.5-pro",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    apiKeyRequired: true,
    modelPlaceholder: "anthropic/claude-sonnet-4.5",
    docsUrl: "https://openrouter.ai/keys",
    hint: "One key for many models. Only tool-capable models are listed.",
  },
  {
    id: "groq",
    label: "Groq",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyRequired: true,
    modelPlaceholder: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    apiKeyRequired: true,
    modelPlaceholder: "mistral-large-latest",
    docsUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    apiKeyRequired: true,
    modelPlaceholder: "deepseek-chat",
    docsUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.x.ai/v1",
    apiKeyRequired: true,
    modelPlaceholder: "grok-4",
    docsUrl: "https://console.x.ai",
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    apiKeyRequired: true,
    modelPlaceholder: "kimi-k2",
    docsUrl: "https://platform.moonshot.ai/console/api-keys",
  },
  {
    id: "dashscope",
    label: "Alibaba Qwen (DashScope)",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyRequired: true,
    modelPlaceholder: "qwen-plus",
    docsUrl: "https://bailian.console.alibabacloud.com/",
  },
  {
    id: "together",
    label: "Together AI",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.together.xyz/v1",
    apiKeyRequired: true,
    modelPlaceholder: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    docsUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyRequired: true,
    modelPlaceholder: "llama-v3p3-70b-instruct",
    docsUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    apiKeyRequired: true,
    modelPlaceholder: "llama-3.3-70b",
    docsUrl: "https://cloud.cerebras.ai",
  },
  {
    id: "cohere",
    label: "Cohere",
    group: "cloud",
    protocol: "openai",
    defaultBaseUrl: "https://api.cohere.ai/compatibility/v1",
    apiKeyRequired: true,
    modelPlaceholder: "command-a-03-2025",
    docsUrl: "https://dashboard.cohere.com/api-keys",
    hint: "Uses Cohere's OpenAI-compatibility endpoint.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    group: "custom",
    protocol: "openai",
    defaultBaseUrl: "",
    apiKeyRequired: false,
    modelPlaceholder: "model-name",
    hint: "Any OpenAI-compatible endpoint: vLLM, LiteLLM, an Azure gateway, a proxy…",
  },
];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDERS.some((provider) => provider.id === value);
}

export function getProvider(id: ProviderId | string): ProviderDefinition {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0]!;
}

export interface ResolvedProvider {
  definition: ProviderDefinition;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The effective base URL, key, and model for the active provider. */
export function resolveProvider(config: AppConfig): ResolvedProvider {
  const definition = getProvider(config.provider);
  const saved = config.providers[definition.id] ?? {};
  const baseUrl = normalizeBaseUrl(saved.baseUrl || definition.defaultBaseUrl);
  return {
    definition,
    baseUrl,
    apiKey: (saved.apiKey ?? "").trim(),
    model: (saved.model ?? "").trim(),
  };
}

const NON_CHAT_MODEL = /embed|embedding|whisper|tts|audio|image|dall-e|moderation|rerank|guard|transcribe|realtime|sora/i;
const PREFERRED_MODEL = [
  /gpt-5/i,
  /sonnet/i,
  /gemini-.*(pro|flash)/i,
  /gpt-4\.1/i,
  /opus/i,
  /large/i,
  /70b|72b|32b/i,
  /instruct|chat/i,
];

/**
 * Chooses a sensible default from a fetched model list. Providers rarely
 * expose tool support, so this prefers chat-looking flagship names and skips
 * models that cannot do chat at all.
 */
export function pickDefaultModel(models: string[]): string {
  if (!models.length) return "";
  const chatModels = models.filter((name) => !NON_CHAT_MODEL.test(name));
  const pool = chatModels.length ? chatModels : models;

  for (const pattern of PREFERRED_MODEL) {
    const matches = pool.filter((name) => pattern.test(name));
    if (matches.length) {
      // Prefer the short, unsuffixed alias ("gpt-5" over "gpt-5-mini").
      return matches.sort((a, b) => a.length - b.length)[0]!;
    }
  }
  return pool[0]!;
}
