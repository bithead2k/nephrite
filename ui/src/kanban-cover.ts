import { invoke } from "@tauri-apps/api/core";
import { splitFrontmatter } from "./frontmatter";
import { isImagePath, vaultMediaSrc } from "./image-embed";
import type { OpenFile } from "./types";

/** First match wins. `cover` is the vault convention (books, events). */
export const KANBAN_COVER_KEYS = ["cover", "image", "banner", "photo"] as const;

const coverSrcCache = new Map<string, string | null>();

export function clearKanbanCoverCache(): void {
  coverSrcCache.clear();
}

export type KanbanCoverRef =
  | { kind: "url"; href: string }
  | { kind: "vault"; target: string };

/** Scalar YAML value for a cover/image/banner/photo key. */
export function extractKanbanCoverValue(yaml: string | null | undefined): string | null {
  if (!yaml) return null;
  const wanted = new Set(KANBAN_COVER_KEYS);
  for (const rawLine of yaml.split(/\r?\n/)) {
    if (/^\s/.test(rawLine)) continue;
    const match = rawLine.match(/^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLocaleLowerCase();
    if (!wanted.has(key as (typeof KANBAN_COVER_KEYS)[number])) continue;
    const value = unquoteYamlScalar(match[2]);
    if (value) return value;
  }
  return null;
}

export function parseKanbanCoverRef(raw: string): KanbanCoverRef | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith("//")) {
    return { kind: "url", href: value.startsWith("//") ? `https:${value}` : value };
  }
  const wiki = value.match(/^!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/);
  if (wiki) return { kind: "vault", target: wiki[1].trim() };
  const markdown = value.match(/^!?\[[^\]]*\]\(([^)]+)\)$/);
  if (markdown) return parseKanbanCoverRef(markdown[1].trim());
  return { kind: "vault", target: value.replace(/^<|>$/g, "") };
}

export async function hydrateKanbanCardCovers(
  root: ParentNode,
  fromPath: string | null,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const cards = Array.from(root.querySelectorAll<HTMLElement>(".kanban-card[data-kanban-link]"));
  await Promise.all(cards.map(async (card) => {
    if (!shouldContinue()) return;
    const link = card.dataset.kanbanLink?.trim();
    if (!link || card.querySelector(".kanban-card-cover")) return;
    const src = await coverSrcForNote(link, fromPath);
    if (!shouldContinue() || !src || !card.isConnected) return;
    const frame = document.createElement("div");
    frame.className = "kanban-card-cover";
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    image.src = src;
    frame.appendChild(image);
    card.prepend(frame);
  }));
}

async function coverSrcForNote(
  link: string,
  fromPath: string | null,
): Promise<string | null> {
  const cacheKey = `${fromPath ?? ""}::${link}`;
  if (coverSrcCache.has(cacheKey)) return coverSrcCache.get(cacheKey) ?? null;
  let src: string | null = null;
  try {
    const resolved = await invoke<string | null>("resolve_wikilink", {
      target: link,
      fromPath,
    });
    if (!resolved) {
      coverSrcCache.set(cacheKey, null);
      return null;
    }
    const file = await invoke<OpenFile>("read_file", { path: resolved });
    const raw = extractKanbanCoverValue(splitFrontmatter(file.content).yaml);
    if (!raw) {
      coverSrcCache.set(cacheKey, null);
      return null;
    }
    const ref = parseKanbanCoverRef(raw);
    if (!ref) {
      coverSrcCache.set(cacheKey, null);
      return null;
    }
    if (ref.kind === "url") {
      src = ref.href;
    } else {
      const media = await invoke<string | null>("resolve_wikilink", {
        target: ref.target,
        fromPath: resolved,
      });
      if (media && isImagePath(media)) src = await vaultMediaSrc(media);
    }
  } catch {
    src = null;
  }
  coverSrcCache.set(cacheKey, src);
  return src;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
