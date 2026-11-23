import { isAbortError, type ChatEvent } from "./llm";
import type { ChatMessage, ToolCall } from "./types";

export type AgentEvent =
  | { type: "step"; step: number; maxSteps: number }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; message: ChatMessage }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      content: string;
      durationMs: number;
      message: ChatMessage;
    }
  | { type: "done"; reason: string; messages: ChatMessage[] }
  | { type: "error"; message: string };

export interface AgentDeps {
  /** Conversation so far, without the system message. */
  messages: ChatMessage[];
  systemPrompt: string;
  maxSteps: number;
  signal: AbortSignal;
  chat(messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<ChatEvent>;
  executeTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; content: string }>;
  /** Return false to skip a tool call (e.g. the user declined). */
  confirm?(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<boolean>;
  onEvent(event: AgentEvent): void;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function makeToolCallId(step: number, index: number): string {
  return `call_${step}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Runs the model <-> tool loop until the model answers without requesting a
 * tool, the step budget is spent, or the run is aborted.
 */
export async function runAgent(deps: AgentDeps): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [...deps.messages];
  const maxSteps = Math.max(1, deps.maxSteps);

  for (let step = 1; step <= maxSteps; step++) {
    if (deps.signal.aborted) {
      deps.onEvent({ type: "done", reason: "aborted", messages });
      return messages;
    }

    deps.onEvent({ type: "step", step, maxSteps });

    let content = "";
    let calls: ToolCall[] = [];
    let finishReason = "stop";

    try {
      for await (const event of deps.chat([{ role: "system", content: deps.systemPrompt }, ...messages], deps.signal)) {
        if (event.type === "delta") {
          content += event.text;
          deps.onEvent({ type: "assistant_delta", text: event.text });
        } else if (event.type === "tool_calls") {
          calls = event.calls;
        } else if (event.type === "done") {
          finishReason = event.reason;
        }
      }
    } catch (error) {
      if (deps.signal.aborted || isAbortError(error)) {
        deps.onEvent({ type: "done", reason: "aborted", messages });
        return messages;
      }
      deps.onEvent({ type: "error", message: errorText(error) });
      return messages;
    }

    const assistant: ChatMessage = { role: "assistant", content: content.trim() };
    if (calls.length) assistant.tool_calls = calls;
    messages.push(assistant);
    deps.onEvent({ type: "assistant_message", message: assistant });

    if (!calls.length) {
      deps.onEvent({ type: "done", reason: finishReason, messages });
      return messages;
    }

    for (const [index, call] of calls.entries()) {
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      const id = makeToolCallId(step, index);
      deps.onEvent({ type: "tool_start", id, name, args });

      const startedAt = Date.now();
      let ok = true;
      let resultContent = "";
      let skipped = false;

      if (deps.confirm) {
        try {
          if (!(await deps.confirm(name, args, deps.signal))) skipped = true;
        } catch (error) {
          if (deps.signal.aborted) {
            deps.onEvent({ type: "done", reason: "aborted", messages });
            return messages;
          }
          skipped = true;
          resultContent = JSON.stringify({ ok: false, error: errorText(error) });
        }
      }

      if (skipped) {
        ok = false;
        if (!resultContent) {
          resultContent = JSON.stringify({ ok: false, error: "The user declined to run this tool." });
        }
      } else {
        try {
          const result = await deps.executeTool(name, args, deps.signal);
          ok = result.ok;
          resultContent = result.content;
        } catch (error) {
          ok = false;
          resultContent = JSON.stringify({ ok: false, error: errorText(error) });
        }
      }

      const toolMessage: ChatMessage = { role: "tool", content: resultContent, tool_name: name };
      messages.push(toolMessage);
      deps.onEvent({
        type: "tool_result",
        id,
        name,
        ok,
        content: resultContent,
        durationMs: Date.now() - startedAt,
        message: toolMessage,
      });

      if (deps.signal.aborted) {
        deps.onEvent({ type: "done", reason: "aborted", messages });
        return messages;
      }
    }
  }

  deps.onEvent({ type: "done", reason: "max_steps", messages });
  return messages;
}
