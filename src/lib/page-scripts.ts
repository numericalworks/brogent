/**
 * Builders for the snippets we inject into the page with
 * `browser.tabs.executeScript({ code })`.
 *
 * Everything here is a plain string: no eval happens in the extension itself,
 * and Firefox injects the code into the page's content-script world.
 *
 * Injected snippets always return a JSON string so that the result survives
 * structure cloning predictably.
 */

const DEFAULT_MAX_CHARS = 12_000;
const MAX_MAX_CHARS = 50_000;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export interface ReadPageOptions {
  mode: "text" | "html" | "links" | "outline" | "selection";
  selector: string;
  maxChars: number;
}

export function parseReadPageOptions(args: Record<string, unknown>): ReadPageOptions {
  const rawMode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "text";
  const mode = (["text", "html", "links", "outline", "selection"] as const).includes(
    rawMode as ReadPageOptions["mode"],
  )
    ? (rawMode as ReadPageOptions["mode"])
    : "text";
  return {
    mode,
    selector: typeof args.selector === "string" ? args.selector.trim() : "",
    maxChars: clampInt(args.max_chars, DEFAULT_MAX_CHARS, 500, MAX_MAX_CHARS),
  };
}

/** Reads the page synchronously; returns `{ ok, url, title, mode, content, ... }`. */
export function buildReadPageScript(args: Record<string, unknown>): string {
  const options = parseReadPageOptions(args);
  return `(() => {
  const options = ${JSON.stringify(options)};
  try {
    const root = options.selector ? document.querySelector(options.selector) : document.body || document.documentElement;
    if (!root) {
      return JSON.stringify({ ok: false, error: "No element matches selector: " + options.selector });
    }
    const selection = (window.getSelection && window.getSelection() && window.getSelection().toString()) || "";
    const meta = {
      url: location.href,
      title: document.title,
      description: (document.querySelector('meta[name="description"]') || {}).content || "",
      mode: options.mode,
      selector: options.selector || null,
      selection: selection.slice(0, 2000)
    };
    let content = "";
    let count = undefined;

    if (options.mode === "text") {
      const raw = root.innerText !== undefined && root.innerText !== null ? root.innerText : (root.textContent || "");
      content = raw.replace(/\\u00a0/g, " ").replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
    } else if (options.mode === "html") {
      const clone = root.cloneNode(true);
      clone.querySelectorAll("script,style,noscript,template,iframe,svg,link,meta").forEach((node) => node.remove());
      clone.querySelectorAll("*").forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
          const name = attribute.name.toLowerCase();
          if (name.startsWith("on") || name === "style" || name === "srcset" || name === "nonce") {
            element.removeAttribute(attribute.name);
          } else if (name === "src" && /^data:/i.test(attribute.value)) {
            element.removeAttribute(attribute.name);
          }
        }
      });
      content = clone.outerHTML || clone.innerHTML || "";
    } else if (options.mode === "links") {
      const seen = new Set();
      const lines = [];
      root.querySelectorAll("a[href]").forEach((anchor) => {
        const href = anchor.href;
        if (!href || /^javascript:/i.test(href) || seen.has(href)) return;
        seen.add(href);
        const text = (anchor.innerText || anchor.textContent || "").replace(/\\s+/g, " ").trim();
        lines.push("- " + (text ? text.slice(0, 160) : "(no text)") + " — " + href);
      });
      count = lines.length;
      content = lines.join("\\n");
    } else if (options.mode === "outline") {
      const lines = [];
      root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading) => {
        const text = (heading.innerText || heading.textContent || "").replace(/\\s+/g, " ").trim();
        if (text) lines.push("[" + heading.tagName + "] " + text);
      });
      count = lines.length;
      content = lines.join("\\n");
    } else if (options.mode === "selection") {
      content = selection;
    } else {
      return JSON.stringify({ ok: false, error: "Unknown mode: " + options.mode });
    }

    const totalChars = content.length;
    const truncated = totalChars > options.maxChars;
    if (truncated) content = content.slice(0, options.maxChars);

    return JSON.stringify({
      ok: true,
      url: meta.url,
      title: meta.title,
      description: meta.description,
      mode: meta.mode,
      selector: meta.selector,
      selection: meta.selection,
      count,
      truncated,
      totalChars,
      content
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String((error && error.stack) || error).slice(0, 2000) });
  }
})()`;
}

