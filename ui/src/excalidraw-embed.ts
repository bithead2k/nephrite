import { invoke } from "@tauri-apps/api/core";
import { parseExcalidrawDocument, isObsidianExcalidrawMarkdown } from "./excalidraw-file";
import type { OpenFile } from "./types";

type Scene = {
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

export async function hydrateExcalidrawEmbeds(
  root: HTMLElement,
  fromPath: string,
  openDrawing: (path: string) => void,
) {
  const embeds = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.preview-wikilink.embed[data-wikilink]"));
  await Promise.all(embeds.map(async (link) => {
    const target = link.dataset.wikilink;
    if (!target) return;
    const resolved = await invoke<string | null>("resolve_wikilink", { target, fromPath });
    if (!resolved) return;
    // Binary/media embeds belong to their own hydrator. Avoid trying to decode
    // them as UTF-8 while checking for Obsidian Excalidraw Markdown.
    if (!/\.(?:md|markdown|excalidraw)$/i.test(resolved)) return;
    const file = await invoke<OpenFile>("read_file", { path: resolved });
    const drawing = resolved.toLowerCase().endsWith(".excalidraw") ||
      isObsidianExcalidrawMarkdown(file.content);
    if (!drawing) return;

    const document = parseExcalidrawDocument(resolved, file.content);
    const scene = JSON.parse(document.scene) as Scene;
    const { exportToSvg } = await import("@excalidraw/excalidraw");
    const svg = await exportToSvg({
      elements: (scene.elements ?? []) as Parameters<typeof exportToSvg>[0]["elements"],
      appState: {
        ...(scene.appState ?? {}),
        exportBackground: true,
        exportWithDarkMode: scene.appState?.theme === "dark",
      } as Parameters<typeof exportToSvg>[0]["appState"],
      files: (scene.files ?? {}) as Parameters<typeof exportToSvg>[0]["files"],
    });

    const figure = documentElement("figure", "excalidraw-embed");
    const width = parseWidth(link.dataset.embedOptions);
    if (width) figure.style.maxWidth = width;
    const button = documentElement("button", "excalidraw-embed-canvas");
    button.type = "button";
    button.title = `Open ${resolved}`;
    button.setAttribute("aria-label", `Open drawing ${resolved}`);
    button.appendChild(svg);
    button.addEventListener("click", () => openDrawing(resolved));
    const caption = documentElement("figcaption", "excalidraw-embed-caption");
    caption.textContent = resolved;
    figure.append(button, caption);
    link.replaceWith(figure);
  }));
}

function documentElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const element = window.document.createElement(tag);
  element.className = className;
  return element;
}

function parseWidth(options?: string): string | null {
  if (!options) return null;
  const match = options.match(/^(\d+)(?:x\d+)?$/);
  if (!match) return null;
  return `${Math.max(40, Math.min(2400, Number(match[1])))}px`;
}
