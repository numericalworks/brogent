import type { ChatMessage, ToolCall } from "../types";
import {
  LlmError,
  abortableRequest,
  dedupeCalls,
  extractErrorDetail,
  httpErrorFromResponse,
  isRecord,
  joinUrl,
  parseArguments,
  readLines,
  sseData,
} from "./http";
import type { ChatEvent, ChatRequest, ListModelsOptions, LlmTool } from "./types";

const DEFAULT_LABEL = "Google Gemini";

function context(request: { baseUrl: string; model?: string; providerLabel?: string }) {
  return {
    providerLabel: request.providerLabel || DEFAULT_LABEL,
    baseUrl: request.baseUrl,
    model: request.model,
  };
}

function headers(apiKey: string): Record<string, string> {
  const result: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey.trim();
  if (key) result["x-goog-api-key"] = key;
  return result;
}

interface Part extends Record<string, unknown> {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
}

interface Content {
  role: "user" | "model";
  parts: Part[];
}

function toolResponsePayload(content: string): Record<string, unknown> {
  const text = (content || "").trim();
  if (!text) return { result: "" };
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : { result: parsed };
  } catch {
    return { result: content };
  }
}

/** Gemini expects OpenAPI-style uppercase primitive types. */
export function toGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: "OBJECT" };
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "$schema" || key === "default" || key === "strict") continue;
    if (key === "type" && typeof value === "string") {
      output.type = value.toUpperCase();
      continue;
    }
    if (key === "properties" && isRecord(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) properties[name] = toGeminiSchema(child);
      output.properties = properties;
      continue;
    }
    if (key === "items") {
      output.items = toGeminiSchema(value);
      continue;
    }
    if (key === "required" && Array.isArray(value) && !value.length) continue;
    output[key] = value;
  }

  return output;
}

/**
 * Converts the internal transcript into Gemini's `contents` array.
 * Tool results become `functionResponse` parts inside a user turn.
 */
export function toGeminiContents(messages: ChatMessage[]): {
  system: string;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const converted: Content[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;

    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content.trim());
      index += 1;
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      const parts: Part[] = [];
      if (message.content.trim()) parts.push({ text: message.content });

      const ids: string[] = [];
      message.tool_calls.forEach((call, callIndex) => {
        const id = `call_${index}_${callIndex}`;
        ids.push(id);
        parts.push({
          functionCall: { id, name: call.function.name, args: call.function.arguments ?? {} },
        });
      });
      converted.push({ role: "model", parts });

      const responses: Part[] = [];
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor]!.role === "tool" && responses.length < ids.length) {
        const toolMessage = messages[cursor]!;
        responses.push({
          functionResponse: {
            id: ids[responses.length]!,
            name: message.tool_calls[responses.length]!.function.name,
            response: toolResponsePayload(toolMessage.content),
          },
        });
        cursor += 1;
      }
      if (responses.length) converted.push({ role: "user", parts: responses });
      index = cursor;
      continue;
    }

    if (message.role === "assistant") {
      if (message.content.trim()) converted.push({ role: "model", parts: [{ text: message.content }] });
      index += 1;
      continue;
    }

    if (message.role === "tool") {
      index += 1;
      continue;
    }

    converted.push({ role: "user", parts: [{ text: message.content }] });
    index += 1;
  }

  const merged: Content[] = [];
  for (const content of converted) {
    if (!content.parts.length) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.role === content.role) previous.parts.push(...content.parts);
    else merged.push({ role: content.role, parts: [...content.parts] });
  }

  if (!merged.length) merged.push({ role: "user", parts: [{ text: "(empty)" }] });
  else if (merged[0]!.role !== "user") merged.unshift({ role: "user", parts: [{ text: "(continue)" }] });

  return { system: systemParts.join("\n\n"), contents: merged };
}

function toGeminiTools(tools: LlmTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => {
    const declaration: Record<string, unknown> = {
      name: tool.function.name,
      description: tool.function.description,
    };
    const parameters = toGeminiSchema(tool.function.parameters);
    if (Object.keys(parameters).length) declaration.parameters = parameters;
    return declaration;
  });
}

function mapFinishReason(reason: string): string {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  return reason.toLowerCase();
}

