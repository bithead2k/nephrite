/**
 * Keep two scrollable panes in sympathy (proportional position).
 *
 * Critical: never let a zero-height/no-scroll pane drive the other to top,
 * and never treat programmatic scrollTop updates as user input (echo loop).
 */

export type ScrollPair = {
  a: HTMLElement;
  b: HTMLElement;
};

let pair: ScrollPair | null = null;
/** Which side the user is currently driving; the other side's events are ignored. */
let driving: "a" | "b" | null = null;
let unlockTimer: ReturnType<typeof setTimeout> | null = null;
let onA: ((e: Event) => void) | null = null;
let onB: ((e: Event) => void) | null = null;
let intentCleanup: Array<() => void> = [];
let syncFrame: number | null = null;
let pendingSide: "a" | "b" | null = null;
let userIntent: "a" | "b" | null = null;
let intentTimer: ReturnType<typeof setTimeout> | null = null;
let cursorSyncTimer: ReturnType<typeof setTimeout> | null = null;
let editorEndLocked = false;
let editorCursorAtDocumentEnd = false;
const suppressed = new WeakSet<HTMLElement>();

const UNLOCK_MS = 150;
const INTENT_MS = 600;
/** Keep preview layout work off the Vim key-repeat hot path. */
export const CURSOR_SYNC_DELAY_MS = 45;

