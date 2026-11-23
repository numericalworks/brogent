import type { AgentEvent } from "./agent";
import type { ProviderId } from "./providers";
import type { AppConfig, ChatMessage } from "./types";

export type PanelRequest =
  | { type: "ping" }
  | { type: "chat"; messages: ChatMessage[]; tabId?: number }
  | { type: "abort" }
  | { type: "models"; provider: ProviderId; baseUrl: string; apiKey: string }
  | { type: "confirm"; id: string; approved: boolean };

export type BackgroundEvent =
  | AgentEvent
  | { type: "ready"; config: AppConfig }
  | { type: "models"; provider: ProviderId; models: string[]; error?: string }
  | { type: "confirm_request"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "busy" }
  | { type: "pong" };

export const PORT_NAME = "brogent";
