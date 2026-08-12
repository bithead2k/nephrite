/**
 * Obsidian Kanban plugin board format:
 *
 * ---
 * kanban-plugin: board
 * ---
 *
 * ## column name
 * - [ ] [[note|label]]
 * - [x] plain text card
 *
 * %% kanban:settings
 * ```
 * {...}
 * ```
 * %%
 */

export type KanbanCard = {
  raw: string;
  checked: boolean;
  text: string;
  /** wikilink target if present */
  link: string | null;
  label: string;
};

export type KanbanColumn = {
  name: string;
  cards: KanbanCard[];
};

export type KanbanHooksConfig = {
  /** Inline JS: card *landed* in a column (after save). */
  onCardMove?: string;
  /** Vault-relative script path for land. */
  onCardMoveFile?: string;
  /** Inline JS: card *leaving* a column (before board rewrite). */
  onCardLeave?: string;
  /** Vault-relative script path for leave. */
  onCardLeaveFile?: string;
  onCardChecked?: string;
  onCardCheckedFile?: string;
};

export type KanbanSettings = {
  raw: Record<string, unknown>;
  nephriteHooks: KanbanHooksConfig;
};

export type KanbanBoard = {
  columns: KanbanColumn[];
  /** Verbatim `%% kanban:settings … %%` tail — never re-stringify */
  settingsBlock: string;
  /** Bytes before first `##` column heading (frontmatter + preamble) */
  headBlock: string;
  /** Full original source when parsed — surgical rewrites only touch columns */
  originalSource: string;
  isKanban: boolean;
  settings: KanbanSettings;
};

/** Shared fields for leave + land. */
export type KanbanCardTransitEvent = {
  boardPath: string;
  card: KanbanCard;
  fromColumn: string;
  toColumn: string;
  fromColumnIndex: number;
  toColumnIndex: number;
  fromIndex: number;
  toIndex: number;
  /** Board columns: pre-move for leave, post-move for land */
  columns: KanbanColumn[];
  /** "leave" | "land" */
  phase: "leave" | "land";
};

/** @deprecated alias — same as land phase */
export type KanbanCardMovedEvent = KanbanCardTransitEvent;

/** Card leaving a swim lane (phase === "leave"). */
export type KanbanCardLeftEvent = KanbanCardTransitEvent;

const SETTINGS_RE = /\n%%\s*kanban:settings[\s\S]*?%%\s*$/i;

export function isKanbanSource(source: string): boolean {
  const head = source.slice(0, 800).toLowerCase();
  if (head.includes("kanban-plugin")) return true;
  if (/%%\s*kanban:settings/i.test(source)) return true;
  return false;
}

export function parseKanban(source: string): KanbanBoard {
  const settingsMatch = source.match(SETTINGS_RE);
  const settingsBlock = settingsMatch ? settingsMatch[0] : "";
  let body = settingsMatch
    ? source.slice(0, settingsMatch.index)
    : source;

  // Head = everything before the first ## column (preserve verbatim on save)
  const firstHeading = body.search(/^##\s+/m);
  const headBlock = firstHeading >= 0 ? body.slice(0, firstHeading) : body;
  const columnRegion = firstHeading >= 0 ? body.slice(firstHeading) : "";

  const columns: KanbanColumn[] = [];
  let current: KanbanColumn | null = null;

  for (const line of columnRegion.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = { name: h[1].trim(), cards: [] };
      columns.push(current);
      continue;
    }
    if (!current) continue;
    const task = line.match(/^\s*[-*+]\s+\[([ xX/~-])\]\s*(.*)$/);
    if (task) {
      const checked = /[xX]/.test(task[1]);
      const text = task[2].trim();
      const linkM = text.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
      current.cards.push({
        raw: line,
        checked,
        text,
        link: linkM ? linkM[1].trim() : null,
        label: linkM ? (linkM[2] || linkM[1]).trim() : text,
      });
    }
  }

  return {
    columns,
    settingsBlock,
    headBlock,
    originalSource: source,
    isKanban: columns.length > 0 && isKanbanSource(source),
    settings: parseKanbanSettings(settingsBlock),
  };
}

