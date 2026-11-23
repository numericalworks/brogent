# Brogent

**Bro**wser + a**gent**. A Firefox extension that lets an Ollama model read, summarize, extract from, and modify the page you are looking at.

Brogent has no backend. It talks directly from your browser to the Ollama server you choose — either `http://localhost:11434` or [Ollama Cloud](https://ollama.com) with an API key.

---

## What it can do

- **Read the current tab.** The model gets the page's visible text, cleaned HTML, all links, the heading outline, or your current selection.
- **Run JavaScript in the tab.** Precise extraction and page changes are done by writing DOM code that runs in the page and returns JSON.
- **Summarize, extract, modify.** Summaries, tables of extracted data, translations, dark mode, readability tweaks, removing clutter — anything expressible as read + script.
- **Stay in control.** By default Brogent asks before running model-authored JavaScript, and every script is shown to you first.

Everything is driven from a sidebar chat, with streamed answers, tool-call cards you can expand, and Markdown rendering.

```
┌──────────────────────────────┐        ┌─────────────────────────┐
│  Sidebar (panel.ts)          │  port  │  Background (MV2 page)  │
│  chat UI · settings · state  │◀──────▶│  agent loop · tools     │
└──────────────────────────────┘        └───────────┬─────────────┘
                                                    │ fetch
                                     ┌──────────────▼──────────────┐
                                     │ Ollama / Ollama Cloud       │
                                     │ POST /api/chat (tools)      │
                                     └─────────────────────────────┘
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
- **Ollama** running locally, or an **Ollama Cloud** account
- A **tool-calling model**, e.g. `qwen3`, `llama3.1`, `mistral-nemo`, `granite3.3`, or a cloud model

## Quick start

```sh
bun install
bun run build
```

Then in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `dist/manifest.json`.
3. Open the sidebar with the toolbar button or **Ctrl+Shift+Y** (⌘⇧Y on macOS).
4. Click the gear icon, choose your model, and press **Fetch models** → **Save**.
5. Ask something like *“Summarize this page in five bullets.”*

Reload the temporary add-on after rebuilding (`bun run build`).

To produce an installable/unsigned package:

```sh
bun run package   # writes brogent.xpi
```

`about:addons` → gear icon → **Install Add-on From File…** works for unsigned local installs when `xpinstall.signatures.required` is `false` in `about:config`.

## Connecting to Ollama

### Local

```sh
ollama serve
ollama pull llama3.1:8b
```

Leave the base URL at `http://localhost:11434`. You do **not** need to set `OLLAMA_ORIGINS` for Brogent: the extension calls Ollama from its background page using host permissions, so its requests are not subject to page CORS.

### Ollama Cloud

1. Create a key at <https://ollama.com/settings/keys>.
2. In Brogent's settings, pick **Ollama Cloud** (this sets the base URL to `https://ollama.com`).
3. Paste the key, press **Fetch models**, and choose a cloud model.

Brogent sends the key as `Authorization: Bearer <key>` on every request.

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
| Base URL | `http://localhost:11434` | Any Ollama-compatible endpoint; `http://` is added if you omit it. |
| API key | empty | Only needed for Ollama Cloud. |
| Model | `llama3.1:8b` | Must support tool calling. |
| Temperature | `0.2` | Lower is more deterministic. |
| Max tool steps | `6` | Model ↔ tool round trips per message. |
| Ask before running JavaScript | on | Shows the code and waits for **Run**/**Skip**. |
| Stream responses | on | Turn off if your server dislikes streaming with tools. |
| System prompt | built in | Edit it to change the agent's behavior or add house rules. |

Chat history (including tool calls) is saved in `browser.storage.local`, so closing the sidebar does not lose the conversation.

## Development

```sh
bun run build       # bundle + copy static files + generate icons into dist/
bun run watch       # rebuild on changes in src/ and scripts/
bun run typecheck   # tsc --noEmit
bun test            # unit tests (agent loop, Ollama client, history repair, injected scripts)
bun run package     # build without sourcemaps and produce brogent.xpi
bun run dev:firefox # build, then launch Firefox with web-ext (downloads web-ext on first use)
```

### Layout

```
src/
  background.ts          agent session, tool execution, Ollama calls
  panel.html/.css/.ts    sidebar UI, settings, streaming renderer
  manifest.json          Manifest V2 for Firefox
  lib/
    agent.ts             the model ↔ tool loop (framework-free, unit tested)
    ollama.ts            /api/chat streaming client + /api/tags + error hints
    tools.ts             tool schemas and UI labels
    page-scripts.ts      the exact strings injected with tabs.executeScript
    markdown.ts          small safe Markdown → DOM renderer
    messages.ts          repairs/trims tool-call history
    protocol.ts          typed port messages between panel and background
    types.ts             config, defaults, system prompt
scripts/
  icons.ts               PNG icon renderer (no image dependencies)
  zip.ts                 minimal ZIP writer for the .xpi
  package.ts             packages dist/ into brogent.xpi
tests/                   bun:test suites
```

### Why Manifest V2?

Arbitrary, model-authored JavaScript in a tab needs `tabs.executeScript({ code })`. Manifest V3 removed the `code` option, and its extension CSP forbids `eval`/`new Function`, so there is no faithful MV3 equivalent for a user-directed agent. Firefox continues to support MV2 background pages. The agent loop, Ollama client, tools, and page scripts are all isolated from the extension plumbing, so an MV3 port would only need a different injection/transport layer.

## Privacy and security

- **No telemetry, no developer backend.** The only network destination is the Ollama endpoint you configure.
- **What leaves the browser:** the page content Brogent reads, your prompts, and the tool results. With a local Ollama server this stays on your machine; with Ollama Cloud it is sent to Ollama. The add-on's Firefox data-collection declaration lists `websiteContent` for this reason.
- **Script confirmation is on by default.** Model output is untrusted: review the code before pressing **Run**, especially on pages that hold sensitive data.
- **Injection is limited to the browser's normal permission model.** Brogent cannot script `about:` pages, `addons.mozilla.org`, the built-in PDF viewer, or other protected pages.
- Chat history is stored unencrypted in the extension's local storage and is visible to anyone with access to your Firefox profile.

## Limitations

- Models without tool calling cannot use Brogent. The error message names the model and suggests alternatives.
- The isolated world cannot call functions defined by the page (React handlers, page globals). Use DOM events (`element.click()`) instead.
- Tool results are capped (30k characters by default, `read_page` at `max_chars`), so very large pages need selector-scoped reads or scripted extraction.
- One conversation is kept at a time; there is no cross-tab memory or scheduled automation yet.
- Streaming with tools depends on your Ollama version. If a model misbehaves, turn **Stream responses** off.

## Ideas / next steps

- Pick a target tab explicitly instead of following the active one.
- Element-index actions (click/focus/type by visible label) on top of DOM reads.
- Screenshot + vision models via `tabs.captureTab`.
- An `open_url` tool and multi-tab workflows.
- Per-site permission presets and a read-only mode.
- MV3 transport behind the same `agent.ts` loop.
