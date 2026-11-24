/**
 * A deliberately small, dependency-free Markdown renderer.
 *
 * It builds DOM nodes directly (never `innerHTML`) so model output cannot
 * inject markup, and it only covers the subset of Markdown that chat answers
 * actually use: headings, lists, quotes, code, tables, emphasis and links.
 */

import { copyToClipboard } from "./clipboard";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function block(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!line.trim()) return true;
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) return true;
  if (isTableStart(lines, index)) return true;
  return false;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? "";
  const separator = lines[index + 1] ?? "";
  return header.includes("|") && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(separator);
}

function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith("#")) return value;
  return null;
}

function link(label: string, url: string, className?: string): HTMLAnchorElement {
  const anchor = h("a");
  anchor.href = url;
  anchor.textContent = label;
  anchor.rel = "noreferrer noopener";
  anchor.target = "_blank";
  if (className) anchor.className = className;
  return anchor;
}

function appendText(fragment: DocumentFragment, text: string): void {
  const parts = text.split("\n");
  parts.forEach((part, index) => {
    if (index > 0) fragment.append(h("br"));
    if (part) fragment.append(document.createTextNode(part));
  });
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\))|(https?:\/\/[^\s<>()\]]+)/g;

function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) appendText(fragment, text.slice(last, index));

    const token = match[0];

    if (token.startsWith("`")) {
      const code = h("code");
      code.textContent = token.slice(1, -1);
      fragment.append(code);
    } else if (token.startsWith("**")) {
      const strong = h("strong");
      strong.append(inline(token.slice(2, -2)));
      fragment.append(strong);
    } else if (token.startsWith("~~")) {
      const del = h("del");
      del.append(inline(token.slice(2, -2)));
      fragment.append(del);
    } else if (token.startsWith("*")) {
      const em = h("em");
      em.append(inline(token.slice(1, -1)));
      fragment.append(em);
    } else if (token.startsWith("[")) {
      const parsed = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(token);
      const href = parsed ? safeHref(parsed[2] ?? "") : null;
      if (parsed && href) {
        fragment.append(link(parsed[1] ?? "", href));
      } else {
        appendText(fragment, parsed?.[1] ?? token);
      }
    } else {
      let url = token;
      let trailing = "";
      while (/[.,;:!?\]}]+$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
      const href = safeHref(url);
      if (href) fragment.append(link(url, href));
      else appendText(fragment, url);
      if (trailing) appendText(fragment, trailing);
    }

    last = index + token.length;
  }

  if (last < text.length) appendText(fragment, text.slice(last));
  return fragment;
}

function codeBlock(code: string, language: string): HTMLElement {
  const wrapper = h("div", "code-block");

  const head = h("div", "code-head");
  const label = h("span", "code-lang");
  label.textContent = language || "code";

  const copy = h("button", "code-copy");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    void copyToClipboard(code).then((copied) => {
      copy.textContent = copied ? "Copied" : "Failed";
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 1200);
    });
  });

  head.append(label, copy);

  const pre = h("pre");
  const codeElement = h("code");
  codeElement.textContent = code;
  pre.append(codeElement);

  wrapper.append(head, pre);
  return wrapper;
}

function table(lines: string[], start: number, fragment: DocumentFragment): number {
  const split = (row: string) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const headers = split(lines[start] ?? "");
  const body = h("tbody");
  const head = h("thead");
  const headRow = h("tr");
  for (const header of headers) {
    const cell = h("th");
    cell.append(inline(header));
    headRow.append(cell);
  }
  head.append(headRow);

  let index = start + 2;
  while (index < lines.length) {
    const row = lines[index] ?? "";
    if (!row.trim() || !row.includes("|")) break;
    const cells = split(row);
    const tr = h("tr");
    headers.forEach((_, cellIndex) => {
      const cell = h("td");
      cell.append(inline(cells[cellIndex] ?? ""));
      tr.append(cell);
    });
    body.append(tr);
    index += 1;
  }

  const element = h("table");
  element.append(head, body);
  fragment.append(element);
  return index;
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

function list(lines: string[], start: number, fragment: DocumentFragment): number {
  const items: ListItem[] = [];
  let index = start;

  while (index < lines.length) {
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index] ?? "");
    if (match) {
      items.push({
        indent: (match[1] ?? "").replace(/\t/g, "  ").length,
        ordered: /\d/.test(match[2] ?? ""),
        text: match[3] ?? "",
      });
      index += 1;
      continue;
    }

    const continuation = lines[index] ?? "";
    const previous = items[items.length - 1];
    if (previous && continuation.trim() && /^\s{2,}/.test(continuation)) {
      previous.text += `\n${continuation.trim()}`;
      index += 1;
      continue;
    }
    break;
  }

  if (!items.length) return index;

  const root = h(items[0]!.ordered ? "ol" : "ul");
  const stack: Array<{ element: HTMLElement; indent: number }> = [
    { element: root, indent: items[0]!.indent },
  ];

  for (const item of items) {
    while (stack.length > 1 && item.indent < stack[stack.length - 1]!.indent) stack.pop();
    let top = stack[stack.length - 1]!;

    if (item.indent > top.indent + 1) {
      const nested = h(item.ordered ? "ol" : "ul");
      const host = top.element.lastElementChild ?? top.element;
      host.append(nested);
      stack.push({ element: nested, indent: item.indent });
      top = stack[stack.length - 1]!;
    }

    const li = h("li");
    li.append(inline(item.text));
    top.element.append(li);
  }

  fragment.append(root);
  return index;
}

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^\s*(`{3,}|~{3,})\s*([\w#+.-]*)\s*$/.exec(line);
    if (fence) {
      const marker = (fence[1] ?? "```")[0]!;
      const language = fence[2] ?? "";
      const closing = new RegExp("^\\s*" + marker + "{3,}\\s*$");
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (closing.test(current)) {
          index += 1;
          break;
        }
        buffer.push(current);
        index += 1;
      }
      fragment.append(codeBlock(buffer.join("\n"), language));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, Math.max(1, (heading[1] ?? "#").length));
      const node = h(`h${level}` as "h1");
      node.append(inline(heading[2] ?? ""));
      fragment.append(node);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      fragment.append(h("hr"));
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buffer: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        buffer.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const quote = h("blockquote");
      quote.append(renderMarkdown(buffer.join("\n")));
      fragment.append(quote);
      continue;
    }

    if (isTableStart(lines, index)) {
      index = table(lines, index, fragment);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      index = list(lines, index, fragment);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !block(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    if (!paragraph.length) {
      // Defensive: never loop forever on an unhandled line.
      paragraph.push(line);
      index += 1;
    }
    const p = h("p");
    p.append(inline(paragraph.join("\n")));
    fragment.append(p);
  }

  return fragment;
}
