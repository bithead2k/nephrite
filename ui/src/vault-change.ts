import { isImagePath } from "./file-kinds";
import type { FileEntry, VaultChangeEvent } from "./types";

/**
 * Content edits do not change the file browser. Rebuild its potentially large
 * DOM only for additions, removals, and renames.
 */
export function vaultChangeTouchesFileTree(
  change: VaultChangeEvent,
  knownPaths: Iterable<string>,
): boolean {
  if (change.removed > 0) return true;
  const known = new Set(knownPaths);
  return change.paths.some((path) => !known.has(path));
}

/**
 * Image-only (and other-page) edits leave the open note's markdown unchanged,
 * so the preview/kanban page cache would no-op and keep stale covers/embeds.
 */
export function vaultChangeInvalidatesPageCache(
  change: VaultChangeEvent,
  currentPath: string | null,
): boolean {
  return change.paths.some((path) => (
    isImagePath(path) || (currentPath != null && path !== currentPath)
  ));
}

/** Coalesce watcher bursts while keeping every changed path. */
export function mergeVaultChanges(
  current: VaultChangeEvent | null,
  next: VaultChangeEvent,
): VaultChangeEvent {
  if (!current) return { ...next, paths: [...new Set(next.paths)] };
  return {
    scanned: current.scanned + next.scanned,
    updated: current.updated + next.updated,
    removed: current.removed + next.removed,
    paths: [...new Set([...current.paths, ...next.paths])],
  };
}

/**
 * Filesystem/index reactions are useful but never urgent enough to steal the
 * main thread from an active editor. Hold and merge them until isDirty clears.
 */
export class DeferredVaultChanges {
  private value: VaultChangeEvent | null = null;

  defer(change: VaultChangeEvent): void {
    this.value = mergeVaultChanges(this.value, change);
  }

  takeIfClean(isDirty: boolean): VaultChangeEvent | null {
    if (isDirty) return null;
    const value = this.value;
    this.value = null;
    return value;
  }

  get pending(): boolean {
    return this.value != null;
  }
}

/** File membership is independent of editor/preview work. Read only changed
 * paths and coalesce bursts; never reload or save the active document. */
export class VaultFileTreeUpdates {
  private pendingChange: VaultChangeEvent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly readFiles: (paths: string[]) => Promise<FileEntry[]>,
    private readonly getFiles: () => FileEntry[],
    private readonly publish: (files: FileEntry[]) => void,
    private readonly generation: () => number,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(change: VaultChangeEvent): void {
    this.pendingChange = mergeVaultChanges(this.pendingChange, change);
    if (!this.timer && !this.running) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 50);
    }
  }

  async flush(): Promise<void> {
    if (this.running) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.running = true;
    try {
      while (this.pendingChange) {
        const change = this.pendingChange;
        this.pendingChange = null;
        if (!vaultChangeTouchesFileTree(change, this.getFiles().map((file) => file.path))) continue;
        const generation = this.generation();
        const paths = new Set(change.paths);
        const updated = await this.readFiles([...paths]);
        if (generation !== this.generation()) continue;
        // Merge into the latest snapshot, not the one from before the await.
        this.publish([...this.getFiles().filter((file) => !paths.has(file.path)), ...updated]);
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
    }
  }

  reset(): void {
    this.pendingChange = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
