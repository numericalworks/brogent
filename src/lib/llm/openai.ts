import type { ChatMessage } from "../types";
import {
  LlmError,
  abortableRequest,
  dedupeCalls,
  extractErrorDetail,
  httpErrorFromResponse,
  isRecord,
  joinUrl,
  normalizeToolCalls,
  parseArguments,
  readLines,
  sseData,
} from "./http";
import type { ChatEvent, ChatRequest, ListModelsOptions, LlmTool } from "./types";

const DEFAULT_LABEL = "OpenAI-compatible provider";

function context(request: { baseUrl: string; model?: string; providerLabel?: string }) {
  return {
    providerLabel: request.providerLabel || DEFAULT_LABEL,
    baseUrl: request.baseUrl,
    model: request.model,
  };
}

function headers(apiKey: string): Record<string, string> {
  const result: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Title": "Brogent",
  };
  const key = apiKey.trim();
  if (key) result.Authorization = `Bearer ${key}`;
  return result;
}

export function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  let pendingIds: string[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const ids = message.tool_calls.map((_, index) => `call_${output.length}_${index}`);
      pendingIds = [...ids];
      output.push({
        role: "assistant",
        content: message.content.trim() ? message.content : null,
        tool_calls: message.tool_calls.map((call, index) => ({
          id: ids[index],
          type: "function",
          function: {
            name: call.function.name,
            arguments: JSON.stringify(call.function.arguments ?? {}),
          },
        })),
      });
      continue;
    }

    if (message.role === "tool") {
      const id = pendingIds.shift() ?? `call_orphan_${output.length}`;
      output.push({
        role: "tool",
        tool_call_id: id,
        content: message.content || "(no output)",
      });
      continue;
    }

    output.push({ role: message.role, content: message.content });
  }

  return output;
}

function toOpenAiTools(tools: LlmTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/** Parses an OpenAI-compatible SSE stream (including fragmented tool calls). */
export async function* parseOpenAiStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const accumulators = new Map<number, ToolCallAccumulator>();
  let finishReason = "stop";

  for await (const line of readLines(body)) {
    const data = sseData(line);
    if (!data) continue;
    if (data === "[DONE]") break;

    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;

    if (chunk.error) {
      throw new LlmError(extractErrorDetail(JSON.stringify(chunk)) || "The provider returned an error.");
    }

    const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : undefined;
    if (!choice) continue;

    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
    if (typeof delta.content === "string" && delta.content) {
      yield { type: "delta", text: delta.content };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!isRecord(raw)) continue;
        const index = typeof raw.index === "number" ? raw.index : 0;
        const entry = accumulators.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof raw.id === "string" && raw.id) entry.id = raw.id;
        const fn = isRecord(raw.function) ? raw.function : undefined;
        if (typeof fn?.name === "string" && fn.name) entry.name = fn.name;
        if (typeof fn?.arguments === "string") entry.arguments += fn.arguments;
        accumulators.set(index, entry);
      }
    }

    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  const calls = [...accumulators.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, entry]) => entry.name)
    .map(([, entry]) => ({
      function: { name: entry.name, arguments: parseArguments(entry.arguments) },
    }));

  const unique = dedupeCalls(calls);
  if (unique.length) yield { type: "tool_calls", calls: unique };
  yield { type: "done", reason: finishReason };
}

export async function* openAiChat(request: ChatRequest): AsyncGenerator<ChatEvent> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const baseUrl = request.baseUrl.replace(/\/+$/, "");
  const stream = request.stream !== false;
  const ctx = context({ ...request, baseUrl });

  const basePayload: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAiMessages(request.messages),
    stream,
  };
  if (request.tools.length) basePayload.tools = toOpenAiTools(request.tools);

  const send = (payload: Record<string, unknown>) =>
    abortableRequest(
      fetchImpl,
      joinUrl(baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: headers(request.apiKey),
        body: JSON.stringify(payload),
        signal: request.signal,
      },
      ctx,
    );

  const withTemperature = Number.isFinite(request.temperature)
    ? { ...basePayload, temperature: request.temperature }
    : basePayload;

  let response = await send(withTemperature);

  if (!response.ok) {
    // Some reasoning models reject `temperature`; retry once without it.
    const detail = await response.clone().text().catch(() => "");
    if (response.status === 400 && /temperature|unsupported|unrecognized|unknown (parameter|field)/i.test(detail)) {
      response = await send(basePayload);
    }
  }

  if (!response.ok) throw await httpErrorFromResponse(response, ctx);

  if (!stream) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmError(`${ctx.providerLabel} returned a response that was not valid JSON.`);
    }
    if (isRecord(payload) && payload.error) {
      throw new LlmError(extractErrorDetail(JSON.stringify(payload)) || "The provider returned an error.");
    }

    const choice =
      isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0])
        ? payload.choices[0]
        : undefined;
    const message = choice && isRecord(choice.message) ? choice.message : {};

    if (typeof message.content === "string" && message.content) {
      yield { type: "delta", text: message.content };
    }
    const calls = dedupeCalls(normalizeToolCalls(message.tool_calls));
    if (calls.length) yield { type: "tool_calls", calls };
    yield {
      type: "done",
      reason: choice && typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
    };
    return;
  }

  if (!response.body) throw new LlmError(`${ctx.providerLabel} returned an empty streaming response.`);
  yield* parseOpenAiStream(response.body);
}

export async function openAiModels(options: ListModelsOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const ctx = context({ baseUrl, providerLabel: options.providerLabel });

  const response = await abortableRequest(
    fetchImpl,
    joinUrl(baseUrl, "/models"),
    { headers: headers(options.apiKey) },
    ctx,
  );
  if (!response.ok) throw await httpErrorFromResponse(response, ctx);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LlmError(`${ctx.providerLabel} returned an unexpected response for /models.`);
  }

  const entries =
    isRecord(payload) && Array.isArray(payload.data) ? payload.data.filter((entry): entry is Record<string, unknown> => isRecord(entry)) : [];

  // OpenRouter-style lists tell us which models can call tools.
  const toolCapable = entries.filter(
    (entry) => Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("tools"),
  );
  const source = toolCapable.length ? toolCapable : entries;

  const names = new Set<string>();
  for (const entry of source) {
    if (typeof entry.id === "string" && entry.id) names.add(entry.id);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
