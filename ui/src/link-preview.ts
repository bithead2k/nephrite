/**
 * Wikilink hover preview — stays open while the pointer is over the
 * link *or* the popup (same rules as Kanban card previews). Full note
 * render including SQL/dataview; one-shot, no live editing.
 */
import { invoke } from "@tauri-apps/api/core";
import { makeEngineContext } from "./dv-context";
import { executeBlocksInPreview } from "./dv-engine";
import { splitFrontmatter } from "./frontmatter";
import { hydrateTableOfContents, renderPreview } from "./preview";
import { hydrateMarkdownImages } from "./image-embed";
import { hydrateMermaid } from "./mermaid";
import { hydrateCsvFences } from "./csv-view";
import type { OpenFile } from "./types";

type BindOptions = {
  fromPath: string;
  openLink: (target: string) => void;
};

const SHOW_DELAY_MS = 300;
const HIDE_DELAY_MS = 220;
const VIEWPORT_MARGIN = 12;

let popup: HTMLElement | null = null;
let showTimer: number | null = null;
let hideTimer: number | null = null;
let activeLink: HTMLAnchorElement | null = null;
let requestId = 0;
let popupFromPath = "";
let popupOpenLink: ((target: string) => void) | null = null;

export function bindLinkPreviews(root: ParentNode, options: BindOptions): void {
  root.querySelectorAll<HTMLAnchorElement>("a.preview-wikilink[data-wikilink]")
    .forEach((link) => {
      if (link.dataset.linkPreviewBound === "1") return;
      // Embeds are expanded in-place; don't also open a hover card on them.
      if (link.classList.contains("embed")) return;
      link.dataset.linkPreviewBound = "1";
      link.addEventListener("mouseenter", () => scheduleShow(link, options));
      link.addEventListener("mouseleave", (event) => {
        // Moving into the popup must not dismiss.
        const next = event.relatedTarget as Node | null;
        if (next && popup?.contains(next)) return;
        scheduleHide();
      });
      link.addEventListener("focus", () => scheduleShow(link, options, 0));
      link.addEventListener("blur", scheduleHide);
    });
}

export function dismissLinkPreview(): void {
  clearTimers();
  requestId++;
  activeLink = null;
  popup?.classList.remove("visible");
  popup?.setAttribute("aria-hidden", "true");
}

function scheduleShow(
  link: HTMLAnchorElement,
  options: BindOptions,
  delay = SHOW_DELAY_MS,
): void {
  if (hideTimer != null) window.clearTimeout(hideTimer);
  if (showTimer != null) window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    showTimer = null;
    void showPreview(link, options);
  }, delay);
}

function scheduleHide(): void {
  if (showTimer != null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    dismissLinkPreview();
  }, HIDE_DELAY_MS);
}

async function showPreview(
  link: HTMLAnchorElement,
  options: BindOptions,
): Promise<void> {
  const target = link.dataset.wikilink?.trim();
  if (!target) return;

  const el = ensurePopup();
  const anchorRect = link.getBoundingClientRect();
  const id = ++requestId;
  activeLink = link;
  popupFromPath = options.fromPath;
  popupOpenLink = options.openLink;
  el.innerHTML = `<div class="link-preview-loading">Loading ${escapeHtml(target)}…</div>`;
  el.classList.add("visible");
  el.setAttribute("aria-hidden", "false");
  positionPopup(anchorRect, el);

  try {
    const resolved = await invoke<string | null>("resolve_wikilink", {
      target,
      fromPath: options.fromPath,
    });
    if (id !== requestId || activeLink !== link) return;
    if (!resolved) {
      el.innerHTML = `<div class="link-preview-error">Page not found: ${escapeHtml(target)}</div>`;
      positionPopup(anchorRect, el);
      return;
    }

    const file = await invoke<OpenFile>("read_file", { path: resolved });
    if (id !== requestId || activeLink !== link) return;
    popupFromPath = file.path;
    const title = file.path.split("/").pop()?.replace(/\.md$/i, "") || file.path;
    const head = document.createElement("div");
    head.className = "link-preview-head";
    head.title = file.path;
    head.textContent = title;
    const page = document.createElement("div");
    page.className = "link-preview-page preview";
    page.innerHTML = renderPreview(file.content);
    page.querySelectorAll<HTMLDetailsElement>("details.props-block").forEach(
      (properties) => properties.removeAttribute("open"),
    );
    const { body } = splitFrontmatter(file.content);
    await executeBlocksInPreview(
      body,
      page,
      makeEngineContext(file.path, file.content, () => {}),
    );
    await hydrateMarkdownImages(page, file.path);
    hydrateCsvFences(page);
    await hydrateMermaid(page);
    if (id !== requestId || activeLink !== link) return;
    hydrateTableOfContents(page);
    el.replaceChildren(head, page);
    bindLinkPreviews(el, { fromPath: file.path, openLink: options.openLink });
    positionPopup(anchorRect, el);
  } catch (error) {
    if (id !== requestId || activeLink !== link) return;
    el.innerHTML = `<div class="link-preview-error">${escapeHtml(String(error))}</div>`;
    positionPopup(anchorRect, el);
  }
}

function ensurePopup(): HTMLElement {
  if (popup) return popup;
  popup = document.createElement("aside");
  popup.className = "link-preview-popup";
  popup.setAttribute("role", "tooltip");
  popup.setAttribute("aria-hidden", "true");
  popup.addEventListener("mouseenter", () => {
    if (hideTimer != null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  popup.addEventListener("mouseleave", (event) => {
    const next = event.relatedTarget as Node | null;
    // Back onto the triggering link — keep open.
    if (next && activeLink && (next === activeLink || activeLink.contains(next))) return;
    scheduleHide();
  });
  popup.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      "a.preview-wikilink[data-wikilink]",
    );
    if (!link) return;
    event.preventDefault();
    const target = link.dataset.wikilink;
    const openLink = popupOpenLink;
    const fromPath = popupFromPath;
    dismissLinkPreview();
    if (target && openLink) {
      void invoke<string | null>("resolve_wikilink", { target, fromPath })
        .then((resolved) => {
          const hash = target.indexOf("#");
          const heading = hash >= 0 ? target.slice(hash) : "";
          openLink(resolved ? `${resolved}${heading}` : target);
        })
        .catch(() => openLink(target));
    }
  });
  document.body.appendChild(popup);
  return popup;
}

function positionPopup(anchorRect: DOMRect, el: HTMLElement): void {
  const popupRect = el.getBoundingClientRect();
  let left = anchorRect.right + VIEWPORT_MARGIN;
  if (left + popupRect.width > window.innerWidth - VIEWPORT_MARGIN) {
    left = anchorRect.left - popupRect.width - VIEWPORT_MARGIN;
  }
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - popupRect.width - VIEWPORT_MARGIN));

  let top = anchorRect.top;
  if (top + popupRect.height > window.innerHeight - VIEWPORT_MARGIN) {
    top = window.innerHeight - popupRect.height - VIEWPORT_MARGIN;
  }
  top = Math.max(VIEWPORT_MARGIN, top);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function clearTimers(): void {
  if (showTimer != null) window.clearTimeout(showTimer);
  if (hideTimer != null) window.clearTimeout(hideTimer);
  showTimer = null;
  hideTimer = null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
