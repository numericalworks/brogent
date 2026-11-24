/**
 * Clipboard helper shared by the chat UI and the Markdown code blocks.
 *
 * `navigator.clipboard` requires a user gesture and is not available in every
 * context, so a hidden-textarea fallback keeps copy working in the sidebar.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
