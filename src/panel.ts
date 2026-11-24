import { normalizeBaseUrl } from "./lib/llm/http";
import { renderMarkdown } from "./lib/markdown";
import { sanitizeHistory } from "./lib/messages";
import type { BackgroundEvent, PanelRequest } from "./lib/protocol";
import { PORT_NAME } from "./lib/protocol";
import {
  PROVIDERS,
  getProvider,
  isProviderId,
  pickDefaultModel,
  resolveProvider,
  type ProviderDefinition,
  type ProviderId,
} from "./lib/providers";
import { describeToolCall } from "./lib/tools";
import {
  CONFIG_KEY,
  DEFAULT_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
  ITEMS_KEY,
  normalizeConfig,
  type AppConfig,
  type ChatMessage,
  type ProviderSettings,
  type ToolCall,
} from "./lib/types";

/** Conversations live per browser tab, keyed by tab id for the session. */
const CONVERSATION_PREFIX = "brogent:conversation:";
const ORPHAN_KEY = "none";
const MAX_CONVERSATIONS = 30;
const MAX_ITEMS_PER_TAB = 60;

/* ------------------------------------------------------------------ DOM */

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

const messagesEl = byId("messages");
const emptyEl = byId("empty");
const inputEl = byId<HTMLTextAreaElement>("input");
const sendBtn = byId<HTMLButtonElement>("btn-send");
const stopBtn = byId<HTMLButtonElement>("btn-stop");
const runStatusEl = byId("run-status");
const runStatusText = byId("run-status-text");
const targetBar = byId("target-bar");
const targetTitle = byId("target-title");
const targetFavicon = byId<HTMLImageElement>("target-favicon");
const connDot = byId("conn-dot");
const modelSelect = byId<HTMLSelectElement>("model-select");
const newBtn = byId<HTMLButtonElement>("btn-new");
const settingsBtn = byId<HTMLButtonElement>("btn-settings");
const closeSettingsBtn = byId<HTMLButtonElement>("btn-close-settings");
const refreshTargetBtn = byId<HTMLButtonElement>("btn-refresh-target");
const settingsEl = byId("settings");
const settingsForm = byId<HTMLFormElement>("settings-form");
const providerSelect = byId<HTMLSelectElement>("provider-select");
const providerHint = byId("provider-hint");
const baseUrlInput = byId<HTMLInputElement>("input-base-url");
const apiKeyInput = byId<HTMLInputElement>("input-api-key");
const toggleKeyBtn = byId<HTMLButtonElement>("btn-toggle-key");
const modelInput = byId<HTMLInputElement>("input-model");
const modelOptions = byId<HTMLDataListElement>("model-options");
const refreshModelsBtn = byId<HTMLButtonElement>("btn-refresh-models");
const modelsStatus = byId("models-status");
const temperatureInput = byId<HTMLInputElement>("input-temperature");
const maxStepsInput = byId<HTMLInputElement>("input-max-steps");
const confirmInput = byId<HTMLInputElement>("input-confirm");
const streamInput = byId<HTMLInputElement>("input-stream");
const systemPromptInput = byId<HTMLTextAreaElement>("input-system-prompt");
const resetPromptBtn = byId<HTMLButtonElement>("btn-reset-prompt");
const toastEl = byId("toast");

/* ---------------------------------------------------------------- types */

interface UserItem {
  kind: "user";
  content: string;
}

interface AssistantItem {
  kind: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  content: string;
  durationMs?: number;
}

interface ConfirmItem {
  kind: "confirm";
  id: string;
  tool: string;
  args: Record<string, unknown>;
  state: "pending" | "approved" | "denied" | "expired";
}

interface ErrorItem {
  kind: "error";
  message: string;
}

interface NoteItem {
  kind: "note";
  message: string;
}

type UiItem = UserItem | AssistantItem | ToolItem | ConfirmItem | ErrorItem | NoteItem;

interface ConversationRecord {
  items: UiItem[];
  updatedAt: number;
}

interface State {
  /** The transcript currently shown in the sidebar. */
  items: UiItem[];
  /** Per-tab transcripts, keyed by tab id (or ORPHAN_KEY). */
  conversations: Record<string, ConversationRecord>;
  /** The tab this transcript belongs to. */
  tabId?: number;
  config: AppConfig;
  models: string[];
  running: boolean;
  /** False until persisted state has been loaded and the first tab selected. */
  initialized: boolean;
  /** Set when the user starts a new chat while a run is finishing. */
  discardRun: boolean;
  live: HTMLElement | null;
  liveText: string;
}