/**
 * Starts an async job and returns immediately. The job's outcome is stored on
 * the content-script `window` so `buildJobPollScript` can read it later; this
 * avoids depending on how `executeScript` handles returned promises.
 */
export function buildExecuteJobScript(code: string, jobKey: string): string {
  return `(() => {
  const store = window.__brogentJobs || (window.__brogentJobs = {});
  store[${JSON.stringify(jobKey)}] = { status: "running" };
  const key = ${JSON.stringify(jobKey)};
  const finish = (payload) => {
    if (payload && payload.ok && payload.result !== undefined) {
      let size = 0;
      try { size = JSON.stringify(payload.result).length; } catch (error) { size = Infinity; }
      if (size > 45000) {
        payload = {
          ok: false,
          error: "The value was " + size + " characters when serialized, which is too large to pass back. Return a smaller value, a summary, or a subset."
        };
      }
    }
    store[key] = Object.assign({ status: "done" }, payload);
  };
  try {
    Promise.resolve((async () => {
${code}
    })()).then(
      (value) => finish({ ok: true, result: __brogentSerialize(value) }),
      (error) => finish({ ok: false, error: __brogentError(error) })
    );
  } catch (error) {
    finish({ ok: false, error: __brogentError(error) });
  }
  return true;

  function __brogentError(error) {
    const text = String((error && error.stack) || (error && error.message) || error);
    return text.slice(0, 4000);
  }

  function __brogentSerialize(value, depth, seen) {
    depth = depth || 0;
    seen = seen || [];
    if (value === null) return null;
    const type = typeof value;
    if (type === "undefined") return null;
    if (type === "string" || type === "boolean") return value;
    if (type === "number") return Number.isFinite(value) ? value : String(value);
    if (type === "bigint") return value.toString() + "n";
    if (type === "symbol") return String(value);
    if (type === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (depth > 5) return "[MaxDepth]";
    for (const ancestor of seen) {
      if (ancestor === value) return "[Circular]";
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: String(value.stack || "").slice(0, 2000) };
    }
    if (typeof Node !== "undefined" && value instanceof Node) {
      if (value.nodeType === 1) {
        return String(value.outerHTML || "").slice(0, 4000);
      }
      return String(value.textContent || "").slice(0, 4000);
    }
    if (typeof NodeList !== "undefined" && value instanceof NodeList) {
      return __brogentSerialize(Array.from(value), depth + 1, seen);
    }
    if (typeof HTMLCollection !== "undefined" && value instanceof HTMLCollection) {
      return __brogentSerialize(Array.from(value), depth + 1, seen);
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    seen.push(value);
    try {
      if (Array.isArray(value)) {
        const limit = 500;
        const mapped = value.slice(0, limit).map((item) => __brogentSerialize(item, depth + 1, seen));
        if (value.length > limit) mapped.push("[..." + (value.length - limit) + " more items]");
        return mapped;
      }
      if (value instanceof Map) {
        return __brogentSerialize(Array.from(value.entries()), depth + 1, seen);
      }
      if (value instanceof Set) {
        return __brogentSerialize(Array.from(value.values()), depth + 1, seen);
      }
      if (type === "object") {
        const output = {};
        let index = 0;
        for (const property in value) {
          if (++index > 300) {
            output.__more = true;
            break;
          }
          try {
            output[property] = __brogentSerialize(value[property], depth + 1, seen);
          } catch (error) {
            output[property] = "[Unserializable]";
          }
        }
        return output;
      }
    } finally {
      seen.pop();
    }
    return String(value);
  }
})()`;
}

export function buildJobPollScript(jobKey: string): string {
  return `(() => {
  const store = window.__brogentJobs;
  const job = store && store[${JSON.stringify(jobKey)}];
  if (!job) return "";
  if (job.status === "done") {
    delete store[${JSON.stringify(jobKey)}];
  }
  return JSON.stringify(job);
})()`;
}

export function buildJobCleanupScript(jobKey: string): string {
  return `(() => {
  if (window.__brogentJobs) {
    delete window.__brogentJobs[${JSON.stringify(jobKey)}];
  }
  return true;
})()`;
}
