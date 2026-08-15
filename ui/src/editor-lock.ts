type IntervalTimers = {
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
};

const browserIntervals: IntervalTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

export type DirtyIdle = { preview: boolean; save: boolean };

/**
 * Keystroke path only flips this flag and the last-edit timestamp.
 * Preview and save fire once the flag has been idle long enough — they are
 * not rescheduled on every tick (that prevented them from ever running).
 */
export class DirtyReactor {
  private dirty = false;
  private lastMarkMs = 0;
  private previewDue = false;
  private saveDue = false;
  private handle: ReturnType<typeof setInterval> | null = null;
  private reactions = 0;
  private now: () => number;

  constructor(
    private readonly onReact: () => void,
    private readonly intervalMs = 50,
    private readonly timers: IntervalTimers = browserIntervals,
    now: () => number = () => performance.now(),
  ) {
    this.now = now;
  }

  markDirty(): void {
    this.dirty = true;
    this.lastMarkMs = this.now();
    this.previewDue = true;
    this.saveDue = true;
  }

  /** Save completed. Preview still fires once the idle window elapses. */
  clearDirty(): void {
    this.dirty = false;
    this.saveDue = false;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get previewPending(): boolean {
    return this.previewDue;
  }

  get reactionCount(): number {
    return this.reactions;
  }

  idleMs(): number {
    return this.now() - this.lastMarkMs;
  }

  consumeIdle(previewAfterMs: number, saveAfterMs: number): DirtyIdle {
    if (!this.dirty && !this.previewDue) return { preview: false, save: false };
    const idle = this.idleMs();
    const preview = this.previewDue && idle >= previewAfterMs;
    const save = this.dirty && this.saveDue && idle >= saveAfterMs;
    if (preview) this.previewDue = false;
    if (save) this.saveDue = false;
    return { preview, save };
  }

  start(): void {
    if (this.handle != null) return;
    this.handle = this.timers.setInterval(() => {
      if (!this.dirty && !this.previewDue) return;
      this.reactions += 1;
      this.onReact();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle == null) return;
    this.timers.clearInterval(this.handle);
    this.handle = null;
  }
}

/** True only when the open markdown note changed on disk and is not dirty. */
export function shouldReloadEditorFromVault(
  currentPath: string | null,
  fileKind: string,
  editorDirty: boolean,
  changedPaths: Iterable<string>,
): boolean {
  if (!currentPath || editorDirty || fileKind !== "markdown") return false;
  for (const path of changedPaths) {
    if (path === currentPath) return true;
  }
  return false;
}

/** Drop in-flight preview work when the user leaves split/preview. */
export function shouldKeepPreviewWork(viewMode: string): boolean {
  return viewMode === "split" || viewMode === "preview";
}

/** Right-pane render may commit only if this generation is still current. */
export function shouldCommitRightPane(
  started: number,
  current: number,
  path: string | null,
): boolean {
  return started === current && path != null;
}

/** Split/preview may refresh when some *other* page changed. */
export function shouldRefreshPreviewFromOtherPages(
  currentPath: string | null,
  viewMode: string,
  changedPaths: Iterable<string>,
): boolean {
  if (!currentPath || (viewMode !== "split" && viewMode !== "preview")) return false;
  for (const path of changedPaths) {
    if (path !== currentPath) return true;
  }
  return false;
}

/** Aggregate COUNT queries take the index lock. Never do this on a save echo. */
export function shouldRefreshVaultStats(manual: boolean, updated: number, removed: number): boolean {
  return manual || updated > 0 || removed > 0;
}

const WIKILINK_RE = /!?\[\[([^\]]+)\]\]/g;

/** Source-mode wikilink highlight scan. Must stay off the 10ms budget. */
export function countWikilinks(source: string): number {
  WIKILINK_RE.lastIndex = 0;
  let count = 0;
  while (WIKILINK_RE.exec(source)) count += 1;
  return count;
}