const state: State = {
  items: [],
  conversations: {},
  config: { ...DEFAULT_CONFIG },
  models: [],
  running: false,
  initialized: false,
  discardRun: false,
  live: null,
  liveText: "",
};

const itemElements = new WeakMap<UiItem, HTMLElement>();

/* ------------------------------------------------------ background port */

let port: browser.runtime.Port | null = null;
let reconnectTimer: number | undefined;

function connect(): void {
  try {
    port = browser.runtime.connect({ name: PORT_NAME });
  } catch {
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((message: unknown) => {
    handleEvent(message as BackgroundEvent);
  });

  port.onDisconnect.addListener(() => {
    port = null;
    if (state.running) finishRun("Lost the connection to Brogent's background process.");
    scheduleReconnect();
  });

  post({ type: "ping" });
}

function post(message: PanelRequest): boolean {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    port = null;
    scheduleReconnect();
    return false;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 1500);
}

/* --------------------------------------------------------------- events */

function handleEvent(event: BackgroundEvent): void {
  if (state.discardRun) {
    // A new chat cleared the transcript; wait for the old run to finish before
    // letting the user start another one.
    if (event.type === "done" || event.type === "error") {
      state.discardRun = false;
      state.running = false;
      sendBtn.disabled = false;
      stopBtn.hidden = true;
      setStatus(null);
      clearLive();
      updateEmptyState();
      void syncActiveTab();
    }
    return;
  }

  switch (event.type) {
    case "ready":
      state.config = event.config;
      if (settingsEl.hidden) fillSettingsForm(event.config);
      updateModelSelect();
      requestModels();
      return;

    case "models":
      handleModels(event.provider, event.models, event.error);
      return;

    case "step":
      if (state.running) setStatus(`Thinking · step ${event.step}/${event.maxSteps}`);
      return;

    case "assistant_delta":
      appendDelta(event.text);
      return;

    case "assistant_message":
      finalizeAssistant(event.message);
      return;

    case "tool_start":
      appendItem(
        {
          kind: "tool",
          id: event.id,
          name: event.name,
          args: event.args,
          status: "running",
          content: "",
        },
        true,
      );
      setStatus(`${describeToolCall(event.name, event.args)}…`);
      return;

    case "tool_result": {
      const item = state.items.find(
        (candidate): candidate is ToolItem => candidate.kind === "tool" && candidate.id === event.id,
      );
      if (item) {
        item.status = event.ok ? "ok" : "error";
        item.content = event.content;
        item.durationMs = event.durationMs;
        updateToolCard(item);
        persist();
      }
      if (state.running) setStatus("Thinking…");
      return;
    }

    case "confirm_request":
      appendItem({ kind: "confirm", id: event.id, tool: event.tool, args: event.args, state: "pending" }, true);
      setStatus("Waiting for your approval…");
      return;

    case "done": {
      const note =
        event.reason === "max_steps"
          ? "Stopped: the step limit was reached."
          : event.reason === "length"
            ? "The model stopped at its output limit. Ask for less at once, or raise the limit at the provider."
            : event.reason === "safety" || event.reason === "recitation"
              ? `The provider blocked this response (${event.reason}).`
              : undefined;
      finishRun(note);
      return;
    }

    case "error":
      appendItem({ kind: "error", message: event.message }, true);
      finishRun();
      return;

    case "busy":
      showToast("Brogent is already working on a request.");
      return;

    case "pong":
      return;
  }
}

