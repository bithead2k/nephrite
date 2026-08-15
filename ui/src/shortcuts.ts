export type ShortcutMap = Record<string, string>;

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  save: "Mod+S",
  command: "Mod+P",
  "file-search": "Mod+O",
  search: "Mod+Shift+F",
  find: "Mod+F",
  templates: "Mod+Y",
  "reopen-tab": "Mod+Shift+T",
};

const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];

function displayKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key[0].toUpperCase() + key.slice(1);
}

export function shortcutFromEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(displayKey(key));
  return parts.join("+");
}

export function normalizeShortcut(raw: string): string {
  const pieces = raw.split("+").map((part) => part.trim()).filter(Boolean);
  if (!pieces.length) return "";
  const modifiers = new Set<string>();
  let key = "";
  for (const piece of pieces) {
    const lower = piece.toLowerCase();
    if (lower === "cmd" || lower === "command" || lower === "super" || lower === "meta") modifiers.add("Meta");
    else if (lower === "control" || lower === "ctrl") modifiers.add("Ctrl");
    else if (lower === "mod") modifiers.add("Mod");
    else if (lower === "option" || lower === "alt") modifiers.add("Alt");
    else if (lower === "shift") modifiers.add("Shift");
    else key = displayKey(piece);
  }
  if (!key) return "";
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

export function shortcutMatches(event: KeyboardEvent, shortcut: string): boolean {
  return shortcutFromEvent(event) === normalizeShortcut(shortcut)
    || explicitShortcutFromEvent(event) === normalizeShortcut(shortcut);
}

function explicitShortcutFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(displayKey(event.key));
  return parts.join("+");
}

export class ShortcutRegistry {
  private values: ShortcutMap;

  constructor(private storageKey = "nephrite.shortcuts.v1") {
    this.values = { ...DEFAULT_SHORTCUTS };
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (stored && typeof stored === "object") {
        for (const [id, value] of Object.entries(stored)) {
          if (typeof value === "string") this.values[id] = normalizeShortcut(value);
        }
      }
    } catch { /* ignore malformed preferences */ }
  }

  get(id: string): string { return this.values[id] ?? ""; }

  set(id: string, shortcut: string): string | null {
    const normalized = normalizeShortcut(shortcut);
    if (normalized) {
      const conflict = Object.entries(this.values).find(([otherId, value]) => otherId !== id && value === normalized);
      if (conflict) return conflict[0];
    }
    this.values[id] = normalized;
    this.persist();
    return null;
  }

  reset() {
    this.values = { ...DEFAULT_SHORTCUTS };
    this.persist();
  }

  match(event: KeyboardEvent, commandIds: readonly string[]): string | null {
    return commandIds.find((id) => this.get(id) && shortcutMatches(event, this.get(id))) ?? null;
  }

  private persist() { localStorage.setItem(this.storageKey, JSON.stringify(this.values)); }
}
