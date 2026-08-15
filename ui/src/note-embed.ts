import { invoke } from "@tauri-apps/api/core";
import { splitFrontmatter } from "./frontmatter";
import { bindLinkPreviews } from "./link-preview";
import { hydrateTableOfContents, renderPreview } from "./preview";
import { executeBlocksInPreview } from "./dv-engine";
import { makeEngineContext } from "./dv-context";
import type { OpenFile } from "./types";
import { splitWikilinkTarget } from "./wikilinks";
import { hydrateMarkdownImages, hydrateWikilinkImage } from "./image-embed";
import { hydrateWikilinkPdf } from "./pdf-view";
import { hydrateMermaid } from "./mermaid";
import { hydrateCsvFences } from "./csv-view";
import { hydrateWikilinkAudio, hydrateWikilinkVideo } from "./media-view";

type EmbedOptions = {
  openLink: (target: string) => void;
  ancestors?: ReadonlySet<string>;
  depth?: number;
};

const MAX_EMBED_DEPTH = 4;

/** Replace Markdown `![[note]]`, `![[note#Heading]]`, and block embeds in-place. */
export async function hydrateNoteEmbeds(
  root: HTMLElement,
  fromPath: string,
  options: EmbedOptions,
): Promise<void> {
  const depth = options.depth ?? 0;
  if (depth >= MAX_EMBED_DEPTH) return;

  const embeds = Array.from(
    root.querySelectorAll<HTMLAnchorElement>(
      "a.preview-wikilink.embed[data-wikilink]",
    ),
  );
  await Promise.all(embeds.map(async (link) => {
    // Skip only if this node was already removed/replaced by another hydrator.
    if (!root.contains(link)) return;
    const target = link.dataset.wikilink?.trim();
    if (!target) return;
    const { note, heading, block } = splitWikilinkTarget(target);
    const resolved = await invoke<string | null>("resolve_wikilink", {
      target: note || fromPath,
      fromPath,
    });
    if (!resolved) {
      link.classList.add("embed-unresolved");
      link.title = `Embedded note not found: ${target}`;
      return;
    }

    if (await hydrateWikilinkImage(link, resolved, target)) return;
    if (await hydrateWikilinkPdf(link, resolved, target)) return;
    if (await hydrateWikilinkAudio(link, resolved, target)) return;
    if (await hydrateWikilinkVideo(link, resolved, target)) return;

    const ancestors = new Set(options.ancestors ?? []);
    const signature = `${resolved}#${
      heading ? `heading:${normalizeHeading(heading)}` : block ? `block:${block}` : "note"
    }`;
    if (ancestors.has(signature)) {
      replaceWithError(link, `Recursive embed: ${target}`);
      return;
    }

    const file = await invoke<OpenFile>("read_file", { path: resolved });
    // Standalone Excalidraw JSON is handled by the drawing hydrator. If drawing
    // hydration failed, do not dump its JSON into a Markdown transclusion.
    if (resolved.toLowerCase().endsWith(".excalidraw")) return;

    const { body } = splitFrontmatter(file.content);
    const selected = heading
      ? extractHeadingSection(body, heading)
      : block
        ? extractBlock(body, block)
        : body;
    if (selected == null) {
      replaceWithError(
        link,
        heading
          ? `Heading not found: ${heading}`
          : `Block not found: ^${block}`,
      );
      return;
    }

    const embed = document.createElement("section");
    embed.className = "note-embed";
    embed.dataset.embedPath = resolved;
    embed.dataset.embedTarget = target;
    embed.innerHTML = renderPreview(selected);
    link.replaceWith(embed);

    await executeBlocksInPreview(
      selected,
      embed,
      makeEngineContext(resolved, file.content, options.openLink),
    );
    await hydrateMarkdownImages(embed, resolved);
    hydrateCsvFences(embed);
    await hydrateMermaid(embed);
    ancestors.add(signature);
    await hydrateNoteEmbeds(embed, resolved, {
      ...options,
      ancestors,
      depth: depth + 1,
    });
    bindEmbeddedLinks(embed, resolved, options.openLink);
    hydrateTableOfContents(embed);
  }));
}

/** Return a heading and its body, stopping at the next peer/ancestor heading. */
export function extractHeadingSection(
  markdown: string,
  requestedHeading: string,
): string | null {
  const wanted = normalizeHeading(requestedHeading);
  const lines = markdown.split(/(?<=\n)/);
  let start = -1;
  let level = 0;
  let offset = 0;
  let inFence: "`" | "~" | null = null;

  for (const line of lines) {
    const plain = line.replace(/\r?\n$/, "");
    const fence = plain.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (inFence === marker) inFence = null;
      else if (!inFence) inFence = marker;
      offset += line.length;
      continue;
    }
    if (inFence) {
      offset += line.length;
      continue;
    }

    const match = plain.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
    if (match) {
      const currentLevel = match[1].length;
      if (start >= 0 && currentLevel <= level) {
        return markdown.slice(start, offset).trimEnd();
      }
      if (start < 0 && normalizeHeading(match[2]) === wanted) {
        start = offset;
        level = currentLevel;
      }
    }
    offset += line.length;
  }
  return start >= 0 ? markdown.slice(start).trimEnd() : null;
}

/** Return the source block carrying an Obsidian `^block-id` marker. */
export function extractBlock(markdown: string, requestedId: string): string | null {
  const id = requestedId.trim().replace(/^\^/, "");
  if (!id) return null;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`(?:^|\\s)\\^${escaped}[ \\t]*$`);
  const lines = markdown.split(/\r?\n/);
  const index = lines.findIndex((line) => marker.test(line));
  if (index < 0) return null;

  let start = index;
  while (start > 0 && lines[start - 1].trim() !== "") start--;
  let end = index + 1;
  const baseIndent = (lines[start].match(/^\s*/)?.[0].length ?? 0);
  while (end < lines.length) {
    const next = lines[end];
    if (!next.trim()) {
      let look = end + 1;
      while (look < lines.length && !lines[look].trim()) look += 1;
      const indent = lines[look]?.match(/^\s*/)?.[0].length ?? 0;
      if (look < lines.length && indent > baseIndent) {
        end = look;
        continue;
      }
      break;
    }
    const indent = next.match(/^\s*/)?.[0].length ?? 0;
    if (indent > baseIndent) {
      end += 1;
      continue;
    }
    break;
  }
  return lines.slice(start, end)
    .join("\n")
    .replace(new RegExp(`[ \\t]*\\^${escaped}[ \\t]*$`), "")
    .trim();
}

function normalizeHeading(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Preserve a literal percent sign in an otherwise valid heading.
  }
  return decoded
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function bindEmbeddedLinks(
  root: HTMLElement,
  fromPath: string,
  openLink: (target: string) => void,
): void {
  root.querySelectorAll<HTMLAnchorElement>("a.preview-wikilink[data-wikilink]")
    .forEach((link) => {
      if (link.classList.contains("embed")) return;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const target = link.dataset.wikilink;
        if (target) openLink(target);
      });
    });
  bindLinkPreviews(root, { fromPath, openLink });
}

function replaceWithError(link: HTMLAnchorElement, message: string): void {
  const error = document.createElement("span");
  error.className = "note-embed-error";
  error.textContent = message;
  link.replaceWith(error);
}
