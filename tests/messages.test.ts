import { describe, expect, test } from "bun:test";
import { sanitizeHistory, trimHistory } from "../src/lib/messages";
import type { ChatMessage } from "../src/lib/types";

const call = { function: { name: "read_page", arguments: { mode: "text" } } };

describe("sanitizeHistory", () => {
  test("drops system messages and orphaned tool results", () => {
    const input: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "tool", content: "orphan", tool_name: "read_page" },
      { role: "user", content: "hi" },
    ];

    expect(sanitizeHistory(input)).toEqual([{ role: "user", content: "hi" }]);
  });

  test("keeps complete tool groups", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "read it" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "page text", tool_name: "read_page" },
      { role: "assistant", content: "done" },
    ];

    expect(sanitizeHistory(input)).toEqual(input);
  });

  test("drops an incomplete tool group but keeps the prose", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "read it" },
      { role: "assistant", content: "Let me check.", tool_calls: [call] },
    ];

    expect(sanitizeHistory(input)).toEqual([
      { role: "user", content: "read it" },
      { role: "assistant", content: "Let me check." },
    ]);
  });

  test("drops an incomplete tool group entirely when there is no prose", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "read it" },
      { role: "assistant", content: "", tool_calls: [call, { function: { name: "execute_javascript", arguments: {} } }] },
      { role: "tool", content: "one result", tool_name: "read_page" },
    ];

    expect(sanitizeHistory(input)).toEqual([{ role: "user", content: "read it" }]);
  });
});

describe("trimHistory", () => {
  test("returns short histories untouched", () => {
    const input: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(trimHistory(input, 10)).toBe(input);
  });

  test("starts the trimmed history at a user message", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a" },
      { role: "user", content: "two" },
      { role: "assistant", content: "b" },
      { role: "user", content: "three" },
      { role: "assistant", content: "c" },
    ];

    const trimmed = trimHistory(input, 3);

    expect(trimmed.map((message) => message.content)).toEqual(["three", "c"]);
  });

  test("does not split a tool group", () => {
    const input: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a" },
      { role: "user", content: "two" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "result", tool_name: "read_page" },
      { role: "assistant", content: "b" },
      { role: "user", content: "three" },
      { role: "assistant", content: "c" },
    ];

    const trimmed = trimHistory(input, 4);

    expect(trimmed.map((message) => message.content)).toEqual(["three", "c"]);
  });
});