function handleModels(provider: ProviderId, models: string[], error?: string): void {
  // Ignore replies for a provider the user has already switched away from.
  if (provider !== state.config.provider) return;

  state.models = models;
  const definition = getProvider(provider);

  modelOptions.replaceChildren();
  for (const name of models) {
    const option = document.createElement("option");
    option.value = name;
    modelOptions.append(option);
  }

  if (error) {
    connDot.classList.remove("ok");
    connDot.classList.add("bad");
    connDot.title = error;
    modelsStatus.hidden = false;
    modelsStatus.classList.add("is-error");
    modelsStatus.textContent = `${error} You can still type a model name manually.`;
  } else {
    connDot.classList.remove("bad");
    connDot.classList.add("ok");
    connDot.title = `${definition.label} · ${models.length} model${models.length === 1 ? "" : "s"} available`;
    modelsStatus.hidden = false;
    modelsStatus.classList.remove("is-error");
    modelsStatus.textContent = models.length
      ? `Found ${models.length} model${models.length === 1 ? "" : "s"} for ${definition.label}.`
      : "No models were listed. Type the model name manually.";
  }

  updateModelSelect();

  // Fresh provider with no saved model: pick a sensible one from the list.
  const current = settingsEl.hidden
    ? (state.config.providers[provider]?.model ?? "")
    : modelInput.value;
  if (!error && !current.trim() && models.length) {
    const picked = pickDefaultModel(models);
    if (picked) {
      // Keep the connection values that just produced this list too.
      if (!settingsEl.hidden) stashProviderFields();
      setActiveModel(picked);
      showToast(`Using ${picked} for ${definition.label}.`);
    }
  }
}

function requestModels(): void {
  const definition = getProvider(state.config.provider);
  const saved = state.config.providers[state.config.provider] ?? {};
  const form = settingsEl.hidden ? saved : readProviderFields();
  const baseUrl = normalizeBaseUrl(form.baseUrl || definition.defaultBaseUrl);

  const sent = post({
    type: "models",
    provider: definition.id,
    baseUrl,
    apiKey: form.apiKey ?? "",
  });
  if (!sent) showToast("Not connected to Brogent's background yet — try again in a moment.");
}

/* ---------------------------------------------------------- transcript */

function setStatus(text: string | null): void {
  if (!text) {
    runStatusEl.hidden = true;
    return;
  }
  runStatusText.textContent = text;
  runStatusEl.hidden = false;
}

function isNearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 140;
}