interface ParsedParts {
  text: string[];
  calls: ToolCall[];
  finishReason?: string;
}

function readCandidate(chunk: unknown): ParsedParts {
  const result: ParsedParts = { text: [], calls: [] };
  if (!isRecord(chunk)) return result;

  const candidate =
    Array.isArray(chunk.candidates) && isRecord(chunk.candidates[0]) ? chunk.candidates[0] : undefined;
  if (!candidate) return result;

  if (isRecord(candidate.content) && Array.isArray(candidate.content.parts)) {
    for (const raw of candidate.content.parts) {
      if (!isRecord(raw)) continue;
      if (typeof raw.text === "string" && raw.text) result.text.push(raw.text);
      if (isRecord(raw.functionCall) && typeof raw.functionCall.name === "string") {
        result.calls.push({
          function: {
            name: raw.functionCall.name,
            arguments: parseArguments(raw.functionCall.args),
          },
        });
      }
    }
  }

  if (typeof candidate.finishReason === "string" && candidate.finishReason) {
    result.finishReason = mapFinishReason(candidate.finishReason);
  }
  return result;
}

export async function* parseGeminiStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const calls: ToolCall[] = [];
  let finishReason = "stop";

  for await (const line of readLines(body)) {
    const data = sseData(line);
    if (!data) continue;

    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (isRecord(chunk) && chunk.error) {
      throw new LlmError(extractErrorDetail(JSON.stringify(chunk)) || "Gemini reported a streaming error.");
    }

    const parsed = readCandidate(chunk);
    for (const text of parsed.text) yield { type: "delta", text };
    calls.push(...parsed.calls);
    if (parsed.finishReason) finishReason = parsed.finishReason;
  }

  const unique = dedupeCalls(calls);
  if (unique.length) yield { type: "tool_calls", calls: unique };
  yield { type: "done", reason: finishReason };
}

export async function* geminiChat(request: ChatRequest): AsyncGenerator<ChatEvent> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const baseUrl = request.baseUrl.replace(/\/+$/, "");
  const stream = request.stream !== false;
  const ctx = context({ ...request, baseUrl });
  const conversation = toGeminiContents(request.messages);
  const modelId = request.model.replace(/^models\//, "");

  const payload: Record<string, unknown> = {
    contents: conversation.contents,
  };
  if (conversation.system) payload.systemInstruction = { parts: [{ text: conversation.system }] };
  if (request.tools.length) {
    payload.tools = [{ functionDeclarations: toGeminiTools(request.tools) }];
  }
  if (Number.isFinite(request.temperature)) {
    payload.generationConfig = { temperature: Math.min(2, Math.max(0, request.temperature)) };
  }

  const path = stream
    ? `/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`
    : `/models/${encodeURIComponent(modelId)}:generateContent`;

  const response = await abortableRequest(
    fetchImpl,
    joinUrl(baseUrl, path),
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
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new LlmError(`${ctx.providerLabel} returned a response that was not valid JSON.`);
    }
    if (isRecord(parsed) && parsed.error) {
      throw new LlmError(extractErrorDetail(JSON.stringify(parsed)) || "Gemini returned an error.");
    }
    const result = readCandidate(parsed);
    for (const text of result.text) yield { type: "delta", text };
    const calls = dedupeCalls(result.calls);
    if (calls.length) yield { type: "tool_calls", calls };
    yield { type: "done", reason: result.finishReason ?? "stop" };
    return;
  }

  if (!response.body) throw new LlmError(`${ctx.providerLabel} returned an empty streaming response.`);
  yield* parseGeminiStream(response.body);
}

export async function geminiModels(options: ListModelsOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const ctx = context({ baseUrl, providerLabel: options.providerLabel });

  const response = await abortableRequest(
    fetchImpl,
    joinUrl(baseUrl, "/models?pageSize=200"),
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

  const models =
    isRecord(payload) && Array.isArray(payload.models)
      ? payload.models.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];

  const names = new Set<string>();
  for (const model of models) {
    if (typeof model.name !== "string") continue;
    const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
    if (methods.length && !methods.includes("generateContent")) continue;
    names.add(model.name.replace(/^models\//, ""));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