/** Parse `%% kanban:settings %%` JSON; read optional `nephrite.hooks`. */
export function parseKanbanSettings(settingsBlock: string): KanbanSettings {
  const empty: KanbanSettings = { raw: {}, nephriteHooks: {} };
  if (!settingsBlock) return empty;
  const m = settingsBlock.match(/```\s*\n?([\s\S]*?)```/);
  const jsonText = (m ? m[1] : settingsBlock).trim();
  // strip %% wrappers if still present
  const cleaned = jsonText
    .replace(/^%%\s*kanban:settings/i, "")
    .replace(/%%\s*$/i, "")
    .trim();
  try {
    const raw = JSON.parse(cleaned) as Record<string, unknown>;
    const nephrite = (raw.nephrite ?? {}) as Record<string, unknown>;
    const hooks = (nephrite.hooks ?? raw.hooks ?? {}) as Record<string, unknown>;
    return {
      raw,
      nephriteHooks: {
        onCardMove: typeof hooks.onCardMove === "string" ? hooks.onCardMove : undefined,
        onCardMoveFile:
          typeof hooks.onCardMoveFile === "string" ? hooks.onCardMoveFile : undefined,
        onCardLeave: typeof hooks.onCardLeave === "string" ? hooks.onCardLeave : undefined,
        onCardLeaveFile:
          typeof hooks.onCardLeaveFile === "string" ? hooks.onCardLeaveFile : undefined,
        onCardChecked:
          typeof hooks.onCardChecked === "string" ? hooks.onCardChecked : undefined,
        onCardCheckedFile:
          typeof hooks.onCardCheckedFile === "string"
            ? hooks.onCardCheckedFile
            : undefined,
      },
    };
  } catch {
    return empty;
  }
}

/**
 * Merge nephrite.hooks into an existing settings block (preserves other keys).
 */
export function settingsBlockWithHooks(
  settingsBlock: string,
  hooks: KanbanHooksConfig,
): string {
  const parsed = parseKanbanSettings(settingsBlock);
  const raw = { ...parsed.raw };
  const nephrite = {
    ...((raw.nephrite as object) || {}),
    hooks: { ...parsed.nephriteHooks, ...hooks },
  };
  raw.nephrite = nephrite;
  if (!raw["kanban-plugin"]) raw["kanban-plugin"] = "board";
  const json = JSON.stringify(raw);
  return `%% kanban:settings\n\`\`\`\n${json}\n\`\`\`\n%%`;
}

/**
 * Rewrite only the ## columns region. Head (frontmatter) and settings footer
 * are copied **verbatim** so hooks / Obsidian formatting are never blasted.
 */
export function serializeKanban(
  columns: KanbanColumn[],
  settingsBlock: string,
  _hooks?: KanbanHooksConfig,
  headBlock?: string,
): string {
  const head =
    headBlock != null && headBlock.length > 0
      ? headBlock.replace(/\s*$/, "\n\n")
      : "---\n\nkanban-plugin: board\n\n---\n\n";

  const colLines: string[] = [];
  for (const col of columns) {
    colLines.push(`## ${col.name}`, "");
    for (const card of col.cards) {
      const mark = card.checked ? "x" : " ";
      const body =
        card.link != null
          ? card.label !== card.link
            ? `[[${card.link}|${card.label}]]`
            : `[[${card.link}]]`
          : card.text;
      colLines.push(`- [${mark}] ${body}`);
    }
    colLines.push("");
  }

  const footer = settingsBlock
    ? settingsBlock.replace(/^\n+/, "").replace(/\s*$/, "\n")
    : "%% kanban:settings\n```\n{\"kanban-plugin\":\"board\"}\n```\n%%\n";

  return head + colLines.join("\n") + footer;
}

/** Move card from (fromCol, fromIdx) to (toCol, toIdx). */
export function moveCard(
  columns: KanbanColumn[],
  fromCol: number,
  fromIdx: number,
  toCol: number,
  toIdx: number,
): KanbanColumn[] {
  const cols = columns.map((c) => ({
    name: c.name,
    cards: [...c.cards],
  }));
  const [card] = cols[fromCol].cards.splice(fromIdx, 1);
  if (!card) return columns;
  const dest = cols[toCol].cards;
  const idx = Math.max(0, Math.min(toIdx, dest.length));
  dest.splice(idx, 0, card);
  return cols;
}