function scrollToBottom(force = false): void {
  if (force || isNearBottom()) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function updateEmptyState(): void {
  emptyEl.hidden = state.items.length > 0 || state.running;
  messagesEl.hidden = state.items.length === 0 && !state.live;
}

/** Redraws the whole transcript for the selected tab. */
function renderCurrentConversation(): void {
  clearLive();
  messagesEl.replaceChildren();
  for (const item of state.items) {
    try {
      renderItem(item, false);
    } catch {
      // Ignore malformed entries left in storage by an older version.
    }
  }
  updateEmptyState();
  scrollToBottom(true);
}

function appendItem(item: UiItem, animate = false): void {
  const stick = isNearBottom();
  state.items.push(item);
  renderItem(item, animate);
  updateEmptyState();
  persist();
  scrollToBottom(stick);
}

function renderItem(item: UiItem, animate = true): void {
  const element = buildItemElement(item);
  if (!element) return;
  if (animate) element.classList.add("message");
  itemElements.set(item, element);
  messagesEl.append(element);
}

function buildItemElement(item: UiItem): HTMLElement | null {
  switch (item.kind) {
    case "user": {
      const element = h("div", "message user");
      element.textContent = item.content;
      return element;
    }

    case "assistant": {
      if (!item.content.trim()) return null;
      const element = h("div", "message assistant markdown");
      element.append(renderMarkdown(item.content));
      return element;
    }

    case "tool":
      return buildToolCard(item);

    case "confirm":
      return buildConfirmCard(item);

    case "error": {
      const element = h("div", "message error");
      element.textContent = item.message;
      return element;
    }

    case "note": {
      const element = h("div", "message note");
      element.textContent = item.message;
      return element;
    }
  }
}

function appendDelta(text: string): void {
  const stick = isNearBottom();
  state.liveText += text;

  if (!state.live) {
    const live = h("div", "message assistant is-streaming");
    live.textContent = state.liveText;
    messagesEl.append(live);
    state.live = live;
    updateEmptyState();
  } else {
    state.live.textContent = state.liveText;
  }

  scrollToBottom(stick);
}

function finalizeAssistant(message: ChatMessage): void {
  clearLive();
  const content = (message.content ?? "").trim();
  if (!content && !message.tool_calls?.length) return;
  appendItem({ kind: "assistant", content, toolCalls: message.tool_calls });
}

function clearLive(): void {
  state.live?.remove();
  state.live = null;
  state.liveText = "";
  updateEmptyState();
}

function finishRun(note?: string): void {
  if (state.liveText.trim()) {
    const content = state.liveText.trim();
    clearLive();
    appendItem({ kind: "assistant", content });
  }
  clearLive();
  if (note) appendItem({ kind: "note", message: note });
  state.running = false;
  sendBtn.disabled = false;
  stopBtn.hidden = true;
  setStatus(null);
  updateEmptyState();
  persist();
  void syncActiveTab();
}

/* -------------------------------------------------------------- tool UI */

function prettyJson(raw: string): string {
  if (!raw) return "(no output)";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function buildToolCard(item: ToolItem): HTMLDetailsElement {
  const card = h("details", "tool-card");
  card.dataset.status = item.status;
  card.open = item.status === "error";

  const summary = h("summary");
  const dot = h("span", "tool-status");
  const name = h("span", "tool-name");
  name.textContent = describeToolCall(item.name, item.args);
  summary.append(dot, name);

  if (item.durationMs !== undefined) {
    const duration = h("span", "tool-duration");
    duration.textContent = `${item.durationMs} ms`;
    summary.append(duration);
  }
  card.append(summary);

  const body = h("div", "tool-body");
  const code = typeof item.args.code === "string" ? item.args.code : "";
  const otherArgs = Object.fromEntries(Object.entries(item.args).filter(([key]) => key !== "code"));

  if (code) {
    body.append(section("Script", code, ""));
  }
  if (Object.keys(otherArgs).length) {
    body.append(section("Arguments", JSON.stringify(otherArgs, null, 2), ""));
  }
  if (item.status === "running") {
    body.append(section("Result", "Running…", "result"));
  } else if (item.content) {
    body.append(section("Result", prettyJson(item.content), "result"));
  }

  card.append(body);
  return card;
}

function section(label: string, value: string, className: string): HTMLElement {
  const wrapper = h("div", "tool-section");
  const heading = h("div", "tool-section-label");
  heading.textContent = label;
  const pre = h("pre", className || undefined);
  pre.textContent = value;
  wrapper.append(heading, pre);
  return wrapper;
}

function updateToolCard(item: ToolItem): void {
  const previous = itemElements.get(item);
  const next = buildToolCard(item);
  next.classList.add("message");
  if (previous) {
    next.open = previous instanceof HTMLDetailsElement ? previous.open : next.open;
    previous.replaceWith(next);
  } else {
    messagesEl.append(next);
  }
  itemElements.set(item, next);
}

function buildConfirmCard(item: ConfirmItem): HTMLElement {
  const card = h("div", "confirm-card message");
  card.dataset.state = item.state;

  const title = h("div", "confirm-title");
  title.textContent = "Brogent wants to run JavaScript in this tab";
  card.append(title);

  const code = typeof item.args.code === "string" ? item.args.code : JSON.stringify(item.args, null, 2);
  const pre = h("pre");
  pre.textContent = prettyCode(code);
  card.append(pre);

  const actions = h("div", "confirm-actions");
  const runButton = h("button", "primary-button compact");
  runButton.type = "button";
  runButton.textContent = "Run";

  const skipButton = h("button", "secondary-button");
  skipButton.type = "button";
  skipButton.textContent = "Skip";

  const finish = (approved: boolean) => {
    if (item.state !== "pending") return;
    item.state = approved ? "approved" : "denied";
    post({ type: "confirm", id: item.id, approved });
    updateConfirmCard(item);
    persist();
  };

  runButton.addEventListener("click", () => finish(true));
  skipButton.addEventListener("click", () => finish(false));

  actions.append(skipButton, runButton);
  card.append(actions);

  if (item.state !== "pending") {
    const result = h("div", "confirm-result");
    result.textContent =
      item.state === "approved"
        ? "Approved."
        : item.state === "denied"
          ? "Skipped."
          : "This request expired.";
    card.append(result);
  }

  return card;
}

function prettyCode(code: string): string {
  return code.replace(/\n{3,}/g, "\n\n").trim();
}

function updateConfirmCard(item: ConfirmItem): void {
  const previous = itemElements.get(item);
  const next = buildConfirmCard(item);
  if (previous) previous.replaceWith(next);
  else messagesEl.append(next);
  itemElements.set(item, next);
}

/* ------------------------------------------------------------ run cycle */

function toMessages(items: UiItem[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      messages.push({ role: "user", content: item.content });
    } else if (item.kind === "assistant") {
      const message: ChatMessage = { role: "assistant", content: item.content };
      if (item.toolCalls?.length) message.tool_calls = item.toolCalls;
      messages.push(message);
    } else if (item.kind === "tool") {
      messages.push({
        role: "tool",
        content: item.content || JSON.stringify({ ok: false, error: "No result was recorded." }),
        tool_name: item.name,
      });
    }
  }
  return sanitizeHistory(messages);
}

async function beginRun(): Promise<void> {
  if (state.running) return;
  const messages = toMessages(state.items);
  if (!messages.length) return;

  if (!port) {
    appendItem({ kind: "error", message: "Brogent is not connected to its background process yet. Try again in a moment." }, true);
    return;
  }

  // Mark the run before awaiting so a fast double-send cannot start two runs.
  state.running = true;
  sendBtn.disabled = true;
  stopBtn.hidden = false;
  updateEmptyState();
  setStatus("Thinking…");

  let tabId = state.tabId;
  if (tabId == null) {
    const active = await getActiveTab();
    tabId = active?.id;
    if (active && tabId != null) {
      // Adopt an orphaned transcript onto the first tab we can see.
      const orphan = state.conversations[ORPHAN_KEY];
      const key = tabKey(tabId);
      if (orphan && orphan.items === state.items && !state.conversations[key]) {
        state.conversations[key] = { items: orphan.items, updatedAt: Date.now() };
        delete state.conversations[ORPHAN_KEY];
      }
      state.tabId = tabId;
      updateTargetBar(active);
    }
  }

  const ok = post({ type: "chat", messages, tabId });
  if (!ok) {
    appendItem({ kind: "error", message: "Could not reach the background process." }, true);
    finishRun();
  }
}

function send(): void {
  const text = inputEl.value.trim();
  if (!text || state.running) return;
  inputEl.value = "";
  autoGrow();
  appendItem({ kind: "user", content: text }, true);
  void beginRun();
}

function stop(): void {
  post({ type: "abort" });
  setStatus("Stopping…");
}

function newChat(): void {
  const wasRunning = state.running;
  if (wasRunning) {
    state.discardRun = true;
    post({ type: "abort" });
    setStatus("Stopping…");
  }

  clearLive();
  state.items = [];
  ensureConversation(state.tabId).items = state.items;
  messagesEl.replaceChildren();

  if (!wasRunning) {
    state.running = false;
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    setStatus(null);
  }

  updateEmptyState();
  persist();
  inputEl.focus();
}

/* -------------------------------------------------------------- targets */

async function getActiveTab(): Promise<browser.tabs.Tab | null> {
  try {
    let tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

function updateTargetBar(tab: browser.tabs.Tab | null): void {
  if (!tab) {
    targetBar.hidden = true;
    return;
  }
  targetBar.hidden = false;
  const label = tab.title?.trim() || tab.url || "Untitled tab";
  targetTitle.textContent = label;
  targetTitle.title = tab.url ?? label;

  if (tab.favIconUrl) {
    targetFavicon.src = tab.favIconUrl;
    targetFavicon.hidden = false;
  } else {
    targetFavicon.removeAttribute("src");
    targetFavicon.hidden = true;
  }
}

function tabKey(tabId: number | undefined): string {
  return tabId != null ? String(tabId) : ORPHAN_KEY;
}

function storageKeyFor(tabId: number | undefined): string {
  return `${CONVERSATION_PREFIX}${tabKey(tabId)}`;
}

function ensureConversation(tabId: number | undefined): ConversationRecord {
  const key = tabKey(tabId);
  let record = state.conversations[key];
  if (!record) {
    record = { items: [], updatedAt: Date.now() };
    state.conversations[key] = record;
  }
  return record;
}

/**
 * Shows the transcript for `tab`. While a run is active the sidebar stays
 * pinned to the tab being worked on, because tool events belong to it.
 */
function selectTab(tab: browser.tabs.Tab | null): void {
  const nextId = tab?.id;
  const key = tabKey(nextId);
  const existing = state.conversations[key];

  if (nextId === state.tabId && existing && existing.items === state.items) {
    updateTargetBar(tab);
    return;
  }
  if (state.running) return;

  state.tabId = nextId;
  const record = existing ?? ensureConversation(nextId);
  state.items = record.items;
  updateTargetBar(tab);
  renderCurrentConversation();
}

/** Follows the active tab of this window unless a run is pinned. */
async function syncActiveTab(): Promise<void> {
  const tab = await getActiveTab();
  if (!state.initialized || state.running) return;
  selectTab(tab);
}

/* ------------------------------------------------------------ settings */

function currentProvider(): ProviderDefinition {
  return getProvider(state.config.provider);
}

function providerSettings(id: ProviderId = state.config.provider): ProviderSettings {
  return state.config.providers[id] ?? {};
}

function buildProviderOptions(): void {
  providerSelect.replaceChildren();
  const groups: Array<{ label: string; group: ProviderDefinition["group"] }> = [
    { label: "Local", group: "local" },
    { label: "Cloud", group: "cloud" },
    { label: "Other", group: "custom" },
  ];

  for (const { label, group } of groups) {
    const definitions = PROVIDERS.filter((provider) => provider.group === group);
    if (!definitions.length) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    for (const definition of definitions) {
      const option = document.createElement("option");
      option.value = definition.id;
      option.textContent = definition.label;
      optgroup.append(option);
    }
    providerSelect.append(optgroup);
  }
}

function renderProviderHint(definition: ProviderDefinition): void {
  providerHint.replaceChildren();
  const parts: string[] = [];
  if (definition.hint) parts.push(definition.hint);
  if (definition.defaultBaseUrl) parts.push(`Default URL: ${definition.defaultBaseUrl}.`);
  parts.push(definition.apiKeyRequired ? "An API key is required." : "No API key is needed for most setups.");
  providerHint.append(document.createTextNode(parts.join(" ")));

  if (definition.docsUrl) {
    providerHint.append(document.createTextNode(" "));
    const link = document.createElement("a");
    link.href = definition.docsUrl;
    link.textContent = definition.apiKeyRequired ? "Get an API key ↗" : "Documentation ↗";
    providerHint.append(link);
  }
}

function fillProviderFields(id: ProviderId): void {
  const definition = getProvider(id);
  const saved = state.config.providers[id] ?? {};
  baseUrlInput.value = saved.baseUrl ?? "";
  baseUrlInput.placeholder = definition.defaultBaseUrl || "https://…/v1";
  apiKeyInput.type = "password";
  apiKeyInput.value = saved.apiKey ?? "";
  apiKeyInput.placeholder = definition.apiKeyRequired ? "Required" : "Optional";
  toggleKeyBtn.textContent = "Show";
  modelInput.value = saved.model ?? "";
  modelInput.placeholder = definition.modelPlaceholder;
  renderProviderHint(definition);
}

function fillSettingsForm(config: AppConfig): void {
  providerSelect.value = config.provider;
  fillProviderFields(config.provider);
  temperatureInput.value = String(config.temperature);
  maxStepsInput.value = String(config.maxSteps);
  confirmInput.checked = config.confirmScripts;
  streamInput.checked = config.stream;
  systemPromptInput.value = config.systemPrompt;
}

/** Reads the connection fields into a normalized provider entry. */
function readProviderFields(): ProviderSettings {
  const definition = currentProvider();
  const rawBase = baseUrlInput.value.trim();
  const baseUrl = normalizeBaseUrl(rawBase);
  return {
    // Store an override only when it differs from the provider default.
    baseUrl: baseUrl && baseUrl !== definition.defaultBaseUrl ? baseUrl : "",
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
  };
}

function stashProviderFields(): void {
  const id = state.config.provider;
  state.config.providers = { ...state.config.providers, [id]: readProviderFields() };
}

function persistConfig(): void {
  void browser.storage.local.set({ [CONFIG_KEY]: state.config }).catch(() => undefined);
}

function setActiveModel(model: string): void {
  const id = state.config.provider;
  state.config.providers = {
    ...state.config.providers,
    [id]: { ...(state.config.providers[id] ?? {}), model },
  };
  if (!settingsEl.hidden) modelInput.value = model;
  updateModelSelect();
  persistConfig();
}

function switchProvider(id: ProviderId): void {
  if (id === state.config.provider) return;
  stashProviderFields();
  state.config.provider = id;
  persistConfig();
  fillProviderFields(id);
  state.models = [];
  modelOptions.replaceChildren();
  modelsStatus.hidden = true;
  updateModelSelect();
  requestModels();
}

function readSettingsForm(): AppConfig {
  const temperature = Number.parseFloat(temperatureInput.value);
  const maxSteps = Number.parseInt(maxStepsInput.value, 10);
  return {
    ...state.config,
    providers: {
      ...state.config.providers,
      [state.config.provider]: readProviderFields(),
    },
    temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : DEFAULT_CONFIG.temperature,
    maxSteps: Number.isFinite(maxSteps) ? Math.min(20, Math.max(1, maxSteps)) : DEFAULT_CONFIG.maxSteps,
    confirmScripts: confirmInput.checked,
    stream: streamInput.checked,
    systemPrompt: systemPromptInput.value.trim() || DEFAULT_SYSTEM_PROMPT,
  };
}

function openSettings(): void {
  fillSettingsForm(state.config);
  settingsEl.hidden = false;
  baseUrlInput.focus();
}

function closeSettings(): void {
  settingsEl.hidden = true;
}

function saveSettings(): void {
  const config = readSettingsForm();
  const resolved = resolveProvider(config);

  if (!resolved.baseUrl) {
    showToast("Add a base URL for the custom provider.");
    baseUrlInput.focus();
    return;
  }
  if (!resolved.model) {
    showToast("Choose a model before saving.");
    modelInput.focus();
    return;
  }

  state.config = config;
  persistConfig();
  fillSettingsForm(state.config);
  updateModelSelect();
  closeSettings();
  showToast("Settings saved.");
  requestModels();
}

function updateModelSelect(): void {
  const current = providerSettings().model ?? "";
  const names = new Set(state.models);
  if (current) names.add(current);

  modelSelect.replaceChildren();
  if (!names.size) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No model";
    modelSelect.append(option);
    modelSelect.disabled = true;
    return;
  }

  modelSelect.disabled = false;
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    modelSelect.append(option);
  }
  modelSelect.value = current;
}

/* ----------------------------------------------------------- persistence */

function compactItem(item: UiItem): UiItem {
  if (item.kind === "tool" && item.content.length > 20_000) {
    return {
      ...item,
      content: JSON.stringify({
        ok: true,
        truncated: true,
        note: "This tool result was too large to keep in the saved chat history.",
      }),
    };
  }
  return item;
}

function persist(): void {
  const record = ensureConversation(state.tabId);
  if (record.items !== state.items) record.items = state.items;
  record.updatedAt = Date.now();

  const payload = {
    updatedAt: record.updatedAt,
    items: record.items.slice(-MAX_ITEMS_PER_TAB).map(compactItem),
  };

  // One key per tab: two windows writing different tabs never clobber each other.
  void browser.storage.local
    .set({ [storageKeyFor(state.tabId)]: payload })
    .catch(() => undefined);
}

function isStoredItem(value: unknown): value is UiItem {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = (value as { kind: unknown }).kind;
  return kind === "user" || kind === "assistant" || kind === "tool" || kind === "confirm" || kind === "error" || kind === "note";
}

function restoreItems(value: unknown): UiItem[] {
  if (!Array.isArray(value)) return [];
  const items: UiItem[] = [];
  for (const entry of value) {
    if (!isStoredItem(entry)) continue;
    if (entry.kind === "tool" && entry.status === "running") {
      items.push({
        ...entry,
        status: "error",
        content: entry.content || JSON.stringify({ ok: false, error: "The run was interrupted." }),
      });
    } else if (entry.kind === "confirm" && entry.state === "pending") {
      items.push({ ...entry, state: "expired" });
    } else {
      items.push(entry);
    }
  }
  return items;
}

function parseConversation(value: unknown): ConversationRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { items?: unknown; updatedAt?: unknown };
  return {
    items: restoreItems(record.items),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

async function loadPersistedState(activeTabId?: number): Promise<void> {
  try {
    const stored = await browser.storage.local.get(null);
    state.config = normalizeConfig(stored[CONFIG_KEY] as Partial<AppConfig> | undefined);

    state.conversations = {};
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(CONVERSATION_PREFIX)) continue;
      const record = parseConversation(value);
      if (record) state.conversations[key.slice(CONVERSATION_PREFIX.length)] = record;
    }

    // One-time migration from the single-conversation format.
    const legacy = restoreItems(stored[ITEMS_KEY]);
    if (!Object.keys(state.conversations).length && legacy.length && activeTabId != null) {
      const record = { items: legacy, updatedAt: Date.now() };
      state.conversations[tabKey(activeTabId)] = record;
      void browser.storage.local.set({ [storageKeyFor(activeTabId)]: record }).catch(() => undefined);
      void browser.storage.local.remove(ITEMS_KEY).catch(() => undefined);
    }
  } catch {
    // Storage may be unavailable; start fresh.
  }

  state.tabId = activeTabId;
  state.items = ensureConversation(activeTabId).items;

  fillSettingsForm(state.config);
  updateModelSelect();
}

