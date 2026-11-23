import type { ChatMessage } from "./types";

/**
 * Repairs a conversation before it is sent back to Ollama.
 *
 * A history is only valid for a tool-calling chat if every assistant message
 * with `tool_calls` is followed by exactly one `tool` message per call. Runs
 * that were aborted or that failed mid-tool can leave dangling entries behind,
 * which makes Ollama reject the whole request.
 */
export function sanitizeHistory(input: ChatMessage[]): ChatMessage[] {
  const output: ChatMessage[] = [];
  let index = 0;

  while (index < input.length) {
    const message = input[index]!;

    if (message.role === "system") {
      index += 1;
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      const required = message.tool_calls.length;
      const responses: ChatMessage[] = [];
      let cursor = index + 1;
      while (cursor < input.length && responses.length < required && input[cursor]!.role === "tool") {
        responses.push(input[cursor]!);
        cursor += 1;
      }

      if (responses.length === required) {
        output.push(message, ...responses);
      } else if (message.content.trim()) {
        // Keep the model's prose, but drop the unfulfilled tool request.
        output.push({ role: "assistant", content: message.content });
      }
      index = cursor;
      continue;
    }

    if (message.role === "tool") {
      // Orphaned tool result with no matching call.
      index += 1;
      continue;
    }

    output.push(message);
    index += 1;
  }

  return output;
}

/**
 * Keeps the tail of a conversation under `maxMessages`, starting at a user
 * message so a tool call group is never split in half.
 */
export function trimHistory(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  let start = messages.length - maxMessages;
  while (start < messages.length && messages[start]!.role !== "user") start += 1;
  return start < messages.length ? messages.slice(start) : messages;
}

/** Drops empty assistant turns that carry neither prose nor tool calls. */
export function isRenderableAssistant(message: ChatMessage): boolean {
  return message.content.trim().length > 0 || Boolean(message.tool_calls?.length);
}
