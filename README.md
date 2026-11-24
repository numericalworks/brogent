# Brogent

**Bro**wser + a**gent**. A Firefox extension that lets an AI model read, summarize, extract from, and modify the page you are looking at.

Brogent has no backend. It talks directly from your browser to the provider you choose — a local server (Ollama, LM Studio, llama.cpp) or a cloud API (OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, and more).

---

## What it can do

- **Read the current tab.** The model gets the page's visible text, cleaned HTML, all links, the heading outline, or your current selection.
- **Run JavaScript in the tab.** Precise extraction and page changes are done by writing DOM code that runs in the page and returns JSON.
- **Keep a conversation per tab.** Switch tabs and the sidebar switches to that tab's transcript. Each tab's agent history targets that tab's page.
- **Summarize, extract, modify.** Summaries, tables of extracted data, translations, dark mode, readability tweaks, removing clutter — anything expressible as read + script.
- **Use the model you already pay for.** Ollama, OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Together, Fireworks, Cerebras, Moonshot, Qwen, or any OpenAI-compatible endpoint.
- **Stay in control.** By default Brogent asks before running model-authored JavaScript, and every script is shown to you first.

Everything is driven from a sidebar chat, with streamed answers, tool-call cards you can expand, and Markdown rendering.

```
┌──────────────────────────────┐        ┌─────────────────────────┐
│  Sidebar (panel.ts)          │  port  │  Background (MV2 page)  │
│  chat UI · settings · state  │◀──────▶│  agent loop · tools     │
└──────────────────────────────┘        └───────────┬─────────────┘
                                                    │ one adapter per protocol
                                     ┌──────────────▼──────────────┐
                                     │ Ollama · OpenAI · Anthropic │
                                     │ · Gemini — /chat or /v1     │
                                     └──────────────┬──────────────┘
                                                    │ tool calls
                                     ┌──────────────▼──────────────┐
                                     │ Active tab (executeScript)  │
                                     │ read_page · execute_js      │
                                     └─────────────────────────────┘
```

---

## Requirements

