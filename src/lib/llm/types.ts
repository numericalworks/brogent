import type { ChatMessage, ToolCall } from "../types";

/** The wire protocols Brogent knows how to speak. */
export type ProviderProtocol = "ollama" | "openai" | "anthropic" | "gemini";

/** One tool in the shape every adapter can translate. */
export interface LlmTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: LlmTool[];
  temperature: number;
  stream: boolean;
  /** Human-readable provider name used in error messages. */
  providerLabel?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Normalized events produced by every adapter. */
export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] }
  | { type: "done"; reason: string };

export interface ListModelsOptions {
  baseUrl: string;
  apiKey: string;
  providerLabel?: string;
  fetchImpl?: typeof fetch;
}
