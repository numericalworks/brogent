/**
 * Shared domain types for Brogent.
 *
 * These deliberately mirror the shape of Ollama's chat API so that messages
 * can be persisted, replayed, and posted back without translation.
 */

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

export interface AppConfig {
  /** Ollama endpoint root, e.g. http://localhost:11434 or https://ollama.com */
  baseUrl: string;
  /** Bearer token, only needed for Ollama Cloud. */
  apiKey: string;
  model: string;
  temperature: number;
  /** Maximum number of model <-> tool round trips per request. */
  maxSteps: number;
  /** Ask the user before running model-authored JavaScript. */
  confirmScripts: boolean;
  /** Stream tokens as they are generated. */
  stream: boolean;
  systemPrompt: string;
}

export const LOCAL_BASE_URL = "http://localhost:11434";
export const CLOUD_BASE_URL = "https://ollama.com";
export const DEFAULT_MODEL = "llama3.1:8b";

export const DEFAULT_SYSTEM_PROMPT = `You are Brogent, an agent that works inside the user's Firefox browser and runs on Ollama.

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
  baseUrl: LOCAL_BASE_URL,
  apiKey: "",
  model: DEFAULT_MODEL,
  temperature: 0.2,
  maxSteps: 6,
  confirmScripts: true,
  stream: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

export const CONFIG_KEY = "brogent:config";
export const ITEMS_KEY = "brogent:items";

/** Fills in missing/invalid values from a partially stored config. */
export function normalizeConfig(partial?: Partial<AppConfig> | null): AppConfig {
  const config = { ...DEFAULT_CONFIG, ...(partial ?? {}) };
  if (!config.baseUrl.trim()) config.baseUrl = DEFAULT_CONFIG.baseUrl;
  if (!config.model.trim()) config.model = DEFAULT_CONFIG.model;
  if (!config.systemPrompt.trim()) config.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  if (!Number.isFinite(config.temperature)) config.temperature = DEFAULT_CONFIG.temperature;
  if (!Number.isFinite(config.maxSteps) || config.maxSteps < 1) config.maxSteps = DEFAULT_CONFIG.maxSteps;
  return config;
}
