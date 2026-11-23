import { describe, expect, test } from "bun:test";
import { runAgent, type AgentDeps, type AgentEvent } from "../src/lib/agent";
import type { ChatEvent } from "../src/lib/ollama";

function chatFrom(turns: ChatEvent[][]) {
  let index = 0;
  return async function* (): AsyncGenerator<ChatEvent> {
    const turn = turns[Math.min(index, turns.length - 1)]!;
    index += 1;
    for (const event of turn) yield event;
  };
}

function setup(overrides: Partial<AgentDeps> & { turns: ChatEvent[][] }) {
  const events: AgentEvent[] = [];
  const { turns, ...rest } = overrides;
  const deps: AgentDeps = {
    messages: [{ role: "user", content: "summarize this page" }],
    systemPrompt: "You are a test.",
    maxSteps: 4,
    signal: new AbortController().signal,
    chat: chatFrom(turns),
    executeTool: async () => ({ ok: true, content: '{"ok":true}' }),
    onEvent: (event) => events.push(event),
    ...rest,
  };
  return { deps, events };
}

const readPageCall = {
  type: "tool_calls" as const,
  calls: [{ function: { name: "read_page", arguments: { mode: "text" } } }],
};

describe("runAgent", () => {
  test("executes a tool and finishes on the next assistant turn", async () => {
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { deps, events } = setup({
      turns: [
        [{ type: "delta", text: "Let me look." }, readPageCall, { type: "done", reason: "stop" }],
        [{ type: "delta", text: "It is about cats." }, { type: "done", reason: "stop" }],
      ],
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return { ok: true, content: '{"ok":true,"content":"cats"}' };
      },
    });

    const messages = await runAgent(deps);

    expect(executed).toEqual([{ name: "read_page", args: { mode: "text" } }]);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]?.tool_calls).toHaveLength(1);
    expect(messages[2]).toMatchObject({ role: "tool", tool_name: "read_page" });
    expect(messages[3]?.content).toBe("It is about cats.");

    const done = events.filter((event) => event.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: "done", reason: "stop" });
    expect((done[0] as { messages: unknown[] }).messages).toHaveLength(4);

    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult).toMatchObject({ name: "read_page", ok: true });
  });

  test("does not run a tool the user declined", async () => {
    let executed = false;
    const { deps, events } = setup({
      turns: [
        [{ type: "tool_calls", calls: [{ function: { name: "execute_javascript", arguments: { code: "1" } } }] }, { type: "done", reason: "stop" }],
        [{ type: "delta", text: "Okay, I skipped it." }, { type: "done", reason: "stop" }],
      ],
      confirm: async () => false,
      executeTool: async () => {
        executed = true;
        return { ok: true, content: "{}" };
      },
    });

    const messages = await runAgent(deps);

    expect(executed).toBe(false);
    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toMatch(/declined/i);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({ ok: false });
  });

  test("stops after the step budget", async () => {
    const { deps, events } = setup({
      maxSteps: 2,
      turns: [[readPageCall, { type: "done", reason: "stop" }]],
    });

    await runAgent(deps);

    const done = events.find((event) => event.type === "done");
    expect(done).toMatchObject({ reason: "max_steps" });
    expect(events.filter((event) => event.type === "step")).toHaveLength(2);
  });

  test("reports chat failures as error events", async () => {
    const { deps, events } = setup({
      turns: [],
      chat: async function* () {
        throw new Error("model exploded");
        yield { type: "done", reason: "stop" } as ChatEvent;
      },
    });

    await runAgent(deps);

    expect(events.some((event) => event.type === "error" && /model exploded/.test(event.message))).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  test("does nothing when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let chatted = false;
    const { deps, events } = setup({
      signal: controller.signal,
      turns: [[{ type: "done", reason: "stop" }]],
      chat: async function* () {
        chatted = true;
        yield { type: "done", reason: "stop" } as ChatEvent;
      },
    });

    await runAgent(deps);

    expect(chatted).toBe(false);
    expect(events).toEqual([
      { type: "done", reason: "aborted", messages: [{ role: "user", content: "summarize this page" }] },
    ]);
  });
});
