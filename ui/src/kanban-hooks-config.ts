/**
 * Vault-level kanban hooks — live **outside** the board Markdown so
 * jobctl board-sync / Obsidian / accidental rewrites cannot erase them.
 *
 * Stored at:  .nephrite/kanban-hooks.json  (under the vault root)
 *
 * Shape:
 * {
 *   "snippets/Job Search 2026 Board.md": {
 *     "onCardMoveFile": "automation/job-board-on-card-move.js",
 *     "onCardLeaveFile": "automation/job-board-on-card-leave.js"
 *   }
 * }
 */

import { invoke } from "@tauri-apps/api/core";
import type { KanbanHooksConfig } from "./kanban";

const CONFIG_PATH = ".nephrite/kanban-hooks.json";

let cache: Record<string, KanbanHooksConfig> | null = null;

export async function loadVaultKanbanHooks(): Promise<
  Record<string, KanbanHooksConfig>
> {
  if (cache) return cache;
  try {
    const file = await invoke<{ path: string; content: string }>("read_file", {
      path: CONFIG_PATH,
    });
    const parsed = JSON.parse(file.content) as Record<string, KanbanHooksConfig>;
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function clearKanbanHooksCache() {
  cache = null;
}

function lookupVaultHooks(
  all: Record<string, KanbanHooksConfig>,
  boardPath: string,
): KanbanHooksConfig {
  if (all[boardPath]) return all[boardPath];
  const norm = boardPath.replace(/^\//, "");
  if (all[norm]) return all[norm];
  // Match by basename or suffix (spaces / path variants)
  const base = norm.split("/").pop() || norm;
  for (const [key, val] of Object.entries(all)) {
    if (key === base || norm.endsWith(key) || key.endsWith(base)) return val;
  }
  return {};
}

/** Merge board-file hooks with vault config. Vault wins on key conflict
 * (so a wiped board footer still runs the real scripts). */
export async function resolveBoardHooks(
  boardPath: string,
  fromBoard: KanbanHooksConfig,
): Promise<KanbanHooksConfig> {
  const all = await loadVaultKanbanHooks();
  const fromVault = lookupVaultHooks(all, boardPath);
  return {
    ...fromBoard,
    ...fromVault,
    // Prefer vault file paths when both set
    onCardMoveFile: fromVault.onCardMoveFile || fromBoard.onCardMoveFile,
    onCardLeaveFile: fromVault.onCardLeaveFile || fromBoard.onCardLeaveFile,
    onCardMove: fromVault.onCardMove || fromBoard.onCardMove,
    onCardLeave: fromVault.onCardLeave || fromBoard.onCardLeave,
    onCardChecked: fromVault.onCardChecked || fromBoard.onCardChecked,
    onCardCheckedFile: fromVault.onCardCheckedFile || fromBoard.onCardCheckedFile,
  };
}

/** Ensure Job Search board has vault-level hooks (idempotent). */
export async function ensureDefaultJobBoardHooks(
  boardPath: string,
): Promise<void> {
  const all = await loadVaultKanbanHooks();
  if (all[boardPath]?.onCardMoveFile) return;
  all[boardPath] = {
    onCardLeaveFile: "automation/job-board-on-card-leave.js",
    onCardMoveFile: "automation/job-board-on-card-move.js",
    ...all[boardPath],
  };
  cache = all;
  try {
    await invoke("create_file", {
      path: CONFIG_PATH,
      content: JSON.stringify(all, null, 2) + "\n",
    });
  } catch {
    // exists — overwrite via write_file
    try {
      await invoke("write_file", {
        path: CONFIG_PATH,
        content: JSON.stringify(all, null, 2) + "\n",
      });
    } catch (e) {
      console.error("[kanban-hooks-config] write failed", e);
    }
  }
}
