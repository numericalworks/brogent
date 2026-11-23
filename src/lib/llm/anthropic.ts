import type { ChatMessage } from "../types";
import {
  LlmError,
  abortableRequest,
  extractErrorDetail,
  httpErrorFromResponse,
  isRecord,
  joinUrl,
  parseArguments,
  readLines,
  sseData,
} from "./http";
import type { ChatEvent, ChatRequest, ListModelsOptions, LlmTool } from "./types";

const DEFAULT_LABEL = "Anthropic";
const MAX_OUTPUT_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";

function context(request: { baseUrl: string; model?: string; providerLabel?: string }) {
  return {
    providerLabel: request.providerLabel || DEFAULT_LABEL,
    baseUrl: request.baseUrl,
    model: request.model,
  };
}

function headers(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    // Required for direct browser/extension access to the API.
    "anthropic-dangerous-direct-browser-access": "true",
    ...(apiKey.trim() ? { "x-api-key": apiKey.trim() } : {}),
  };
}

interface Block extends Record<string, unknown> {
  type: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

function textBlocks(content: string): Block[] {
  return content.trim() ? [{ type: "text", text: content }] : [];
}

/**
 * Converts the internal transcript into Anthropic's block format.
 *
 * Tool results must be sent as `tool_result` blocks inside a *user* message,
 * and consecutive messages of the same role are merged because Anthropic
 * expects the roles to alternate.
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;

    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content.trim());
      index += 1;
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      const blocks: Block[] = textBlocks(message.content);
      const ids: string[] = [];

      message.tool_calls.forEach((call, callIndex) => {
        const id = `toolu_${index}_${callIndex}`;
        ids.push(id);
        blocks.push({
          type: "tool_use",
          id,
          name: call.function.name,
          input: call.function.arguments ?? {},
        });
      });

      converted.push({ role: "assistant", content: blocks });

      const results: Block[] = [];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor]!.role === "tool" && results.length < ids.length) {
        const toolMessage = messages[cursor]!;
        results.push({
          type: "tool_result",
          tool_use_id: ids[results.length]!,
          content: toolMessage.content || "(no output)",
        });
        cursor += 1;
      }
      if (results.length) converted.push({ role: "user", content: results });
      index = cursor;
      continue;
    }

    if (message.role === "assistant") {
      const blocks = textBlocks(message.content);
      if (blocks.length) converted.push({ role: "assistant", content: blocks });
      index += 1;
      continue;
    }

    if (message.role === "tool") {
      // Orphaned result; history sanitising normally prevents this.
      index += 1;
      continue;
    }

    converted.push({ role: "user", content: textBlocks(message.content) });
    index += 1;
  }

  const merged: AnthropicMessage[] = [];
  for (const message of converted) {
    if (!message.content.length) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }

  if (!merged.length) {
    merged.push({ role: "user", content: [{ type: "text", text: "(empty)" }] });
  } else if (merged[0]!.role !== "user") {
    merged.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }

  return { system: systemParts.join("\n\n"), messages: merged };
}

function toAnthropicTools(tools: LlmTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

/** Parses Anthropic's `event:`/`data:` SSE stream. */
export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const toolBlocks = new Map<number, { name: string; json: string; input?: unknown }>();
  let finishReason = "end_turn";

