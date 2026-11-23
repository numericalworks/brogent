import { describe, expect, test } from "bun:test";
import { chatEvents, listModels } from "../src/lib/llm";
import { parseAnthropicStream, toAnthropicMessages } from "../src/lib/llm/anthropic";
import { parseGeminiStream, toGeminiContents, toGeminiSchema } from "../src/lib/llm/gemini";
import { abortableRequest, connectionError, normalizeBaseUrl, parseArguments, sseData } from "../src/lib/llm/http";
import { parseOllamaStream } from "../src/lib/llm/ollama";
import { parseOpenAiStream, toOpenAiMessages } from "../src/lib/llm/openai";
import type { ChatMessage } from "../src/lib/types";

const readPageTool = {
  type: "function" as const,
  function: {
    name: "read_page",
    description: "Read the page",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["text", "html"] } },
      required: [],
    },
  },
};

const baseRequest = {
  baseUrl: "http://localhost:11434",
  apiKey: "",
  model: "test-model",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [] as Array<typeof readPageTool>,
  temperature: 0.2,
  stream: true,
};

const toolConversation: ChatMessage[] = [
  { role: "system", content: "rules" },
  { role: "user", content: "read it" },
  {
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }],
  },
  { role: "tool", content: '{"ok":true}', tool_name: "read_page" },
  { role: "assistant", content: "done" },
];

/* --------------------------------------------------------------- helpers */

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const expectError = async (promise: Promise<unknown>): Promise<Error> => {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
};

/* ------------------------------------------------------------------ http */

describe("normalizeBaseUrl", () => {
  test("adds a scheme and trims trailing slashes", () => {
    expect(normalizeBaseUrl("localhost:11434")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("http://localhost:11434///")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("ollama.com")).toBe("https://ollama.com");
    expect(normalizeBaseUrl("api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("192.168.1.5:1234/v1")).toBe("http://192.168.1.5:1234/v1");
    expect(normalizeBaseUrl("  ")).toBe("");
  });
});

describe("parseArguments", () => {
  test("accepts objects, JSON strings, and plain text", () => {
    expect(parseArguments({ a: 1 })).toEqual({ a: 1 });
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("not json")).toEqual({ input: "not json" });
    expect(parseArguments(undefined)).toEqual({});
  });
});

describe("sseData", () => {
  test("extracts data payloads only", () => {
    expect(sseData('data: {"a":1}')).toBe('{"a":1}');
    expect(sseData("event: message")).toBeNull();
    expect(sseData(": keep-alive")).toBeNull();
    expect(sseData("data:")).toBeNull();
  });
});

describe("errors", () => {
  test("connectionError mentions local servers", () => {
    const error = connectionError(
      { providerLabel: "Ollama", baseUrl: "http://localhost:11434" },
      new TypeError("Failed to fetch"),
    );
    expect(error.message).toContain("local server");
    expect(error.message).toContain("Ollama");
  });

  test("abortableRequest preserves abort errors", async () => {
    const fetchImpl = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;

    await expect(
      abortableRequest(
        fetchImpl,
        "http://x",
        {},
        { providerLabel: "X", baseUrl: "http://x" },
      ),
    ).rejects.toThrow("aborted");
  });
});

/* ---------------------------------------------------------------- ollama */

describe("Ollama adapter", () => {
  test("parses newline-delimited JSON, including split chunks", async () => {
    const body = stream([
      '{"message":{"content":"Hel',
      'lo "},"done":false}\n',
      '{"message":{"content":"world"},"done":false}\n',
      '{"message":{"content":"","tool_calls":[{"function":{"name":"read_page","arguments":{"mode":"text"}}}]},"done":false}\n',
      '{"done":true,"done_reason":"stop"}\n',
    ]);

    const events = await collect(parseOllamaStream(body));
    expect(events).toEqual([
      { type: "delta", text: "Hello " },
      { type: "delta", text: "world" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "stop" },
    ]);
  });

  test("posts to /api/chat and streams", async () => {
    const { fetchImpl, calls } = mockFetch(
      () => new Response('{"message":{"content":"hey"},"done":true}\n', { status: 200 }),
    );

    const events = await collect(chatEvents("ollama", { ...baseRequest, fetchImpl, providerLabel: "Ollama" }));

    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(String(calls[0]!.init?.body)).stream).toBe(true);
    expect(events).toEqual([
      { type: "delta", text: "hey" },
      { type: "done", reason: "stop" },
    ]);
  });

  test("explains models without tool support", async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(JSON.stringify({ error: "registry.ollama.ai/library/x:y does not support tools" }), {
          status: 400,
        }),
    );

    const error = await expectError(collect(chatEvents("ollama", { ...baseRequest, fetchImpl })));
    expect(error.message).toMatch(/does not support tool calling/i);
  });

  test("hints at pulling a missing model", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 }),
    );

    const error = await expectError(
      collect(chatEvents("ollama", { ...baseRequest, model: "ghost:1b", fetchImpl })),
    );
    expect(error.message).toContain("ollama pull ghost:1b");
  });

  test("lists models from /api/tags", async () => {
    const { fetchImpl, calls } = mockFetch(
      () => new Response(JSON.stringify({ models: [{ name: "z:1" }, { name: "a:1" }, { name: "a:1" }] })),
    );

    await expect(
      listModels("ollama", { baseUrl: "http://localhost:11434", apiKey: "", fetchImpl }),
    ).resolves.toEqual(["a:1", "z:1"]);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/tags");
  });

  test("parses a non-streaming reply", async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            message: { content: "hi", tool_calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
            done_reason: "stop",
          }),
        ),
    );

    const events = await collect(chatEvents("ollama", { ...baseRequest, stream: false, fetchImpl }));

    expect(events).toEqual([
      { type: "delta", text: "hi" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "stop" },
    ]);
  });
});

