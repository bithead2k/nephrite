import { isImagePath } from "./file-kinds";
import type { VaultChangeEvent } from "./types";

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
