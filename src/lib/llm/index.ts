import { anthropicChat, anthropicModels } from "./anthropic";
import { geminiChat, geminiModels } from "./gemini";
import { ollamaChat, ollamaModels } from "./ollama";
import { openAiChat, openAiModels } from "./openai";
import type { ChatEvent, ChatRequest, ListModelsOptions, ProviderProtocol } from "./types";

export async function* chatEvents(
  protocol: ProviderProtocol,
  request: ChatRequest,
): AsyncGenerator<ChatEvent> {
  switch (protocol) {
    case "ollama":
      yield* ollamaChat(request);
      return;
    case "openai":
      yield* openAiChat(request);
      return;
    case "anthropic":
      yield* anthropicChat(request);
      return;
    case "gemini":
      yield* geminiChat(request);
      return;
  }
}

export async function listModels(
  protocol: ProviderProtocol,
  options: ListModelsOptions,
): Promise<string[]> {
  switch (protocol) {
    case "ollama":
      return ollamaModels(options);
    case "openai":
      return openAiModels(options);
    case "anthropic":
      return anthropicModels(options);
    case "gemini":
      return geminiModels(options);
  }
}

export { LlmError, isAbortError } from "./http";
export type { ChatEvent, ChatRequest, ListModelsOptions, LlmTool, ProviderProtocol } from "./types";
