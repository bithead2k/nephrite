import { marked } from "marked";
import { renderPropertiesHtml, splitFrontmatter } from "./frontmatter";
import { blockHash, splitMarkdownBlocks } from "./preview-blocks";
import { renderMarkdownMath } from "./math";
import { applyPandocInlineCodeAttrs } from "./pandoc-attrs";

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
      html += renderBlockHtml(blocks[index], index);
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
  hideEmptyContentSections(root);
  const outlines = root.querySelectorAll<HTMLElement>(".table-of-contents");
  if (outlines.length === 0) return;

  const counts = new Map<string, number>();
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
    .filter((heading) => heading.textContent?.trim() && !heading.closest("[hidden]"));
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

/**
 * Collapse preview-only sections whose rendered body has no content. This runs
 * after query hydration, so an empty Dataview result is treated as empty while
 * errors and real results remain visible. Source Markdown is never changed.
 */
export function hideEmptyContentSections(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-empty-section-hidden="true"]').forEach((element) => {
    element.hidden = false;
    delete element.dataset.emptySectionHidden;
  });

  root.querySelectorAll<HTMLElement>(".dv-block").forEach((block) => {
    setEmptySectionHidden(block, !hasRenderedContent(block));
  });

  hideEmptyGoalLists(root);

  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"));
  const children = directElementChildren(root);
  const sections = headings.map((heading) => ({
    heading,
    level: Number(heading.tagName.slice(1)),
    block: directChildContaining(root, heading),
  }));

  // Work from the bottom up so an empty child section cannot make its parent
  // appear populated merely because it contains another heading.
  for (let index = sections.length - 1; index >= 0; index--) {
    const section = sections[index];
    if (!section.block) continue;
    const start = children.indexOf(section.block);
    if (start < 0) continue;
    let end = children.length;
    for (let next = index + 1; next < sections.length; next++) {
      if (sections[next].level <= section.level && sections[next].block) {
        end = children.indexOf(sections[next].block!);
        break;
      }
    }
    if (end < start) continue;
    const hasContent = children.slice(start, end).some((block) => hasRenderedContent(block));
    if (!hasContent) {
      children.slice(start, end).forEach((block) => setEmptySectionHidden(block, true));
    }
  }
}

function hideEmptyGoalLists(root: ParentNode): void {
  const flow = Array.from(root.querySelectorAll<HTMLElement>(
    "strong, ul, ol, h1, h2, h3, h4, h5, h6",
  ));
  for (let index = 0; index < flow.length; index++) {
    const marker = flow[index];
    if (marker.tagName !== "STRONG") continue;
    const label = (marker.textContent ?? "").trim().replace(/:\s*$/, "").toLowerCase();
    if (label !== "daily goals" && label !== "stretch goals") continue;

    let list: HTMLElement | null = null;
    for (let next = index + 1; next < flow.length; next++) {
      const candidate = flow[next];
      if (/^H[1-6]$/.test(candidate.tagName) || candidate.tagName === "STRONG") break;
      if (candidate.tagName === "UL" || candidate.tagName === "OL") {
        list = candidate;
        break;
      }
    }
    if (!list || hasRenderedContent(list)) continue;
    setEmptySectionHidden(marker.closest<HTMLElement>("p") ?? marker, true);
    setEmptySectionHidden(list, true);
  }
}

function hasRenderedContent(element: HTMLElement): boolean {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(
    "h1, h2, h3, h4, h5, h6, hr, nav.table-of-contents, [hidden], input[type=checkbox]",
  ).forEach((ignored) => ignored.remove());
  if ((clone.textContent ?? "").trim()) return true;
  return Boolean(clone.querySelector(
    "img, video, audio, canvas, svg, iframe, table, .excalidraw-embed, .mermaid",
  ));
}

function directElementChildren(root: ParentNode): HTMLElement[] {
  return Array.from(root.childNodes).filter((node): node is HTMLElement => node.nodeType === 1);
}

function directChildContaining(root: ParentNode, element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current && current.parentNode !== root) current = current.parentElement;
  return current;
}

function setEmptySectionHidden(element: HTMLElement, hidden: boolean): void {
  if (!hidden) return;
  element.hidden = true;
  element.dataset.emptySectionHidden = "true";
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
  const math = renderMarkdownMath(block);
  const withLinks = replaceWikilinksOutsideCode(math.markdown);
  try {
    const rendered = marked.parse(withLinks, { async: false }) as string;
    const inner = applyPandocInlineCodeAttrs(
      math.restore(renderTocMarkers(renderCallouts(rendered))),
    );
    const hash = blockHash(block);
    return `<div class="md-block" data-block-index="${index}" data-block-hash="${hash}">${inner}</div>`;
  } catch {
    return `<div class="md-block" data-block-index="${index}" data-block-hash="${blockHash(block)}"><pre class="preview-error">${escapeHtml(block)}</pre></div>`;
  }
}