/* ---------------------------------------------------------------- openai */

describe("OpenAI adapter", () => {
  test("pairs tool calls with tool results", () => {
    const converted = toOpenAiMessages(toolConversation);
    const assistant = converted[2] as {
      tool_calls: Array<{ id: string; function: { arguments: string } }>;
    };
    const tool = converted[3] as { role: string; tool_call_id: string; content: string };

    expect(converted[0]).toEqual({ role: "system", content: "rules" });
    expect(assistant.tool_calls).toHaveLength(1);
    expect(JSON.parse(assistant.tool_calls[0]!.function.arguments)).toEqual({ mode: "text" });
    expect(tool).toEqual({
      role: "tool",
      tool_call_id: assistant.tool_calls[0]!.id,
      content: '{"ok":true}',
    });
  });

  test("streams text and reassembles fragmented tool arguments", async () => {
    const body = stream([
      sse({ choices: [{ delta: { content: "Hel" } }] }),
      sse({ choices: [{ delta: { content: "lo" } }] }),
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", type: "function", function: { name: "read_page", arguments: '{"mo' } },
              ],
            },
          },
        ],
      }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'de":"text"}' } }] } }] }),
      "data: [DONE]\n\n",
    ]);

    const events = await collect(parseOpenAiStream(body));

    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "stop" },
    ]);
  });

  test("sends tools and translates a non-streaming reply", async () => {
    const { fetchImpl, calls } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "ok",
                  tool_calls: [
                    { id: "c1", type: "function", function: { name: "read_page", arguments: '{"mode":"text"}' } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        ),
    );

    const events = await collect(
      chatEvents("openai", {
        ...baseRequest,
        baseUrl: "https://api.example/v1",
        apiKey: "sk",
        providerLabel: "Example",
        tools: [readPageTool],
        stream: false,
        fetchImpl,
      }),
    );

    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(calls[0]!.url).toBe("https://api.example/v1/chat/completions");
    expect(body.model).toBe("test-model");
    expect(body.tools[0].function.name).toBe("read_page");
    expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bearer sk");
    expect(events).toEqual([
      { type: "delta", text: "ok" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "tool_calls" },
    ]);
  });

  test("retries without temperature when the model rejects it", async () => {
    let attempt = 0;
    const { fetchImpl, calls } = mockFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({
            error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
      );
    });

    const events = await collect(
      chatEvents("openai", {
        ...baseRequest,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk",
        providerLabel: "OpenAI",
        stream: false,
        fetchImpl,
      }),
    );

    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]!.init?.body)).temperature).toBeUndefined();
    expect(events[0]).toEqual({ type: "delta", text: "ok" });
  });

  test("labels errors with the provider name", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    );

    const error = await expectError(
      collect(
        chatEvents("openai", {
          ...baseRequest,
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey: "x",
          providerLabel: "Groq",
          fetchImpl,
        }),
      ),
    );
    expect(error.message).toContain("Groq rejected the credentials");
  });

  test("filters OpenRouter-style model lists to tool-capable models", async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "a/plain" },
              { id: "b/tools", supported_parameters: ["temperature", "tools"] },
            ],
          }),
        ),
    );

    await expect(
      listModels("openai", { baseUrl: "https://openrouter.ai/api/v1", apiKey: "x", fetchImpl }),
    ).resolves.toEqual(["b/tools"]);
  });
});

/* ------------------------------------------------------------- anthropic */

