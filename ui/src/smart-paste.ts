/**
 * Clipboard interpretation for the Markdown editor.
 * HTML from a browser becomes Markdown. Already-Markdown plain text is kept.
 * Pasting a URL over a selection wraps it as a Markdown link.
 */

const MARKDOWN_HINT =
  /^(?:#{1,6}\s|[-*+]\s+\S|\d+\.\s|>\s|```|---$|\|.+\|)/m;

const MARKDOWN_INLINE = /!?\[.+\]\(|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`/;

export function looksLikeMarkdown(text: string): boolean {
  const sample = text.trim();
  if (!sample) return false;
  return MARKDOWN_HINT.test(sample) || MARKDOWN_INLINE.test(sample);
}

export function looksLikeUrl(text: string): boolean {
  const value = text.trim();
  return /^(https?:\/\/|mailto:|www\.)\S+$/i.test(value);
}

export function normalizePastedUrl(text: string): string {
  const value = text.trim();
  return /^www\./i.test(value) ? `https://${value}` : value;
}

export function smartPasteText(input: {
  html?: string | null;
  text?: string | null;
  selection?: string | null;
}): string {
  const text = (input.text ?? "").replace(/\r\n/g, "\n");
  const html = input.html?.trim() ?? "";
  const selection = input.selection ?? "";
  if (selection && looksLikeUrl(text) && !text.includes("\n")) {
    return `[${selection}](${normalizePastedUrl(text)})`;
  }
  if (html && shouldConvertHtml(html, text)) {
    const converted = htmlToMarkdown(html).replace(/\n{3,}/g, "\n\n").trim();
    if (converted) return converted;
  }
  return text;
}

function shouldConvertHtml(html: string, text: string): boolean {
  if (looksLikeMarkdown(text)) return false;
  if (/<(?:table|h[1-6]|ul|ol|blockquote|pre|img)\b/i.test(html)) return true;
  const links = html.match(/<a\b/gi)?.length ?? 0;
  return links >= 1 && !/^\s*https?:\/\//i.test(text.trim());
}

export function htmlToMarkdown(html: string): string {
  const parsed = new DOMParser().parseFromString(unwrapClipboardHtml(html), "text/html");
  parsed.querySelectorAll("script, style, meta, link, xml").forEach((node) => node.remove());
  return serializeNode(parsed.body).replace(/[ \t]+\n/g, "\n").trim();
}

function unwrapClipboardHtml(html: string): string {
  return html
    .replace(/^[\s\S]*<!--StartFragment-->/i, "")
    .replace(/<!--EndFragment-->[\s\S]*$/i, "")
    .replace(/<\/?o:p[^>]*>/gi, "");
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return collapseText(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = serializeChildren(el);
  switch (tag) {
    case "h1": return `\n# ${plain(inner)}\n\n`;
    case "h2": return `\n## ${plain(inner)}\n\n`;
    case "h3": return `\n### ${plain(inner)}\n\n`;
    case "h4": return `\n#### ${plain(inner)}\n\n`;
    case "h5": return `\n##### ${plain(inner)}\n\n`;
    case "h6": return `\n###### ${plain(inner)}\n\n`;
    case "p": return `\n${inner.trim()}\n\n`;
    case "br": return "\n";
    case "strong":
    case "b": return inner.trim() ? `**${inner.trim()}**` : "";
    case "em":
    case "i": return inner.trim() ? `*${inner.trim()}*` : "";
    case "s":
    case "del":
    case "strike": return inner.trim() ? `~~${inner.trim()}~~` : "";
    case "code":
      return el.closest("pre") ? inner : (inner ? `\`${inner}\`` : "");
    case "pre": {
      const lang = el.querySelector("code")?.className.match(/language-(\S+)/)?.[1] ?? "";
      const code = (el.textContent ?? "").replace(/\n$/, "");
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }
    case "a": {
      const href = el.getAttribute("href")?.trim() ?? "";
      const label = inner.trim() || href;
      if (!href || href.startsWith("javascript:")) return label;
      return `[${label}](${href})`;
    }
    case "img": {
      const src = el.getAttribute("src")?.trim() ?? "";
      const alt = el.getAttribute("alt")?.trim() ?? "";
      return src && !src.startsWith("data:") ? `![${alt}](${src})` : alt;
    }
    case "blockquote":
      return `\n${inner.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    case "ul": return `\n${serializeList(el, false)}\n`;
    case "ol": return `\n${serializeList(el, true)}\n`;
    case "li": return inner;
    case "hr": return "\n---\n\n";
    case "table": return `\n${serializeTable(el)}\n\n`;
    case "thead":
    case "tbody":
    case "tr":
    case "td":
    case "th":
    case "div":
    case "span":
    case "section":
    case "article":
    case "main":
    case "body":
    case "font":
      return inner;
    default:
      return inner;
  }
}

function serializeChildren(el: Element): string {
  return Array.from(el.childNodes).map(serializeNode).join("");
}

function serializeList(list: HTMLElement, ordered: boolean): string {
  const items = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === "li");
  return items.map((item, index) => {
    const marker = ordered ? `${index + 1}. ` : "- ";
    const body = serializeChildren(item).trim().replace(/\n+/g, "\n  ");
    return `${marker}${body}`;
  }).join("\n") + "\n";
}

function serializeTable(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return "";
  const cells = rows.map((row) =>
    Array.from(row.querySelectorAll("th, td")).map((cell) =>
      (cell.textContent ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim(),
    ),
  );
  const width = Math.max(...cells.map((row) => row.length));
  const padded = cells.map((row) => [...row, ...Array(width - row.length).fill("")]);
  const header = padded[0];
  const divider = header.map(() => "---");
  const rest = padded.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
    ...rest.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function collapseText(value: string): string {
  return value.replace(/\s+/g, " ");
}

function plain(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
