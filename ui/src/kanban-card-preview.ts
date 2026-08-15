/**
 * Hover preview for Kanban cards — stays open while the pointer is over the
 * card or the popup itself. Linked notes get a one-shot full preview
 * (markdown + SQL/dataview); no incremental refresh.
 */
import { invoke } from "@tauri-apps/api/core";
import { hydrateTableOfContents, renderPreview } from "./preview";
import { splitFrontmatter } from "./frontmatter";
import { makeEngineContext } from "./dv-context";
import { executeBlocksInPreview } from "./dv-engine";
import { hydrateMarkdownImages } from "./image-embed";
import { hydrateNoteEmbeds } from "./note-embed";
import { hydrateMermaid } from "./mermaid";
import { hydrateCsvFences } from "./csv-view";
import type { KanbanCard } from "./kanban";

type OpenFile = { path: string; content: string };

const SHOW_DELAY_MS = 280;
const HIDE_DELAY_MS = 200;
const SCROLL_SUPPRESS_MS = 220;
const VIEWPORT_MARGIN = 12;

let popup: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let requestId = 0;
let activeCard: HTMLElement | null = null;
let popupOpenLink: ((target: string) => void) | null = null;
let scrollSuppressUntil = 0;
let scrollSuppressTimer: ReturnType<typeof setTimeout> | null = null;

export function isKanbanPreviewSuppressed(now = performance.now()): boolean {
  return now < scrollSuppressUntil;
}

/** Drop an in-flight hover preview and ignore new hovers until scrolling stops. */
export function suppressKanbanCardPreview(ms = SCROLL_SUPPRESS_MS): void {
  scrollSuppressUntil = performance.now() + ms;
  dismissKanbanCardPreview();
  if (scrollSuppressTimer != null) globalThis.clearTimeout(scrollSuppressTimer);
  scrollSuppressTimer = globalThis.setTimeout(() => {
    scrollSuppressTimer = null;
    scrollSuppressUntil = 0;
  }, ms);
}

/** Wheel/scroll on a lane must not open a full note preview under the pointer. */
export function bindKanbanScrollPreviewGuard(root: HTMLElement): void {
  if (root.dataset.kanbanScrollGuard === "1") return;
  root.dataset.kanbanScrollGuard = "1";
  const suppress = () => suppressKanbanCardPreview();
  root.addEventListener("wheel", suppress, { passive: true, capture: true });
  root.addEventListener("scroll", suppress, { passive: true, capture: true });
  root.addEventListener("touchmove", suppress, { passive: true, capture: true });
}

export function dismissKanbanCardPreview(): void {
  requestId += 1;
  activeCard = null;
  if (showTimer != null) {
    globalThis.clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer != null) {
    globalThis.clearTimeout(hideTimer);
    hideTimer = null;
  }
  const el = popup;
  if (!el) return;
  el.classList.remove("visible");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = "";
}

