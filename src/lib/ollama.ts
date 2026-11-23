import type { ChatMessage, ToolCall } from "./types";

/** Subset of Ollama's tool schema that we use. */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  tools?: OllamaTool[];
  temperature?: number;
  stream?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "done"; reason: string };

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function normalizeBaseUrl(input: string): string {
  let url = (input || "").trim();
  if (!url) return "http://localhost:11434";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const looksLikeCloud = /^(www\.)?ollama\.com(\/|$)/i.test(url);
    url = `${looksLikeCloud ? "https" : "http"}://${url}`;
  }
  return url.replace(/\/+$/, "");
}

export function isCloudEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(normalizeBaseUrl(baseUrl)).hostname;
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

function authHeaders(apiKey: string | undefined, json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  const key = (apiKey ?? "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** Turns a fetch/network failure into something a human can act on. */
function connectionError(baseUrl: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (isCloudEndpoint(baseUrl)) {
    return `Could not reach Ollama Cloud at ${baseUrl}. Check your internet connection and API key. (${detail})`;
  }
  return `Could not reach Ollama at ${baseUrl}. Start it with \`ollama serve\` and check the base URL in settings. (${detail})`;
}

async function httpError(response: Response, baseUrl: string, model: string): Promise<string> {
  let body = "";
  try {
    body = (await response.text()).slice(0, 800);
  } catch {
    // ignore
  }
  const status = response.status;

  if (status === 401 || status === 403) {
    return `Ollama rejected the request (HTTP ${status}). ${
      isCloudEndpoint(baseUrl)
        ? "Add a valid Ollama Cloud API key in settings."
        : "Check your API key or make sure the endpoint does not require one."
    }`;
  }

  if (/does not support tools/i.test(body)) {
    return `The model "${model}" does not support tool calling, which Brogent relies on. Try a tool-capable model such as qwen3, llama3.1, mistral-nemo, granite3.3, or qwen2.5.`;
  }

  if (status === 404) {
    const hint = model ? ` Pull it first with \`ollama pull ${model}\`.` : "";
    return `Ollama could not find that model (HTTP 404).${hint} ${body}`.trim();
  }

  return `Ollama responded with HTTP ${status}${response.statusText ? ` ${response.statusText}` : ""}: ${
    body || "empty response"
  }`;
}

function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const fn = (entry as { function?: { name?: unknown; arguments?: unknown } })?.function;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) continue;
    let args: unknown = fn?.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { input: args };
      }
    }
    calls.push({
      function: {
        name,
        arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
      },
    });
  }
  return calls;
}

function dedupeCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = JSON.stringify(call.function);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface RawChunk {
  message?: { content?: unknown; tool_calls?: unknown };
  response?: unknown;
  error?: unknown;
  done?: boolean;
  done_reason?: unknown;
}

/**
 * Parses Ollama's newline-delimited JSON chat stream.
 *
 * Exported separately from `chatEvents` so it can be exercised in tests with a
 * plain ReadableStream.
 */
export async function* parseChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const calls: ToolCall[] = [];
  let buffer = "";
  let finishReason = "stop";

  const handleLine = (line: string): string | null => {
    let payload = line.trim();
    if (!payload) return null;
    // Tolerate SSE frames from proxies that wrap Ollama's JSONL in `data:`.
    if (payload.startsWith("data:")) payload = payload.slice(5).trim();
    if (!payload || payload === "[DONE]") return null;

    let chunk: RawChunk;
    try {
      chunk = JSON.parse(payload) as RawChunk;
    } catch {
      // Keep-alives / non-JSON noise are ignored rather than aborting a run.
      return null;
    }

    if (chunk.error) throw new OllamaError(String(chunk.error));
    calls.push(...normalizeToolCalls(chunk.message?.tool_calls));

    if (typeof chunk.done_reason === "string" && chunk.done_reason) {
      finishReason = chunk.done_reason;
    }

    const text = typeof chunk.message?.content === "string" ? chunk.message.content : "";
    if (typeof chunk.response === "string" && !text) return chunk.response;
    return text || null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const text = handleLine(line);
        if (text) yield { type: "delta", text };
        newline = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const text = handleLine(buffer);
      if (text) yield { type: "delta", text };
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }

  const unique = dedupeCalls(calls);
  if (unique.length) yield { type: "tool_calls", calls: unique };
  yield { type: "done", reason: finishReason };
}

/** Streams (or fetches) one assistant turn from Ollama. */
export async function* chatEvents(request: ChatRequest): AsyncGenerator<ChatEvent> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(request.baseUrl);
  const endpoint = `${baseUrl}/api/chat`;
  const stream = request.stream !== false;

  const payload: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream,
  };
  if (request.tools?.length) payload.tools = request.tools;
  if (typeof request.temperature === "number" && Number.isFinite(request.temperature)) {
    payload.options = { temperature: request.temperature };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: authHeaders(request.apiKey, true),
      body: JSON.stringify(payload),
      signal: request.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new OllamaError(connectionError(baseUrl, error));
  }

  if (!response.ok) {
    throw new OllamaError(await httpError(response, baseUrl, request.model));
  }

  if (!stream) {
    let chunk: RawChunk;
    try {
      chunk = (await response.json()) as RawChunk;
    } catch {
      throw new OllamaError("Ollama returned a response that was not valid JSON.");
    }
    if (chunk.error) throw new OllamaError(String(chunk.error));
    const text = typeof chunk.message?.content === "string" ? chunk.message.content : "";
    if (text) yield { type: "delta", text };
    const calls = dedupeCalls(normalizeToolCalls(chunk.message?.tool_calls));
    if (calls.length) yield { type: "tool_calls", calls };
    yield { type: "done", reason: typeof chunk.done_reason === "string" ? chunk.done_reason : "stop" };
    return;
  }

  if (!response.body) {
    throw new OllamaError("Ollama returned an empty streaming response.");
  }

  yield* parseChatStream(response.body);
}

export async function listModels(options: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/tags`, {
      headers: authHeaders(options.apiKey),
    });
  } catch (error) {
    throw new OllamaError(connectionError(baseUrl, error));
  }

  if (!response.ok) {
    throw new OllamaError(await httpError(response, baseUrl, ""));
  }

  let payload: { models?: Array<{ name?: unknown }> };
  try {
    payload = (await response.json()) as { models?: Array<{ name?: unknown }> };
  } catch {
    throw new OllamaError("Ollama returned an unexpected response for /api/tags.");
  }

  const names = new Set<string>();
  for (const model of payload.models ?? []) {
    if (typeof model?.name === "string" && model.name) names.add(model.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