describe("Anthropic adapter", () => {
  test("moves tool results into a user message", () => {
    const { system, messages } = toAnthropicMessages(toolConversation);

    expect(system).toBe("rules");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);

    const assistantBlocks = messages[1]!.content;
    const toolUse = assistantBlocks.find((block) => block.type === "tool_use") as Record<string, unknown>;
    expect(toolUse).toMatchObject({ type: "tool_use", name: "read_page", input: { mode: "text" } });

    expect(messages[2]!.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: '{"ok":true}',
    });
  });

  test("merges consecutive messages with the same role", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toHaveLength(2);
  });

  test("parses streamed text and tool input fragments", async () => {
    const body = stream([
      'event: content_block_start\n',
      `${sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
      `${sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}\n`,
      `${sse({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "read_page", input: {} },
      })}\n`,
      `${sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"mo' } })}\n`,
      `${sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'de":"text"}' } })}\n`,
      `${sse({ type: "message_delta", delta: { stop_reason: "tool_use" } })}\n`,
    ]);

    const events = await collect(parseAnthropicStream(body));

    expect(events).toEqual([
      { type: "delta", text: "Hi" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "tool_use" },
    ]);
  });

  test("sends the Anthropic headers and lists models", async () => {
    const { fetchImpl, calls } = mockFetch(
      () => new Response(JSON.stringify({ data: [{ id: "claude-sonnet" }, { id: "claude-opus" }] })),
    );

    await expect(
      listModels("anthropic", { baseUrl: "https://api.anthropic.com/v1", apiKey: "ak", fetchImpl }),
    ).resolves.toEqual(["claude-opus", "claude-sonnet"]);

    const headers = new Headers(calls[0]!.init?.headers);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(headers.get("x-api-key")).toBe("ak");
    expect(headers.get("anthropic-version")).toBeTruthy();
  });

  test("parses a non-streaming reply", async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "Hi" },
              { type: "tool_use", id: "toolu_1", name: "read_page", input: { mode: "text" } },
            ],
            stop_reason: "tool_use",
          }),
        ),
    );

    const events = await collect(
      chatEvents("anthropic", {
        ...baseRequest,
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "ak",
        tools: [readPageTool],
        stream: false,
        providerLabel: "Anthropic",
        fetchImpl,
      }),
    );

    expect(events).toEqual([
      { type: "delta", text: "Hi" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "tool_use" },
    ]);
  });
});

/* ---------------------------------------------------------------- gemini */

describe("Gemini adapter", () => {
  test("uppercases schema types and drops unsupported keys", () => {
    expect(
      toGeminiSchema({
        type: "object",
        properties: { mode: { type: "string", enum: ["text"] } },
        required: [],
        additionalProperties: false,
      }),
    ).toEqual({ type: "OBJECT", properties: { mode: { type: "STRING", enum: ["text"] } } });
  });

  test("converts tool results into functionResponse parts", () => {
    const { system, contents } = toGeminiContents(toolConversation);

    expect(system).toBe("rules");
    expect(contents.map((content) => content.role)).toEqual(["user", "model", "user", "model"]);

    const call = contents[1]!.parts[0] as { functionCall: Record<string, unknown> };
    const response = contents[2]!.parts[0] as { functionResponse: Record<string, unknown> };
    expect(call.functionCall).toMatchObject({ name: "read_page", args: { mode: "text" } });
    expect(response.functionResponse).toMatchObject({ name: "read_page", response: { ok: true } });
    expect(response.functionResponse.id).toBe(call.functionCall.id);
  });

  test("streams text and function calls", async () => {
    const body = stream([
      sse({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }),
      sse({
        candidates: [
          {
            content: { parts: [{ functionCall: { id: "c1", name: "read_page", args: { mode: "text" } } }] },
            finishReason: "STOP",
          },
        ],
      }),
    ]);

    const events = await collect(parseGeminiStream(body));

    expect(events).toEqual([
      { type: "delta", text: "Hi" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "stop" },
    ]);
  });

  test("uses the streamGenerateContent endpoint", async () => {
    const { fetchImpl, calls } = mockFetch(
      () => new Response(stream([sse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })])),
    );

    const events = await collect(
      chatEvents("gemini", {
        ...baseRequest,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gk",
        model: "gemini-2.5-pro",
        providerLabel: "Google Gemini",
        fetchImpl,
      }),
    );

    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
    expect(new Headers(calls[0]!.init?.headers).get("x-goog-api-key")).toBe("gk");
    expect(events[0]).toEqual({ type: "delta", text: "ok" });
  });

  test("filters models that cannot generate content", async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            models: [
              { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
              { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
              { name: "models/gemini-2.5-flash" },
            ],
          }),
        ),
    );

    await expect(
      listModels("gemini", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gk",
        fetchImpl,
      }),
    ).resolves.toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
  });

  test("parses a non-streaming reply", async () => {
    const { fetchImpl, calls } = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: "Hi" },
                    { functionCall: { id: "c1", name: "read_page", args: { mode: "text" } } },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          }),
        ),
    );

    const events = await collect(
      chatEvents("gemini", {
        ...baseRequest,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gk",
        model: "gemini-2.5-pro",
        tools: [readPageTool],
        stream: false,
        providerLabel: "Google Gemini",
        fetchImpl,
      }),
    );

    expect(calls[0]!.url).toContain(":generateContent");
    expect(events).toEqual([
      { type: "delta", text: "Hi" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "stop" },
    ]);
  });
});
