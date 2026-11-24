import { runAgent } from "./lib/agent";
import { chatEvents, listModels } from "./lib/llm";
import { normalizeBaseUrl } from "./lib/llm/http";
import { sanitizeHistory, trimHistory } from "./lib/messages";
import {
  buildChromeEvaluateExpression,
  buildExecuteJobScript,
  buildJobCleanupScript,
  buildJobPollScript,
  buildReadPageScript,
  parseReadPageOptions,
  readPageInTab,
} from "./lib/page-scripts";
import { chromeApi, ext, isChrome, type ChromeInjectionResult } from "./lib/platform";
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

if (isChrome) {
  const openPanelOnActionClick = () => {
    void chromeApi?.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => undefined);
  };
  openPanelOnActionClick();
  ext.runtime.onInstalled.addListener(openPanelOnActionClick);
  ext.runtime.onStartup.addListener(openPanelOnActionClick);
} else {
  ext.browserAction.onClicked.addListener(() => {
    void ext.sidebarAction.open();
  });
}

async function loadConfig(): Promise<AppConfig> {
  try {
    const stored = await ext.storage.local.get(CONFIG_KEY);
    return normalizeConfig(stored[CONFIG_KEY] as Partial<AppConfig> | undefined);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function getActiveTab(): Promise<browser.tabs.Tab | null> {
  try {
    let tabs = await ext.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) tabs = await ext.tabs.query({ active: true, lastFocusedWindow: true });
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
    return `${message} Browsers block extensions on some pages (about:, chrome://, addons.mozilla.org, the Chrome Web Store, the PDF viewer, and other built-in pages). Open a normal web page and try again.`;
  }
  if (/SyntaxError|parse/i.test(message)) {
    return `The injected script could not be parsed: ${message}`;
  }
  return message;
}

async function inject(tabId: number, code: string): Promise<unknown> {
  const results = await ext.tabs.executeScript(tabId, { code, runAt: "document_idle" });
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
  let value: unknown;

  if (isChrome) {
    const scripting = chromeApi?.scripting;
    if (!scripting) {
      return {
        ok: false,
        content: JSON.stringify({ ok: false, error: "Chrome's scripting API is unavailable." }),
      };
    }
    const results = await scripting.executeScript({
      target: { tabId },
      func: readPageInTab,
      args: [parseReadPageOptions(args)],
      world: "ISOLATED",
    });
    const first = results[0];
    if (first?.error) throw new Error(first.error);
    value = first?.result;
  } else {
    value = await inject(tabId, buildReadPageScript(args));
  }

  const parsed = parseInjected(value);
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

  return isChrome
    ? executeJavascriptChrome(tabId, code, signal)
    : executeJavascriptFirefox(tabId, code, signal);
}

async function executeJavascriptFirefox(
  tabId: number,
  code: string,
  signal: AbortSignal,
): Promise<ToolResult> {
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

function chromeScriptError(error: unknown): string {
  const message = errorText(error);
  if (/stopped|abort/i.test(message)) return "The run was stopped.";
  if (/not enabled|user scripts|permission|access to the script|denied/i.test(message)) {
    return `Chrome blocked the script. Enable "Allow User Scripts" for Brogent in chrome://extensions → Details (or Developer mode on older Chrome), then try again. (${message})`;
  }
  if (/cannot access|chrome:\/\/|webstore|extension gallery|protected/i.test(message)) {
    return `${message} Chrome extensions cannot run on chrome:// pages, the Chrome Web Store, or other protected pages.`;
  }
  return message;
}

async function executeJavascriptChrome(
  tabId: number,
  code: string,
  signal: AbortSignal,
): Promise<ToolResult> {
  const userScripts = chromeApi?.userScripts;
  if (!userScripts?.execute) {
    return {
      ok: false,
      content: JSON.stringify({
        ok: false,
        error:
          'Chrome\'s User Scripts API is unavailable. Open chrome://extensions, click Details on Brogent, and enable "Allow User Scripts" (Chrome 138+) or Developer mode on older Chrome, then try again.',
      }),
    };
  }

  const expression = buildChromeEvaluateExpression(code);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const execution = userScripts.execute({
      target: { tabId },
      js: [{ code: expression }],
      world: "USER_SCRIPT",
      injectImmediately: true,
    });

    const results = await new Promise<ChromeInjectionResult[]>((resolve, reject) => {
      timer = globalThis.setTimeout(() => {
        reject(new Error(`The script did not finish within ${SCRIPT_TIMEOUT_MS / 1000} seconds.`));
      }, SCRIPT_TIMEOUT_MS);
      onAbort = () => reject(new Error("The run was stopped."));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      execution.then(resolve, reject);
    });

    const first = results[0];
    if (first?.error) {
      return { ok: false, content: JSON.stringify({ ok: false, error: first.error }) };
    }
    const raw = first?.result;
    if (raw !== undefined && raw !== null) {
      const parsed = typeof raw === "string" ? parseInjected(raw) : raw;
      const content = typeof raw === "string" ? raw : JSON.stringify(raw);
      return {
        ok: isRecord(parsed) ? Boolean(parsed.ok) : false,
        content: truncate(content, MAX_TOOL_CONTENT),
      };
    }
    return { ok: false, content: JSON.stringify({ ok: false, error: "The script returned no result." }) };
  } catch (error) {
    return { ok: false, content: JSON.stringify({ ok: false, error: chromeScriptError(error) }) };
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
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
      request.tabId != null ? await ext.tabs.get(request.tabId).catch(() => null) : await getActiveTab();
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

ext.runtime.onConnect.addListener((port) => {
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