function maxScroll(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

function atEnd(el: HTMLElement): boolean {
  const maximum = maxScroll(el);
  return maximum > 1 && el.scrollTop >= maximum - 1;
}

function sync(source: HTMLElement, target: HTMLElement) {
  const sm = maxScroll(source);
  const tm = maxScroll(target);
  // Either side not scrollable → do nothing (prevents snap-to-top).
  if (sm <= 1 || tm <= 1) return;
  const next = (source.scrollTop / sm) * tm;
  // Skip tiny deltas (sub-pixel noise from scrollbar drag)
  if (Math.abs(target.scrollTop - next) < 0.5) return;
  target.scrollTop = next;
}

function markDriving(side: "a" | "b") {
  driving = side;
  if (unlockTimer != null) clearTimeout(unlockTimer);
  unlockTimer = setTimeout(() => {
    driving = null;
    unlockTimer = null;
  }, UNLOCK_MS);
}

function markUserIntent(side: "a" | "b") {
  userIntent = side;
  if (intentTimer != null) clearTimeout(intentTimer);
  intentTimer = setTimeout(() => {
    userIntent = null;
    intentTimer = null;
  }, INTENT_MS);
}

function isScrollKey(event: KeyboardEvent): boolean {
  return [
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "PageUp", "PageDown", "Home", "End", " ",
  ].includes(event.key);
}

function bindIntent(el: HTMLElement, side: "a" | "b") {
  const pointer = () => markUserIntent(side);
  const wheel = () => markUserIntent(side);
  const touch = () => markUserIntent(side);
  const key = (event: Event) => {
    if (isScrollKey(event as KeyboardEvent)) markUserIntent(side);
  };
  el.addEventListener("pointerdown", pointer, { passive: true });
  el.addEventListener("wheel", wheel, { passive: true });
  el.addEventListener("touchstart", touch, { passive: true });
  el.addEventListener("keydown", key);
  intentCleanup.push(() => {
    el.removeEventListener("pointerdown", pointer);
    el.removeEventListener("wheel", wheel);
    el.removeEventListener("touchstart", touch);
    el.removeEventListener("keydown", key);
  });
}

function scheduleSync(side: "a" | "b") {
  pendingSide = side;
  markDriving(side);
  if (syncFrame != null) return;
  syncFrame = requestAnimationFrame(() => {
    syncFrame = null;
    if (!pair || !pendingSide) return;
    const sideToSync = pendingSide;
    pendingSide = null;
    if (sideToSync === "a") sync(pair.a, pair.b);
    else sync(pair.b, pair.a);
  });
}

export function clearScrollSync() {
  if (pair && onA && onB) {
    pair.a.removeEventListener("scroll", onA);
    pair.b.removeEventListener("scroll", onB);
  }
  if (unlockTimer != null) {
    clearTimeout(unlockTimer);
    unlockTimer = null;
  }
  if (intentTimer != null) {
    clearTimeout(intentTimer);
    intentTimer = null;
  }
  if (cursorSyncTimer != null) {
    clearTimeout(cursorSyncTimer);
    cursorSyncTimer = null;
  }
  intentCleanup.forEach((remove) => remove());
  intentCleanup = [];
  if (syncFrame != null) {
    cancelAnimationFrame(syncFrame);
    syncFrame = null;
  }
  pendingSide = null;
  pair = null;
  onA = null;
  onB = null;
  driving = null;
  userIntent = null;
  editorEndLocked = false;
}

/** Cursor semantics beat virtual-scroll geometry (notably Vim's G command). */
export function setEditorDocumentEnd(atDocumentEnd: boolean) {
  // CodeMirror reports the cursor after every document edit. Most typing is
  // done on the final line, so measuring and assigning preview scrollTop here
  // on every keystroke creates a forced-layout hot path. Only act when the
  // cursor actually enters or leaves the final line; rebinding handles a
  // preview whose height changed after rendering.
  if (editorCursorAtDocumentEnd === atDocumentEnd) return;
  editorCursorAtDocumentEnd = atDocumentEnd;
  if (!atDocumentEnd) {
    editorEndLocked = false;
    return;
  }
  editorEndLocked = true;
  if (!pair) return;
  pinPreviewToEnd();
}

function pinPreviewToEnd() {
  if (!pair) return;
  const previewMaximum = maxScroll(pair.b);
  if (previewMaximum > 1) pair.b.scrollTop = previewMaximum;
}

/** Follow a cursor-line motion after CodeMirror has laid out its new viewport. */
export function syncEditorCursorMovement() {
  if (!pair || editorEndLocked || editorCursorAtDocumentEnd) return;
  if (cursorSyncTimer != null) clearTimeout(cursorSyncTimer);
  cursorSyncTimer = setTimeout(() => {
    cursorSyncTimer = null;
    if (!pair || editorEndLocked || editorCursorAtDocumentEnd) return;
    scheduleSync("a");
  }, CURSOR_SYNC_DELAY_MS);
}

/** Bind two elements so user scroll on either updates the other proportionally. */
export function bindScrollSync(a: HTMLElement, b: HTMLElement) {
  if (pair?.a === a && pair.b === b && onA && onB) {
    if (editorCursorAtDocumentEnd) pinPreviewToEnd();
    return;
  }
  clearScrollSync();
  pair = { a, b };
  editorEndLocked = editorCursorAtDocumentEnd || atEnd(a);

  onA = () => {
    if (!pair) return;
    const reachedEnd = atEnd(pair.a);
    if (!reachedEnd) editorEndLocked = false;
    if (reachedEnd) {
      // Let the transition to EOF finish once (including Vim's G, whose
      // CodeMirror scroll is programmatic), then make the editor immovable.
      if (editorEndLocked || suppressed.has(pair.a)) return;
      editorEndLocked = true;
      scheduleSync("a");
      return;
    }
    if (suppressed.has(pair.a) || userIntent !== "a") return;
    // Echo from us driving B → A: ignore
    if (driving === "b") return;
    markUserIntent("a");
    scheduleSync("a");
  };

  onB = () => {
    if (!pair) return;
    if (editorEndLocked || atEnd(pair.a)) return;
    if (suppressed.has(pair.b) || userIntent !== "b") return;
    if (driving === "a") return;
    markUserIntent("b");
    scheduleSync("b");
  };

  a.addEventListener("scroll", onA, { passive: true });
  b.addEventListener("scroll", onB, { passive: true });
  bindIntent(a, "a");
  bindIntent(b, "b");
  // Rebinding follows every preview DOM replacement. Keep Vim G pinned after
  // the replacement changes the preview's scroll height.
  if (editorCursorAtDocumentEnd) pinPreviewToEnd();
}

/** Keep DOM replacement/scroll restoration from masquerading as user scrolling. */
export function withoutScrollSync<T>(element: HTMLElement, mutate: () => T): T {
  suppressed.add(element);
  try {
    return mutate();
  } finally {
    // Scroll events caused by layout/scrollTop assignment can arrive after the
    // mutation. Two paint frames cover that delivery without disabling later input.
    requestAnimationFrame(() => requestAnimationFrame(() => suppressed.delete(element)));
  }
}

/** Re-apply after DOM refresh (e.g. preview re-render). */
export function rebindScrollSync(a: HTMLElement | null, b: HTMLElement | null) {
  if (!a || !b) {
    clearScrollSync();
    return;
  }
  bindScrollSync(a, b);
}
