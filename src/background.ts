import { runAgent } from "./lib/agent";
import { chatEvents, listModels } from "./lib/llm";
import { normalizeBaseUrl } from "./lib/llm/http";
import { sanitizeHistory, trimHistory } from "./lib/messages";
import {
  buildExecuteJobScript,
  buildJobCleanupScript,
  buildJobPollScript,
  buildReadPageScript,
} from "./lib/page-scripts";
import type { BackgroundEvent, PanelRequest } from "./lib/protocol";
import { PORT_NAME } from "./lib/protocol";
import { getProvider, resolveProvider } from "./lib/providers";
import { EXECUTE_JAVASCRIPT, READ_PAGE, TOOL_DEFINITIONS, isKnownTool, mutatingTool } from "./lib/tools";
import { CONFIG_KEY, DEFAULT_CONFIG, normalizeConfig, type AppConfig, type ToolResult } from "./lib/types";

const MAX_TOOL_CONTENT = 60_000;
const MAX_HISTORY_MESSAGES = 80;
const SCRIPT_TIMEOUT_MS = 120_000;
const MAX_SCRIPT_LENGTH = 40_000;

interface Session {
  port: browser.runtime.Port;
  running: boolean;
  controller?: AbortController;
  pendingConfirms: Map<string, (approved: boolean) => void>;
}

browser.browserAction.onClicked.addListener(() => {
  void browser.sidebarAction.open();
});

