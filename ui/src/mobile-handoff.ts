export function obsidianOpenNoteUri(
  vaultRoot: string | null,
  vaultRelativePath: string | null,
): string | null {
  if (!vaultRoot?.startsWith("/") || !vaultRelativePath) return null;
  if (vaultRelativePath.startsWith("/") || !vaultRelativePath.toLowerCase().endsWith(".md")) {
    return null;
  }

  const segments = vaultRelativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;

  const root = vaultRoot.replace(/\/+$/, "");
  if (!root) return null;
  return `obsidian://open?path=${encodeURIComponent(`${root}/${segments.join("/")}`)}`;
}
