import { invoke } from "@tauri-apps/api/core";
import type { MediaFile } from "./types";

export function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path);
}

/** Replace an Obsidian wikilink image embed with a native image element. */
export async function hydrateWikilinkImage(
  link: HTMLAnchorElement,
  resolved: string,
  target: string,
): Promise<boolean> {
  if (!isImagePath(resolved)) return false;
  const media = await invoke<MediaFile>("read_media_file", { path: resolved });
  const image = document.createElement("img");
  image.className = "image-embed";
  image.src = mediaSource(media);
  image.alt = target.split("/").pop()?.split("#")[0] || "Embedded image";
  image.loading = "lazy";
  image.decoding = "async";
  image.dataset.vaultImage = "1";
  applyImageDimensions(image, link.dataset.embedOptions);
  link.replaceWith(image);
  return true;
}

/** Resolve ordinary Markdown images against the vault/source-note location. */
export async function hydrateMarkdownImages(
  root: HTMLElement,
  fromPath: string,
): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img[src]"));
  await Promise.all(images.map(async (image) => {
    if (image.dataset.vaultImage === "1") return;
    const rawSource = image.getAttribute("src")?.trim();
    if (!rawSource || /^(?:data:|blob:|https?:|file:|\/\/)/i.test(rawSource)) return;
    let target = rawSource;
    try {
      target = decodeURIComponent(rawSource);
    } catch {
      // A literal percent sign is valid in a vault filename.
    }
    const resolved = await invoke<string | null>("resolve_wikilink", {
      target,
      fromPath,
    });
    if (!resolved || !isImagePath(resolved)) return;
    const media = await invoke<MediaFile>("read_media_file", { path: resolved });
    image.src = mediaSource(media);
    image.dataset.vaultImage = "1";
    image.loading = "lazy";
    image.decoding = "async";
    applyMarkdownImageOptions(image, resolved);
  }));
}

function mediaSource(media: MediaFile): string {
  return `data:${media.mime};base64,${media.data}`;
}

function applyImageDimensions(image: HTMLImageElement, options?: string): void {
  if (!options) return;
  const match = options.trim().match(/^(\d+)(?:x(\d+))?$/);
  if (!match) return;
  image.style.width = `${Math.max(1, Math.min(10000, Number(match[1])))}px`;
  image.style.maxWidth = "100%";
  if (match[2]) {
    image.style.height = `${Math.max(1, Math.min(10000, Number(match[2])))}px`;
    image.style.objectFit = "contain";
  }
}

function applyMarkdownImageOptions(image: HTMLImageElement, resolved: string): void {
  const alt = image.alt.trim();
  const option = alt.match(/(?:^|\|)(\d+)(?:x(\d+))?$/);
  if (option) {
    applyImageDimensions(image, `${option[1]}${option[2] ? `x${option[2]}` : ""}`);
    image.alt = alt.slice(0, option.index).trim() ||
      resolved.split("/").pop() || "Embedded image";
  }
}
