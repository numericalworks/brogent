import { describe, expect, test } from "bun:test";
import {
  OllamaError,
  chatEvents,
  isCloudEndpoint,
  listModels,
  normalizeBaseUrl,
  parseChatStream,
  type ChatEvent,
} from "../src/lib/ollama";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(generator: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("parseChatStream", () => {
  test("reassembles JSON lines split across chunks", async () => {
    const events = await collect(
      parseChatStream(
        stream([
          '{"message":{"content":"Hel',
          'lo "}',
          ',"done":false}\n',
          '{"message":{"content":"world"},"done":false}\n',
          '{"message":{"content":"","tool_calls":[{"function":{"name":"read_page","arguments":{"mode":"text"}}}]},"done":false}\n',
          '{"done":true,"done_reason":"stop"}\n',
        ]),
      ),
    );

    expect(events).toEqual([
      { type: "delta", text: "Hello " },
      { type: "delta", text: "world" },
      { type: "tool_calls", calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }] },
      { type: "done", reason: "stop" },
    ]);
  });

  test("accepts SSE frames and ignores keep-alives", async () => {
    const events = await collect(
      parseChatStream(
        stream(['data: {"message":{"content":"hi"}}\n\n', "event: ping\n", "data: [DONE]\n"]),
      ),
    );

    expect(events).toEqual([
      { type: "delta", text: "hi" },
      { type: "done", reason: "stop" },
    ]);
  });

  test("parses string tool arguments", async () => {
    const events = await collect(
      parseChatStream(
        stream([
          '{"message":{"tool_calls":[{"function":{"name":"execute_javascript","arguments":"{\\"code\\":\\"return 1\\"}"}}]},"done":true}\n',
        ]),
      ),
    );

    expect(events[0]).toEqual({
      type: "tool_calls",
      calls: [{ function: { name: "execute_javascript", arguments: { code: "return 1" } } }],
    });
  });

  test("deduplicates repeated tool calls", async () => {
    const chunk =
      '{"message":{"tool_calls":[{"function":{"name":"read_page","arguments":{}}}]},"done":false}\n';
    const events = await collect(parseChatStream(stream([chunk, chunk])));
    const toolCalls = events.filter((event) => event.type === "tool_calls");
    expect(toolCalls).toHaveLength(1);
  });

  test("surfaces mid-stream errors", async () => {
    const generator = parseChatStream(stream(['{"error":"model crashed"}\n']));
    await expect(collect(generator)).rejects.toThrow("model crashed");
  });
});

describe("chatEvents", () => {
  const base = {
    baseUrl: "http://localhost:11434/",
    model: "llama3.1:8b",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  test("posts to /api/chat and streams deltas", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? "");
      return new Response('{"message":{"content":"hey"},"done":true}\n', { status: 200 });
    }) as unknown as typeof fetch;

    const events = await collect(chatEvents({ ...base, fetchImpl }));

    expect(seenUrl).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(seenBody).stream).toBe(true);
    expect(events).toEqual([
      { type: "delta", text: "hey" },
      { type: "done", reason: "stop" },
    ]);
  });

  test("supports non-streaming responses and sends the API key", async () => {
    let authorization: string | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get("Authorization") ?? undefined;
      return new Response(
        JSON.stringify({ message: { content: "done", tool_calls: [] }, done_reason: "stop" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const events = await collect(
      chatEvents({ ...base, baseUrl: "https://ollama.com", apiKey: "secret", stream: false, fetchImpl }),
    );

    expect(authorization).toBe("Bearer secret");
    expect(events).toEqual([
      { type: "delta", text: "done" },
      { type: "done", reason: "stop" },
    ]);
  });

  test("explains models without tool support", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "registry.ollama.ai/library/x:y does not support tools" }), {
        status: 400,
      })) as unknown as typeof fetch;

    const error = await collect(chatEvents({ ...base, fetchImpl })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OllamaError);
    expect((error as Error).message).toMatch(/does not support tool calling/i);
  });

  test("explains an unreachable local server", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const error = await collect(chatEvents({ ...base, fetchImpl })).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/ollama serve/);
  });

  test("explains a missing model", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 })) as unknown as typeof fetch;
    const error = await collect(chatEvents({ ...base, model: "ghost:1b", fetchImpl })).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain("ollama pull ghost:1b");
  });
});

describe("normalizeBaseUrl", () => {
  test("adds a scheme and trims trailing slashes", () => {
    expect(normalizeBaseUrl("localhost:11434")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("http://localhost:11434///")).toBe("http://localhost:11434");
    expect(normalizeBaseUrl("ollama.com")).toBe("https://ollama.com");
    expect(normalizeBaseUrl("  ")).toBe("http://localhost:11434");
  });

  test("detects Ollama Cloud hosts", () => {
    expect(isCloudEndpoint("https://ollama.com")).toBe(true);
    expect(isCloudEndpoint("http://localhost:11434")).toBe(false);
  });
});

describe("listModels", () => {
  test("returns sorted unique model names", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ name: "z:1" }, { name: "a:1" }, { name: "a:1" }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(listModels({ baseUrl: "http://localhost:11434", fetchImpl })).resolves.toEqual([
      "a:1",
      "z:1",
    ]);
  });
});