- **Firefox 142+** (desktop)
- **[Bun](https://bun.sh) 1.1+** to build and test
- A **tool-calling model** from one of the supported providers (see below)

## Quick start

```sh
bun install
bun run build
```

Then in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `dist/manifest.json`.
3. Open the sidebar with the toolbar button or **Ctrl+Shift+Y** (⌘⇧Y on macOS).
4. Click the gear icon, choose a **Provider**, paste an **API key** if needed, and press **Fetch models**.
5. Pick a model, press **Save**, and ask something like *"Summarize this page in five bullets."*

The first model in the fetched list is selected automatically when you have not chosen one yet, so a fresh provider is ready to chat as soon as the list loads.

Reload the temporary add-on after rebuilding (`bun run build`).

To produce an installable/unsigned package:

```sh
bun run package   # writes brogent.xpi
```

`about:addons` → gear icon → **Install Add-on From File…** works for unsigned local installs when `xpinstall.signatures.required` is `false` in `about:config`.

## Providers

Brogent speaks four wire protocols: **Ollama** (native), **OpenAI-compatible** chat completions, **Anthropic** Messages, and **Google Gemini**. Every cloud provider below except Ollama Cloud, Anthropic, and Google rides the OpenAI-compatible adapter, which is why adding another compatible endpoint only requires a registry entry.

| Provider | Default endpoint | Key | Protocol |
| --- | --- | --- | --- |
| Ollama (local) | `http://localhost:11434` | no | Ollama |
| LM Studio (local) | `http://localhost:1234/v1` | no | OpenAI |
| llama.cpp (local) | `http://localhost:8080/v1` | no | OpenAI |
| Ollama Cloud | `https://ollama.com` | yes | Ollama |
| OpenAI | `https://api.openai.com/v1` | yes | OpenAI |
| Anthropic (Claude) | `https://api.anthropic.com/v1` | yes | Anthropic |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | yes | Gemini |
| OpenRouter | `https://openrouter.ai/api/v1` | yes | OpenAI |
| Groq | `https://api.groq.com/openai/v1` | yes | OpenAI |
| Mistral AI | `https://api.mistral.ai/v1` | yes | OpenAI |
| DeepSeek | `https://api.deepseek.com/v1` | yes | OpenAI |
| xAI (Grok) | `https://api.x.ai/v1` | yes | OpenAI |
| Moonshot (Kimi) | `https://api.moonshot.ai/v1` | yes | OpenAI |
| Alibaba Qwen (DashScope) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | yes | OpenAI |
| Together AI | `https://api.together.xyz/v1` | yes | OpenAI |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | yes | OpenAI |
| Cerebras | `https://api.cerebras.ai/v1` | yes | OpenAI |
| Cohere | `https://api.cohere.ai/compatibility/v1` | yes | OpenAI |
| Custom | you supply | optional | OpenAI |

Notes:

- The **Base URL** field is optional; leave it empty to use the provider default. Override it for proxies, gateways, or self-hosted endpoints.
- Keys are stored **per provider**, so switching back and forth does not lose them.
- **Custom** works with vLLM, LiteLLM, an Azure OpenAI gateway, LocalAI, or any other OpenAI-compatible server.
- OpenRouter model lists are filtered to models that advertise tool support.

### Local setup

```sh
ollama serve
ollama pull llama3.1:8b     # or qwen3, mistral-nemo, granite3.3
```

For LM Studio, start its local server from the Developer tab. For llama.cpp, run `llama-server` with an OpenAI-compatible model.

You do **not** need to set `OLLAMA_ORIGINS` for Brogent: the extension calls the endpoint from its background page using host permissions, so its requests are not subject to page CORS.

### Tool calling is required

Brogent's agent loop depends on function calling. Models without it cannot use the extension, and the error message names the model and suggests alternatives. Good picks include:

- Ollama: `qwen3`, `llama3.1`, `mistral-nemo`, `granite3.3`
- OpenAI: current `gpt-5`/`gpt-4.1` families
- Anthropic: `claude-sonnet-*` / `claude-opus-*`
- Gemini: `gemini-2.5-pro`, `gemini-2.5-flash`
- OpenRouter: any model whose listing includes the `tools` parameter

## Per-tab conversations

Every browser tab has its own transcript and its own agent context:

- Switching tabs switches the sidebar to that tab's conversation. New chats start empty, so a second tab never inherits the first tab's history.
- The **target tab** is shown above the conversation (title, favicon, ⟳ to re-read the active tab). Send and tool calls always target the displayed tab, even if you switch tabs mid-run.
- While a run is in progress the sidebar stays **pinned** to the running tab so streamed text and tool results land in the right transcript. When the run finishes (or you press Stop), the sidebar follows the active tab again.
- **＋** clears only the current tab's conversation.
- Closing a tab discards its transcript. Tab ids are per-session, so transcripts are also pruned after a browser restart rather than being attached to unrelated new tabs. Navigating within the same tab keeps the conversation.

Transcripts are stored one key per tab in `browser.storage.local`, so several sidebar windows do not overwrite each other's history.

## Tools

The model can call two tools. They target whichever tab was active when you pressed **Send** (the target tab is shown above the conversation and can be re-read with ⟳).

| Tool | Arguments | What it does |
| --- | --- | --- |
| `read_page` | `mode` (`text` \| `html` \| `links` \| `outline` \| `selection`), `selector` (CSS, optional), `max_chars` (default 12000) | Returns `{ url, title, content, truncated, … }` for the tab. HTML mode strips scripts, styles, event handlers, and inline styles. |
| `execute_javascript` | `code` (async function body), `purpose` | Runs your code in the tab and returns `{ ok, result }` or `{ ok, error }`. |

`execute_javascript` runs in the extension's isolated content-script world: full DOM access, but **no access to the page's own JavaScript variables or functions**. Scripts are the body of an `async` function — use `return` to send data back, and return JSON-friendly values. Long-running scripts are polled and time out after 120 seconds; **Stop** aborts the run.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Provider | Ollama (local) | See the provider table above. |
| Base URL | provider default | Leave empty to use the default; override for proxies. |
| API key | empty | Stored per provider; needed for most cloud APIs. |
| Model | auto-picked | Fetched from the provider; can also be typed manually. |
| Temperature | `0.2` | Lower is more deterministic. Clamped per provider. |
| Max tool steps | `6` | Model ↔ tool round trips per message. |
| Ask before running JavaScript | on | Shows the code and waits for **Run**/**Skip**. |
| Stream responses | on | Turn off if a provider dislikes streaming with tools. |
| System prompt | built in | Edit it to change the agent's behavior or add house rules. |

Chat history is saved per tab in `browser.storage.local`, so closing the sidebar does not lose it, and switching providers mid-conversation preserves it.

## Development

```sh
bun run build       # bundle + copy static files + generate icons into dist/
bun run watch       # rebuild on changes in src/ and scripts/
bun run typecheck   # tsc --noEmit
bun test            # unit tests (adapters, agent loop, history repair, injected scripts)
bun run package     # build without sourcemaps and produce brogent.xpi
bun run dev:firefox # build, then launch Firefox with web-ext (downloads web-ext on first use)
```

### Layout

```
src/
  background.ts          agent session, tool execution, provider dispatch
  panel.html/.css/.ts    sidebar UI, per-tab transcripts, provider settings, streaming renderer
  manifest.json          Manifest V2 for Firefox
  lib/
    agent.ts             the model ↔ tool loop (framework-free, unit tested)
    providers.ts         provider registry, defaults, per-provider resolution
    tools.ts             tool schemas and UI labels
    page-scripts.ts      the exact strings injected with tabs.executeScript
    markdown.ts          small safe Markdown → DOM renderer
    messages.ts          repairs/trims tool-call history
    protocol.ts          typed port messages between panel and background
    types.ts             config schema, defaults, system prompt, migration
    llm/
      index.ts           protocol dispatch (chat + model lists)
      ollama.ts          native /api/chat and /api/tags
      openai.ts          OpenAI-compatible chat completions + /models
      anthropic.ts       Messages API + SSE block/tool parsing
      gemini.ts          generateContent + function calling
      http.ts            shared streaming, errors, tool-call normalization
      types.ts           normalized ChatEvent / ChatRequest shapes
scripts/
  icons.ts               PNG icon renderer (no image dependencies)
  zip.ts                 minimal ZIP writer for the .xpi
  package.ts             packages dist/ into brogent.xpi
tests/                   bun:test suites
```

Each adapter translates our normalized transcript into its provider's shape and back, so the agent loop, UI, and stored history are provider-agnostic. Adding a provider usually means one registry entry; a new protocol means one adapter.

### Why Manifest V2?

Arbitrary, model-authored JavaScript in a tab needs `tabs.executeScript({ code })`. Manifest V3 removed the `code` option, and its extension CSP forbids `eval`/`new Function`, so there is no faithful MV3 equivalent for a user-directed agent. Firefox continues to support MV2 background pages. The agent loop, provider adapters, tools, and page scripts are all isolated from the extension plumbing, so an MV3 port would only need a different injection/transport layer.

## Privacy and security

- **No telemetry, no developer backend.** Brogent ships no analytics and has no server of its own.
- **Who sees your pages:** whatever `read_page` returns, your prompts, and tool results are sent to the **provider you select**. With a local provider (Ollama, LM Studio, llama.cpp) that stays on your machine; with a cloud provider it is sent to that company under their terms. The add-on's Firefox data-collection declaration lists `websiteContent` for this reason.
- **API keys** are stored unencrypted in the extension's local storage, like chat history.
- **Script confirmation is on by default.** Model output is untrusted: review the code before pressing **Run**, especially on pages that hold sensitive data.
- **Injection is limited to the browser's normal permission model.** Brogent cannot script `about:` pages, `addons.mozilla.org`, the built-in PDF viewer, or other protected pages.
- Chat history is stored unencrypted in the extension's local storage and is visible to anyone with access to your Firefox profile.

## Limitations

- Models without tool calling cannot use Brogent.
- The isolated world cannot call functions defined by the page (React handlers, page globals). Use DOM events (`element.click()`) instead.
- Tool results are capped (60k characters, `read_page` at `max_chars`), so very large pages need selector-scoped reads or scripted extraction.
- Transcripts are scoped to the tab for the current browser session; they are not preserved after a restart (tab ids change).
- Model-list endpoints differ between providers; if one is unavailable, type the model name manually.
- Some reasoning models reject `temperature`; the OpenAI adapter retries once without it.
- Streaming with tools depends on the provider. If a model misbehaves, turn **Stream responses** off.
- One run at a time; the sidebar is pinned to the running tab until it finishes.
- No cross-tab memory or scheduled automation yet.

## Ideas / next steps

- Azure OpenAI (different auth header/query), Amazon Bedrock, and other protocol-specific adapters.
- Pick a target tab explicitly instead of following the active one.
- Element-index actions (click/focus/type by visible label) on top of DOM reads.
- Screenshot + vision models via `tabs.captureTab`.
- An `open_url` tool and multi-tab workflows.
- Per-site permission presets and a read-only mode.
- MV3 transport behind the same `agent.ts` loop.
