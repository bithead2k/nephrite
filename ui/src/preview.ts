import { marked } from "marked";
import { renderPropertiesHtml, splitFrontmatter } from "./frontmatter";
import { blockHash, splitMarkdownBlocks } from "./preview-blocks";

marked.setOptions({
  gfm: true,
  breaks: true,
});

export type RenderPreviewOptions = {
  /** When false, omit the Properties / YAML block entirely. Default true. */
  includeFrontmatter?: boolean;
  /**
   * When true, force the Properties <details> open (useful for print/PDF).
   * Default false.
   */
  openFrontmatter?: boolean;
};

/**
 * Render for the preview pane only — never a write-back path.
 * Frontmatter is stripped and shown as a property table; body is Markdown.
 */
export function renderPreview(
  markdown: string,
  options: RenderPreviewOptions = {},
): string {
  const includeFrontmatter = options.includeFrontmatter !== false;
  const { yaml, body, hasFrontmatter } = splitFrontmatter(markdown);

  let html = "";
  if (includeFrontmatter && hasFrontmatter && yaml != null) {
    let props = renderPropertiesHtml(yaml);
    if (options.openFrontmatter) {
      props = props.replace("<details ", "<details open ");
    }
    html += props;
  }

  // Fence-aware blocks: trivial edits can replace a single .md-block node.
  try {
    const blocks = splitMarkdownBlocks(body);
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      const withLinks = replaceWikilinksOutsideCode(block);
      const rendered = marked.parse(withLinks, { async: false }) as string;
      const inner = renderTocMarkers(renderCallouts(rendered));
      const hash = blockHash(block);
      html += `<div class="md-block" data-block-index="${index}" data-block-hash="${hash}">${inner}</div>`;
    }
  } catch {
    html += `<pre class="preview-error">${escapeHtml(body)}</pre>`;
  }

  return html || `<p class="preview-empty">(empty note)</p>`;
}

function renderTocMarkers(html: string): string {
  return html.replace(
    /<p>\s*\[toc\]\s*<\/p>/gi,
    `<nav class="table-of-contents" aria-label="Table of contents">` +
      `<div class="toc-title">Contents</div><ol></ol></nav>`,
  );
}

export function hydrateTableOfContents(root: ParentNode): void {
  const outlines = root.querySelectorAll<HTMLElement>(".table-of-contents");
  if (outlines.length === 0) return;

  const counts = new Map<string, number>();
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
  const entries = headings.map((heading) => {
    const label = heading.textContent?.trim() || "Section";
    const base = slugify(label) || "section";
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    heading.id = id;
    return { id, label, level: Number(heading.tagName.slice(1)) };
  });

  outlines.forEach((outline) => {
    outline.classList.toggle("empty", entries.length === 0);
    const list = outline.querySelector("ol");
    if (!list) return;
    list.innerHTML = entries.map(({ id, label, level }) =>
      `<li class="toc-level-${level}"><a href="#${escapeAttr(id)}" data-toc-target="${escapeAttr(id)}">${escapeHtml(label)}</a></li>`,
    ).join("");
    list.querySelectorAll<HTMLAnchorElement>("a[data-toc-target]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const targetId = link.dataset.tocTarget;
        const target = headings.find((heading) => heading.id === targetId);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  });
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function renderCallouts(html: string): string {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (whole, inner: string) => {
    const marker = inner.match(
      /^\s*<p>\[!\s*([a-z0-9_-]+)\]([+-]?)[ \t]*(?:([^\n<]+)\n)?/i,
    );
    if (!marker) return whole;

    const type = marker[1].toLowerCase();
    const fold = marker[2];
    const title = marker[3]?.trim() || calloutTitle(type);
    let remainder = inner.slice(marker[0].length);
    const startsNewBlock = remainder.startsWith("</p>");
    if (startsNewBlock) remainder = remainder.slice(4).replace(/^\s+/, "");
    const content = startsNewBlock ? remainder : `<p>${remainder}`;
    const titleHtml =
      `<span class="callout-icon" aria-hidden="true">${calloutIcon(type)}</span>` +
      `<span class="callout-title-text">${title}</span>`;

    if (fold) {
      const open = fold === "+" ? " open" : "";
      return `<details class="callout" data-callout="${escapeAttr(type)}"${open}>` +
        `<summary class="callout-title">${titleHtml}</summary>` +
        `<div class="callout-content">${content}</div></details>`;
    }
    return `<aside class="callout" data-callout="${escapeAttr(type)}">` +
      `<div class="callout-title">${titleHtml}</div>` +
      `<div class="callout-content">${content}</div></aside>`;
  });
}

function calloutTitle(type: string): string {
  return type.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function calloutIcon(type: string): string {
  if (["warning", "caution", "attention"].includes(type)) return "⚠";
  if (["danger", "error", "failure", "fail", "missing"].includes(type)) return "!";
  if (["success", "check", "done"].includes(type)) return "✓";
  if (["question", "help", "faq"].includes(type)) return "?";
  if (["tip", "hint", "important"].includes(type)) return "◆";
  if (["quote", "cite"].includes(type)) return "“";
  return "i";
}

function replaceWikilinksOutsideCode(markdown: string): string {
  const renderLinks = (text: string) => text.replace(
    /(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, embed: string, target: string, alias?: string) => {
      const label = alias?.trim() || target.trim();
      const cls = embed ? "preview-wikilink embed" : "preview-wikilink";
      const options = embed && alias ? ` data-embed-options="${escapeAttr(alias.trim())}"` : "";
      return `<a href="#" class="${cls}" data-wikilink="${escapeAttr(target.trim())}"${options}>${escapeHtml(label)}</a>`;
    },
  );

  let output = "";
  let proseStart = 0;
  let i = 0;
  while (i < markdown.length) {
    if (markdown[i] !== "`") {
      i++;
      continue;
    }
    let delimiterEnd = i + 1;
    while (markdown[delimiterEnd] === "`") delimiterEnd++;
    const delimiter = markdown.slice(i, delimiterEnd);
    const close = markdown.indexOf(delimiter, delimiterEnd);
    if (close < 0) {
      i = delimiterEnd;
      continue;
    }
    output += renderLinks(markdown.slice(proseStart, i));
    output += markdown.slice(i, close + delimiter.length);
    i = close + delimiter.length;
    proseStart = i;
  }
  output += renderLinks(markdown.slice(proseStart));
  return output;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}


/** Render a single markdown block to the same wrapper shape as renderPreview. */
export function renderBlockHtml(block: string, index: number): string {
  const withLinks = replaceWikilinksOutsideCode(block);
  try {
    const rendered = marked.parse(withLinks, { async: false }) as string;
    const inner = renderTocMarkers(renderCallouts(rendered));
    const hash = blockHash(block);
    return `<div class="md-block" data-block-index="${index}" data-block-hash="${hash}">${inner}</div>`;
  } catch {
    return `<div class="md-block" data-block-index="${index}" data-block-hash="${blockHash(block)}"><pre class="preview-error">${escapeHtml(block)}</pre></div>`;
  }
}
