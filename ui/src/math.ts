/**
 * Preview-only math: `$…$`, `$$…$$`, and ` ```math ` / ` ```tex `.
 * Source Markdown is never rewritten.
 */

import katex from "katex";

const PLACEHOLDER = (index: number) => `<!--NEPHRITE_MATH_${index}-->`;
const PLACEHOLDER_RE = /<!--NEPHRITE_MATH_(\d+)-->/g;
const FENCE_MATH = /^(math|tex)$/i;

export type MathSlot = { tex: string; display: boolean };

export function looksLikeMathFence(info: string): boolean {
  return FENCE_MATH.test(info.trim().split(/\s+/)[0] ?? "");
}

/** Replace math with HTML comments so marked/wikilinks cannot mangle TeX. */
export function extractMath(markdown: string): { text: string; slots: MathSlot[] } {
  const slots: MathSlot[] = [];
  let output = "";
  let i = 0;
  const n = markdown.length;

  const push = (tex: string, display: boolean) => {
    const index = slots.length;
    slots.push({ tex, display });
    output += PLACEHOLDER(index);
  };

  while (i < n) {
    if (markdown[i] === "\\" && markdown[i + 1] === "$") {
      output += "\\$";
      i += 2;
      continue;
    }

    const fence = fenceAt(markdown, i);
    if (fence) {
      const close = markdown.indexOf(fence.token, fence.contentStart);
      if (close < 0) {
        output += markdown.slice(i);
        break;
      }
      if (looksLikeMathFence(fence.info)) {
        push(markdown.slice(fence.contentStart, close).replace(/^\n/, "").replace(/\n$/, ""), true);
      } else {
        output += markdown.slice(i, close + fence.token.length);
      }
      i = close + fence.token.length;
      continue;
    }

    if (markdown[i] === "`") {
      const tick = tickRun(markdown, i);
      const close = markdown.indexOf(tick, i + tick.length);
      if (close < 0) {
        output += markdown[i];
        i += 1;
        continue;
      }
      output += markdown.slice(i, close + tick.length);
      i = close + tick.length;
      continue;
    }

    if (markdown.startsWith("$$", i)) {
      const close = markdown.indexOf("$$", i + 2);
      if (close < 0) {
        output += markdown[i];
        i += 1;
        continue;
      }
      push(markdown.slice(i + 2, close), true);
      i = close + 2;
      continue;
    }

    if (markdown[i] === "$" && isInlineOpen(markdown, i)) {
      const close = findInlineClose(markdown, i + 1);
      if (close < 0) {
        output += markdown[i];
        i += 1;
        continue;
      }
      push(markdown.slice(i + 1, close), false);
      i = close + 1;
      continue;
    }

    output += markdown[i];
    i += 1;
  }

  return { text: output, slots };
}

export function renderMathSlot(slot: MathSlot): string {
  const tex = slot.tex.trim();
  if (!tex) {
    return `<code class="math-empty">${slot.display ? "$$" : "$"}${slot.display ? "$$" : "$"}</code>`;
  }
  try {
    return katex.renderToString(tex, {
      displayMode: slot.display,
      throwOnError: false,
      strict: "ignore",
      output: "html",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<code class="math-error" title="${escapeAttr(message)}">${escapeHtml(tex)}</code>`;
  }
}

export function restoreMath(html: string, slots: MathSlot[]): string {
  if (!slots.length) return html;
  return html
    .replace(/<p>\s*<!--NEPHRITE_MATH_(\d+)-->\s*<\/p>/g, (_whole, raw: string) => {
      const slot = slots[Number(raw)];
      return slot ? renderMathSlot(slot) : _whole;
    })
    .replace(PLACEHOLDER_RE, (_whole, raw: string) => {
      const slot = slots[Number(raw)];
      return slot ? renderMathSlot(slot) : _whole;
    });
}

export function renderMarkdownMath(markdown: string): { markdown: string; restore: (html: string) => string } {
  const extracted = extractMath(markdown);
  return {
    markdown: extracted.text,
    restore: (html) => restoreMath(html, extracted.slots),
  };
}

function fenceAt(markdown: string, index: number): { token: string; info: string; contentStart: number } | null {
  if (markdown[index] !== "`" && markdown[index] !== "~") return null;
  if (index > 0 && markdown[index - 1] !== "\n") return null;
  const marker = markdown[index];
  let end = index + 1;
  while (markdown[end] === marker) end += 1;
  if (end - index < 3) return null;
  const lineEnd = markdown.indexOf("\n", end);
  const infoLine = markdown.slice(end, lineEnd < 0 ? markdown.length : lineEnd);
  if (infoLine.includes(marker)) return null;
  return {
    token: markdown.slice(index, end),
    info: infoLine.trim(),
    contentStart: lineEnd < 0 ? markdown.length : lineEnd + 1,
  };
}

function tickRun(markdown: string, index: number): string {
  let end = index + 1;
  while (markdown[end] === "`") end += 1;
  return markdown.slice(index, end);
}

function isInlineOpen(markdown: string, index: number): boolean {
  const prev = markdown[index - 1] ?? "";
  const next = markdown[index + 1] ?? "";
  if (next === "$" || next === "" || /\s/.test(next) || /\d/.test(next)) return false;
  if (/\d/.test(prev)) return false;
  return true;
}

function findInlineClose(markdown: string, start: number): number {
  for (let i = start; i < markdown.length; i++) {
    if (markdown[i] === "\\" && markdown[i + 1] === "$") {
      i += 1;
      continue;
    }
    if (markdown[i] !== "$") continue;
    if (markdown[i + 1] === "$") continue;
    const prev = markdown[i - 1] ?? "";
    if (/\s/.test(prev)) continue;
    return i;
  }
  return -1;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
