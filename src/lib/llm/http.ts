import type { ToolCall } from "../types";

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adds a scheme when missing and drops trailing slashes. Empty stays empty. */
export function normalizeBaseUrl(input: string): string {
  let url = (input || "").trim();
  if (!url) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const authority = url.split(/[/?#]/)[0] ?? "";
    const host = authority.replace(/:\d+$/, "");
    const isLocal =
      /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|[\w.-]+\.local)$/i.test(host);
    url = `${isLocal ? "http" : "https"}://${url}`;
  }
  return url.replace(/\/+$/, "");
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export function isLocalUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(baseUrl);
}

/** Yields non-empty lines from a streamed response. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield line;
        newline = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const last = buffer.replace(/\r$/, "");
    if (last.trim()) yield last;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

/** Extracts the payload of an SSE `data:` line. */
export function sseData(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  return data || null;
}

export interface ErrorContext {
  providerLabel: string;
  baseUrl: string;
  model?: string;
}

export function extractErrorDetail(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const error = json.error;
    const candidates: unknown[] = [
      isRecord(error) ? error.message : typeof error === "string" ? error : undefined,
      isRecord(error) && isRecord(error.error) ? error.error.message : undefined,
      json.message,
      json.detail,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 600);
    }
    if (isRecord(error)) {
      const type = error.type ?? error.status ?? error.code;
      if (typeof type === "string") return type;
    }
    return text.slice(0, 600);
  } catch {
    return text.slice(0, 600);
  }
}

export async function httpErrorFromResponse(response: Response, context: ErrorContext): Promise<LlmError> {
  let body = "";
  try {
    body = (await response.text()).slice(0, 1200);
  } catch {
    // ignore
  }

  const detail = extractErrorDetail(body);
  const suffix = detail ? ` ${detail}` : "";
  const status = response.status;
  const label = context.providerLabel;

  if (status === 401 || status === 403) {
    return new LlmError(`${label} rejected the credentials (HTTP ${status}). Check the API key in settings.${suffix}`);
  }
  if (status === 429) {
    return new LlmError(
      `${label} rate-limited the request (HTTP 429). Wait a moment, or check your plan and credits.${suffix}`,
    );
  }
  if (status === 402 || /quota|credit|billing|insufficient/i.test(detail)) {
    return new LlmError(`${label} says the account is out of quota or credits.${suffix}`);
  }
  if (/does not support tools|tools? (are|is) not supported|tool calling is not supported/i.test(detail)) {
    return new LlmError(
      `The model "${context.model ?? ""}" does not support tool calling, which Brogent needs. Pick a different model.${suffix}`,
    );
  }
  if (status === 404) {
    const model = context.model ? ` The model "${context.model}" may not exist for this provider.` : "";
    return new LlmError(`${label} could not find the requested resource (HTTP 404).${model}${suffix}`);
  }

  const reason = response.statusText ? ` ${response.statusText}` : "";
  return new LlmError(`${label} returned HTTP ${status}${reason}.${suffix}`);
}

export function connectionError(context: ErrorContext, error: unknown): LlmError {
  const detail = error instanceof Error ? error.message : String(error);
  const where = context.baseUrl ? ` at ${context.baseUrl}` : "";
  const hint = isLocalUrl(context.baseUrl)
    ? " Make sure the local server is running and the port is correct."
    : " Check your internet connection, the base URL, and the provider's status page.";
  return new LlmError(`Could not reach ${context.providerLabel}${where}.${hint} (${detail})`);
}

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : { input: parsed };
    } catch {
      return { input: raw };
    }
  }
  return isRecord(raw) ? raw : {};
}

export function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!isRecordArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const fn = isRecord(entry) && isRecord(entry.function) ? entry.function : undefined;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) continue;
    calls.push({ function: { name, arguments: parseArguments(fn?.arguments) } });
  }
  return calls;
}

export function dedupeCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = JSON.stringify(call.function);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function abortableRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  context: ErrorContext,
): Promise<Response> {
  return fetchImpl(url, init).catch((error: unknown) => {
    if (isAbortError(error)) throw error;
    throw connectionError(context, error);
  });
}
