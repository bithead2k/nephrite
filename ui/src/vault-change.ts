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
