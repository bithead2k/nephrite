/** Never persist the temporary shell between vault-open and session commit. */
export function canPersistSession(
  vaultOpen: boolean,
  restoringSession: boolean,
  sessionPersistenceReady: boolean,
): boolean {
  return vaultOpen && sessionPersistenceReady && !restoringSession;
}

/** Title above the editor, suppressing the empty-state prompt during session paint. */
export function editorTabTitle(
  currentPath: string | null,
  dirty: boolean,
  openTabCount: number,
  sessionPersistenceReady: boolean,
): string {
  if (currentPath) return dirty ? `${currentPath} •` : currentPath;
  if (!sessionPersistenceReady || openTabCount > 0) return "";
  return "Open a Markdown file";
}
