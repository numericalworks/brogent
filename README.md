# Brogent

**Bro**wser + a**gent**. A Firefox extension that lets an AI model read, summarize, extract from, and modify the page you are looking at.

Brogent has no backend. It talks directly from your browser to the provider you choose — a local server (Ollama, LM Studio, llama.cpp) or a cloud API (OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, and more).

---

## What it can do

- **Read the current tab.** The model gets the page's visible text, cleaned HTML, all links, the heading outline, or your current selection.
- **Run JavaScript in the tab.** Precise extraction and page changes are done by writing DOM code that runs in the page and returns JSON.
- **Keep a conversation per tab.** Switch tabs and the sidebar switches to that tab's transcript. Each tab's agent history targets that tab's page.
- **Copy prompts and answers.** Hover any prompt or response for a copy button; code blocks have their own copy button too.
- **Read comfortably.** **A− / A+** in the composer (or the Text size slider in settings) scales prompts, answers, code blocks, and tool output from 11 to 20 px.
- **Make it yours.** Pick light, dark, ash, coffee, or **auto** (follows your system appearance live), or build a **custom** palette from a background, text, and accent color.
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

- **Firefox 142+** or **Chrome 135+** (desktop)
- **[Bun](https://bun.sh) 1.1+** to build and test
- A **tool-calling model** from one of the supported providers (see below)

## Build and install

The same source builds both extensions: the Firefox build is Manifest V2, the Chrome build is Manifest V3.

```sh
bun install
bun run build:all     # dist/ (Firefox) and dist-chrome/ (Chrome)
```

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `dist/manifest.json`.
3. Open the sidebar with the toolbar button or **Ctrl+Shift+Y** (⌘⇧Y on macOS).
4. Click the gear icon, choose a **Provider**, paste an **API key** if needed, and press **Fetch models**.
5. Pick a model, press **Save**, and ask something like *"Summarize this page in five bullets."*

Reload the temporary add-on after rebuilding.

### Chrome

1. Run `bun run build:chrome` (or `bun run build:all`).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `dist-chrome/` folder.
4. Click the Brogent toolbar icon to open the side panel.
5. Configure a provider and model exactly as in Firefox.

For `execute_javascript` on Chrome, enable **Allow User Scripts** on the extension's Details page (Chrome 138+). On Chrome 135–137, enable **Developer mode** instead. `read_page` works without that toggle.

### Build and package commands

| Command | Result |
| --- | --- |
| `bun run build` / `build:firefox` | `dist/` — Firefox MV2 |
| `bun run build:chrome` | `dist-chrome/` — Chrome MV3 |
| `bun run build:all` | both builds |
| `bun run package` | `brogent.xpi` |
| `bun run package:chrome` | `brogent-chrome.zip` |
| `bun run package:all` | both packages |
| `bun run dev:firefox` | build + launch a temporary Firefox profile |

`about:addons` → gear icon → **Install Add-on From File…** works for unsigned Firefox installs when `xpinstall.signatures.required` is `false` in `about:config`. For Chrome, load `dist-chrome/` unpacked, or upload `brogent-chrome.zip` to the Chrome Web Store.

The first model in the fetched list is selected automatically when you have not chosen one yet, so a fresh provider is ready to chat as soon as the list loads.

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
| Text size | `13px` | Transcript size (11–20 px). Use **A− / A+** in the composer or the slider in settings. |
| Theme | Auto | Light, dark, ash, coffee, or custom. **Auto** follows the system appearance and reacts to changes; **custom** takes a background, text, and accent color (plus a dark/light base for native controls). Theme changes apply immediately. |
| Ask before running JavaScript | on | Shows the code and waits for **Run**/**Skip**. |
| Stream responses | on | Turn off if a provider dislikes streaming with tools. |
| System prompt | built in | Edit it to change the agent's behavior or add house rules. |

Chat history is saved per tab in `browser.storage.local`, so closing the sidebar does not lose it, and switching providers mid-conversation preserves it.

## Development

```sh
bun run build:all   # build both extensions (dist/ and dist-chrome/)
bun run watch       # rebuild the selected target(s) on changes
bun run typecheck   # tsc --noEmit
bun test            # unit tests (adapters, agent loop, history repair, injected scripts)
bun run package:all # build without sourcemaps and package both
bun run dev:firefox # build, then launch Firefox with web-ext (downloads web-ext on first use)
```

### Layout

```
src/
  background.ts          agent session, tool execution, provider dispatch
  panel.html/.css/.ts    sidebar/side-panel UI, per-tab transcripts, provider settings, streaming
  manifest.firefox.json  Manifest V2 for Firefox
  manifest.chrome.json   Manifest V3 for Chrome
  icons/                 16/32/48/96/128 px extension icons (from assets/logo.webp)
  lib/
    platform.ts          browser shim, manifest-version detection, Chrome API types
    agent.ts             the model ↔ tool loop (framework-free, unit tested)
    providers.ts         provider registry, defaults, per-provider resolution
    tools.ts             tool schemas and UI labels
    page-scripts.ts      page reader + JS runners for Firefox and Chrome
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
assets/
  logo.webp              source artwork for the icons
scripts/
  zip.ts                 minimal ZIP writer for .xpi and Chrome .zip packages
  package.ts             packages dist/ or dist-chrome/
tests/                   bun:test suites
```

Each adapter translates our normalized transcript into its provider's shape and back, so the agent loop, UI, and stored history are provider-agnostic. Adding a provider usually means one registry entry; a new protocol means one adapter.

### Why Manifest V2 for Firefox, MV3 for Chrome?

Running model-authored JavaScript in a tab needs a runner that is not limited to packaged files:

- **Firefox** uses `tabs.executeScript({ code })`, which Firefox's MV2 support still provides. A small job/poll protocol handles async scripts and lets **Stop** cancel a run.
- **Chrome** is MV3-only and removed `executeScript({ code })`; `eval`/`new Function` are blocked by the extension CSP. The Chrome build uses the sanctioned [`userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts) API (`userScripts.execute({ js: [{ code }] })`), which compiles the code in an isolated world and awaits promises. Chrome requires the user to allow user scripts for the extension.

The shared agent loop, provider adapters, tools, UI, and history are identical. Only `src/lib/platform.ts`, the tool runners in `background.ts`, the two manifests, and the sidebar/side-panel wiring differ. The MV3 service worker can be suspended while idle, so the panel pings the background every 20 seconds during a run; `read_page` uses `scripting.executeScript` on Chrome and works without the user-scripts toggle.

## Privacy and security

- **No telemetry, no developer backend.** Brogent ships no analytics and has no server of its own.
- **Who sees your pages:** whatever `read_page` returns, your prompts, and tool results are sent to the **provider you select**. With a local provider (Ollama, LM Studio, llama.cpp) that stays on your machine; with a cloud provider it is sent to that company under their terms. The Firefox build declares `websiteContent` for this reason; the Chrome build sends the same data to the provider you choose.
- **API keys** are stored unencrypted in the extension's local storage, like chat history.
- **Script confirmation is on by default.** Model output is untrusted: review the code before pressing **Run**, especially on pages that hold sensitive data.
- **Injection is limited to the browser's normal permission model.** Brogent cannot script `about:` or `chrome://` pages, `addons.mozilla.org`, the Chrome Web Store, the built-in PDF viewer, or other protected pages.
- Chat history is stored unencrypted in the extension's local storage and is visible to anyone with access to your browser profile.

## Limitations

- Models without tool calling cannot use Brogent.
- The isolated world cannot call functions defined by the page (React handlers, page globals). Use DOM events (`element.click()`) instead.
- Tool results are capped (60k characters, `read_page` at `max_chars`), so very large pages need selector-scoped reads or scripted extraction.
- Transcripts are scoped to the tab for the current browser session; they are not preserved after a restart (tab ids change).
- Model-list endpoints differ between providers; if one is unavailable, type the model name manually.
- Some reasoning models reject `temperature`; the OpenAI adapter retries once without it.
- Streaming with tools depends on the provider. If a model misbehaves, turn **Stream responses** off.
- One run at a time; the sidebar is pinned to the running tab until it finishes.
- Chrome's `execute_javascript` requires the extension's **Allow User Scripts** toggle (Chrome 138+) or Developer mode (Chrome 135–137).
- The Chrome build targets Chrome 135+ and MV3. Chrome Web Store review may scrutinize extensions that execute model-provided code, so the Chrome build is best suited to unpacked/local use.
- No cross-tab memory or scheduled automation yet.

## Ideas / next steps

- Azure OpenAI (different auth header/query), Amazon Bedrock, and other protocol-specific adapters.
- Pick a target tab explicitly instead of following the active one.
- Element-index actions (click/focus/type by visible label) on top of DOM reads.
- Screenshot + vision models via `tabs.captureTab`.
- An `open_url` tool and multi-tab workflows.
- Per-site permission presets and a read-only mode.
- Publish signed Firefox and Chrome builds, and document store-review notes for dynamic code execution.

## Donate

Brogent is free to use and developed in the open. If it saves you time, you can
support the project with a one-off donation via
[PayPal](https://paypal.me/mindaslab).

## License

Brogent is free software: you can redistribute it and/or modify it under the
terms of the **GNU General Public License, version 3 or (at your option) any
later version** (GPL-3.0-or-later).

It is distributed in the hope that it will be useful, but **without any
warranty**; without even the implied warranty of merchantability or fitness for
a particular purpose. See the
[GNU GPL v3 text](https://www.gnu.org/licenses/gpl-3.0.html) for the full terms.
