export type CtxKind = "file" | "tab" | "folder" | "empty";

export type CtxTarget = {
  kind: CtxKind;
  /** Vault-relative path; "" for vault root */
  path: string;
  pinned?: boolean;
};

export type CtxAction =
  // file
  | "open-new-tab"
  | "open-right"
  | "open-new-window"
  | "merge-file"
  | "version-history"
  | "open-default-app"
  | "close-tab"
  | "pin-tab"
  | "unpin-tab"
  // folder create
  | "new-note"
  | "new-folder"
  | "new-canvas"
  | "new-drawing"
  | "new-base"
  | "new-kanban"
  | "search-in-folder"
  // shared
  | "make-copy"
  | "move-to"
  | "bookmark"
  | "copy-path"
  | "show-explorer"
  | "rename"
  | "delete";

type MenuItem =
  | { type: "item"; id: CtxAction; label: string; danger?: boolean }
  | { type: "sep" };

/** Directory (and empty tree area) context menu — matches Obsidian folder menu. */
function folderItems(): MenuItem[] {
  return [
    { type: "item", id: "new-note", label: "New note" },
    { type: "item", id: "new-folder", label: "New folder" },
    { type: "item", id: "new-canvas", label: "New canvas" },
    { type: "item", id: "new-drawing", label: "New Excalidraw drawing" },
    { type: "item", id: "new-base", label: "New base" },
    { type: "item", id: "new-kanban", label: "New kanban board" },
    { type: "sep" },
    { type: "item", id: "make-copy", label: "Make a copy" },
    { type: "item", id: "move-to", label: "Move folder to…" },
    { type: "item", id: "search-in-folder", label: "Search in folder" },
    { type: "item", id: "bookmark", label: "Bookmark…" },
    { type: "sep" },
    { type: "item", id: "copy-path", label: "Copy path" },
    { type: "item", id: "show-explorer", label: "Show in system explorer" },
    { type: "sep" },
    { type: "item", id: "rename", label: "Rename…" },
    { type: "item", id: "delete", label: "Delete", danger: true },
  ];
}

/** File context menu — matches Obsidian file menu. */
function fileItems(): MenuItem[] {
  return [
    { type: "item", id: "open-new-tab", label: "Open in new tab" },
    { type: "item", id: "open-right", label: "Open to the right" },
    { type: "item", id: "open-new-window", label: "Open in new window" },
    { type: "sep" },
    { type: "item", id: "make-copy", label: "Make a copy" },
    { type: "item", id: "move-to", label: "Move file to…" },
    { type: "item", id: "bookmark", label: "Bookmark…" },
    { type: "item", id: "merge-file", label: "Merge entire file with…" },
    { type: "sep" },
    { type: "item", id: "copy-path", label: "Copy path" },
    { type: "item", id: "version-history", label: "Open version history" },
    { type: "item", id: "open-default-app", label: "Open in default app" },
    { type: "item", id: "show-explorer", label: "Show in system explorer" },
    { type: "sep" },
    { type: "item", id: "rename", label: "Rename…" },
    { type: "item", id: "delete", label: "Delete", danger: true },
  ];
}

function tabItems(pinned: boolean): MenuItem[] {
  return [
    { type: "item", id: "close-tab", label: "Close tab" },
    {
      type: "item",
      id: pinned ? "unpin-tab" : "pin-tab",
      label: pinned ? "Unpin tab" : "Pin tab",
    },
    { type: "sep" },
    ...fileItems().slice(4),
  ];
}

function itemsFor(target: CtxTarget): MenuItem[] {
  if (target.kind === "file") return fileItems();
  if (target.kind === "tab") return tabItems(Boolean(target.pinned));
  // folder + empty (vault root)
  const items = folderItems();
  if (target.kind === "empty") {
    // root: no rename/delete/move/copy of the vault itself
    return items.filter(
      (it) =>
        it.type === "sep" ||
        (it.type === "item" &&
          !["rename", "delete", "make-copy", "move-to"].includes(it.id)),
    );
  }
  return items;
}

let menuEl: HTMLDivElement | null = null;

function ensureMenu(): HTMLDivElement {
  if (menuEl) return menuEl;
  menuEl = document.createElement("div");
  menuEl.className = "ctx-menu hidden";
  menuEl.setAttribute("role", "menu");
  document.body.appendChild(menuEl);
  document.addEventListener("click", () => hideContextMenu(), true);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") hideContextMenu();
    },
    true,
  );
  window.addEventListener("blur", () => hideContextMenu());
  return menuEl;
}

export function hideContextMenu() {
  if (!menuEl) return;
  menuEl.classList.add("hidden");
  menuEl.innerHTML = "";
}

export function showContextMenu(
  x: number,
  y: number,
  target: CtxTarget,
  onAction: (action: CtxAction, target: CtxTarget) => void,
) {
  const menu = ensureMenu();
  menu.innerHTML = "";
  menu.classList.remove("hidden");

  for (const it of itemsFor(target)) {
    if (it.type === "sep") {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-item" + (it.danger ? " danger" : "");
    btn.setAttribute("role", "menuitem");
    btn.textContent = it.label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideContextMenu();
      onAction(it.id, target);
    });
    menu.appendChild(btn);
  }

  const pad = 6;
  menu.style.left = "0px";
  menu.style.top = "0px";
  // force layout
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - pad) {
    left = window.innerWidth - rect.width - pad;
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = window.innerHeight - rect.height - pad;
  }
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;
}

export function parentDir(path: string): string {
  if (!path) return "";
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return `${dir.replace(/\/$/, "")}/${name}`;
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Unique copy name: Note.md → Note copy.md → Note copy 2.md */
export function uniqueCopyName(path: string, existing: Set<string>): string {
  const dir = parentDir(path);
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 0;
  while (true) {
    const suffix = n === 0 ? " copy" : ` copy ${n + 1}`;
    const candidate = joinPath(dir, `${stem}${suffix}${ext}`);
    if (!existing.has(candidate)) return candidate;
    n++;
  }
}