export function bindKanbanCardPreview(
  cardEl: HTMLElement,
  card: KanbanCard,
  options: {
    fromPath: string | null;
    openLink: (target: string) => void;
  },
): void {
  if (cardEl.dataset.kanbanPreviewBound === "1") return;
  cardEl.dataset.kanbanPreviewBound = "1";

  cardEl.addEventListener("mouseenter", () => {
    if (isKanbanPreviewSuppressed()) return;
    popupOpenLink = options.openLink;
    if (hideTimer != null) {
      globalThis.clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (showTimer != null) globalThis.clearTimeout(showTimer);
    showTimer = globalThis.setTimeout(() => {
      showTimer = null;
      void showCardPreview(cardEl, card, options);
    }, SHOW_DELAY_MS);
  });

  cardEl.addEventListener("mouseleave", () => {
    if (showTimer != null) {
      globalThis.clearTimeout(showTimer);
      showTimer = null;
    }
    scheduleHide();
  });
}

function scheduleHide(): void {
  if (hideTimer != null) globalThis.clearTimeout(hideTimer);
  hideTimer = globalThis.setTimeout(() => {
    hideTimer = null;
    dismissKanbanCardPreview();
  }, HIDE_DELAY_MS);
}

async function showCardPreview(
  cardEl: HTMLElement,
  card: KanbanCard,
  options: { fromPath: string | null; openLink: (target: string) => void },
): Promise<void> {
  if (isKanbanPreviewSuppressed()) return;
  const id = ++requestId;
  activeCard = cardEl;
  const el = ensurePopup();
  const anchorRect = cardEl.getBoundingClientRect();

  el.innerHTML = `<div class="kanban-card-preview-loading">Loading…</div>`;
  el.classList.add("visible");
  el.setAttribute("aria-hidden", "false");
  positionPopup(anchorRect, el);

  try {
    if (card.link) {
      const resolved = await invoke<string | null>("resolve_wikilink", {
        target: card.link,
        fromPath: options.fromPath,
      });
      if (id !== requestId || activeCard !== cardEl) return;
      if (!resolved) {
        el.innerHTML =
          `<div class="kanban-card-preview-head">${escapeHtml(card.label)}</div>` +
          `<div class="kanban-card-preview-error">Page not found: ${escapeHtml(card.link)}</div>`;
        positionPopup(anchorRect, el);
        return;
      }
      const file = await invoke<OpenFile>("read_file", { path: resolved });
      if (id !== requestId || activeCard !== cardEl) return;
      await renderNotePreview(el, file, options.openLink);
      positionPopup(anchorRect, el);
      return;
    }

    // Plain-text card: show label + body text only
    if (id !== requestId || activeCard !== cardEl) return;
    const head = document.createElement("div");
    head.className = "kanban-card-preview-head";
    head.textContent = card.label;
    const page = document.createElement("div");
    page.className = "kanban-card-preview-page preview";
    const body = (card.text || card.raw || card.label).trim();
    page.innerHTML = body
      ? renderPreview(body.startsWith("---") ? body : body)
      : `<p class="preview-empty">(empty card)</p>`;
    hydrateCsvFences(page);
    await hydrateMermaid(page);
    el.replaceChildren(head, page);
    positionPopup(anchorRect, el);
  } catch (error) {
    if (id !== requestId || activeCard !== cardEl) return;
    el.innerHTML =
      `<div class="kanban-card-preview-error">${escapeHtml(String(error))}</div>`;
    positionPopup(anchorRect, el);
  }
}

async function renderNotePreview(
  el: HTMLElement,
  file: OpenFile,
  openLink: (target: string) => void,
): Promise<void> {
  const title = file.path.split("/").pop()?.replace(/\.md$/i, "") || file.path;
  const head = document.createElement("div");
  head.className = "kanban-card-preview-head";
  head.title = file.path;
  head.textContent = title;
  const page = document.createElement("div");
  page.className = "kanban-card-preview-page preview";
  page.innerHTML = renderPreview(file.content);
  page.querySelectorAll<HTMLDetailsElement>("details.props-block").forEach((p) =>
    p.removeAttribute("open"),
  );
  // One-shot full render (markdown + SQL/dataview). No live updates — hover is read-only.
  const { body } = splitFrontmatter(file.content);
  await executeBlocksInPreview(
    body,
    page,
    makeEngineContext(file.path, file.content, openLink),
  );
  await hydrateMarkdownImages(page, file.path);
  await hydrateNoteEmbeds(page, file.path, { openLink });
  hydrateCsvFences(page);
  await hydrateMermaid(page);
  hydrateTableOfContents(page);
  el.replaceChildren(head, page);

  // Click title to open the note
  head.style.cursor = "pointer";
  head.addEventListener("click", () => {
    dismissKanbanCardPreview();
    openLink(file.path);
  });
}

function ensurePopup(): HTMLElement {
  if (popup) return popup;
  popup = document.createElement("aside");
  popup.className = "kanban-card-preview-popup";
  popup.setAttribute("role", "tooltip");
  popup.setAttribute("aria-hidden", "true");
  popup.addEventListener("mouseenter", () => {
    if (hideTimer != null) {
      globalThis.clearTimeout(hideTimer);
      hideTimer = null;
    }
  });
  popup.addEventListener("mouseleave", scheduleHide);
  popup.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      "a.preview-wikilink[data-wikilink]",
    );
    if (!link) return;
    event.preventDefault();
    const target = link.dataset.wikilink;
    const openLink = popupOpenLink;
    dismissKanbanCardPreview();
    if (target && openLink) openLink(target);
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
  left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(left, window.innerWidth - popupRect.width - VIEWPORT_MARGIN),
  );

  let top = anchorRect.top;
  if (top + popupRect.height > window.innerHeight - VIEWPORT_MARGIN) {
    top = window.innerHeight - popupRect.height - VIEWPORT_MARGIN;
  }
  top = Math.max(VIEWPORT_MARGIN, top);

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