async function loadConfig(): Promise<AppConfig> {
  try {
    const stored = await browser.storage.local.get(CONFIG_KEY);
    return normalizeConfig(stored[CONFIG_KEY] as Partial<AppConfig> | undefined);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function getActiveTab(): Promise<browser.tabs.Tab | null> {
  try {
    let tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

function post(port: browser.runtime.Port, event: BackgroundEvent): void {
  try {
    port.postMessage(event);
  } catch {
    // The sidebar went away; nothing to do.
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters]`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function friendlyPageError(error: unknown): string {
  const message = errorText(error);
  if (/Missing host permission|does not have permission|not allowed|not permitted/i.test(message)) {
    return `${message} Firefox blocks extensions on some pages (about:, addons.mozilla.org, the PDF viewer, and other built-in pages). Open a normal web page and try again.`;
  }
  if (/SyntaxError|parse/i.test(message)) {
    return `The injected script could not be parsed: ${message}`;
  }
  return message;
}

async function inject(tabId: number, code: string): Promise<unknown> {
  const results = await browser.tabs.executeScript(tabId, { code, runAt: "document_idle" });
  return Array.isArray(results) ? results[0] : undefined;
}

function parseInjected(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readPage(tabId: number, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = parseInjected(await inject(tabId, buildReadPageScript(args)));
  if (!isRecord(parsed)) {
    return {
      ok: false,
      content: JSON.stringify({ ok: false, error: "The page did not return a readable result." }),
    };
  }
  return { ok: Boolean(parsed.ok), content: truncate(JSON.stringify(parsed), MAX_TOOL_CONTENT) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function executeJavascript(
  tabId: number,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim()) {
    return { ok: false, content: JSON.stringify({ ok: false, error: "No code was provided." }) };
  }
  if (code.length > MAX_SCRIPT_LENGTH) {
    return {
      ok: false,
      content: JSON.stringify({
        ok: false,
        error: `The script is too long (${code.length} characters, limit ${MAX_SCRIPT_LENGTH}).`,
      }),
    };
  }

  const jobKey = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await inject(tabId, buildExecuteJobScript(code, jobKey));

  const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
  let delay = 25;

  for (;;) {
    if (signal.aborted) {
      await inject(tabId, buildJobCleanupScript(jobKey)).catch(() => undefined);
      return { ok: false, content: JSON.stringify({ ok: false, error: "The run was stopped." }) };
    }

    const state = parseInjected(await inject(tabId, buildJobPollScript(jobKey)));
    if (!isRecord(state)) {
      return {
        ok: false,
        content: JSON.stringify({
          ok: false,
          error: "The script's state was lost — the page probably navigated or reloaded while the script was running.",
        }),
      };
    }
    if (state.status === "done") {
      const payload = state.ok
        ? { ok: true, result: state.result }
        : { ok: false, error: state.error };
      return { ok: Boolean(state.ok), content: truncate(JSON.stringify(payload), MAX_TOOL_CONTENT) };
    }

    if (Date.now() > deadline) {
      await inject(tabId, buildJobCleanupScript(jobKey)).catch(() => undefined);
      return {
        ok: false,
        content: JSON.stringify({
          ok: false,
          error: `The script did not finish within ${SCRIPT_TIMEOUT_MS / 1000} seconds.`,
        }),
      };
    }

    await sleep(delay);
    delay = Math.min(250, Math.round(delay * 1.6));
  }
}

async function runTool(
  tabId: number,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!isKnownTool(name)) {
    return {
      ok: false,
      content: JSON.stringify({
        ok: false,
        error: `Unknown tool "${name}". Available tools: ${READ_PAGE}, ${EXECUTE_JAVASCRIPT}.`,
      }),
    };
  }

  try {
    if (name === READ_PAGE) return await readPage(tabId, args);
    return await executeJavascript(tabId, args, signal);
  } catch (error) {
    return { ok: false, content: JSON.stringify({ ok: false, error: friendlyPageError(error) }) };
  }
}

function askForConfirmation(
  session: Session,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const id = crypto.randomUUID();
    const finish = (approved: boolean) => {
      session.pendingConfirms.delete(id);
      signal.removeEventListener("abort", onAbort);
      resolve(approved);
    };
    const onAbort = () => finish(false);
    session.pendingConfirms.set(id, finish);
    signal.addEventListener("abort", onAbort, { once: true });
    post(session.port, { type: "confirm_request", id, tool, args });
  });
}

async function startChat(session: Session, request: Extract<PanelRequest, { type: "chat" }>): Promise<void> {
  const port = session.port;
  if (session.running) {
    post(port, { type: "busy" });
    return;
  }

  // Reserve the session immediately so two quick messages cannot race.
  session.running = true;
  const controller = new AbortController();
  session.controller = controller;

  try {
    const config = await loadConfig();
    const resolved = resolveProvider(config);

    if (!resolved.baseUrl) {
      post(port, {
        type: "error",
        message: "The custom provider needs a base URL, for example http://localhost:8000/v1.",
      });
      return;
    }
    if (resolved.definition.apiKeyRequired && !resolved.apiKey) {
      post(port, {
        type: "error",
        message: `${resolved.definition.label} needs an API key. Add one in settings.`,
      });
      return;
    }
    if (!resolved.model) {
      post(port, {
        type: "error",
        message: `No model is selected for ${resolved.definition.label}. Open settings and fetch the model list.`,
      });
      return;
    }

    const tab =
      request.tabId != null ? await browser.tabs.get(request.tabId).catch(() => null) : await getActiveTab();
    if (!tab || tab.id == null) {
      post(port, {
        type: "error",
        message: "There is no active tab to work on. Open a web page and try again.",
      });
      return;
    }

    const tabId = tab.id;
    const history = trimHistory(
      sanitizeHistory(Array.isArray(request.messages) ? request.messages : []),
      MAX_HISTORY_MESSAGES,
    );

    await runAgent({
      messages: history,
      systemPrompt: config.systemPrompt,
      maxSteps: Math.min(20, Math.max(1, Math.round(config.maxSteps || DEFAULT_CONFIG.maxSteps))),
      signal: controller.signal,
      chat: (messages, signal) =>
        chatEvents(resolved.definition.protocol, {
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          model: resolved.model,
          messages,
          tools: TOOL_DEFINITIONS,
          temperature: config.temperature,
          stream: config.stream,
          providerLabel: resolved.definition.label,
          signal,
        }),
      executeTool: (name, args, signal) => runTool(tabId, name, args, signal),
      confirm: config.confirmScripts
        ? async (name, args, signal) => (mutatingTool(name) ? askForConfirmation(session, name, args, signal) : true)
        : undefined,
      onEvent: (event) => post(port, event),
    });
  } catch (error) {
    post(port, { type: "error", message: errorText(error) });
  } finally {
    session.running = false;
    session.controller = undefined;
  }
}

async function handleMessage(session: Session, message: PanelRequest): Promise<void> {
  switch (message.type) {
    case "ping":
      post(session.port, { type: "pong" });
      return;

    case "models": {
      const definition = getProvider(message.provider);
      const baseUrl = normalizeBaseUrl(message.baseUrl || definition.defaultBaseUrl);
      if (!baseUrl) {
        post(session.port, {
          type: "models",
          provider: definition.id,
          models: [],
          error: "Set a base URL for this provider.",
        });
        return;
      }
      try {
        const models = await listModels(definition.protocol, {
          baseUrl,
          apiKey: message.apiKey,
          providerLabel: definition.label,
        });
        post(session.port, { type: "models", provider: definition.id, models });
      } catch (error) {
        post(session.port, {
          type: "models",
          provider: definition.id,
          models: [],
          error: errorText(error),
        });
      }
      return;
    }

    case "confirm": {
      const finish = session.pendingConfirms.get(message.id);
      if (finish) finish(Boolean(message.approved));
      return;
    }

    case "abort": {
      session.controller?.abort();
      return;
    }

    case "chat": {
      await startChat(session, message);
      return;
    }
  }
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  const session: Session = { port, running: false, pendingConfirms: new Map() };

  port.onMessage.addListener((message: unknown) => {
    void handleMessage(session, message as PanelRequest).catch((error: unknown) => {
      post(port, { type: "error", message: errorText(error) });
    });
  });

  port.onDisconnect.addListener(() => {
    session.controller?.abort();
    for (const resolve of session.pendingConfirms.values()) resolve(false);
    session.pendingConfirms.clear();
  });

  void loadConfig()
    .then((config) => post(port, { type: "ready", config }))
    .catch((error: unknown) => post(port, { type: "error", message: errorText(error) }));
});