  for await (const line of readLines(body)) {
    const data = sseData(line);
    if (!data) continue;

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) continue;
      event = parsed;
    } catch {
      continue;
    }

    if (event.type === "error") {
      const error = isRecord(event.error) ? event.error : undefined;
      const message =
        (typeof error?.message === "string" && error.message) ||
        extractErrorDetail(JSON.stringify(event)) ||
        "Anthropic reported a streaming error.";
      throw new LlmError(message);
    }

    if (event.type === "content_block_start" && isRecord(event.content_block)) {
      const block = event.content_block;
      if (block.type === "tool_use" && typeof event.index === "number") {
        toolBlocks.set(event.index, {
          name: typeof block.name === "string" ? block.name : "",
          json: "",
          input: block.input,
        });
      }
      continue;
    }

    if (event.type === "content_block_delta" && isRecord(event.delta)) {
      const delta = event.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        yield { type: "delta", text: delta.text };
      } else if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string" &&
        typeof event.index === "number"
      ) {
        const block = toolBlocks.get(event.index);
        if (block) block.json += delta.partial_json;
      }
      continue;
    }

    if (event.type === "message_delta" && isRecord(event.delta)) {
      if (typeof event.delta.stop_reason === "string" && event.delta.stop_reason) {
        finishReason = event.delta.stop_reason;
      }
    }
  }

  const calls = [...toolBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, block]) => block.name)
    .map(([, block]) => ({
      function: {
        name: block.name,
        arguments: block.json.trim()
          ? parseArguments(block.json)
          : isRecord(block.input)
            ? block.input
            : {},
      },
    }));

  if (calls.length) yield { type: "tool_calls", calls };
  yield { type: "done", reason: finishReason };
}

export async function* anthropicChat(request: ChatRequest): AsyncGenerator<ChatEvent> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const baseUrl = request.baseUrl.replace(/\/+$/, "");
  const stream = request.stream !== false;
  const ctx = context({ ...request, baseUrl });
  const conversation = toAnthropicMessages(request.messages);

  const payload: Record<string, unknown> = {
    model: request.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: conversation.messages,
    stream,
  };
  if (conversation.system) payload.system = conversation.system;
  if (request.tools.length) payload.tools = toAnthropicTools(request.tools);
  if (Number.isFinite(request.temperature)) {
    payload.temperature = Math.min(1, Math.max(0, request.temperature));
  }

  const response = await abortableRequest(
    fetchImpl,
    joinUrl(baseUrl, "/messages"),
    {
      method: "POST",
      headers: headers(request.apiKey),
      body: JSON.stringify(payload),
      signal: request.signal,
    },
    ctx,
  );

  if (!response.ok) throw await httpErrorFromResponse(response, ctx);

  if (!stream) {
    let payloadJson: unknown;
    try {
      payloadJson = await response.json();
    } catch {
      throw new LlmError(`${ctx.providerLabel} returned a response that was not valid JSON.`);
    }
    if (!isRecord(payloadJson)) throw new LlmError(`${ctx.providerLabel} returned an unexpected response.`);
    if (payloadJson.error) {
      throw new LlmError(extractErrorDetail(JSON.stringify(payloadJson)) || "Anthropic returned an error.");
    }

    const blocks = Array.isArray(payloadJson.content) ? payloadJson.content : [];
    const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
    for (const raw of blocks) {
      if (!isRecord(raw)) continue;
      if (raw.type === "text" && typeof raw.text === "string" && raw.text) {
        yield { type: "delta", text: raw.text };
      } else if (raw.type === "tool_use" && typeof raw.name === "string") {
        calls.push({ function: { name: raw.name, arguments: parseArguments(raw.input) } });
      }
    }
    if (calls.length) yield { type: "tool_calls", calls };
    yield {
      type: "done",
      reason: typeof payloadJson.stop_reason === "string" ? payloadJson.stop_reason : "stop",
    };
    return;
  }

  if (!response.body) throw new LlmError(`${ctx.providerLabel} returned an empty streaming response.`);
  yield* parseAnthropicStream(response.body);
}

export async function anthropicModels(options: ListModelsOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const ctx = context({ baseUrl, providerLabel: options.providerLabel });

  const response = await abortableRequest(
    fetchImpl,
    joinUrl(baseUrl, "/models?limit=100"),
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

  const data =
    isRecord(payload) && Array.isArray(payload.data)
      ? payload.data.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];

  const names = new Set<string>();
  for (const entry of data) {
    if (typeof entry.id === "string" && entry.id) names.add(entry.id);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
