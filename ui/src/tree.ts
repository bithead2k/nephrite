import type { FileEntry } from "./types";

/** True if any path segment is a dotfile/dotdir (`.obsidian`, `.git`, `.hidden.md`, …). */
export function isDotPath(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith(".") && seg.length > 1);
}

/** Filter entries for the file browser. */
export function visibleFiles(
  files: FileEntry[],
  showDotfiles: boolean,
): FileEntry[] {
  if (showDotfiles) return files;
  return files.filter((f) => !isDotPath(f.path));
}

export type TreeNode = {
  name: string;
  /** folder path or file path */
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
};

/** Build a directory tree from flat file entries (markdown only). */
export function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };

  function ensureDir(parts: string[]): TreeNode {
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find((c) => c.kind === "dir" && c.name === part);
      if (!child) {
        child = { name: part, path: acc, kind: "dir", children: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  }

  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const fileName = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);
    const parent = dirParts.length ? ensureDir(dirParts) : root;
    if (!parent.children.some((c) => c.kind === "file" && c.path === f.path)) {
      parent.children.push({
        name: fileName,
        path: f.path,
        kind: "file",
        children: [],
      });
    }
  }

  sortTree(root);
  return root;
}

function sortTree(node: TreeNode) {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const c of node.children) {
    if (c.kind === "dir") sortTree(c);
  }
}

/** Filter tree: keep dirs that contain matching files (or match themselves). */
export function filterTree(root: TreeNode, query: string): TreeNode {
  const q = query.trim().toLowerCase();
  if (!q) return root;

  function walk(node: TreeNode): TreeNode | null {
    if (node.kind === "file") {
      return node.path.toLowerCase().includes(q) ||
        node.name.toLowerCase().includes(q)
        ? { ...node, children: [] }
        : null;
    }
    const kids = node.children
      .map(walk)
      .filter((c): c is TreeNode => c != null);
    if (kids.length === 0 && node.path && !node.path.toLowerCase().includes(q)) {
      return null;
    }
    return { ...node, children: kids };
  }

  return walk(root) ?? { name: "", path: "", kind: "dir", children: [] };
}

/**
 * Guess today's journal path from known vault conventions.
 * Prefers existing paths in `files`.
 */
export function findTodayJournal(
  files: FileEntry[],
  now = new Date(),
): string | null {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");

  const candidates = [
    `journals/${y}_${m}_${d}.md`,
    `journals/${y}-${m}-${d}.md`,
    `journals/${y}/${m}_${d}.md`,
    `journals/${y}/${m}-${d}.md`,
    `journal/${y}_${m}_${d}.md`,
    `Daily/${y}-${m}-${d}.md`,
    `daily/${y}-${m}-${d}.md`,
    `moody/${y}-${m}-${d}.md`,
  ];

  const set = new Set(files.map((f) => f.path));
  for (const c of candidates) {
    if (set.has(c)) return c;
  }

  // Fuzzy: any file whose name is today's date under a journals-like folder
  const dayNames = [
    `${y}_${m}_${d}.md`,
    `${y}-${m}-${d}.md`,
    `${m}_${d}.md`,
    `${m}-${d}.md`,
  ];
  for (const f of files) {
    const base = f.name.toLowerCase();
    const parent = f.parent_path.toLowerCase();
    if (
      dayNames.some((n) => n.toLowerCase() === base) &&
      (parent.includes("journal") || parent.includes("daily") || parent.includes("moody"))
    ) {
      return f.path;
    }
  }
  return null;
}

/** Default path to create if no today journal exists. */
export function defaultTodayJournalPath(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `journals/${y}_${m}_${d}.md`;
}
