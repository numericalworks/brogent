import type { LlmTool } from "./llm/types";
import { parseReadPageOptions } from "./page-scripts";

export const READ_PAGE = "read_page";
export const EXECUTE_JAVASCRIPT = "execute_javascript";

export const TOOL_DEFINITIONS: LlmTool[] = [
  {
    type: "function",
    function: {
      name: READ_PAGE,
      description:
        'Read the active browser tab. mode "text" returns the visible text (best for summarizing), "html" returns cleaned HTML, "links" lists every link, "outline" lists headings, "selection" returns the user\'s selected text.',
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["text", "html", "links", "outline", "selection"],
            description: 'What to read. Defaults to "text".',
          },
          selector: {
            type: "string",
            description:
              "Optional CSS selector to limit the read to one element (e.g. \"main\" or \"#content\").",
          },
          max_chars: {
            type: "integer",
            description: "Maximum characters to return. Defaults to 12000, capped at 60000.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: EXECUTE_JAVASCRIPT,
      description:
        "Run JavaScript in the active tab and return a JSON-serializable result. The code is the body of an async function: use `return` to send a value back. Full DOM access is available, but the page's own JS variables and functions are not.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Async function body to execute in the tab. Example: `const items = [...document.querySelectorAll('h2')]; return items.map((h) => h.innerText);`",
          },
          purpose: {
            type: "string",
            description: "One-line, human-readable description of what the script does.",
          },
        },
        required: ["code"],
      },
    },
  },
];

/** Tools that change the page and therefore may need user confirmation. */
export function mutatingTool(name: string): boolean {
  return name === EXECUTE_JAVASCRIPT;
}

export function describeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === READ_PAGE) {
    const options = parseReadPageOptions(args);
    const scope = options.selector ? ` ${options.selector}` : "";
    return `Read ${options.mode}${scope}`;
  }
  if (name === EXECUTE_JAVASCRIPT) {
    const purpose = typeof args.purpose === "string" ? args.purpose.trim() : "";
    return purpose ? `Run script: ${purpose}` : "Run JavaScript";
  }
  return name;
}

export function isKnownTool(name: string): boolean {
  return name === READ_PAGE || name === EXECUTE_JAVASCRIPT;
}