/** Drops transcripts whose tabs no longer exist (for example after a restart). */
async function pruneStaleConversations(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    const live = new Set(tabs.map((tab) => tabKey(tab.id)));
    const current = tabKey(state.tabId);
    const stale: string[] = [];

    for (const key of Object.keys(state.conversations)) {
      if (key === ORPHAN_KEY || key === current || live.has(key)) continue;
      delete state.conversations[key];
      stale.push(`${CONVERSATION_PREFIX}${key}`);
    }

    // Keep storage bounded even if many tabs had a conversation.
    const rest = Object.entries(state.conversations)
      .filter(([key]) => key !== current && key !== ORPHAN_KEY)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
    for (const [key] of rest.slice(MAX_CONVERSATIONS)) {
      delete state.conversations[key];
      stale.push(`${CONVERSATION_PREFIX}${key}`);
    }

    if (stale.length) await browser.storage.local.remove(stale);
  } catch {
    // Tab listing is optional; keep what we loaded.
  }
}

/* ---------------------------------------------------------------- toast */

let toastTimer: number | undefined;

function showToast(message: string): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
    toastTimer = undefined;
  }, 2600);
}

/* --------------------------------------------------------------- wiring */

function autoGrow(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(160, inputEl.scrollHeight)}px`;
}

function wireEvents(): void {
  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", stop);
  newBtn.addEventListener("click", newChat);
  refreshTargetBtn.addEventListener("click", () => {
    if (state.running) {
      showToast("Brogent is still working on this tab.");
      return;
    }
    void syncActiveTab();
  });

  inputEl.addEventListener("input", autoGrow);
  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });

  for (const suggestion of document.querySelectorAll<HTMLButtonElement>(".suggestion")) {
    suggestion.addEventListener("click", () => {
      const prompt = suggestion.dataset.prompt ?? suggestion.textContent ?? "";
      inputEl.value = prompt;
      autoGrow();
      send();
    });
  }

  document.addEventListener("click", (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) return;
    event.preventDefault();
    void browser.tabs.create({ url: href });
  });

  settingsBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !settingsEl.hidden) closeSettings();
  });

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSettings();
  });

  resetPromptBtn.addEventListener("click", () => {
    systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
  });

  refreshModelsBtn.addEventListener("click", () => {
    modelsStatus.hidden = false;
    modelsStatus.classList.remove("is-error");
    modelsStatus.textContent = `Contacting ${currentProvider().label}…`;
    requestModels();
  });

  modelSelect.addEventListener("change", () => {
    if (!modelSelect.value) return;
    setActiveModel(modelSelect.value);
    if (!settingsEl.hidden) modelInput.value = modelSelect.value;
  });

  providerSelect.addEventListener("change", () => {
    if (isProviderId(providerSelect.value)) switchProvider(providerSelect.value);
  });

  toggleKeyBtn.addEventListener("click", () => {
    const showing = apiKeyInput.type === "text";
    apiKeyInput.type = showing ? "password" : "text";
    toggleKeyBtn.textContent = showing ? "Show" : "Hide";
  });

  window.addEventListener("focus", () => void syncActiveTab());
  browser.tabs.onActivated.addListener(() => void syncActiveTab());
  browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.title !== undefined || changeInfo.url !== undefined || changeInfo.status === "complete")) {
      void syncActiveTab();
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    delete state.conversations[String(tabId)];
    void browser.storage.local.remove(storageKeyFor(tabId)).catch(() => undefined);

    if (state.tabId === tabId && !state.running) {
      // The activation event will select a neighbouring tab; clear the stale view now.
      state.tabId = undefined;
      state.items = [];
      messagesEl.replaceChildren();
      updateTargetBar(null);
      updateEmptyState();
      persist();
    }
  });
}

async function init(): Promise<void> {
  buildProviderOptions();
  wireEvents();
  const activeTab = await getActiveTab();
  await loadPersistedState(activeTab?.id);
  updateTargetBar(activeTab);
  renderCurrentConversation();
  await pruneStaleConversations();
  state.initialized = true;
  // Catch a tab switch that happened while we were loading.
  await syncActiveTab();
  connect();
  autoGrow();
  inputEl.focus();
}

void init();
