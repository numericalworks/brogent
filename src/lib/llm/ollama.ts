import type { ToolCall } from "../types";
import {
  LlmError,
  abortableRequest,
  dedupeCalls,
  extractErrorDetail,
  httpErrorFromResponse,
  joinUrl,
  normalizeToolCalls,
  readLines,
  sseData,
} from "./http";
import type { ChatEvent, ChatRequest, ListModelsOptions } from "./types";

interface RawChunk {
  message?: { content?: unknown; tool_calls?: unknown };
  response?: unknown;
  error?: unknown;
  done?: boolean;
  done_reason?: unknown;
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function headers(apiKey: string, json = false): Record<string, string> {
  const result: Record<string, string> = {};
  if (json) result["Content-Type"] = "application/json";
  const key = apiKey.trim();
  if (key) result.Authorization = `Bearer ${key}`;
  return result;
}

function context(request: { baseUrl: string; model: string }) {
  return {
    providerLabel: normalizeBase(request.baseUrl).includes("ollama.com") ? "Ollama Cloud" : "Ollama",
    baseUrl: normalizeBase(request.baseUrl),
    model: request.model,
  };
}

/**
 * Parses Ollama's newline-delimited JSON chat stream. Exported for tests.
 */
export async function* parseOllamaStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const calls: ToolCall[] = [];
  let finishReason = "stop";

  for await (const rawLine of readLines(body)) {
    let payload = rawLine.trim();
    if (payload.startsWith("data:")) {
      const data = sseData(rawLine);
      if (!data) continue;
      payload = data;
    }
    if (payload === "[DONE]") break;

    let chunk: RawChunk;
    try {
      chunk = JSON.parse(payload) as RawChunk;
    } catch {
      // Keep-alives and other noise are ignored.
      continue;
    }

    if (chunk.error) throw new LlmError(String(chunk.error));
    calls.push(...normalizeToolCalls(chunk.message?.tool_calls));

    if (typeof chunk.done_reason === "string" && chunk.done_reason) {
      finishReason = chunk.done_reason;
    }

    const text = typeof chunk.message?.content === "string" ? chunk.message.content : "";
    if (typeof chunk.response === "string" && !text) yield { type: "delta", text: chunk.response };
    else if (text) yield { type: "delta", text };
  }

  const unique = dedupeCalls(calls);
  if (unique.length) yield { type: "tool_calls", calls: unique };
  yield { type: "done", reason: finishReason };
}

export async function* ollamaChat(request: ChatRequest): AsyncGenerator<ChatEvent> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const baseUrl = normalizeBase(request.baseUrl);
  const stream = request.stream !== false;

  const payload: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream,
  };
  if (request.tools.length) payload.tools = request.tools;
  if (Number.isFinite(request.temperature)) payload.options = { temperature: request.temperature };

  const response = await abortableRequest(
    fetchImpl,
    joinUrl(baseUrl, "/api/chat"),
    {
      method: "POST",
      headers: headers(request.apiKey, true),
      body: JSON.stringify(payload),
      signal: request.signal,
    },
    context(request),
  );

  if (!response.ok) {
    // Early tool support failures are common; surface a clearer hint.
    const body = await response.clone().text().catch(() => "");
    if (/does not support tools/i.test(body)) {
      throw new LlmError(
        `The model "${request.model}" does not support tool calling, which Brogent needs. Try qwen3, llama3.1, mistral-nemo, or granite3.3.`,
      );
    }
    if (response.status === 404 && /not found|pull model/i.test(body)) {
      throw new LlmError(
        `Ollama does not have the model "${request.model}". Pull it with \`ollama pull ${request.model}\` or pick another model.`,
      );
    }
    throw await httpErrorFromResponse(response, context(request));
  }

  if (!stream) {
    let chunk: RawChunk;
    try {
      chunk = (await response.json()) as RawChunk;
    } catch {
      throw new LlmError("Ollama returned a response that was not valid JSON.");
    }
    if (chunk.error) throw new LlmError(extractErrorDetail(JSON.stringify(chunk)) || String(chunk.error));
    const text = typeof chunk.message?.content === "string" ? chunk.message.content : "";
    if (text) yield { type: "delta", text };
    const calls = dedupeCalls(normalizeToolCalls(chunk.message?.tool_calls));
    if (calls.length) yield { type: "tool_calls", calls };
    yield { type: "done", reason: typeof chunk.done_reason === "string" ? chunk.done_reason : "stop" };
    return;
  }

  if (!response.body) throw new LlmError("Ollama returned an empty streaming response.");
  yield* parseOllamaStream(response.body);
}

export async function ollamaModels(options: ListModelsOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeBase(options.baseUrl);

  const response = await abortableRequest(
    fetchImpl,
    joinUrl(baseUrl, "/api/tags"),
    { headers: headers(options.apiKey) },
    {
      providerLabel: options.providerLabel || "Ollama",
      baseUrl,
    },
  );

  if (!response.ok) {
    throw await httpErrorFromResponse(response, { providerLabel: "Ollama", baseUrl });
  }

  let payload: { models?: Array<{ name?: unknown }> };
  try {
    payload = (await response.json()) as { models?: Array<{ name?: unknown }> };
  } catch {
    throw new LlmError("Ollama returned an unexpected response for /api/tags.");
  }

  const names = new Set<string>();
  for (const model of payload.models ?? []) {
    if (typeof model?.name === "string" && model.name) names.add(model.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
