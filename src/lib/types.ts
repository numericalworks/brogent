/**
 * Shared domain types for Brogent.
 *
 * `ChatMessage` deliberately mirrors the common denominator of the provider
 * APIs so a conversation can be stored once and translated per provider.
 */

import { isProviderId, type ProviderId } from "./providers";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant messages that requested tool executions. */
  tool_calls?: ToolCall[];
  /** Present on tool messages: the tool the result belongs to. */
  tool_name?: string;
}

export interface ToolResult {
  ok: boolean;
  /** JSON string handed back to the model. */
  content: string;
}

export interface ProviderSettings {
  /** Overrides the provider's default endpoint. Empty means "use the default". */
  baseUrl?: string;
  /** Stored per provider so switching back does not require retyping it. */
  apiKey?: string;
  model?: string;
}

export interface AppConfig {
  provider: ProviderId;
  providers: Partial<Record<ProviderId, ProviderSettings>>;
  temperature: number;
  maxSteps: number;
  /** Ask the user before running model-authored JavaScript. */
  confirmScripts: boolean;
  /** Stream tokens as they are generated. */
  stream: boolean;
  systemPrompt: string;
}

export const DEFAULT_SYSTEM_PROMPT = `You are Brogent, an agent that works inside the user's Firefox browser and runs on the user's chosen AI provider.

You act on the user's current browser tab through two tools:

1. read_page — read the active tab.
   - mode "text": visible text (best for summarizing and answering questions)
   - mode "html": cleaned-up HTML, optionally scoped with a CSS selector
   - mode "links": every link on the page
   - mode "outline": the heading structure, useful for long documents
   - mode "selection": the text the user has selected

2. execute_javascript — run JavaScript in the active tab and return a JSON-serializable result.

Rules:
- Inspect the page with a tool before answering questions about it. Never invent page content.
- Prefer read_page for reading. Use execute_javascript for precise extraction, counting, or when the page text is too large or noisy.
- execute_javascript runs in the extension's isolated content-script world: you have full DOM access, but you CANNOT see variables or functions defined by the page's own scripts. Interact with the page through the DOM only.
- A script is the body of an async function. Use \`return\` to send data back, e.g. \`return document.title;\`. \`await\` is allowed. Return small, JSON-friendly values and never return DOM nodes directly.
- To change the page, modify the DOM directly (textContent, style, remove(), insertAdjacentHTML after escaping values, etc.).
- Keep answers concise and use Markdown. Mention the page URL or title when it helps.
- If a tool fails, read the error and adjust. Do not repeat an identical failing call.
- Never claim that you changed something unless a tool result confirms it.
- If the request is ambiguous or destructive, ask a short clarifying question before acting.`;

export const DEFAULT_CONFIG: AppConfig = {
  provider: "ollama",
  providers: {},
  temperature: 0.2,
  maxSteps: 6,
  confirmScripts: true,
  stream: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

export const CONFIG_KEY = "brogent:config";
export const ITEMS_KEY = "brogent:items";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProviders(input: unknown): Partial<Record<ProviderId, ProviderSettings>> {
  if (!isRecord(input)) return {};
  const output: Partial<Record<ProviderId, ProviderSettings>> = {};
  for (const [id, value] of Object.entries(input)) {
    if (!isProviderId(id) || !isRecord(value)) continue;
    const entry: ProviderSettings = {};
    if (typeof value.baseUrl === "string") entry.baseUrl = value.baseUrl;
    if (typeof value.apiKey === "string") entry.apiKey = value.apiKey;
    if (typeof value.model === "string") entry.model = value.model;
    output[id] = entry;
  }
  return output;
}

interface LegacyConfig {
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
}

/**
 * Fills in defaults, clamps numbers, and migrates the pre-provider flat
 * config (`baseUrl`/`apiKey`/`model`) into the provider map.
 */
export function normalizeConfig(partial?: Partial<AppConfig> | null): AppConfig {
  if (!partial) return { ...DEFAULT_CONFIG, providers: {} };

  const raw = partial as Partial<AppConfig> & LegacyConfig;
  let provider: ProviderId = isProviderId(raw.provider) ? raw.provider : "ollama";

  let providers = normalizeProviders(raw.providers);

  if (!isRecord(raw.providers)) {
    const legacyBase = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
    const legacyKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
    const legacyModel = typeof raw.model === "string" ? raw.model.trim() : "";
    if (legacyBase || legacyKey || legacyModel) {
      const legacyProvider: ProviderId = /ollama\.com/i.test(legacyBase) ? "ollama-cloud" : "ollama";
      provider = legacyProvider;
      providers = {
        ...providers,
        [legacyProvider]: { baseUrl: legacyBase, apiKey: legacyKey, model: legacyModel },
      };
    }
  }

  const temperature = Number.isFinite(raw.temperature)
    ? Math.min(2, Math.max(0, raw.temperature as number))
    : DEFAULT_CONFIG.temperature;
  const maxSteps =
    Number.isFinite(raw.maxSteps) && (raw.maxSteps as number) >= 1
      ? Math.min(20, Math.round(raw.maxSteps as number))
      : DEFAULT_CONFIG.maxSteps;

  return {
    provider,
    providers,
    temperature,
    maxSteps,
    confirmScripts: typeof raw.confirmScripts === "boolean" ? raw.confirmScripts : DEFAULT_CONFIG.confirmScripts,
    stream: typeof raw.stream === "boolean" ? raw.stream : DEFAULT_CONFIG.stream,
    systemPrompt:
      typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()
        ? raw.systemPrompt
        : DEFAULT_SYSTEM_PROMPT,
  };
}
