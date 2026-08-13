import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { NephriteEditor, type FoldRange } from "./editor";
import { hydrateTableOfContents, renderBlockHtml, renderPreview } from "./preview";
import { planPreviewUpdate } from "./preview-blocks";
import { PreviewWorkerClient } from "./preview-worker-client";
import { patchPreviewHtml } from "./preview-patch";
import { findBooleanPropertyEdit, renderPropertiesHtml, splitFrontmatter } from "./frontmatter";
import { splitWikilinkTarget } from "./wikilinks";
import {
  buildTree,
  defaultTodayJournalPath,
  filterTree,
  findTodayJournal,
  visibleFiles,
  type TreeNode,
} from "./tree";
import {
  isKanbanSource,
  moveCard,
  parseKanban,
  serializeKanban,
  type KanbanBoard,
  type KanbanCardMovedEvent,
  type KanbanCardTransitEvent,
  type KanbanHooksConfig,
} from "./kanban";
import {
  executeBlocksInPreview,
  executeBlocksInSubtree,
} from "./dv-engine";
import { makeEngineContext } from "./dv-context";
import * as hooks from "./hooks";
import { $ as sh, $$ as shFull, shell } from "./shell";
import {
  clearKanbanHooksCache,
  ensureDefaultJobBoardHooks,
  resolveBoardHooks,
} from "./kanban-hooks-config";
import { installZoomKeys, getZoom } from "./zoom";
import {
  clearQueryDiagnostics,
  queryDiagnostic,
  queryDiagnosticText,
} from "./query-diagnostics";
import { installWindowStatePersistence } from "./window-state";
import {
  showContextMenu,
  parentDir,
  joinPath,
  baseName,
  uniqueCopyName,
  type CtxAction,
  type CtxTarget,
} from "./context-menu";
import {
  clearScrollSync,
  CURSOR_SYNC_DELAY_MS,
  rebindScrollSync,
  setEditorDocumentEnd,
  syncEditorCursorMovement,
  withoutScrollSync,
} from "./scroll-sync";
import { bindLinkPreviews, dismissLinkPreview } from "./link-preview";
import { bindKanbanCardPreview, dismissKanbanCardPreview } from "./kanban-card-preview";
import { findTaskCheckboxEdit } from "./tasks";
import { VimPowerlineClient } from "./vim-powerline";
import {
  emptyExcalidrawFile,
  isObsidianExcalidrawMarkdown,
  parseExcalidrawDocument,
  type ExcalidrawDocument,
} from "./excalidraw-file";
import { renderTemplater } from "./templater";
import { planTemplateApplication } from "./template-application";
import { hydrateExcalidrawEmbeds } from "./excalidraw-embed";
import { hydrateNoteEmbeds } from "./note-embed";
import { hydrateMarkdownImages } from "./image-embed";
import { DeferredDocumentWork } from "./edit-scheduler";
import { RefreshGate } from "./refresh-gate";
import { resizedKanbanLaneWidth } from "./kanban-resize";
import { canPersistSession } from "./session-guard";
import { bindQueryUriLinks } from "./query-uri";
import { vaultChangeTouchesFileTree } from "./vault-change";
import { CanvasView, serializeCanvas } from "./canvas-view";
import { renderGraph } from "./graph-view";
import { renderCommandBar, type AppCommand } from "./command-bar";
import {
  PluginManager,
  type PluginDescriptor,
  type PluginViewResult,
} from "./plugin-host";
import {
  DEFAULT_TASK_VIEW,
  DEFAULT_TASK_SCOPE,
  groupTasks,
  normalizeTaskScope,
  selectTasks,
  taskScopeIsActive,
  updateTaskMetadataLine,
  type TaskView,
} from "./task-dashboard";
import { ShortcutRegistry, shortcutFromEvent } from "./shortcuts";
import {
  automationVariables,
  expandAutomationText,
  validateAutomationConfig,
  type AutomationAction,
  type AutomationConfig,
} from "./automation";
import { findInKanbanLane, normalizePageFindQuery } from "./kanban-find";
import type {
  FileEntry,
  GitCommit,
  GitBranches,
  GitStatus,
  GitSyncStatus,
  GitCommitDetails,
  SearchResult,
  GraphData,
  OpenFile,
  TaskRow,
  UserVimrc,
  VaultInfo,
  VaultChangeEvent,
  VaultOpenPlan,
  VaultOpenProgress,
  ViewMode,
  TaskScope,
} from "./types";
import "./styles.css";

const BOOKMARKS_KEY = "nephrite.bookmarks";
const PANE_SPLIT_KEY = "nephrite.paneSplit";
const PROPERTIES_FOLD_KEY_PREFIX = "nephrite.propertiesFold.v1:";
const PAGE_VIEW_KEY_PREFIX = "nephrite.pageView.v1:";
const EDITOR_FOLD_KEY_PREFIX = "nephrite.editorFolds.v1:";
const KANBAN_WIDTH_KEY_PREFIX = "nephrite.kanbanWidths.v1:";
const TASK_VIEWS_KEY = "nephrite.taskViews.v1";
const TASK_SCOPE_KEY = "nephrite.taskScope.v1";
const SIDEBAR_COLLAPSED_KEY = "nephrite.sidebarCollapsed";
const AUTOSAVE_DELAY_MS = 800;
// A sub-half-second gap is normal thinking/typing cadence, not a completed edit.
const PREVIEW_DELAY_MS = 1_000;

const LAST_VAULT_KEY = "nephrite.lastVault";
const VIM_KEY = "nephrite.vim";
const PREVIEW_CSS_KEY = "nephrite.previewCss.v1";
const DEFAULT_PREVIEW_CSS = "/* Nephrite page styles \u2014 edit in Preferences. Scoped to .preview */\n\n.preview {\n  line-height: 1.55;\n  color: var(--text);\n}\n\n.preview a {\n  color: var(--accent);\n  text-decoration: underline;\n  text-underline-offset: 2px;\n}\n\n.preview a:hover {\n  color: #9ee4c8;\n}\n\n.preview hr {\n  border: none;\n  border-top: 1px solid var(--border);\n  margin: 1.25em 0;\n}\n\n.preview ul,\n.preview ol {\n  margin: 0.55em 0 0.55em 1.35em;\n  padding: 0;\n}\n\n.preview li {\n  margin: 0.25em 0;\n}\n\n.preview li > ul,\n.preview li > ol {\n  margin-top: 0.2em;\n}\n\n.preview img {\n  max-width: 100%;\n  height: auto;\n  border-radius: 6px;\n}\n\n.preview table {\n  width: 100%;\n  border-collapse: collapse;\n  margin: 0.9em 0;\n  font-size: 0.92em;\n  display: block;\n  overflow-x: auto;\n}\n\n.preview th,\n.preview td {\n  border: 1px solid var(--border);\n  padding: 0.45em 0.7em;\n  text-align: left;\n  vertical-align: top;\n}\n\n.preview th {\n  background: #1a2330;\n  font-weight: 650;\n  color: #dff8ec;\n}\n\n.preview tr:nth-child(even) td {\n  background: color-mix(in srgb, #1a2330 55%, transparent);\n}\n\n.preview tr:hover td {\n  background: color-mix(in srgb, var(--accent) 10%, transparent);\n}\n\n.preview input[type=\"checkbox\"] {\n  margin-right: 0.4em;\n}\n";
const EXTERNAL_BROWSER_KEY = "nephrite.externalLinksInBrowser";
const VIEW_KEY = "nephrite.viewMode";
const EXPANDED_KEY = "nephrite.expandedFolders";
const DOTFILES_KEY = "nephrite.showDotfiles";
const STATUS_HINT =
  "Ctrl± zoom · Ctrl+Enter task · Ctrl/Cmd+click link · Ctrl/Cmd+S save";

type SessionState = {
  tabs: string[];
  active: string | null;
  right: string | null;
};

let editor: NephriteEditor | null = null;
let excalidrawView: import("./excalidraw-view").ExcalidrawView | null = null;
let canvasView: CanvasView | null = null;
let pluginManager: PluginManager | null = null;
const shortcuts = new ShortcutRegistry();
let taskScope: TaskScope = loadTaskScope();
let vaultFilesAll: FileEntry[] = [];
let automationConfig: AutomationConfig | null = null;
let automationRunning = new Set<string>();
let currentPath: string | null = null;
let currentFileKind = "markdown";
let drawingContent = "";
let drawingDocument: ExcalidrawDocument | null = null;
let canvasContent = "";
let dirty = false;
/** All markdown paths from the index (unfiltered). */
let mdFilesAll: FileEntry[] = [];
/** What the tree shows after dotfile + search filters. */
let mdFiles: FileEntry[] = [];
let filterQuery = "";
let sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
let showDotfiles = localStorage.getItem(DOTFILES_KEY) === "1";
let vimOn = localStorage.getItem(VIM_KEY) === "1";
let externalLinksInBrowser = localStorage.getItem(EXTERNAL_BROWSER_KEY) === "1";
let viewMode: ViewMode = normalizeMode(localStorage.getItem(VIEW_KEY));
const previewWork = new DeferredDocumentWork(PREVIEW_DELAY_MS);
const previewRenderer = new PreviewWorkerClient();
const vaultPreviewRefresh = new RefreshGate();
let previewRevision = 0;
/** Last markdown body committed to the preview (for trivial block patches). */
let lastPreviewBody: string | null = null;
let lastPreviewPath: string | null = null;
let statusHintTimer: number | null = null;
let autosaveTimer: number | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let vaultOpen = false;
let refreshInProgress = false;
let vaultChangeQueue: Promise<void> = Promise.resolve();
let statusLine = 1;
let statusColumn = 1;
let cursorChromeFrame: number | null = null;
let vimPowerline: VimPowerlineClient | null = null;
let expanded = loadExpanded();
let treeRoot: TreeNode = { name: "", path: "", kind: "dir", children: [] };
let kanbanBoard: KanbanBoard | null = null;
/** Open file tabs for this vault (restored on open). */
let openTabs: string[] = [];
/** Secondary pane path for "Open to the right". */
let rightPath: string | null = null;
/** Editor share of split width (0.15–0.85). */
let paneSplit = loadPaneSplit();
/** Skip session writes during restore. */
let restoringSession = false;
/** Preview-only fold state; never written into vault files. */
const propertiesFoldState = new Map<string, boolean>();
let propertiesFoldStorageKey: string | null = null;
const pageViewModes = new Map<string, ViewMode>();
const editorFoldState = new Map<string, FoldRange[]>();
const kanbanLaneWidths = new Map<string, Record<string, number>>();
let pageViewStorageKey: string | null = null;
let editorFoldStorageKey: string | null = null;
let kanbanWidthStorageKey: string | null = null;
let lastEditorKeyAt = 0;
let kanbanFindOpen = false;
let kanbanFindQuery = "";
let kanbanFindMatchIndex = 0;
let kanbanFindPath: string | null = null;
const kanbanExpandedCollapsedLanes = new Set<string>();

function loadPageState(vaultRoot: string) {
  pageViewModes.clear();
  editorFoldState.clear();
  kanbanLaneWidths.clear();
  pageViewStorageKey = `${PAGE_VIEW_KEY_PREFIX}${vaultRoot}`;
  editorFoldStorageKey = `${EDITOR_FOLD_KEY_PREFIX}${vaultRoot}`;
  kanbanWidthStorageKey = `${KANBAN_WIDTH_KEY_PREFIX}${vaultRoot}`;
  try {
    const modes = JSON.parse(localStorage.getItem(pageViewStorageKey) || "{}");
    if (modes && typeof modes === "object" && !Array.isArray(modes)) {
      for (const [path, mode] of Object.entries(modes)) {
        if (mode === "source" || mode === "split" || mode === "preview") {
          pageViewModes.set(path, mode);
        }
      }
    }
  } catch { /* disposable UI state */ }
  try {
    const folds = JSON.parse(localStorage.getItem(editorFoldStorageKey) || "{}");
    if (folds && typeof folds === "object" && !Array.isArray(folds)) {
      for (const [path, ranges] of Object.entries(folds)) {
        if (!Array.isArray(ranges)) continue;
        editorFoldState.set(path, ranges.filter((range): range is FoldRange =>
          !!range && typeof range.from === "number" && typeof range.to === "number"
        ));
      }
    }
  } catch { /* disposable UI state */ }
  try {
    const boards = JSON.parse(localStorage.getItem(kanbanWidthStorageKey) || "{}");
    if (boards && typeof boards === "object" && !Array.isArray(boards)) {
      for (const [path, widths] of Object.entries(boards)) {
        if (!widths || typeof widths !== "object" || Array.isArray(widths)) continue;
        const valid: Record<string, number> = {};
        for (const [lane, width] of Object.entries(widths as Record<string, unknown>)) {
          if (typeof width === "number" && Number.isFinite(width)) {
            valid[lane] = Math.max(180, Math.min(600, width));
          }
        }
        kanbanLaneWidths.set(path, valid);
      }
    }
  } catch { /* disposable UI state */ }
}

function persistMap<T>(key: string | null, value: Map<string, T>) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(value)));
  } catch { /* quota / private mode */ }
}

function rememberEditorFolds() {
  if (!currentPath || currentFileKind !== "markdown" || !editor) return;
  editorFoldState.set(currentPath, editor.getFoldedRanges());
  persistMap(editorFoldStorageKey, editorFoldState);
}

function restoreEditorFolds(path: string) {
  if (!editor) return;
  const saved = editorFoldState.get(path);
  if (saved) {
    editor.setFoldedRanges(saved);
  }
}

function bindPropertiesFoldState(root: HTMLElement, path: string) {
  root.dataset.propertiesPath = path;
  root.querySelectorAll<HTMLDetailsElement>("details.props-block").forEach(
    (properties) => {
      const saved = propertiesFoldState.get(path);
      if (saved != null) properties.open = saved;
      if (properties.dataset.foldStateBound === "1") return;
      properties.dataset.foldStateBound = "1";
      const summary = properties.querySelector("summary");
      // `toggle` is queued by the browser. Record the user's intent during
      // the click itself so a preview replacement cannot race ahead of it.
      summary?.addEventListener("click", () => {
        setPropertiesFoldState(path, !properties.open);
      });
      properties.addEventListener("toggle", () => {
        setPropertiesFoldState(path, properties.open);
      });
    },
  );
}

function rememberPropertiesFoldState(root: HTMLElement) {
  const path = root.dataset.propertiesPath;
  if (!path) return;
  const properties = root.querySelector<HTMLDetailsElement>("details.props-block");
  if (properties) setPropertiesFoldState(path, properties.open);
}

function setPropertiesFoldState(path: string, open: boolean) {
  propertiesFoldState.set(path, open);
  if (!propertiesFoldStorageKey) return;
  try {
    localStorage.setItem(
      propertiesFoldStorageKey,
      JSON.stringify(Object.fromEntries(propertiesFoldState)),
    );
  } catch {
    /* Storage can be unavailable in private/webview-restricted contexts. */
  }
}

function loadPropertiesFoldState(vaultRoot: string) {
  propertiesFoldState.clear();
  propertiesFoldStorageKey = `${PROPERTIES_FOLD_KEY_PREFIX}${vaultRoot}`;
  try {
    const saved = JSON.parse(localStorage.getItem(propertiesFoldStorageKey) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [path, open] of Object.entries(saved)) {
      if (typeof open === "boolean") propertiesFoldState.set(path, open);
    }
  } catch {
    /* A damaged cache is disposable; Markdown remains authoritative. */
  }
}

function loadPaneSplit(): number {
  const n = Number(localStorage.getItem(PANE_SPLIT_KEY));
  if (Number.isFinite(n) && n >= 0.15 && n <= 0.85) return n;
  return 0.5;
}

function sessionStorageKey(vaultRoot: string): string {
  return `nephrite.session.v1:${vaultRoot}`;
}

function saveSession() {
  // The last-vault key exists before automatic startup indexing finishes.
  // Do not let the crash-safety timer overwrite a valid saved workspace with
  // the still-empty startup state while a large index is opening.
  if (!canPersistSession(vaultOpen, restoringSession)) return;
  const vault = localStorage.getItem(LAST_VAULT_KEY);
  if (!vault) return;
  const tabs = [...openTabs];
  if (currentPath && !tabs.includes(currentPath)) tabs.push(currentPath);
  const session: SessionState = {
    tabs,
    active: currentPath,
    right: rightPath,
  };
  try {
    localStorage.setItem(sessionStorageKey(vault), JSON.stringify(session));
  } catch {
    /* quota / private mode */
  }
}

function loadSession(vaultRoot: string): SessionState | null {
  try {
    const raw = localStorage.getItem(sessionStorageKey(vaultRoot));
    if (!raw) return null;
    const s = JSON.parse(raw) as SessionState;
    if (!s || !Array.isArray(s.tabs)) return null;
    return {
      tabs: s.tabs.filter((t) => typeof t === "string"),
      active: typeof s.active === "string" ? s.active : null,
      right: typeof s.right === "string" ? s.right : null,
    };
  } catch {
    return null;
  }
}

function pathExistsInIndex(path: string): boolean {
  return mdFilesAll.some((f) => f.path === path);
}

/** Re-open tabs / active note / right pane after vault index is ready. */
async function restoreSession(vaultRoot: string) {
  const session = loadSession(vaultRoot);
  if (!session) return;

  restoringSession = true;
  try {
    const tabs = session.tabs.filter(pathExistsInIndex);
    openTabs = tabs;
    rightPath = session.right && pathExistsInIndex(session.right) ? session.right : null;

    const active =
      (session.active && pathExistsInIndex(session.active) && session.active) ||
      tabs[0] ||
      null;

    renderTabBar();
    if (active) {
      await openNote(active, { skipDirtyPrompt: true, fromSession: true });
    }
    if (rightPath) {
      await updateRightPane();
    }
  } finally {
    restoringSession = false;
    saveSession();
  }
}

function normalizeMode(raw: string | null): ViewMode {
  if (raw === "source" || raw === "live" || raw === "preview" || raw === "split") return raw;
  return "live";
}

function loadTaskScope(): TaskScope {
  try {
    return normalizeTaskScope(JSON.parse(localStorage.getItem(TASK_SCOPE_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_TASK_SCOPE };
  }
}

function saveTaskScopePreferences() {
  taskScope = normalizeTaskScope({
    folders: ($("task-scope-folders") as HTMLInputElement).value.split(","),
    tags: ($("task-scope-tags") as HTMLInputElement).value.split(","),
    property: ($("task-scope-property") as HTMLInputElement).value.replace(/[^A-Za-z0-9_.-]/g, ""),
  });
  localStorage.setItem(TASK_SCOPE_KEY, JSON.stringify(taskScope));
  ($("task-scope-property") as HTMLInputElement).value = taskScope.property;
  setTransientStatus(taskScopeIsActive(taskScope) ? "Task scope saved" : "Task scope cleared; all checkboxes included", "#5ecf9a");
}

/** Folder paths the user has explicitly expanded. Empty = everything rolled up. */
function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw == null) return new Set(); // first run: fully collapsed
    const a = JSON.parse(raw) as string[];
    return new Set(Array.isArray(a) ? a : []);
  } catch {
    return new Set();
  }
}

function saveExpanded() {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

type ActivityId = "files" | "search" | "graph" | "tasks" | "bookmarks" | "git" | "query-log";

function activityIcon(name: ActivityId | "settings" | "file-search" | "panel-close" | "folder-open" | "refresh"): string {
  const paths: Record<string, string> = {
    files: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    graph: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
    tasks: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    bookmarks: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
    git: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M8 6h6a4 4 0 0 1 4 4v0"/>',
    "query-log": '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    "file-search": '<path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="3"/><path d="m14.5 15.5 2 2"/>',
    "panel-close": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18m7-13-4 4 4 4"/>',
    "folder-open": '<path d="M3 6h6l2 2h10l-2 10H5Z"/><path d="M3 6v12"/>',
    refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M18 9a7 7 0 0 0-12-3L4 8m2 7a7 7 0 0 0 12 3l2-2"/>',
  };
  return `<svg class="activity-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

async function renderShell() {
  void installWindowStatePersistence();
  document.getElementById("app")!.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="logo">Nephrite</span>
        <span class="ver" id="ver"></span>
      </div>
      <div class="actions">
        <button type="button" id="btn-today" title="Jump to today's journal" disabled>Today</button>
        <button type="button" id="btn-save" disabled title="Save (Ctrl/Cmd+S)">Save</button>
        <button type="button" id="btn-command" title="Command bar (Ctrl+P)">Command</button>
        <div class="seg" role="group" aria-label="View mode">
          <button type="button" data-mode="source" class="seg-btn" title="Source only">Source</button>
          <button type="button" data-mode="live" class="seg-btn" title="Live preview editor">Live</button>
          <button type="button" data-mode="split" class="seg-btn" title="Edit + preview">Split</button>
          <button type="button" data-mode="preview" class="seg-btn" title="Preview only">Preview</button>
        </div>
        <button type="button" id="btn-drawing" title="Create an Excalidraw drawing" disabled>Draw</button>
        <button type="button" id="btn-canvas" title="Create an Obsidian canvas" disabled>Canvas</button>
        <button type="button" id="btn-template" title="Apply a template (Ctrl-Y)" disabled>Template</button>
      </div>
    </header>
    <div class="main">
      <nav class="activity-rail" aria-label="Workspace activities">
        <div class="activity-rail-main">
          <button type="button" id="activity-files" class="activity-button" title="Files" aria-label="Files" aria-pressed="true">${activityIcon("files")}</button>
          <button type="button" id="activity-search" class="activity-button" title="Search" aria-label="Search" aria-pressed="false" disabled>${activityIcon("search")}</button>
          <button type="button" id="activity-graph" class="activity-button" title="Graph" aria-label="Graph" aria-pressed="false" disabled>${activityIcon("graph")}</button>
          <button type="button" id="activity-tasks" class="activity-button" title="Tasks" aria-label="Tasks" aria-pressed="false" disabled>${activityIcon("tasks")}</button>
          <button type="button" id="activity-bookmarks" class="activity-button" title="Bookmarks" aria-label="Bookmarks" aria-pressed="false" disabled>${activityIcon("bookmarks")}</button>
          <button type="button" id="activity-git" class="activity-button" title="Git" aria-label="Git" aria-pressed="false" disabled>${activityIcon("git")}</button>
          <button type="button" id="activity-query-log" class="activity-button" title="Query log" aria-label="Query log" aria-pressed="false">${activityIcon("query-log")}</button>
        </div>
        <button type="button" id="btn-preferences" class="activity-button" title="Preferences" aria-label="Preferences" aria-expanded="false" aria-controls="preferences-popover">${activityIcon("settings")}</button>
        <section id="preferences-popover" class="preferences-popover hidden" role="dialog" aria-modal="false" aria-labelledby="preferences-title">
          <header>
            <strong id="preferences-title">Preferences</strong>
            <button type="button" id="preferences-close" class="preferences-close" title="Close preferences" aria-label="Close preferences">×</button>
          </header>
          <div class="preferences-body">
            <button type="button" id="btn-open" class="preferences-action">${activityIcon("folder-open")}<span>Open a vault…</span></button>
            <label class="preference-toggle">
              <input type="checkbox" id="vim-toggle" ${vimOn ? "checked" : ""} />
              <span>Vim mode</span>
            </label>
            <label class="preference-toggle">
              <input type="checkbox" id="dotfiles-toggle" ${showDotfiles ? "checked" : ""} />
              <span>Show dotfiles</span>
            </label>
            <label class="preference-toggle">
              <input type="checkbox" id="external-browser-toggle" ${externalLinksInBrowser ? "checked" : ""} />
              <span>Open external links in browser</span>
            </label>
            <section class="preferences-section">
              <strong>Task scope</strong>
              <small>Only checkboxes matching at least one configured rule appear in Tasks. Leave all fields empty to include every checkbox.</small>
              <input type="text" id="task-scope-folders" placeholder="Folders: Projects, Work" />
              <input type="text" id="task-scope-tags" placeholder="Tags: task, todo" />
              <input type="text" id="task-scope-property" placeholder="Frontmatter property: tasks" />
              <button type="button" id="task-scope-save">Save task scope</button>
            </section>
            <section class="preferences-section">
              <strong>Page CSS</strong>
              <small>Styles the Markdown preview. Prefer selectors under <code>.preview</code>. Saved in this browser profile.</small>
              <textarea id="preview-css-editor" class="preferences-css" spellcheck="false" rows="12"></textarea>
              <div class="preferences-css-actions">
                <button type="button" id="preview-css-save">Save page CSS</button>
                <button type="button" id="preview-css-reset">Reset to default</button>
              </div>
            </section>
            <section class="preferences-section">
              <strong>Plugins</strong>
              <div id="preferences-plugins" class="preferences-plugins"></div>
              <button type="button" id="preferences-plugin-reload">Reload plugins</button>
            </section>
            <section class="preferences-section">
              <strong>Automation</strong>
              <small id="preferences-automation-status">No automation configuration loaded.</small>
              <button type="button" id="preferences-automation-reload">Reload .nephrite/automations.json</button>
              <button type="button" id="preferences-automation-create">Create example configuration</button>
            </section>
            <button type="button" id="preferences-hotkeys" class="preferences-action"><span>Keyboard shortcuts…</span></button>
            <button type="button" id="btn-refresh" class="preferences-action" disabled>${activityIcon("refresh")}<span>Rescan Vault</span></button>
          </div>
        </section>
      </nav>
      <aside id="sidebar" class="sidebar" aria-label="Vault browser">
        <div class="sidebar-title">
          <strong>Files</strong>
          <div class="sidebar-title-actions">
            <button type="button" id="btn-file-search" class="sidebar-icon-button" title="Search files (Ctrl+O)" aria-label="Search files">${activityIcon("file-search")}</button>
            <button type="button" id="btn-sidebar" class="sidebar-icon-button" title="Collapse file panel" aria-label="Collapse file panel">${activityIcon("panel-close")}</button>
          </div>
        </div>
        <div class="sidebar-head">
          <div id="vault-label" class="vault-label">No vault open</div>
          <div id="index-stats" class="index-stats"></div>
          <div id="sidebar-filter-slot" class="sidebar-tools">
            <input type="search" id="file-filter" class="file-filter"
              placeholder="Filter files…" title="Filter files (Ctrl-O)"
              autocomplete="off" spellcheck="false" />
            <button type="button" id="btn-today-side" class="btn-today-side" disabled title="Today's journal">📅</button>
          </div>
        </div>
        <div id="file-tree" class="file-tree" role="tree"></div>
      </aside>
      <section class="workspace" id="workspace">
        <div id="index-progress" class="index-progress hidden" role="status" aria-live="polite">
          <span id="index-action">Indexing vault…</span>
          <progress aria-label="Vault indexing in progress"></progress>
        </div>
        <div id="tab-bar" class="tab-bar"></div>
        <div id="tab" class="tab">Open a Markdown file</div>
        <div id="panes" class="panes mode-${viewMode}">
          <div id="editor-host" class="editor-host"></div>
          <div id="pane-splitter" class="pane-splitter" role="separator"
            aria-orientation="vertical" aria-label="Resize editor and preview"
            title="Drag to resize · double-click to reset"></div>
          <div id="preview-host" class="preview-host" tabindex="-1">
            <div id="preview" class="preview"></div>
            <div id="kanban" class="kanban hidden" aria-label="Kanban board"></div>
          </div>
          <div id="right-pane" class="right-pane">
            <div class="right-pane-head">
              <span id="right-path">—</span>
              <button type="button" id="right-close" title="Close">×</button>
            </div>
            <div id="right-body" class="right-pane-body"></div>
          </div>
          <div id="excalidraw-host" class="excalidraw-host hidden" tabindex="-1"></div>
          <div id="canvas-workspace" class="canvas-workspace hidden">
            <div class="canvas-toolbar">
              <button type="button" id="canvas-add-text">+ Text</button>
              <button type="button" id="canvas-add-file">+ Note</button>
              <button type="button" id="canvas-add-link">+ Link</button>
              <button type="button" id="canvas-add-group">+ Group</button>
              <button type="button" id="canvas-connect">Connect</button>
              <button type="button" id="canvas-edit-edge">Edit edge</button>
              <button type="button" id="canvas-copy">Copy</button>
              <button type="button" id="canvas-paste">Paste</button>
              <button type="button" id="canvas-duplicate">Duplicate</button>
              <button type="button" id="canvas-delete">Delete selected</button>
              <input type="color" id="canvas-color" value="#5ecf9a" title="Selected card color" aria-label="Selected card color" />
              <button type="button" id="canvas-zoom-out" title="Zoom out">−</button>
              <button type="button" id="canvas-zoom-reset" title="Reset zoom">100%</button>
              <button type="button" id="canvas-zoom-in" title="Zoom in">+</button>
              <span>Double-click empty space to add text · drag and resize cards · Connect then click target</span>
            </div>
            <div id="canvas-host" tabindex="0"></div>
          </div>
        </div>
        <footer class="statusbar" id="statusbar">
          <span id="status-powerline" hidden></span>
          <span id="status-path" class="status-muted">—</span>
          <span id="status-cursor" class="status-muted">Ln 1, Col 1</span>
          <span id="status-zoom" class="status-muted">100%</span>
          <span id="status-hint" class="status-muted">${STATUS_HINT}</span>
        </footer>
      </section>
    </div>
    <div id="feature-panel" class="feature-panel hidden" role="dialog" aria-modal="true">
      <div class="feature-card">
        <header><h2 id="feature-title"></h2><button type="button" id="feature-close" title="Close">×</button></header>
        <div id="feature-body" class="feature-body"></div>
      </div>
    </div>
    <div id="external-view" class="external-view hidden" role="dialog" aria-label="External link">
      <header class="external-toolbar">
        <button type="button" id="external-close" title="Close external page">×</button>
        <span id="external-url"></span>
        <button type="button" id="external-default">Use default browser</button>
      </header>
      <iframe id="external-frame" title="External page"
        sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
    </div>
  `;

  $("btn-open").addEventListener("click", () => {
    closePreferences();
    void openVault();
  });
  $("activity-files").addEventListener("click", () => setSidebarCollapsed(false));
  $("btn-sidebar").addEventListener("click", () => setSidebarCollapsed(!sidebarCollapsed));
  $("btn-file-search").addEventListener("click", focusFileFilter);
  $("btn-refresh").addEventListener("click", () => void forceVaultRefresh());
  $("btn-save").addEventListener("click", () => void saveFile());
  $("btn-today").addEventListener("click", () => void openToday());
  $("btn-today-side").addEventListener("click", () => void openToday());
  $("btn-drawing").addEventListener("click", () => void createDrawing());
  $("btn-canvas").addEventListener("click", () => void createCanvas());
  $("activity-search").addEventListener("click", () => void showSearchPanel());
  $("activity-graph").addEventListener("click", () => void showGraphPanel());
  $("canvas-add-text").addEventListener("click", () => canvasView?.addText());
  $("canvas-add-file").addEventListener("click", () => {
    const path = window.prompt("Vault-relative note path", currentPath?.replace(/\.canvas$/i, ".md") ?? "");
    if (path?.trim()) canvasView?.addFile(path.trim());
  });
  $("canvas-add-link").addEventListener("click", () => {
    const url = window.prompt("Link URL", "https://");
    if (!url?.trim()) return;
    const label = window.prompt("Card label", url.trim()) || url.trim();
    canvasView?.addLink(url.trim(), label);
  });
  $("canvas-add-group").addEventListener("click", () => {
    const label = window.prompt("Group label", "Group")?.trim();
    if (label) canvasView?.addGroup(label);
  });
  $("canvas-delete").addEventListener("click", () => canvasView?.deleteSelected());
  $("canvas-edit-edge").addEventListener("click", () => {
    if (!canvasView?.editSelectedEdge()) setTransientStatus("Select a canvas edge first", "#e9ad55");
  });
  $("canvas-copy").addEventListener("click", () => canvasView?.copySelection());
  $("canvas-paste").addEventListener("click", () => canvasView?.pasteCopied());
  $("canvas-duplicate").addEventListener("click", () => canvasView?.duplicateSelected());
  $("canvas-connect").addEventListener("click", () => {
    if (!canvasView?.beginConnect()) setTransientStatus("Select a canvas node first", "#e9ad55");
  });
  $("canvas-color").addEventListener("input", (event) => {
    canvasView?.setSelectedColor((event.target as HTMLInputElement).value);
  });
  $("canvas-zoom-out").addEventListener("click", () => canvasView?.changeZoom(-0.1));
  $("canvas-zoom-reset").addEventListener("click", () => canvasView?.resetZoom());
  $("canvas-zoom-in").addEventListener("click", () => canvasView?.changeZoom(0.1));
  $("btn-template").addEventListener("click", () => void showTemplatePanel());
  $("btn-command").addEventListener("click", showCommandBar);
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const commands = commandCatalog(false);
    const id = shortcuts.match(event, commands.map((command) => command.id));
    if (!id) return;
    const command = commands.find((candidate) => candidate.id === id);
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    void Promise.resolve(command.run()).catch((error) => alert(String(error)));
  }, true);
  document.addEventListener("keydown", recordEditorInputTiming, true);
  $("activity-tasks").addEventListener("click", () => void showTasksPanel());
  $("activity-bookmarks").addEventListener("click", showBookmarksPanel);
  $("activity-git").addEventListener("click", () => void showGitPanel());
  $("activity-query-log").addEventListener("click", showQueryLogPanel);
  $("btn-preferences").addEventListener("click", togglePreferences);
  ($("task-scope-folders") as HTMLInputElement).value = taskScope.folders.join(", ");
  ($("task-scope-tags") as HTMLInputElement).value = taskScope.tags.join(", ");
  ($("task-scope-property") as HTMLInputElement).value = taskScope.property;
  $("task-scope-save").addEventListener("click", saveTaskScopePreferences);
  $("preferences-plugin-reload").addEventListener("click", () => void reloadPlugins().then(renderPreferencesPlugins));
  $("preferences-automation-reload").addEventListener("click", () => void reloadAutomations(true));
  $("preferences-automation-create").addEventListener("click", () => void createExampleAutomationConfig());
  $("preferences-hotkeys").addEventListener("click", showHotkeysPanel);
  $("preferences-close").addEventListener("click", closePreferences);
  $("preview-css-save").addEventListener("click", savePreviewCssFromEditor);
  $("preview-css-reset").addEventListener("click", resetPreviewCss);
  applyPreviewCss();
  $("feature-close").addEventListener("click", closeFeaturePanel);
  $("feature-panel").addEventListener("mousedown", (event) => {
    if (event.target === $("feature-panel")) closeFeaturePanel();
  });
  document.addEventListener("mousedown", (event) => {
    const target = event.target as Node;
    if (!$("preferences-popover").classList.contains("hidden") &&
        !$("preferences-popover").contains(target) &&
        !$("btn-preferences").contains(target)) {
      closePreferences();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("preferences-popover").classList.contains("hidden")) {
      closePreferences();
      $("btn-preferences").focus();
    }
  });
  $("external-close").addEventListener("click", closeExternalView);
  $("external-default").addEventListener("click", () => {
    const uri = ($("external-frame") as HTMLIFrameElement).dataset.uri;
    if (uri) void openUrl(uri).catch((error) => alert(String(error)));
  });
  document.addEventListener("nephrite-open-external", (event) => {
    const detail = (event as CustomEvent<{ uri?: string }>).detail;
    if (detail?.uri) openExternalView(detail.uri);
  });
  $("right-close").addEventListener("click", () => {
    rightPath = null;
    updateRightPane();
    saveSession();
  });
  installPaneSplitter();
  applyPaneSplit();
  $("vim-toggle").addEventListener("change", (e) => {
    vimOn = (e.target as HTMLInputElement).checked;
    localStorage.setItem(VIM_KEY, vimOn ? "1" : "0");
    editor?.setVim(vimOn);
    updateVimPowerline();
  });
  $("file-filter").addEventListener("input", (e) => {
    filterQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderTree();
    renderFileFilterPopout();
  });
  $("file-filter").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      (event.currentTarget as HTMLInputElement).value = "";
      filterQuery = "";
      renderTree();
      renderFileFilterPopout();
    }
  });
  $("dotfiles-toggle").addEventListener("change", (e) => {
    showDotfiles = (e.target as HTMLInputElement).checked;
    localStorage.setItem(DOTFILES_KEY, showDotfiles ? "1" : "0");
    rebuildVisibleTree();
  });
  $("external-browser-toggle").addEventListener("change", (e) => {
    externalLinksInBrowser = (e.target as HTMLInputElement).checked;
    localStorage.setItem(EXTERNAL_BROWSER_KEY, externalLinksInBrowser ? "1" : "0");
  });
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setViewMode(btn.dataset.mode as ViewMode);
    });
  });

  syncModeButtons();
  setSidebarCollapsed(sidebarCollapsed, false);
  installZoomKeys();
  updateZoomLabel();
  window.addEventListener("nephrite-zoom", () => updateZoomLabel());
  window.addEventListener("resize", () => updateVimPowerline());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && dirty) void saveFile(true);
  });
  vimPowerline = new VimPowerlineClient();
  await initEditor();
  pluginManager = new PluginManager({
    listFiles: () => mdFilesAll,
    readFile: async (path) => (await invoke<OpenFile>("read_file", { path })).content,
    writeFile: async (path, content) => {
      if (path === currentPath && dirty) throw new Error("Save or discard current edits before a plugin writes this file");
      await invoke("write_file", { path, content });
      if (path === currentPath) await openNote(path, { skipDirtyPrompt: true });
      await refreshTree();
    },
    queryIndex: (sql) => invoke("query_vault_sql", { sql }),
    editorState: () => ({
      path: currentPath,
      content: currentFileKind === "markdown" ? editor?.getDoc() ?? "" : "",
      selection: currentFileKind === "markdown" ? editor?.getSelection() ?? "" : "",
    }),
    replaceSelection: (content) => {
      if (currentFileKind !== "markdown" || !editor) throw new Error("No Markdown editor is active");
      editor.replaceSelection(content);
    },
    openPath: (path) => openNote(path),
    showView: showPluginView,
    executeShell: (command, args) => invoke("shell_command", {
      command: [command, ...args].map(shellArgument).join(" "), cwd: null, timeoutMs: 60_000,
    }),
  }, renderPreferencesPlugins);
  canvasView = new CanvasView(
    $("canvas-host"),
    (source) => {
      if (currentFileKind !== "canvas") return;
      canvasContent = source;
      dirty = true;
      updateChrome();
      scheduleAutosave();
    },
    (path) => void openNote(path),
    (url) => openExternalView(url),
  );
  await installVaultChangeListener();
  applyViewMode();

  invoke<string>("project_version")
    .then((v) => {
      $("ver").textContent = v;
    })
    .catch(() => {
      $("ver").textContent = "0.2";
    });

  const last = localStorage.getItem(LAST_VAULT_KEY);
  if (last) {
    void openVaultPath(last).catch((error) => {
      const message = `Could not reopen vault: ${String(error)}`;
      $("vault-label").textContent = "Vault reopen failed";
      $("index-stats").textContent = message;
      setTransientStatus(message, "#e9ad55");
    });
  }
}

async function initEditor() {
  const host = $("editor-host");
  host.innerHTML = "";
  let userVimrc: UserVimrc | null = null;
  try {
    userVimrc = await invoke<UserVimrc | null>("read_user_vimrc");
  } catch (error) {
    console.warn("[vimrc] could not load user configuration", error);
  }
  editor = new NephriteEditor(
    host,
    {
      onDirty: (d) => {
        if (dirty === d) return;
        dirty = d;
        updateChrome();
      },
      onSave: () => saveFile(false),
      onVimMessage: (message, isError) =>
        setTransientStatus(message, isError ? "#e9ad55" : "#5ecf9a"),
      onCursor: (line, col, totalLines) => {
        const lineChanged = line !== statusLine;
        statusLine = line;
        statusColumn = col;
        const atDocumentEnd = line === totalLines;
        setEditorDocumentEnd(atDocumentEnd);
        if (lineChanged && !atDocumentEnd) syncEditorCursorMovement();
        scheduleCursorChromeUpdate();
      },
      onOpenWikilink: (target) => void openWikilink(target),
      onDocChange: () => {
        scheduleEditorPreview();
        scheduleAutosave();
      },
      onFoldsChanged: () => rememberEditorFolds(),
    },
    vimOn,
    userVimrc,
  );
  schedulePreview("");
}

function scheduleCursorChromeUpdate() {
  if (cursorChromeFrame != null) return;
  cursorChromeFrame = requestAnimationFrame(() => {
    cursorChromeFrame = null;
    $("status-cursor").textContent = `Ln ${statusLine}, Col ${statusColumn}`;
    updateVimPowerline();
  });
}

function focusFileFilter() {
  setSidebarCollapsed(false);
  const input = document.getElementById("file-filter") as HTMLInputElement | null;
  if (!input) return;
  if (!$("feature-panel").classList.contains("hidden")) closeFeaturePanel();
  closePreferences();
  input.focus();
  input.select();
}

function setActiveActivity(activity: ActivityId | null) {
  document.querySelectorAll<HTMLButtonElement>(".activity-rail-main .activity-button").forEach((button) => {
    button.setAttribute("aria-pressed", button.id === `activity-${activity}` ? "true" : "false");
  });
}


function getPreviewCss(): string {
  const raw = localStorage.getItem(PREVIEW_CSS_KEY);
  if (raw == null || raw.trim() === "") return DEFAULT_PREVIEW_CSS;
  return raw;
}

function applyPreviewCss(css: string = getPreviewCss()) {
  let el = document.getElementById("nephrite-user-preview-css") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "nephrite-user-preview-css";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function loadPreviewCssEditor() {
  const editor = document.getElementById("preview-css-editor") as HTMLTextAreaElement | null;
  if (editor) editor.value = getPreviewCss();
}

function savePreviewCssFromEditor() {
  const editor = document.getElementById("preview-css-editor") as HTMLTextAreaElement | null;
  if (!editor) return;
  localStorage.setItem(PREVIEW_CSS_KEY, editor.value);
  applyPreviewCss(editor.value);
  setTransientStatus("Page CSS saved", "#5ecf9a");
}

function resetPreviewCss() {
  localStorage.removeItem(PREVIEW_CSS_KEY);
  applyPreviewCss(DEFAULT_PREVIEW_CSS);
  loadPreviewCssEditor();
  setTransientStatus("Page CSS reset to default", "#5ecf9a");
}

function togglePreferences() {
  const popover = $("preferences-popover");
  const opening = popover.classList.contains("hidden");
  popover.classList.toggle("hidden", !opening);
  if (opening) loadPreviewCssEditor();
  $("btn-preferences").setAttribute("aria-expanded", opening ? "true" : "false");
  $("btn-preferences").classList.toggle("active", opening);
  if (opening) {
    if (!$("feature-panel").classList.contains("hidden")) closeFeaturePanel();
    renderPreferencesPlugins();
    (popover.querySelector("button, input") as HTMLElement | null)?.focus();
  }
}

function closePreferences() {
  const popover = document.getElementById("preferences-popover");
  if (!popover) return;
  popover.classList.add("hidden");
  $("btn-preferences").setAttribute("aria-expanded", "false");
  $("btn-preferences").classList.remove("active");
}

function setViewMode(mode: ViewMode) {
  viewMode = mode;
  localStorage.setItem(VIEW_KEY, mode);
  if (currentPath && currentFileKind === "markdown") {
    pageViewModes.set(currentPath, mode);
    persistMap(pageViewStorageKey, pageViewModes);
  }
  syncModeButtons();
  applyViewMode();
  if ((mode === "split" || mode === "preview") && editor) {
    schedulePreview(editor.getDoc());
  } else {
    previewRevision++;
    previewWork.cancel();
    clearScrollSync();
  }
  if (mode !== "preview") {
    editor?.focus();
  }
  // Re-bind after layout switch
  requestAnimationFrame(() => setupScrollSync());
}

function syncModeButtons() {
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === viewMode);
  });
}

function applyViewMode() {
  const panes = $("panes");
  panes.className = `panes mode-${viewMode}`;
  editor?.setLivePreview(viewMode === "live");
  applyPaneSplit();
}

function applyPaneSplit() {
  const panes = document.getElementById("panes");
  if (!panes) return;
  panes.style.setProperty("--split-editor", String(paneSplit));
  panes.style.setProperty("--split-preview", String(1 - paneSplit));
  // Set columns in JS — `calc(n * 1fr)` is not reliable across engines.
  if (viewMode === "split") {
    const ed = Math.max(0.15, Math.min(0.85, paneSplit));
    const pr = 1 - ed;
    const withRight = document
      .getElementById("workspace")
      ?.classList.contains("with-right");
    panes.style.gridTemplateColumns = withRight
      ? `minmax(120px, ${ed}fr) 6px minmax(120px, ${pr}fr) minmax(200px, 0.85fr)`
      : `minmax(140px, ${ed}fr) 6px minmax(140px, ${pr}fr)`;
  } else {
    panes.style.gridTemplateColumns = "";
  }
}

function installPaneSplitter() {
  const handle = document.getElementById("pane-splitter");
  const panes = document.getElementById("panes");
  if (!handle || !panes) return;

  let dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const rect = panes.getBoundingClientRect();
    if (rect.width < 40) return;
    // Account for splitter sitting between editor and preview
    let r = (e.clientX - rect.left) / rect.width;
    // When right pane is open, only the first two columns share the drag region
    // roughly: still use full width ratio which is good enough.
    r = Math.min(0.85, Math.max(0.15, r));
    paneSplit = r;
    applyPaneSplit();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing-panes");
    localStorage.setItem(PANE_SPLIT_KEY, String(paneSplit));
    requestAnimationFrame(() => setupScrollSync());
  };

  handle.addEventListener("mousedown", (e) => {
    if (viewMode !== "split") return;
    e.preventDefault();
    dragging = true;
    document.body.classList.add("resizing-panes");
  });

  handle.addEventListener("dblclick", () => {
    paneSplit = 0.5;
    applyPaneSplit();
    localStorage.setItem(PANE_SPLIT_KEY, String(paneSplit));
    requestAnimationFrame(() => setupScrollSync());
  });

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** Editor ↔ preview scroll sympathy (Split mode only). */
function setupScrollSync() {
  if (viewMode !== "split") {
    clearScrollSync();
    return;
  }
  const ed = editor?.scrollElement() ?? null;
  // Preview scrolls on #preview-host; kanban on its horizontal strip (skip sync for board).
  const kanban = document.getElementById("kanban");
  if (kanban && !kanban.classList.contains("hidden")) {
    clearScrollSync();
    return;
  }
  const previewHost = document.getElementById("preview-host");
  rebindScrollSync(ed, previewHost);
}

function updateZoomLabel() {
  const el = document.getElementById("status-zoom");
  if (el) el.textContent = `${Math.round(getZoom() * 100)}%`;
}

function schedulePreview(text: string) {
  schedulePreviewRead(() => text);
}

function scheduleEditorPreview() {
  schedulePreviewRead(() => editor?.getDoc() ?? "");
}

function schedulePreviewRead(read: () => string) {
  const revision = ++previewRevision;
  previewWork.cancel();
  previewRenderer.cancel();
  if (viewMode === "source" || viewMode === "live") return;
  previewWork.schedule(read, (text) => {
    void renderRightPane(text, revision);
  });
}

async function renderRightPane(text: string, revision: number) {
  dismissLinkPreview();
  const previewEl = $("preview");
  const kanbanEl = $("kanban");

  if (isKanbanSource(text)) {
    if (kanbanFindPath !== currentPath) {
      kanbanFindOpen = false;
      kanbanFindQuery = "";
      kanbanFindMatchIndex = 0;
      kanbanExpandedCollapsedLanes.clear();
      kanbanFindPath = currentPath;
    }
    kanbanBoard = parseKanban(text);
    // Merge vault-level hooks (survive footer nukes from jobctl/Obsidian)
    if (currentPath) {
      void (async () => {
        if (currentPath?.includes("Job Search") && currentPath.endsWith("Board.md")) {
          await ensureDefaultJobBoardHooks(currentPath);
        }
        clearKanbanHooksCache();
        if (kanbanBoard && currentPath) {
          const merged = await resolveBoardHooks(
            currentPath,
            kanbanBoard.settings.nephriteHooks,
          );
          kanbanBoard = {
            ...kanbanBoard,
            settings: { ...kanbanBoard.settings, nephriteHooks: merged },
          };
        }
      })();
    }
    previewEl.classList.add("hidden");
    kanbanEl.classList.remove("hidden");
    renderKanbanBoard(kanbanBoard);
    requestAnimationFrame(() => setupScrollSync());
    return;
  }

  kanbanBoard = null;
  kanbanFindOpen = false;
  kanbanFindQuery = "";
  kanbanFindPath = null;
  kanbanExpandedCollapsedLanes.clear();
  kanbanEl.classList.add("hidden");
  kanbanEl.innerHTML = "";
  previewEl.classList.remove("hidden");
  rememberPropertiesFoldState(previewEl);
  const path = currentPath;
  const requestedAt = performance.now();

  // Trivial edit path: same block structure → re-render only dirty blocks on the
  // main thread. Full worker parse is the fallback when the document DTD shifts.
  if (path && path === lastPreviewPath && lastPreviewBody != null) {
    const plan = planPreviewUpdate(lastPreviewBody, text, splitFrontmatter);
    if (plan.kind === "noop") {
      return;
    }
    if (plan.kind === "yaml") {
      // Frontmatter-only: refresh props; re-render + re-run fence-bearing body blocks.
      const host = document.getElementById("preview-host");
      const scrollTop = host?.scrollTop ?? 0;
      const scrollLeft = host?.scrollLeft ?? 0;
      const { yaml, hasFrontmatter } = splitFrontmatter(text);
      const existingProps = previewEl.querySelector(":scope > .props-block");
      if (hasFrontmatter || (yaml && yaml.trim())) {
        const tpl = document.createElement("template");
        tpl.innerHTML = renderPropertiesHtml(yaml ?? "").trim();
        const node = tpl.content.firstElementChild;
        if (node && existingProps) existingProps.replaceWith(node);
        else if (node && !existingProps) previewEl.insertBefore(node, previewEl.firstChild);
      } else if (existingProps) {
        existingProps.remove();
      }
      previewEl.querySelectorAll(".dv-block, .dv-inline").forEach((el) => el.remove());
      for (let index = 0; index < plan.blocks.length; index++) {
        const block = plan.blocks[index];
        if (!/```(?:sql|dataview|dataviewjs|js|javascript)/i.test(block)) continue;
        const node = previewEl.querySelector(
          `:scope > .md-block[data-block-index="${index}"]`,
        ) as HTMLElement | null;
        if (!node) continue;
        const tpl = document.createElement("template");
        tpl.innerHTML = renderBlockHtml(block, index).trim();
        const fresh = tpl.content.firstElementChild as HTMLElement | null;
        if (!fresh) continue;
        node.replaceWith(fresh);
        const dynCtx = makeEngineContext(path, text, (target) => void openWikilink(target));
        void executeBlocksInSubtree(block, fresh, dynCtx, () =>
          isPreviewRevisionCurrent(path, revision),
        );
      }
      lastPreviewBody = text;
      previewEl.dataset.previewPath = path;
      if (host) {
        host.scrollTop = scrollTop;
        host.scrollLeft = scrollLeft;
      }
      bindPreviewContent(previewEl, path);
      queryDiagnostic("preview.yaml-patch", { path, revision });
      requestAnimationFrame(() => setupScrollSync());
      return;
    }
    if (plan.kind === "patch" && previewEl.querySelector(":scope > .md-block")) {
      const host = document.getElementById("preview-host");
      const scrollTop = host?.scrollTop ?? 0;
      const scrollLeft = host?.scrollLeft ?? 0;
      const commitStarted = performance.now();
      let replaced = 0;
      for (const index of plan.changed) {
        const existing = previewEl.querySelector(
          `:scope > .md-block[data-block-index="${index}"]`,
        );
        if (!existing) {
          // DOM out of sync with plan → full fallback
          replaced = -1;
          break;
        }
        const wrapper = document.createElement("template");
        wrapper.innerHTML = renderBlockHtml(plan.blocks[index], index).trim();
        const node = wrapper.content.firstElementChild;
        if (!node) {
          replaced = -1;
          break;
        }
        existing.replaceWith(node);
        replaced++;
      }
      if (replaced >= 0) {
        if (host) {
          host.scrollTop = scrollTop;
          host.scrollLeft = scrollLeft;
        }
        lastPreviewBody = text;
        previewEl.dataset.previewPath = path;
        queryDiagnostic("preview.block-patch", {
          path,
          revision,
          changed: plan.changed,
          htmlCommitMs: Number((performance.now() - commitStarted).toFixed(1)),
          roundTripMs: Number((performance.now() - requestedAt).toFixed(1)),
        });
        // Bind only; skip full dynamic re-run unless a dirty block has code fences.
        bindPreviewContent(previewEl, path);
        // Scoped dynamics: only re-execute fences inside the replaced .md-block nodes.
        const dynCtx = makeEngineContext(path, text, (target) => void openWikilink(target));
        for (const index of plan.changed) {
          const node = previewEl.querySelector(
            `:scope > .md-block[data-block-index="${index}"]`,
          ) as HTMLElement | null;
          if (!node?.querySelector("pre > code")) continue;
          void executeBlocksInSubtree(plan.blocks[index], node, dynCtx, () =>
            isPreviewRevisionCurrent(path, revision),
          );
        }
        requestAnimationFrame(() => setupScrollSync());
        return;
      }
    }
  }

  let markup;
  try {
    markup = await previewRenderer.render(text);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    queryDiagnostic("preview.worker.error", {
      path,
      revision,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!path || !isPreviewRevisionCurrent(path, revision)) {
    queryDiagnostic("preview.worker.discard", { path, revision, previewRevision });
    return;
  }
  const commitStarted = performance.now();
  const forceFull = previewEl.dataset.previewPath !== path;
  const host = document.getElementById("preview-host");
  const scrollTop = host?.scrollTop ?? 0;
  const scrollLeft = host?.scrollLeft ?? 0;
  const patch = patchPreviewHtml(previewEl, markup.html, forceFull);
  previewEl.dataset.previewPath = path ?? "";
  lastPreviewBody = text;
  lastPreviewPath = path;
  if (host) {
    host.scrollTop = scrollTop;
    host.scrollLeft = scrollLeft;
  }
  const htmlCommitMs = performance.now() - commitStarted;
  queryDiagnostic("preview.worker.complete", {
    path,
    revision,
    worker: markup.worker,
    renderMs: Number(markup.renderMs.toFixed(1)),
    roundTripMs: Number((commitStarted - requestedAt).toFixed(1)),
    htmlCommitMs: Number(htmlCommitMs.toFixed(1)),
    preservedNodes: patch.preserved,
    removedNodes: patch.removed,
    insertedNodes: patch.inserted,
    fullCommit: patch.full,
  });
  if (path) {
    queryDiagnostic("preview.rendered", {
      path,
      revision,
      codeElements: previewEl.querySelectorAll("pre > code").length,
      current: isPreviewRevisionCurrent(path, revision),
    });
    bindPreviewContent(previewEl, path);
    void (async () => {
      try {
        await renderDynamicPreview(text, path, revision, previewEl);
      } finally {
        void hydrateNoteEmbeds(previewEl, path, {
          openLink: (target) => void openWikilink(target),
        }).catch((error) => console.warn("[note embed]", error));
      }
    })();
  } else {
    hydrateTableOfContents(previewEl);
  }
  requestAnimationFrame(() => setupScrollSync());
}

function recordEditorInputTiming(event: KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest(".cm-editor")) return;
  const receivedAt = performance.now();
  if (receivedAt - lastEditorKeyAt < 500) {
    lastEditorKeyAt = receivedAt;
    return;
  }
  lastEditorKeyAt = receivedAt;
  const rawQueueMs = receivedAt - event.timeStamp;
  const queueMs = rawQueueMs >= 0 && rawQueueMs < 60_000
    ? Number(rawQueueMs.toFixed(1))
    : null;
  queryDiagnostic("input.first-key", { path: currentPath, queueMs });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    queryDiagnostic("input.first-paint", {
      path: currentPath,
      elapsedMs: Number((performance.now() - receivedAt).toFixed(1)),
    });
  }));
}

function openExternalView(uri: string) {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    setTransientStatus(`Invalid external link: ${uri}`, "#e9ad55");
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    void openUrl(uri).catch((error) => alert(String(error)));
    return;
  }
  if (externalLinksInBrowser) {
    void openUrl(parsed.href).catch((error) => alert(String(error)));
    return;
  }
  const view = $("external-view");
  const frame = $("external-frame") as HTMLIFrameElement;
  frame.dataset.uri = parsed.href;
  frame.src = parsed.href;
  $("external-url").textContent = parsed.href;
  view.classList.remove("hidden");
  $("external-close").focus();
}

function closeExternalView() {
  const view = $("external-view");
  const frame = $("external-frame") as HTMLIFrameElement;
  view.classList.add("hidden");
  frame.removeAttribute("src");
  delete frame.dataset.uri;
  $("external-url").textContent = "";
  focusActiveDocumentPane();
}

function bindExternalLinks(root: ParentNode) {
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    if (link.dataset.externalBound === "1" || link.dataset.queryUri) return;
    const href = link.getAttribute("href") ?? "";
    if (!/^(?:https?:|mailto:|tel:)/i.test(href)) return;
    link.dataset.externalBound = "1";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      link.dispatchEvent(new CustomEvent("nephrite-open-external", {
        bubbles: true,
        detail: { uri: link.href, mime: link.type || null },
      }));
    });
  });
}

function bindPreviewContent(root: HTMLElement, path: string) {
  bindPropertiesFoldState(root, path);
  bindQueryUriLinks(root);
  bindExternalLinks(root);
  root.querySelectorAll<HTMLInputElement>("li > input[type=checkbox]:not(.prop-bool)").forEach(
    (checkbox, taskIndex) => {
      if (checkbox.dataset.taskBound === "1") return;
      checkbox.dataset.taskBound = "1";
      checkbox.disabled = path !== currentPath || !editor;
      checkbox.title = checkbox.disabled
        ? "Open this note to change the task"
        : "Update task in Markdown";
      checkbox.addEventListener("change", () => {
        if (!editor || path !== currentPath) return;
        const edit = findTaskCheckboxEdit(editor.getDoc(), taskIndex, checkbox.checked);
        if (!edit) {
          checkbox.checked = !checkbox.checked;
          setTransientStatus("Could not safely locate this task in Markdown", "#e9ad55");
          return;
        }
        editor.replaceRange(edit.from, edit.to, edit.insert);
      });
    },
  );
  root.querySelectorAll<HTMLInputElement>("input.prop-bool[data-property-key]").forEach(
    (checkbox) => {
      if (checkbox.dataset.propertyBound === "1") return;
      checkbox.dataset.propertyBound = "1";
      checkbox.disabled = path !== currentPath || !editor;
      checkbox.addEventListener("change", () => {
        if (!editor || path !== currentPath) return;
        const key = checkbox.dataset.propertyKey;
        const edit = key
          ? findBooleanPropertyEdit(editor.getDoc(), key, checkbox.checked)
          : null;
        if (!edit) {
          checkbox.checked = !checkbox.checked;
          setTransientStatus(`Could not safely update YAML property ${key || ""}`, "#e9ad55");
          return;
        }
        editor.replaceRange(edit.from, edit.to, edit.insert);
      });
    },
  );
  root.querySelectorAll<HTMLAnchorElement>("a.preview-wikilink").forEach((a) => {
    if (a.dataset.openLinkBound === "1") return;
    a.dataset.openLinkBound = "1";
    a.addEventListener("click", (event) => {
      event.preventDefault();
      const target = a.dataset.wikilink;
      if (target) void openWikilink(target);
    });
  });
  // Embeds always — independent calls so one failure cannot skip the others.
  void hydrateMarkdownImages(root, path)
    .catch((error) => console.warn("[markdown image]", error));
  void hydrateExcalidrawEmbeds(root, path, (drawingPath) => void openNote(drawingPath))
    .catch((error) => console.warn("[excalidraw embed]", error));
  void hydrateNoteEmbeds(root, path, {
    openLink: (target) => void openWikilink(target),
  }).catch((error) => console.warn("[note embed]", error));
  bindLinkPreviews(root, {
    fromPath: path,
    openLink: (target) => void openWikilink(target),
  });
  hydrateTableOfContents(root);
}

async function renderDynamicPreview(
  text: string,
  path: string,
  revision: number,
  target: HTMLElement,
) {
  const currentAtStart = isPreviewRevisionCurrent(path, revision);
  queryDiagnostic("dynamic.start", { path, revision, previewRevision, currentAtStart });
  if (!currentAtStart) {
    queryDiagnostic("dynamic.cancel.before-execution", { path, revision, previewRevision });
    return;
  }
  vaultPreviewRefresh.begin();
  const ctx = makeEngineContext(path, text, (target) => void openWikilink(target));
  try {
    const { body } = splitFrontmatter(text);
    await executeBlocksInPreview(
      body,
      target,
      ctx,
      // The block elements belong to this preview revision. If a later edit
      // replaces the preview DOM, these detached nodes can finish harmlessly.
      () => true,
    );
  } catch (error) {
    queryDiagnostic("dynamic.error", {
      path,
      revision,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(error);
  } finally {
    if (vaultPreviewRefresh.end()) scheduleEditorPreview();
  }
  if (!isPreviewRevisionCurrent(path, revision)) {
    queryDiagnostic("dynamic.cancel.before-commit", { path, revision, previewRevision });
    return;
  }
  queryDiagnostic("dynamic.commit", {
    path,
    revision,
    resultBlocks: target.querySelectorAll(".dv-block").length,
    sourceBlocks: target.querySelectorAll("pre > code.language-sql, pre > code.language-dataview, pre > code.language-dataviewjs").length,
  });
  bindPreviewContent(target, path);
  requestAnimationFrame(() => setupScrollSync());
}

function isPreviewRevisionCurrent(path: string, revision: number): boolean {
  return revision === previewRevision && currentPath === path &&
    (viewMode === "split" || viewMode === "preview");
}

function renderKanbanBoard(board: KanbanBoard) {
  dismissKanbanCardPreview();
  const host = $("kanban");
  host.innerHTML = "";
  if (!board.isKanban || board.columns.length === 0) {
    host.innerHTML = `<div class="empty">Kanban frontmatter found but no columns (## headings).</div>`;
    return;
  }

  const findBar = document.createElement("div");
  findBar.className = `kanban-find${kanbanFindOpen ? "" : " hidden"}`;
  findBar.setAttribute("role", "search");
  findBar.innerHTML = `
    <input type="search" class="kanban-find-input" aria-label="Find in board"
      placeholder="Find in board…" autocomplete="off" spellcheck="false" />
    <span class="kanban-find-count" aria-live="polite">No matches</span>
    <button type="button" class="kanban-find-prev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
    <button type="button" class="kanban-find-next" title="Next match (Enter)" aria-label="Next match">↓</button>
    <button type="button" class="kanban-find-close" title="Close find (Escape)" aria-label="Close find">×</button>`;
  host.appendChild(findBar);

  const findInput = findBar.querySelector(".kanban-find-input") as HTMLInputElement;
  findInput.value = kanbanFindQuery;
  findInput.addEventListener("input", () => {
    kanbanFindQuery = findInput.value;
    kanbanFindMatchIndex = 0;
    kanbanExpandedCollapsedLanes.clear();
    applyKanbanFind();
  });
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeKanbanFind();
    } else if (event.key === "Enter") {
      event.preventDefault();
      stepKanbanFind(event.shiftKey ? -1 : 1);
    }
  });
  findBar.querySelector(".kanban-find-prev")?.addEventListener("click", () => stepKanbanFind(-1));
  findBar.querySelector(".kanban-find-next")?.addEventListener("click", () => stepKanbanFind(1));
  findBar.querySelector(".kanban-find-close")?.addEventListener("click", closeKanbanFind);

  const scroller = document.createElement("div");
  scroller.className = "kanban-scroll";
  const savedWidths = currentPath ? (kanbanLaneWidths.get(currentPath) || {}) : {};

  board.columns.forEach((col, colIdx) => {
    const colEl = document.createElement("section");
    colEl.className = "kanban-col";
    colEl.dataset.col = String(colIdx);
    const laneKey = `${colIdx}:${col.name}`;
    colEl.dataset.laneKey = laneKey;
    colEl.classList.toggle("kanban-col-empty", col.cards.length === 0);
    const savedWidth = savedWidths[laneKey];
    if (savedWidth) {
      colEl.style.flexBasis = `${savedWidth}px`;
      colEl.style.width = `${savedWidth}px`;
    }

    const head = document.createElement("header");
    head.className = "kanban-col-head";
    head.innerHTML = `<span class="kanban-col-title">${escapeHtml(col.name)}</span><span class="kanban-count">${col.cards.length}</span>`;
    colEl.appendChild(head);
    head.tabIndex = 0;
    head.title = col.cards.length === 0 ? "Expand empty lane" : col.name;
    const toggleCollapsedLane = () => {
      if (colEl.classList.contains("kanban-col-collapsed")) {
        kanbanExpandedCollapsedLanes.add(laneKey);
      } else {
        const result = findInKanbanLane(col, kanbanFindQuery);
        if (!result.collapse) return;
        kanbanExpandedCollapsedLanes.delete(laneKey);
      }
      applyKanbanFind();
    };
    head.addEventListener("click", toggleCollapsedLane);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleCollapsedLane();
      }
    });

    const list = document.createElement("div");
    list.className = "kanban-cards";
    list.dataset.col = String(colIdx);

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      list.classList.add("drag-over");
    });
    list.addEventListener("dragleave", () => list.classList.remove("drag-over"));
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      list.classList.remove("drag-over");
      const raw =
        e.dataTransfer?.getData("application/x-nephrite-kanban") ||
        e.dataTransfer?.getData("text/plain") ||
        "";
      if (!raw || !kanbanBoard) {
        setHookStatus("Drop ignored (no drag payload)", true);
        return;
      }
      let fromCol = -1;
      let fromIdx = -1;
      try {
        const parsed = JSON.parse(raw) as { fromCol: number; fromIdx: number };
        fromCol = parsed.fromCol;
        fromIdx = parsed.fromIdx;
      } catch {
        setHookStatus("Drop ignored (bad payload)", true);
        return;
      }
      if (fromCol === colIdx) return; // same column — no stage change
      const toCol = colIdx;
      const toIdx = kanbanBoard.columns[toCol].cards.length;
      const card = kanbanBoard.columns[fromCol]?.cards[fromIdx];
      if (!card) {
        setHookStatus("Drop ignored (card not found)", true);
        return;
      }
      const fromName = kanbanBoard.columns[fromCol].name;
      const toName = kanbanBoard.columns[toCol].name;
      const prevCols = kanbanBoard.columns;

      setHookStatus(`Moving “${card.label}”: ${fromName} → ${toName}…`);

      // 1) Leave swim lane (board still has card in fromColumn)
      const leaveEv: KanbanCardTransitEvent = {
        boardPath: currentPath || "",
        card,
        fromColumn: fromName,
        toColumn: toName,
        fromColumnIndex: fromCol,
        toColumnIndex: toCol,
        fromIndex: fromIdx,
        toIndex: toIdx,
        columns: prevCols,
        phase: "leave",
      };
      void (async () => {
        try {
          await fireKanbanCardLeft(leaveEv);

          const nextCols = moveCard(prevCols, fromCol, fromIdx, toCol, toIdx);
          kanbanBoard = { ...kanbanBoard!, columns: nextCols };
          persistKanban();
          renderKanbanBoard(kanbanBoard);

          // 2) Land in swim lane (board rewritten)
          const landEv: KanbanCardMovedEvent = {
            ...leaveEv,
            columns: nextCols,
            phase: "land",
          };
          await fireKanbanCardMoved(landEv);
          setHookStatus(
            `Hooks done: ${card.label.slice(0, 40)} → ${toName}`,
          );
        } catch (err) {
          setHookStatus(
            `Hook failed: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      })();
    });

    col.cards.forEach((card, cardIdx) => {
      const cardEl = document.createElement("article");
      cardEl.className = "kanban-card" + (card.checked ? " done" : "");
      cardEl.draggable = true;
      cardEl.dataset.col = String(colIdx);
      cardEl.dataset.idx = String(cardIdx);
      cardEl.dataset.searchMatch = "false";

      const label = document.createElement("button");
      label.type = "button";
      label.className = "kanban-card-label";
      label.textContent = card.label;
      label.title = card.link || card.text;
      label.addEventListener("click", () => {
        if (card.link) void openWikilink(card.link);
      });

      cardEl.addEventListener("dragstart", (e) => {
        const payload = JSON.stringify({ fromCol: colIdx, fromIdx: cardIdx });
        // text/plain required — many engines blank custom MIME types on drop
        e.dataTransfer?.setData("text/plain", payload);
        e.dataTransfer?.setData("application/x-nephrite-kanban", payload);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        cardEl.classList.add("dragging");
      });
      cardEl.addEventListener("dragend", () => cardEl.classList.remove("dragging"));

      cardEl.appendChild(label);
      bindKanbanCardPreview(cardEl, card, {
        fromPath: currentPath,
        openLink: (target) => void openWikilink(target),
      });
      list.appendChild(cardEl);
    });

    colEl.appendChild(list);
    scroller.appendChild(colEl);
    {
      const sizer = document.createElement("div");
      sizer.className = "kanban-col-sizer";
      const isFinalLane = colIdx === board.columns.length - 1;
      if (isFinalLane) sizer.classList.add("kanban-col-sizer-final");
      sizer.setAttribute("role", "separator");
      sizer.setAttribute("aria-orientation", "vertical");
      sizer.setAttribute("aria-label", `Resize ${col.name} lane`);
      sizer.title = "Drag to resize lane · double-click to reset";
      sizer.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || colEl.classList.contains("kanban-col-collapsed")) return;
        event.preventDefault();
        const startX = event.clientX;
        const laneRect = colEl.getBoundingClientRect();
        const startWidth = laneRect.width;
        const pointerId = event.pointerId;
        const move = (moveEvent: PointerEvent) => {
          if (moveEvent.pointerId !== pointerId) return;
          const width = resizedKanbanLaneWidth({
            startWidth,
            pointerDelta: moveEvent.clientX - startX,
          });
          colEl.style.flexBasis = `${width}px`;
          colEl.style.width = `${width}px`;
        };
        const finish = (upEvent: PointerEvent) => {
          if (upEvent.pointerId !== pointerId) return;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
          if (!currentPath) return;
          const widths = { ...(kanbanLaneWidths.get(currentPath) || {}) };
          widths[laneKey] = Math.round(colEl.getBoundingClientRect().width);
          kanbanLaneWidths.set(currentPath, widths);
          persistMap(kanbanWidthStorageKey, kanbanLaneWidths);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
      });
      sizer.addEventListener("dblclick", () => {
        colEl.style.flexBasis = "";
        colEl.style.width = "";
        if (!currentPath) return;
        const widths = { ...(kanbanLaneWidths.get(currentPath) || {}) };
        delete widths[laneKey];
        kanbanLaneWidths.set(currentPath, widths);
        persistMap(kanbanWidthStorageKey, kanbanLaneWidths);
      });
      scroller.appendChild(sizer);
    }
  });

  host.appendChild(scroller);
  applyKanbanFind();
  if (kanbanFindOpen) requestAnimationFrame(() => findInput.focus());
}

function openKanbanFind() {
  kanbanFindOpen = true;
  const bar = document.querySelector<HTMLElement>("#kanban .kanban-find");
  if (!bar) {
    if (kanbanBoard) renderKanbanBoard(kanbanBoard);
    return;
  }
  bar.classList.remove("hidden");
  const input = bar.querySelector<HTMLInputElement>(".kanban-find-input");
  input?.focus();
  input?.select();
  applyKanbanFind();
}

function closeKanbanFind() {
  kanbanFindOpen = false;
  kanbanFindQuery = "";
  kanbanFindMatchIndex = 0;
  kanbanExpandedCollapsedLanes.clear();
  document.querySelector<HTMLElement>("#kanban .kanban-find")?.classList.add("hidden");
  const input = document.querySelector<HTMLInputElement>("#kanban .kanban-find-input");
  if (input) input.value = "";
  applyKanbanFind();
}

function applyKanbanFind() {
  if (!kanbanBoard) return;
  const needle = normalizePageFindQuery(kanbanFindQuery);
  const matches: HTMLElement[] = [];
  const lanes = document.querySelectorAll<HTMLElement>("#kanban .kanban-col");
  lanes.forEach((lane, colIdx) => {
    const column = kanbanBoard!.columns[colIdx];
    if (!column) return;
    const result = findInKanbanLane(column, needle);
    lane.querySelectorAll<HTMLElement>(".kanban-card").forEach((card, cardIdx) => {
      const match = result.cardMatches[cardIdx] ?? false;
      card.dataset.searchMatch = match ? "true" : "false";
      card.classList.toggle("kanban-find-match", match);
      card.classList.toggle("kanban-find-dim", needle.length > 0 && !match);
      if (match) matches.push(card);
    });
    const laneKey = lane.dataset.laneKey ?? "";
    const collapsed = result.collapse && !kanbanExpandedCollapsedLanes.has(laneKey);
    lane.classList.toggle("kanban-col-collapsed", collapsed);
    const sizer = lane.nextElementSibling;
    if (sizer instanceof HTMLElement && sizer.classList.contains("kanban-col-sizer")) {
      sizer.classList.toggle("kanban-col-sizer-disabled", collapsed);
      sizer.setAttribute("aria-disabled", collapsed ? "true" : "false");
      sizer.title = collapsed
        ? "Expand the lane before resizing"
        : "Drag to resize lane · double-click to reset";
    }
    lane.classList.toggle("kanban-find-no-match", needle.length > 0 && result.matchingCards === 0);
    const count = lane.querySelector<HTMLElement>(".kanban-count");
    if (count) count.textContent = needle ? `${result.matchingCards}/${column.cards.length}` : String(column.cards.length);
  });
  if (matches.length === 0) kanbanFindMatchIndex = 0;
  else kanbanFindMatchIndex = Math.min(kanbanFindMatchIndex, matches.length - 1);
  matches.forEach((card, index) => card.classList.toggle("kanban-find-current", index === kanbanFindMatchIndex));
  const count = document.querySelector<HTMLElement>("#kanban .kanban-find-count");
  if (count) count.textContent = needle.length === 0
    ? "Type to find"
    : matches.length === 0
      ? "No matches"
      : `${kanbanFindMatchIndex + 1} of ${matches.length}`;
}

function stepKanbanFind(delta: number) {
  const matches = [...document.querySelectorAll<HTMLElement>("#kanban .kanban-card[data-search-match='true']")];
  if (matches.length === 0) return;
  kanbanFindMatchIndex = (kanbanFindMatchIndex + delta + matches.length) % matches.length;
  applyKanbanFind();
  matches[kanbanFindMatchIndex]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function persistKanban() {
  if (!kanbanBoard || !currentPath || !editor) return;
  // Surgical rewrite: only ## columns change; head + settings footer are verbatim.
  const md = serializeKanban(
    kanbanBoard.columns,
    kanbanBoard.settingsBlock,
    undefined,
    kanbanBoard.headBlock,
  );
  kanbanBoard = { ...kanbanBoard, originalSource: md };
  editor.setDoc(md);
  dirty = true;
  updateChrome();
  void saveFile();
}

/** Effective hooks = board footer ∪ vault `.nephrite/kanban-hooks.json`. */
function effectiveKanbanHooks(): KanbanHooksConfig {
  return kanbanBoard?.settings.nephriteHooks || {};
}

/**
 * Card leaving a swim lane (before board rewrite).
 * Settings: `nephrite.hooks.onCardLeave` / `onCardLeaveFile`
 */
async function fireKanbanCardLeft(event: KanbanCardTransitEvent) {
  await hooks.emit(hooks.Events.KanbanCardLeft, event);
  const h = effectiveKanbanHooks();
  // Re-resolve vault config in case footer was wiped
  if (currentPath) {
    const merged = await resolveBoardHooks(currentPath, h);
    if (kanbanBoard) {
      kanbanBoard = {
        ...kanbanBoard,
        settings: { ...kanbanBoard.settings, nephriteHooks: merged },
      };
    }
  }
  const hooksCfg = effectiveKanbanHooks();
  await runBoardHookScripts("leave", event, {
    inline: hooksCfg.onCardLeave,
    file: hooksCfg.onCardLeaveFile,
  });
}

/**
 * Card landed in a swim lane (after board save).
 * Settings: `nephrite.hooks.onCardMove` / `onCardMoveFile`
 * plus vault `.nephrite/kanban-hooks.json` fallback.
 */
async function fireKanbanCardMoved(event: KanbanCardMovedEvent) {
  await hooks.emit(hooks.Events.KanbanCardMoved, event);
  if (currentPath) {
    const merged = await resolveBoardHooks(currentPath, effectiveKanbanHooks());
    if (kanbanBoard) {
      kanbanBoard = {
        ...kanbanBoard,
        settings: { ...kanbanBoard.settings, nephriteHooks: merged },
      };
    }
  }
  const hooksCfg = effectiveKanbanHooks();
  await runBoardHookScripts("land", event, {
    inline: hooksCfg.onCardMove,
    file: hooksCfg.onCardMoveFile,
  });
}

function setHookStatus(msg: string, isError = false) {
  setTransientStatus(msg, isError ? "#e07070" : "#5ecf9a");
  // Always log — DevTools / tauri console
  console[isError ? "error" : "log"]("[nephrite-hook]", msg);
  // Durable log under vault (best-effort)
  void sh(
    `mkdir -p .nephrite && printf '%s\\n' ${shellQuote(`[${new Date().toISOString()}] ${msg}`)} >> .nephrite/hook-log.txt`,
  ).catch(() => {
    /* ignore */
  });
}

function setTransientStatus(msg: string, color: string) {
  const el = document.getElementById("status-hint");
  if (el) {
    if (statusHintTimer != null) {
      window.clearTimeout(statusHintTimer);
    }
    el.textContent = msg;
    el.style.color = color;
    statusHintTimer = window.setTimeout(() => {
      el.textContent = STATUS_HINT;
      el.style.removeProperty("color");
      statusHintTimer = null;
    }, 10_000);
  }
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function runBoardHookScripts(
  kind: "leave" | "land",
  event: KanbanCardTransitEvent,
  src: { inline?: string; file?: string },
) {
  const scripts: { label: string; code: string }[] = [];
  if (src.inline?.trim()) {
    scripts.push({ label: `inline:${kind}`, code: src.inline });
  }
  if (src.file?.trim()) {
    try {
      const file = await invoke<OpenFile>("read_file", {
        path: src.file.trim(),
      });
      let code = file.content;
      const fence = code.match(
        /```(?:js|javascript|nephrite)?\s*\n([\s\S]*?)```/,
      );
      if (fence) code = fence[1];
      scripts.push({ label: src.file.trim(), code });
      setHookStatus(`${kind}: loaded ${src.file.trim()}`);
    } catch (e) {
      const msg = `${kind}: failed to load ${src.file}: ${e}`;
      console.error(msg);
      setHookStatus(msg, true);
    }
  }

  if (scripts.length === 0) {
    setHookStatus(
      `${kind}: no hooks configured (board footer + .nephrite/kanban-hooks.json)`,
      true,
    );
    return;
  }

  for (const { label, code } of scripts) {
    try {
      setHookStatus(`${kind}: running ${label}…`);
      await runKanbanHookScript(code, event, kind);
      setHookStatus(`${kind}: ok ${label}`);
    } catch (e) {
      console.error(`[kanban hook] ${kind}`, e);
      const errMsg = e instanceof Error ? e.message : String(e);
      setHookStatus(`${kind} FAILED (${label}): ${errMsg}`, true);
      const host = document.getElementById("kanban");
      if (host) {
        let err = host.querySelector(".kanban-hook-error") as HTMLElement | null;
        if (!err) {
          err = document.createElement("div");
          err.className = "kanban-hook-error";
          host.prepend(err);
        }
        err.textContent = `Kanban ${kind} hook error: ${errMsg}`;
      }
    }
  }
}

/** Run board hook JS with `event` + `$()` shell expansion (async allowed). */
async function runKanbanHookScript(
  code: string,
  event: KanbanCardTransitEvent,
  kind: "leave" | "land",
): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  const tag = kind === "leave" ? "kanban:onCardLeave" : "kanban:onCardMove";
  const api = {
    event,
    phase: kind,
    open: (path: string) => void openNote(path),
    openLink: (target: string) => void openWikilink(target),
    log: (...args: unknown[]) => console.log(`[${tag}]`, ...args),
    invoke: <T>(cmd: string, args?: Record<string, unknown>) =>
      invoke<T>(cmd, args),
    $: sh,
    $$: shFull,
    shell,
  };

  const fn = new AsyncFunction(
    "event",
    "phase",
    "api",
    "open",
    "openLink",
    "log",
    "invoke",
    "$",
    "$$",
    "shell",
    `"use strict";\n${code}`,
  );
  await fn(
    event,
    kind,
    api,
    api.open,
    api.openLink,
    api.log,
    api.invoke,
    sh,
    shFull,
    shell,
  );
}

function updateChrome() {
  const save = $("btn-save") as HTMLButtonElement;
  save.disabled = !currentPath || !dirty;
  const tab = $("tab");
  if (!currentPath) {
    tab.textContent = "Open a Markdown file";
    $("status-path").textContent = "—";
  } else {
    tab.textContent = dirty ? `${currentPath} •` : currentPath;
    $("status-path").textContent = currentPath;
  }
  const hasVault = mdFiles.length > 0 || !!localStorage.getItem(LAST_VAULT_KEY);
  ($("btn-refresh") as HTMLButtonElement).disabled = !vaultOpen || refreshInProgress;
  ($("btn-today") as HTMLButtonElement).disabled = !hasVault && mdFiles.length === 0;
  ($("btn-today-side") as HTMLButtonElement).disabled = mdFiles.length === 0;
  ($("btn-drawing") as HTMLButtonElement).disabled = !hasVault;
  ($("btn-canvas") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-search") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-graph") as HTMLButtonElement).disabled = !hasVault;
  ($("btn-template") as HTMLButtonElement).disabled = !hasVault || currentFileKind !== "markdown" || !currentPath;
  ($("activity-tasks") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-bookmarks") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-git") as HTMLButtonElement).disabled = !hasVault;
  updateVimPowerline();
}

function updateVimPowerline() {
  vimPowerline?.update({
    enabled: vimOn,
    path: currentPath,
    line: statusLine,
    column: statusColumn,
    dirty,
  });
}

async function openVault() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Obsidian vault / folder",
  });
  if (!selected || Array.isArray(selected)) return;
  await openVaultPath(selected as string);
}

async function openVaultPath(path: string) {
  if (dirty && currentPath) {
    await saveFile(true);
    if (dirty) {
      const proceed = confirm(`Automatic save of ${currentPath} failed. Open another vault anyway?`);
      if (!proceed) return;
    }
  }
  rememberPropertiesFoldState($("preview"));
  rememberEditorFolds();
  const previousRightBody = document.getElementById("right-body");
  if (previousRightBody) rememberPropertiesFoldState(previousRightBody);
  propertiesFoldState.clear();
  propertiesFoldStorageKey = null;
  delete $("preview").dataset.propertiesPath;
  if (previousRightBody) delete previousRightBody.dataset.propertiesPath;
  let plan: VaultOpenPlan = { rebuild: false, action: "Checking the vault index…" };
  try {
    plan = await invoke<VaultOpenPlan>("vault_open_plan", { path });
  } catch {
    /* open_vault will provide the authoritative path error. */
  }
  $("vault-label").textContent = plan.rebuild ? "Rebuilding index…" : "Indexing…";
  $("index-stats").textContent = "Large vaults can take a minute on first open";
  showIndexProgress(plan.action);
  // Let WebKit paint the progress UI before the synchronous index command starts.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  let info: VaultInfo;
  try {
    info = await invoke<VaultInfo>("open_vault", { path });
  } finally {
    hideIndexProgress();
  }
  loadPropertiesFoldState(info.root);
  loadPageState(info.root);
  vaultOpen = true;
  localStorage.setItem(LAST_VAULT_KEY, path);
  $("vault-label").textContent = info.root;
  $("index-stats").textContent =
    `v${info.project_version} · ${info.file_count} files · ${info.task_count} tasks` +
    (info.full_rebuild ? " · rebuilt" : ` · Δ+${info.updated}/−${info.removed}`);

  currentPath = null;
  currentFileKind = "markdown";
  drawingContent = "";
  drawingDocument = null;
  canvasContent = "";
  dirty = false;
  openTabs = [];
  rightPath = null;
  editor?.setDoc("");
  excalidrawView?.clear();
  canvasView?.clear();
  showDrawingWorkspace(false);
  showCanvasWorkspace(false);
  updateChrome();
  renderTabBar();
  await refreshTree();
  await reloadPlugins(info.root);
  await reloadAutomations();
  // Restore tabs + active note + right pane from last session for this vault.
  await restoreSession(path);
  await runAutomationLifecycle("onVaultOpen");
}

function showIndexProgress(action: string) {
  $("index-action").textContent = action;
  const bar = $("index-progress").querySelector("progress");
  bar?.removeAttribute("value");
  $("index-progress").classList.remove("hidden");
  $("status-hint").textContent = action;
}

function hideIndexProgress() {
  $("index-progress").classList.add("hidden");
  $("status-hint").textContent = STATUS_HINT;
}

async function refreshTree() {
  const files = await invoke<FileEntry[]>("list_files");
  vaultFilesAll = files.sort((a, b) => a.path.localeCompare(b.path));
  mdFilesAll = vaultFilesAll
    .filter((f) => f.file_kind === "markdown" || f.file_kind === "excalidraw" || f.file_kind === "canvas")
    .sort((a, b) => a.path.localeCompare(b.path));
  editor?.setCompletionFiles(mdFilesAll);
  rebuildVisibleTree();
  renderFileFilterPopout();
  updateChrome();
}

function setSidebarCollapsed(collapsed: boolean, remember = true) {
  sidebarCollapsed = collapsed;
  if (remember) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  const sidebar = $("sidebar");
  sidebar.classList.toggle("collapsed", collapsed);
  setActiveActivity(collapsed ? null : "files");
  renderFileFilterPopout();
}

function renderFileFilterPopout() {
  const popout = document.getElementById("file-filter-popout");
  if (!popout) return;
  popout.innerHTML = "";
  if (!sidebarCollapsed || !filterQuery) {
    popout.classList.add("hidden");
    return;
  }
  const matches = mdFiles
    .filter((file) => file.path.toLowerCase().includes(filterQuery))
    .slice(0, 100);
  if (matches.length === 0) {
    popout.innerHTML = `<div class="file-filter-empty">No matches.</div>`;
  } else {
    for (const file of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-filter-match";
      button.textContent = file.path.replace(/\.md$/i, "");
      button.title = file.path;
      button.addEventListener("click", () => void selectFileFilterMatch(file.path));
      popout.appendChild(button);
    }
  }
  popout.classList.remove("hidden");
}

async function selectFileFilterMatch(path: string) {
  const input = document.getElementById("file-filter") as HTMLInputElement | null;
  if (input) input.value = "";
  filterQuery = "";
  renderTree();
  renderFileFilterPopout();

  await openNote(path);
  focusActiveDocumentPane();
}

async function openVaultEntry(path: string) {
  const entry = vaultFilesAll.find((file) => file.path === path);
  if (!entry || isDocumentEntry(entry)) {
    await openNote(path);
  } else {
    await invoke("open_with_default_app", { path });
  }
}

function isDocumentEntry(entry: FileEntry): boolean {
  return ["markdown", "excalidraw", "canvas"].includes(entry.file_kind);
}

function focusActiveDocumentPane() {
  if (currentFileKind === "excalidraw") {
    document.getElementById("excalidraw-host")?.focus();
  } else if (currentFileKind === "canvas") {
    document.getElementById("canvas-host")?.focus();
  } else if (viewMode === "preview") {
    document.getElementById("preview-host")?.focus();
  } else {
    editor?.focus();
  }
}

async function installVaultChangeListener() {
  await Promise.all([
    listen<VaultChangeEvent>("vault-index-changed", (event) => {
      vaultChangeQueue = vaultChangeQueue
        .then(() => applyVaultChange(event.payload, false))
        .catch((error) => console.warn("[vault tracker]", error));
    }),
    listen<VaultOpenProgress>("vault-open-progress", (event) => {
      updateIndexProgress(event.payload);
    }),
  ]);
}

function updateIndexProgress(progress: VaultOpenProgress) {
  const bar = $("index-progress").querySelector("progress") as HTMLProgressElement | null;
  const phase = progress.phase === "scan"
    ? "Scanning vault"
    : progress.phase === "index"
      ? "Indexing vault"
      : "Resolving links";
  const count = progress.total > 0 ? ` ${progress.done}/${progress.total}` : "";
  const path = progress.path ? ` · ${progress.path}` : "";
  const message = `${phase}${count}${path}`;
  $("index-action").textContent = message;
  $("status-hint").textContent = message;
  if (bar) {
    if (progress.total > 0) {
      bar.max = progress.total;
      bar.value = Math.min(progress.done, progress.total);
    } else {
      bar.removeAttribute("value");
    }
  }
}

async function forceVaultRefresh() {
  if (!vaultOpen || refreshInProgress) return;
  refreshInProgress = true;
  updateChrome();
  const button = $("btn-refresh");
  const label = button.querySelector("span");
  if (label) label.textContent = "Rescanning…";
  showIndexProgress("Reconciling the vault with files on disk…");
  try {
    const change = await invoke<VaultChangeEvent>("refresh_vault");
    await applyVaultChange(change, true);
  } catch (error) {
    setTransientStatus(`Vault refresh failed: ${String(error)}`, "#e9ad55");
  } finally {
    hideIndexProgress();
    if (label) label.textContent = "Rescan Vault";
    refreshInProgress = false;
    updateChrome();
  }
}

async function applyVaultChange(change: VaultChangeEvent, manual: boolean) {
  if (vaultChangeTouchesFileTree(change, mdFilesAll.map((file) => file.path))) {
    await refreshTree();
  }
  const changed = new Set(change.paths);

  if (currentPath && changed.has(currentPath)) {
    if (change.removed > 0 && !pathExistsInIndex(currentPath)) {
      if (dirty) {
        setTransientStatus(
          `${currentPath} was deleted externally; the unsaved editor was left intact`,
          "#e9ad55",
        );
      } else {
        const removedPath = currentPath;
        openTabs = openTabs.filter((path) => path !== removedPath);
        currentPath = null;
        editor?.setDoc("");
        renderTabBar();
        updateChrome();
        setTransientStatus(`${removedPath} was deleted externally`, "#e9ad55");
      }
    } else if (dirty) {
      setTransientStatus(
        `${currentPath} changed externally; your unsaved editor was not overwritten`,
        "#e9ad55",
      );
    } else if (currentFileKind === "markdown") {
      const file = await invoke<OpenFile>("read_file", { path: currentPath });
      // Nephrite's own save returns through the watcher too. Do not replace
      // the complete CodeMirror document when the bytes are already current.
      if (editor && file.content !== editor.getDoc()) editor.reloadDoc(file.content);
    } else {
      await openNote(currentPath, { skipDirtyPrompt: true });
    }
  } else if (currentPath && currentFileKind === "markdown" &&
      (viewMode === "split" || viewMode === "preview")) {
    // SQL and Dataview results may depend on any page in the vault.
    // Do not invalidate a query already rendering. External scripts can update
    // the vault continuously; cancelling on every watcher event can otherwise
    // leave executable fences permanently unrendered. Coalesce those events
    // into one follow-up render after the active pass completes.
    if (vaultPreviewRefresh.request()) scheduleEditorPreview();
  }

  if (rightPath && changed.has(rightPath)) await updateRightPane();
  const info = await invoke<VaultInfo>("vault_stats");
  $("index-stats").textContent =
    `v${info.project_version} · ${info.file_count} files · ${info.task_count} tasks`;

  const total = change.updated + change.removed;
  if (manual) {
    setTransientStatus(
      total === 0 ? "Vault index is already current" :
        `Vault refreshed: ${change.updated} updated, ${change.removed} removed`,
      "#5ecf9a",
    );
  } else {
    setTransientStatus(
      `External changes indexed: ${change.updated} updated, ${change.removed} removed`,
      "#5ecf9a",
    );
  }
}

function rebuildVisibleTree() {
  mdFiles = visibleFiles(vaultFilesAll, showDotfiles);
  treeRoot = buildTree(mdFiles);
  renderTree();
}

function renderTree() {
  const host = $("file-tree");
  host.innerHTML = "";

  host.oncontextmenu = (e) => {
    // Empty area of tree → vault-root context
    if (e.target === host) {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, { kind: "empty", path: "" }, handleCtxAction);
    }
  };

  if (mdFiles.length === 0) {
    host.innerHTML = `<div class="empty">Open a vault to browse notes.</div>`;
    return;
  }

  const view = filterQuery ? filterTree(treeRoot, filterQuery) : treeRoot;
  if (view.children.length === 0) {
    host.innerHTML = `<div class="empty">No matches.</div>`;
    return;
  }

  // Filter temporarily reveals matching branches only (does not change saved roll-up state).
  const revealForFilter = !!filterQuery;
  const frag = document.createDocumentFragment();
  for (const child of view.children) {
    frag.appendChild(renderNode(child, 0, revealForFilter));
  }
  host.appendChild(frag);
}

function bindCtx(el: HTMLElement, target: CtxTarget) {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, target, handleCtxAction);
  });
}

function renderNode(node: TreeNode, depth: number, revealForFilter: boolean): HTMLElement {
  if (node.kind === "file") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tree-file" + (node.path === currentPath ? " active" : "");
    btn.style.paddingLeft = `${10 + depth * 14}px`;
    btn.textContent = node.name.replace(/\.md$/i, "");
    btn.title = node.path;
    btn.dataset.path = node.path;
    btn.addEventListener("click", () => void openVaultEntry(node.path));
    bindCtx(btn, { kind: "file", path: node.path });
    return btn;
  }

  const wrap = document.createElement("div");
  wrap.className = "tree-dir";
  // Open only if user expanded it (or filter is temporarily revealing matches).
  const isOpen = revealForFilter || expanded.has(node.path);

  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-folder" + (isOpen ? " open" : "");
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.setAttribute("aria-expanded", isOpen ? "true" : "false");
  row.innerHTML = `<span class="twist">${isOpen ? "▾" : "▸"}</span><span class="fname">${escapeHtml(node.name || "/")}</span>`;
  row.title = node.path || "(vault root)";
  row.addEventListener("click", (e) => {
    e.preventDefault();
    if (expanded.has(node.path)) expanded.delete(node.path);
    else expanded.add(node.path);
    saveExpanded();
    renderTree();
  });
  bindCtx(row, { kind: "folder", path: node.path });
  wrap.appendChild(row);

  if (isOpen) {
    const kids = document.createElement("div");
    kids.className = "tree-children";
    for (const c of node.children) {
      kids.appendChild(renderNode(c, depth + 1, revealForFilter));
    }
    wrap.appendChild(kids);
  }
  return wrap;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Serializes openNote so tab clicks cannot interleave read/setDoc/save. */
let openNoteChain: Promise<void> = Promise.resolve();
let openNoteGeneration = 0;

async function openNote(
  path: string,
  opts?: { skipDirtyPrompt?: boolean; fromSession?: boolean },
) {
  const run = openNoteChain.then(() => openNoteSerialized(path, opts));
  openNoteChain = run.catch((error) => {
    console.error("[openNote]", error);
  });
  return run;
}

async function openNoteSerialized(
  path: string,
  opts?: { skipDirtyPrompt?: boolean; fromSession?: boolean },
) {
  dismissLinkPreview();
  dismissKanbanCardPreview();
  // Cancel pending autosave before any await so it cannot fire mid-switch.
  if (autosaveTimer != null) {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  if (!opts?.skipDirtyPrompt && dirty && currentPath) {
    const savingPath = currentPath;
    await saveFile(true);
    if (dirty && currentPath === savingPath) {
      const discard = confirm(`Automatic save of ${savingPath} failed. Discard changes?`);
      if (!discard) return;
      dirty = false;
    }
  }
  rememberEditorFolds();
  const generation = ++openNoteGeneration;
  const file = await invoke<OpenFile>("read_file", { path });
  // A newer openNote won the race — do not clobber editor/path.
  if (generation !== openNoteGeneration) return;
  currentPath = file.path;
  currentFileKind = mdFilesAll.find((entry) => entry.path === file.path)?.file_kind ??
    (file.path.toLowerCase().endsWith(".excalidraw") ? "excalidraw" :
      file.path.toLowerCase().endsWith(".canvas") ? "canvas" : "markdown");
  if (currentFileKind === "markdown" && isObsidianExcalidrawMarkdown(file.content)) {
    currentFileKind = "excalidraw";
  }
  if (currentFileKind === "markdown") {
    viewMode = pageViewModes.get(file.path) ?? normalizeMode(localStorage.getItem(VIEW_KEY));
    syncModeButtons();
    applyViewMode();
  }
  dirty = false;
  // Track in open-file set (session restore + tab bar)
  if (!openTabs.includes(file.path)) {
    openTabs.push(file.path);
  }
  if (currentFileKind === "excalidraw") {
    canvasContent = "";
    canvasView?.clear();
    showCanvasWorkspace(false);
    drawingContent = file.content;
    showDrawingWorkspace(true);
    try {
      drawingDocument = parseExcalidrawDocument(file.path, file.content);
      const drawingView = await ensureExcalidrawView();
      if (generation !== openNoteGeneration) return;
      drawingView.open(file.path, drawingDocument.scene, (scene) => {
        if (currentPath !== file.path || currentFileKind !== "excalidraw") return;
        drawingContent = drawingDocument?.serialize(scene) ?? scene;
        dirty = true;
        updateChrome();
        scheduleAutosave();
      });
    } catch (error) {
      showDrawingWorkspace(false);
      currentFileKind = "markdown";
      editor?.setDoc(file.content);
      alert(`Could not open Excalidraw drawing: ${String(error)}`);
    }
  } else if (currentFileKind === "canvas") {
    drawingContent = "";
    drawingDocument = null;
    excalidrawView?.clear();
    showDrawingWorkspace(false);
    canvasContent = file.content;
    showCanvasWorkspace(true);
    try {
      canvasView?.open(file.content);
    } catch (error) {
      setTransientStatus(`Invalid canvas: ${String(error)}`, "#e07070");
    }
  } else {
    drawingContent = "";
    drawingDocument = null;
    excalidrawView?.clear();
    showDrawingWorkspace(false);
    showCanvasWorkspace(false);
    canvasContent = "";
    canvasView?.clear();
    // Full vault file into the editor — frontmatter, --- fences, Dataview, everything.
    editor?.setDoc(file.content);
    restoreEditorFolds(file.path);
    if (viewMode !== "preview") editor?.focus();
  }
  // Opening a note peels open only its ancestor folders (and remembers that).
  const parts = path.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    expanded.add(acc);
  }
  saveExpanded();
  updateChrome();
  renderTree();
  renderTabBar();
  if (currentFileKind === "markdown") schedulePreview(file.content);
  saveSession();
  await runAutomationLifecycle("onNoteOpen");
}

function showDrawingWorkspace(active: boolean) {
  $("panes").classList.toggle("drawing-active", active);
  $("excalidraw-host").classList.toggle("hidden", !active);
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((button) => {
    button.disabled = active;
  });
  clearScrollSync();
}

function showCanvasWorkspace(active: boolean) {
  $("panes").classList.toggle("canvas-active", active);
  $("canvas-workspace").classList.toggle("hidden", !active);
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((button) => {
    button.disabled = active;
  });
  if (active) clearScrollSync();
}

async function ensureExcalidrawView() {
  if (excalidrawView) return excalidrawView;
  $("excalidraw-host").innerHTML = `<div class="feature-loading excalidraw-loading">Loading Excalidraw…</div>`;
  const { ExcalidrawView } = await import("./excalidraw-view");
  excalidrawView = new ExcalidrawView($("excalidraw-host"));
  return excalidrawView;
}

async function openToday() {
  if (mdFiles.length === 0) {
    alert("Open a vault first.");
    return;
  }
  let path = findTodayJournal(mdFiles);
  if (!path) {
    path = defaultTodayJournalPath();
    const create = confirm(
      `No journal for today found.\nCreate ${path}?`,
    );
    if (!create) return;
    const y = new Date().toISOString().slice(0, 10);
    const stub =
      `---\n` +
      `title: Personal Journal\n` +
      `date: ${y}\n` +
      `tags:\n` +
      `  - journal\n` +
      `---\n\n`;
    await invoke("write_file", { path, content: stub });
    await refreshTree();
  }
  await openNote(path);
}

async function openWikilink(target: string) {
  const { note, heading, block } = splitWikilinkTarget(target);
  if (!note && !heading && !block) return;
  try {
    // Same-note fragment link: [[#Heading]] / [[#^block]] — do not reload (setDoc resets caret).
    if (!note && (heading || block) && currentPath) {
      jumpToWikilinkFragment(heading, block);
      return;
    }

    const resolved = note
      ? await invoke<string | null>("resolve_wikilink", {
          target: note,
          fromPath: currentPath,
        })
      : currentPath;

    if (resolved) {
      if (resolved === currentPath) {
        jumpToWikilinkFragment(heading, block);
        return;
      }
      await openNote(resolved);
      // Defer past openNote's setDoc/focus/preview so the caret sticks.
      requestAnimationFrame(() => jumpToWikilinkFragment(heading, block));
      return;
    }
    // Missing target: create the note (wiki click-to-create) and open it.
    if (!note) {
      alert(`Could not resolve [[${target}]]`);
      return;
    }
    const path = pathForNewWikilink(note);
    const title = path
      .replace(/\.md$/i, "")
      .split("/")
      .pop() || "Untitled";
    const content = `# ${title}

`;
    try {
      await invoke("create_file", { path, content });
    } catch (createErr) {
      // If the file appeared between resolve and create, open it.
      const message = createErr instanceof Error ? createErr.message : String(createErr);
      if (!/already exists|exists/i.test(message)) {
        throw createErr;
      }
    }
    await refreshTree();
    await openNote(path);
    requestAnimationFrame(() => jumpToWikilinkFragment(heading, block));
  } catch (e) {
    alert(String(e));
  }
}

/** Vault-relative path for a missing wikilink target (Obsidian-style). */
function pathForNewWikilink(note: string): string {
  let key = note.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!key) key = "Untitled";
  // Strip accidental .md for title handling; re-add below.
  const hasExt = /\.md$/i.test(key);
  if (!hasExt) key = `${key}.md`;
  // Path-like targets are vault-relative.
  if (key.includes("/")) return key;
  // Bare names land next to the current note when possible.
  if (currentPath && currentPath.includes("/")) {
    const dir = currentPath.slice(0, currentPath.lastIndexOf("/"));
    return `${dir}/${key}`;
  }
  return key;
}

function jumpToWikilinkFragment(
  heading: string | null,
  block: string | null,
) {
  if (currentFileKind !== "markdown") return;

  const edScroll = editor?.scrollElement() ?? null;
  const previewHost = document.getElementById("preview-host");

  const applyEditor = () => {
    if (!editor) return;
    const doc = editor.getDoc();
    if (heading) {
      const line = findMarkdownHeadingLine(doc, heading);
      if (line != null) editor.goToLine(line);
    } else if (block) {
      const line = findMarkdownBlockLine(doc, block);
      if (line != null) editor.goToLine(line);
    }
  };

  const applyPreview = () => {
    // Element-based scroll on #preview-host (not ratio sync — different content height).
    if (heading) scrollPreviewToHeading(heading);
    else if (block) scrollPreviewToBlock(block);
  };

  // Editor jump under suppress so goToLine does not schedule ratio sync unchecked.
  if (edScroll) withoutScrollSync(edScroll, applyEditor);
  else applyEditor();

  // Preview: set scrollTop now, then again after cursor-sync delay so we win the race.
  const runPreview = () => {
    if (previewHost) withoutScrollSync(previewHost, applyPreview);
    else applyPreview();
  };
  runPreview();
  window.setTimeout(runPreview, CURSOR_SYNC_DELAY_MS + 30);
  window.setTimeout(runPreview, CURSOR_SYNC_DELAY_MS + 100);
}

/**
 * Scroll `#preview-host` so `el` sits ~35% from the top (readable, not edge-clipped).
 * Uses scrollTop math against the real scroller — not scrollIntoView (wrong ancestor / sync fights).
 */
function scrollChildIntoPreviewHost(host: HTMLElement, el: HTMLElement) {
  const hostRect = host.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const delta = elRect.top - hostRect.top;
  const next = host.scrollTop + delta - host.clientHeight * 0.35;
  const max = Math.max(0, host.scrollHeight - host.clientHeight);
  host.scrollTop = Math.max(0, Math.min(next, max));
}

/** Scroll preview pane to an ATX heading by visible text. */
function scrollPreviewToHeading(heading: string) {
  const host = document.getElementById("preview-host");
  if (!host) return;
  const want = normalizeHeadingKey(heading);
  if (!want) return;
  const headings = host.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6");
  for (const el of headings) {
    if (normalizeHeadingKey(el.textContent || "") === want) {
      scrollChildIntoPreviewHost(host, el);
      return;
    }
  }
  const slug = want.replace(/\s+/g, "-");
  const byId =
    host.querySelector<HTMLElement>(`#${cssEscape(slug)}`) ||
    host.querySelector<HTMLElement>(`[id^="${cssEscape(slug)}"]`);
  if (byId) scrollChildIntoPreviewHost(host, byId);
}

function scrollPreviewToBlock(blockId: string) {
  const host = document.getElementById("preview-host");
  if (!host) return;
  const want = blockId.trim().toLowerCase();
  if (!want) return;
  const byId =
    host.querySelector<HTMLElement>(`#${cssEscape(want)}`) ||
    host.querySelector<HTMLElement>(`#user-content-${cssEscape(want)}`) ||
    host.querySelector<HTMLElement>(`[id*="${cssEscape(want)}"]`);
  if (byId) {
    scrollChildIntoPreviewHost(host, byId);
    return;
  }
  for (const el of host.querySelectorAll<HTMLElement>("p, li, blockquote, h1, h2, h3, h4, h5, h6")) {
    if ((el.textContent || "").toLowerCase().includes("^" + want)) {
      scrollChildIntoPreviewHost(host, el);
      return;
    }
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** 1-based line of an ATX heading matching `heading`. */
function findMarkdownHeadingLine(doc: string, heading: string): number | null {
  const want = normalizeHeadingKey(heading);
  if (!want) return null;
  const lines = doc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (normalizeHeadingKey(m[2]) === want) return i + 1;
  }
  return null;
}

/** 1-based line of a `^block` marker. */
function findMarkdownBlockLine(doc: string, blockId: string): number | null {
  const want = blockId.trim().toLowerCase();
  if (!want) return null;
  const lines = doc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes("^" + want)) return i + 1;
  }
  return null;
}

function normalizeHeadingKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gi, "")
    .replace(/\s+/g, " ");
}

function scheduleAutosave() {
  if (!dirty || !editor || !currentPath) return;
  if (autosaveTimer != null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null;
    void saveFile(true);
  }, AUTOSAVE_DELAY_MS);
}

type PendingSave = {
  path: string;
  kind: string;
  content: string;
  documentRevision: number | null;
  automatic: boolean;
};

function saveFile(automatic = false): Promise<void> {
  if (autosaveTimer != null) {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  // Snapshot identity + body NOW — never re-read currentPath/editor after await,
  // or a tab switch can write journal text into another note.
  if (!currentPath) return Promise.resolve();
  if (currentFileKind === "markdown" && !editor) return Promise.resolve();
  const pending: PendingSave = {
    path: currentPath,
    kind: currentFileKind,
    content:
      currentFileKind === "excalidraw"
        ? drawingContent
        : currentFileKind === "canvas"
          ? canvasContent
          : editor!.getDoc(),
    documentRevision:
      currentFileKind === "markdown" ? editor!.getDocumentRevision() : null,
    automatic,
  };
  const operation = saveQueue.then(() => performSave(pending));
  saveQueue = operation.catch((error) => {
    console.error("[save queue]", error);
  });
  return operation;
}

async function performSave(pending: PendingSave) {
  const { path, kind, content, documentRevision, automatic } = pending;
  try {
    await invoke("write_file", { path, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setTransientStatus(`Save failed: ${message}`, "#e07070");
    console.error("[save] failed", error);
    if (!automatic) window.alert(`Save failed: ${message}`);
    return;
  }
  const unchanged =
    currentPath === path &&
    currentFileKind === kind &&
    (kind === "excalidraw"
      ? drawingContent === content
      : kind === "canvas"
        ? canvasContent === content
        : editor?.getDocumentRevision() === documentRevision);
  if (unchanged) dirty = false;
  updateChrome();
  await runAutomationLifecycle("onNoteSave");
  if (!automatic) setTransientStatus(`Saved ${path}`, "#5ecf9a");
  if (!unchanged) scheduleAutosave();
  if (automatic) return;
  try {
    const info = await invoke<VaultInfo>("vault_stats");
    $("index-stats").textContent =
      `v${info.project_version} · ${info.file_count} files · ${info.task_count} tasks`;
  } catch {
    /* File was saved; stale aggregate stats are non-fatal. */
  }
}

function openFeaturePanel(title: string): HTMLElement {
  closePreferences();
  const activityByTitle: Partial<Record<string, ActivityId>> = {
    Bookmarks: "bookmarks",
    "Query rendering log": "query-log",
    "Search vault contents": "search",
    "Vault graph": "graph",
    Tasks: "tasks",
    Git: "git",
  };
  const activity = activityByTitle[title];
  if (activity) setActiveActivity(activity);
  $("feature-title").textContent = title;
  const body = $("feature-body");
  body.className = "feature-body";
  body.replaceChildren();
  $("feature-panel").classList.remove("hidden");
  return body;
}

function closeFeaturePanel() {
  $("feature-panel").classList.add("hidden");
  $("feature-body").replaceChildren();
  setActiveActivity(sidebarCollapsed ? null : "files");
}

function showBookmarksPanel() {
  const body = openFeaturePanel("Bookmarks");
  const bookmarks = loadBookmarks();
  if (bookmarks.length === 0) {
    body.innerHTML = `<div class="empty">No bookmarks yet. Right-click a file or folder and choose Bookmark.</div>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "bookmark-list";
  for (const path of bookmarks) {
    const row = document.createElement("div");
    row.className = "bookmark-row";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "bookmark-open";
    openButton.textContent = path;
    openButton.title = path;
    openButton.addEventListener("click", () => {
      const file = mdFilesAll.find((entry) => entry.path === path);
      if (file) {
        closeFeaturePanel();
        void openNote(path);
        return;
      }
      const folder = path === "(vault root)" ? "" : path;
      const input = $("file-filter") as HTMLInputElement;
      filterQuery = folder ? `${folder.toLowerCase()}/` : "";
      input.value = folder ? `${folder}/` : "";
      if (folder) expanded.add(folder);
      saveExpanded();
      renderTree();
      closeFeaturePanel();
    });
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "bookmark-remove";
    removeButton.textContent = "×";
    removeButton.title = `Remove ${path}`;
    removeButton.addEventListener("click", () => {
      saveBookmarks(loadBookmarks().filter((bookmark) => bookmark !== path));
      showBookmarksPanel();
    });
    row.append(openButton, removeButton);
    list.appendChild(row);
  }
  body.appendChild(list);
}

function showQueryLogPanel() {
  const body = openFeaturePanel("Query rendering log");
  const controls = document.createElement("div");
  controls.className = "query-log-controls";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy log";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(queryDiagnosticText());
    setTransientStatus("Query log copied", "#5ecf9a");
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => {
    clearQueryDiagnostics();
    showQueryLogPanel();
  });
  controls.append(copy, clear);
  const log = document.createElement("pre");
  log.className = "query-log";
  log.textContent = queryDiagnosticText();
  body.append(controls, log);
}

function appendSearchSnippet(host: HTMLElement, snippet: string) {
  const parts = snippet.split(/(\[\[HIT\]\]|\[\[\/HIT\]\])/);
  let highlighted = false;
  for (const part of parts) {
    if (part === "[[HIT]]") {
      highlighted = true;
    } else if (part === "[[/HIT]]") {
      highlighted = false;
    } else if (part) {
      const node = highlighted ? document.createElement("mark") : document.createTextNode(part);
      if (node instanceof HTMLElement) node.textContent = part;
      host.appendChild(node);
    }
  }
}

async function showSearchPanel() {
  const body = openFeaturePanel("Search vault contents");
  const controls = document.createElement("div");
  controls.className = "vault-search-controls";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Words in notes, YAML properties, headings, tags, or canvases…";
  input.autocomplete = "off";
  input.spellcheck = false;
  const count = document.createElement("span");
  controls.append(input, count);
  const results = document.createElement("div");
  results.className = "vault-search-results";
  body.append(controls, results);
  let revision = 0;
  const search = async () => {
    const current = ++revision;
    const query = input.value.trim();
    if (!query) {
      count.textContent = "";
      results.innerHTML = `<div class="feature-empty">Searches indexed vault contents, not only filenames.</div>`;
      return;
    }
    results.innerHTML = `<div class="feature-loading">Searching…</div>`;
    try {
      const matches = await invoke<SearchResult[]>("search_vault", { query, limit: 120 });
      if (current !== revision) return;
      results.replaceChildren();
      count.textContent = `${matches.length} result${matches.length === 1 ? "" : "s"}`;
      if (!matches.length) results.innerHTML = `<div class="feature-empty">No content matches.</div>`;
      for (const match of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "vault-search-result";
        const title = document.createElement("strong");
        title.textContent = match.title;
        const path = document.createElement("small");
        path.textContent = `${match.path}${match.line ? `:${match.line}` : ""}`;
        const snippet = document.createElement("span");
        appendSearchSnippet(snippet, match.snippet);
        button.append(title, path, snippet);
        button.addEventListener("click", () => void (async () => {
          closeFeaturePanel();
          await openNote(match.path);
          if (match.line && currentFileKind === "markdown") editor?.goToLine(match.line);
        })());
        results.appendChild(button);
      }
    } catch (error) {
      if (current === revision) results.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
    }
  };
  let timer: number | null = null;
  input.addEventListener("input", () => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => void search(), 140);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void search();
  });
  requestAnimationFrame(() => input.focus());
  void search();
}

async function showGraphPanel() {
  const body = openFeaturePanel("Vault graph");
  body.classList.add("graph-panel-body");
  body.innerHTML = `<div class="feature-loading">Loading indexed links…</div>`;
  try {
    const graph = await invoke<GraphData>("graph_data");
    renderGraph(body, graph, (path) => {
      closeFeaturePanel();
      void openNote(path);
    }, currentFileKind === "markdown" ? currentPath : null);
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

function shellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function reloadPlugins(vaultRoot?: string) {
  if (!pluginManager || !vaultOpen) return;
  const root = vaultRoot ?? localStorage.getItem(LAST_VAULT_KEY) ?? "vault";
  try {
    const descriptors = await invoke<PluginDescriptor[]>("list_plugins");
    await pluginManager.load(descriptors, root);
    renderPreferencesPlugins();
  } catch (error) {
    setTransientStatus(`Plugin loader: ${String(error)}`, "#e9ad55");
  }
}

const AUTOMATION_CONFIG_PATH = ".nephrite/automations.json";

async function reloadAutomations(report = false) {
  automationConfig = null;
  try {
    const file = await invoke<OpenFile>("read_file", { path: AUTOMATION_CONFIG_PATH });
    automationConfig = validateAutomationConfig(JSON.parse(file.content));
    for (const command of automationConfig.commands) {
      if (command.shortcut && !shortcuts.get(`automation:${command.id}`)) {
        shortcuts.set(`automation:${command.id}`, command.shortcut);
      }
    }
    if (report) setTransientStatus(`Loaded ${automationConfig.commands.length} automation commands`, "#5ecf9a");
  } catch (error) {
    if (report) setTransientStatus(`Automation configuration: ${String(error)}`, "#e9ad55");
  }
  renderAutomationPreferences();
}

function renderAutomationPreferences() {
  const status = document.getElementById("preferences-automation-status");
  if (!status) return;
  status.textContent = automationConfig
    ? `${automationConfig.commands.length} named command${automationConfig.commands.length === 1 ? "" : "s"} loaded.`
    : `No valid ${AUTOMATION_CONFIG_PATH} found.`;
}

async function createExampleAutomationConfig() {
  if (!vaultOpen) return;
  const example: AutomationConfig = {
    version: 1,
    functions: { captureLine: "- {{time}} {{value}}" },
    commands: [{
      id: "quick-capture",
      name: "Quick capture to inbox",
      description: "Prompt for text and append it to Inbox.md",
      shortcut: "Mod+Shift+C",
      prompts: [{ name: "value", label: "Capture" }],
      actions: [
        { type: "append", path: "Inbox.md", content: "{{function:captureLine}}\n" },
        { type: "open", path: "Inbox.md" },
      ],
    }],
    lifecycle: {},
  };
  try {
    await invoke("create_file", { path: AUTOMATION_CONFIG_PATH, content: `${JSON.stringify(example, null, 2)}\n` });
    await reloadAutomations(true);
  } catch (error) {
    setTransientStatus(String(error), "#e9ad55");
  }
}

async function runAutomationLifecycle(event: "onVaultOpen" | "onNoteOpen" | "onNoteSave") {
  const ids = automationConfig?.lifecycle?.[event] ?? [];
  for (const id of ids) await executeAutomation(id, true).catch((error) => console.error(`[automation] ${event}:${id}`, error));
}

async function executeAutomation(id: string, lifecycle = false) {
  const command = automationConfig?.commands.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`Unknown automation command: ${id}`);
  if (automationRunning.has(id)) throw new Error(`Recursive automation command: ${id}`);
  automationRunning.add(id);
  try {
    const variables: Record<string, string> = automationVariables(
      currentPath,
      currentFileKind === "markdown" ? editor?.getSelection() ?? "" : "",
    );
    for (const prompt of command.prompts ?? []) {
      if (lifecycle) throw new Error(`Lifecycle automation ${id} cannot display prompts`);
      const fallback = expandAutomationText(prompt.default ?? "", variables, automationConfig?.functions);
      const value = window.prompt(prompt.label, fallback);
      if (value == null) return;
      variables[prompt.name] = value;
    }
    for (const action of command.actions) await executeAutomationAction(action, variables);
    await refreshTree();
    setTransientStatus(`Automation complete: ${command.name}`, "#5ecf9a");
  } finally {
    automationRunning.delete(id);
  }
}

async function executeAutomationAction(action: AutomationAction, variables: Record<string, string>) {
  const expand = (value: string) => expandAutomationText(value, variables, automationConfig?.functions);
  if (action.type === "notice") {
    setTransientStatus(expand(action.message), "#5ecf9a");
    return;
  }
  if (action.type === "open") {
    await openVaultEntry(expand(action.path));
    return;
  }
  if (action.type === "move" || action.type === "rename") {
    const from = expand(action.from || variables["active.path"] || "");
    if (!from) throw new Error(`${action.type} needs an active file or explicit source`);
    const to = expand(action.to);
    await invoke("rename_path", { from, to });
    remapOpenPaths(from, to);
    variables["active.path"] = to;
    return;
  }
  if (action.type === "apply-template") {
    if (!currentPath || currentFileKind !== "markdown" || !editor) throw new Error("No active Markdown note for template application");
    const templatePath = expand(action.template);
    const template = await invoke<OpenFile>("read_file", { path: templatePath });
    const result = await renderTemplateForCurrent(template.content, currentPath);
    const application = planTemplateApplication(editor.getDoc(), editor.getSelectionRange(), result.text, result.cursor);
    editor.applyChanges(application.changes, application.cursor);
    return;
  }
  if (action.type !== "create" && action.type !== "append" && action.type !== "prepend") {
    throw new Error(`Unsupported automation action: ${String((action as { type?: string }).type)}`);
  }
  const path = expand(action.path);
  const rawContent = typeof action.content === "string" ? action.content : null;
  const templatePath = action.template ? expand(action.template) : null;
  const source = templatePath
    ? (await invoke<OpenFile>("read_file", { path: templatePath })).content
    : expand(rawContent ?? "");
  const existing = action.type === "create" ? "" : await readAutomationTarget(path);
  const rendered = templatePath
    ? (await renderTemplater(source, automationTemplateContext(path, existing, variables))).text
    : source;
  if (action.type === "create") {
    await invoke("create_file", { path, content: rendered });
    if (action.open) await openNote(path);
  } else {
    const content = action.type === "append" ? `${existing}${rendered}` : `${rendered}${existing}`;
    await invoke("write_file", { path, content });
    if (currentPath === path) await openNote(path, { skipDirtyPrompt: true });
  }
}

async function readAutomationTarget(path: string): Promise<string> {
  try {
    return (await invoke<OpenFile>("read_file", { path })).content;
  } catch {
    return "";
  }
}

function automationTemplateContext(path: string, content: string, variables: Record<string, string>) {
  return {
    path,
    content,
    selection: variables.selection ?? "",
    readFile: async (requested: string) => (await invoke<OpenFile>("read_file", { path: requested })).content,
    prompt: async (message: string, defaultValue?: string) => window.prompt(message, defaultValue ?? ""),
  };
}

function remapOpenPaths(from: string, to: string) {
  remapBookmarks(from, to, false);
  if (currentPath === from) currentPath = to;
  if (rightPath === from) rightPath = to;
  openTabs = openTabs.map((path) => path === from ? to : path);
  renderTabBar();
  saveSession();
}

function renderPreferencesPlugins() {
  const host = document.getElementById("preferences-plugins");
  if (!host) return;
  host.replaceChildren();
  const statuses = pluginManager?.statuses() ?? [];
  if (!vaultOpen) {
    host.textContent = "Open a vault to load plugins.";
    return;
  }
  if (!statuses.length) {
    host.textContent = "No plugins installed.";
    return;
  }
  for (const plugin of statuses) {
    const label = document.createElement("label");
    label.className = "preferences-plugin";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = plugin.enabled;
    const name = document.createElement("span");
    name.textContent = `${plugin.name} ${plugin.version}`;
    const state = document.createElement("small");
    state.textContent = plugin.error || (plugin.loaded ? "Loaded" : plugin.enabled ? "Starting" : "Disabled");
    toggle.addEventListener("change", () => void pluginManager?.setEnabled(plugin.id, toggle.checked).then(renderPreferencesPlugins));
    label.append(toggle, name, state);
    host.appendChild(label);
  }
}

function showPluginView(title: string, result: PluginViewResult) {
  const body = openFeaturePanel(title);
  const normalized = typeof result === "string" ? { type: "text" as const, content: result } : result ?? {};
  const content = String(normalized.content ?? "");
  if (normalized.type === "markdown") {
    body.classList.add("markdown-preview");
    body.innerHTML = renderPreview(escapeHtml(content));
    hydrateTableOfContents(body);
  } else {
    const pre = document.createElement("pre");
    pre.className = "plugin-view-text";
    pre.textContent = content;
    body.appendChild(pre);
  }
}


/** Collect CSS that should apply to an exported/print page. */
function collectExportCss(): string {
  const chunks: string[] = [];
  // User Page CSS from Preferences (injected style tag), if present.
  const user = document.getElementById("nephrite-user-preview-css");
  if (user?.textContent?.trim()) {
    chunks.push(user.textContent);
  }
  // Always add print-oriented chrome so tables/props survive without full app CSS.
  chunks.push(`
html, body {
  background: #fff;
  color: #111;
  font: 12pt/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0;
  padding: 0;
}
.preview, .print-export {
  max-width: 100%;
  padding: 0.5in;
  box-sizing: border-box;
}
.preview a { color: #0b5; text-decoration: underline; }
.preview table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 0.95em;
}
.preview th, .preview td {
  border: 1px solid #888;
  padding: 0.35em 0.55em;
  text-align: left;
  vertical-align: top;
}
.preview th { background: #eee; font-weight: 650; }
.preview pre, .preview code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.preview pre {
  background: #f4f4f4;
  padding: 0.6em 0.8em;
  border-radius: 4px;
  overflow: visible;
  white-space: pre-wrap;
}
.preview blockquote {
  margin: 0.6em 0;
  padding-left: 0.8em;
  border-left: 3px solid #999;
  color: #333;
}
.preview img { max-width: 100%; height: auto; }
.props-block {
  border: 1px solid #bbb;
  border-radius: 6px;
  margin: 0 0 1em;
  padding: 0.4em 0.6em;
  background: #fafafa;
}
.props-summary { font-weight: 650; cursor: default; }
.props-rows { display: grid; gap: 0.25em; margin-top: 0.4em; }
.prop-row { display: grid; grid-template-columns: 10rem 1fr; gap: 0.5em; }
.prop-key { color: #444; font-weight: 600; }
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .preview, .print-export { padding: 0; }
  a[href]::after { content: ""; }
}
`);
  return chunks.join("\n\n");
}

/**
 * Ask whether to include YAML frontmatter in the export.
 * Resolves true/false, or null if the user cancels.
 */
function promptIncludeFrontmatter(): Promise<boolean | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "export-pdf-modal";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-labelledby", "export-pdf-title");
    host.innerHTML = `
      <div class="export-pdf-card">
        <h2 id="export-pdf-title">Export to PDF</h2>
        <p>Uses the system print dialog — choose “Save as PDF” as the printer. Page CSS from Preferences is applied.</p>
        <label class="export-pdf-check">
          <input type="checkbox" id="export-pdf-frontmatter" checked />
          <span>Include YAML frontmatter (Properties)</span>
        </label>
        <div class="export-pdf-actions">
          <button type="button" id="export-pdf-cancel">Cancel</button>
          <button type="button" id="export-pdf-go" class="primary">Print / Save PDF…</button>
        </div>
      </div>
    `;
    const finish = (value: boolean | null) => {
      host.remove();
      resolve(value);
    };
    host.addEventListener("click", (event) => {
      if (event.target === host) finish(null);
    });
    host.querySelector("#export-pdf-cancel")?.addEventListener("click", () => finish(null));
    host.querySelector("#export-pdf-go")?.addEventListener("click", () => {
      const box = host.querySelector("#export-pdf-frontmatter") as HTMLInputElement | null;
      finish(Boolean(box?.checked));
    });
    document.addEventListener(
      "keydown",
      function onKey(event: KeyboardEvent) {
        if (event.key === "Escape") {
          document.removeEventListener("keydown", onKey);
          finish(null);
        }
      },
    );
    document.body.appendChild(host);
    (host.querySelector("#export-pdf-go") as HTMLButtonElement | null)?.focus();
  });
}

function printHtmlAsPdf(title: string, bodyHtml: string, css: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    setTransientStatus("Could not open print view", "#e07070");
    return;
  }
  const safeTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  doc.open();
  doc.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
      `<style>${css}</style></head>` +
      `<body class="preview print-export">${bodyHtml}</body></html>`,
  );
  doc.close();
  const trigger = () => {
    try {
      win.focus();
      win.print();
    } finally {
      window.setTimeout(() => iframe.remove(), 1500);
    }
  };
  // Images/fonts may still be settling; print after a paint.
  if (doc.readyState === "complete") {
    requestAnimationFrame(() => setTimeout(trigger, 50));
  } else {
    iframe.addEventListener("load", () => requestAnimationFrame(() => setTimeout(trigger, 50)), {
      once: true,
    });
  }
}

async function exportCurrentPagePdf() {
  if (!currentPath || currentFileKind !== "markdown") {
    setTransientStatus("Open a markdown note to export", "#e07070");
    return;
  }
  const include = await promptIncludeFrontmatter();
  if (include == null) return;

  let markdown = "";
  if (editor && currentFileKind === "markdown") {
    markdown = editor.getDoc();
  } else {
    setTransientStatus("Editor has no markdown content", "#e07070");
    return;
  }

  const bodyHtml = renderPreview(markdown, {
    includeFrontmatter: include,
    openFrontmatter: include,
  });
  const title =
    currentPath.split("/").pop()?.replace(/\.md$/i, "") || currentPath || "note";
  printHtmlAsPdf(title, bodyHtml, collectExportCss());
  setTransientStatus(
    include ? "Print dialog opened (with frontmatter)" : "Print dialog opened (body only)",
    "#5ecf9a",
  );
}

function showCommandBar() {
  const body = openFeaturePanel("Command bar");
  renderCommandBar(body, commandCatalog(true), closeFeaturePanel);
}

function openFindCommand() {
  const boardVisible = !$("kanban").classList.contains("hidden");
  if (boardVisible && kanbanBoard) openKanbanFind();
  else if (editor) {
    if (viewMode === "preview") {
      setViewMode("split");
      requestAnimationFrame(() => editor?.openFind());
    } else editor.openFind();
  }
}

function commandCatalog(includeFiles: boolean): AppCommand[] {
  const commands: AppCommand[] = [
    { id: "save", title: "Save current file", keywords: "write", run: () => saveFile(false) },
    { id: "export-pdf", title: "Export page to PDF…", keywords: "print save pdf frontmatter yaml css", run: () => void exportCurrentPagePdf() },
    { id: "command", title: "Open command bar", keywords: "palette actions", run: showCommandBar },
    { id: "file-search", title: "Search file names", keywords: "quick open", run: focusFileFilter },
    { id: "find", title: "Find in current note or board", keywords: "search current", run: openFindCommand },
    { id: "mode-source", title: "View: Source", keywords: "editor", run: () => setViewMode("source") },
    { id: "mode-live", title: "View: Live Preview", keywords: "editor rendered markdown", run: () => setViewMode("live") },
    { id: "mode-split", title: "View: Split", keywords: "editor preview", run: () => setViewMode("split") },
    { id: "mode-preview", title: "View: Preview", keywords: "render", run: () => setViewMode("preview") },
    { id: "search", title: "Search vault", keywords: "find", run: showSearchPanel },
    { id: "graph", title: "Open graph", keywords: "links backlinks local", run: showGraphPanel },
    { id: "tasks", title: "Open tasks", keywords: "todo agenda", run: showTasksPanel },
    { id: "bookmarks", title: "Open bookmarks", run: showBookmarksPanel },
    { id: "git", title: "Open Git history", keywords: "versions source control", run: showGitPanel },
    { id: "templates", title: "Apply template", keywords: "templater automation", run: showTemplatePanel },
    { id: "today", title: "Open today's journal", keywords: "daily note", run: openToday },
    { id: "canvas", title: "Create canvas", run: createCanvas },
    { id: "drawing", title: "Create Excalidraw drawing", keywords: "draw", run: createDrawing },
    { id: "sidebar", title: sidebarCollapsed ? "Show file sidebar" : "Hide file sidebar", keywords: "files", run: () => setSidebarCollapsed(!sidebarCollapsed) },
    { id: "vim", title: vimOn ? "Disable Vim mode" : "Enable Vim mode", run: () => {
      vimOn = !vimOn;
      localStorage.setItem(VIM_KEY, vimOn ? "1" : "0");
      ($("vim-toggle") as HTMLInputElement).checked = vimOn;
      editor?.setVim(vimOn);
      updateVimPowerline();
    } },
    { id: "preferences", title: "Open preferences", keywords: "settings", run: togglePreferences },
    { id: "plugins", title: "Preferences: Plugins", keywords: "extensions permissions reload", run: () => {
      if ($("preferences-popover").classList.contains("hidden")) togglePreferences();
      renderPreferencesPlugins();
      document.getElementById("preferences-plugins")?.scrollIntoView({ block: "center" });
    } },
    { id: "hotkeys", title: "Preferences: Keyboard shortcuts", keywords: "keys bindings", run: showHotkeysPanel },
    ...(automationConfig?.commands.map((automation): AppCommand => ({
      id: `automation:${automation.id}`,
      title: automation.name,
      keywords: `${automation.description ?? ""} automation macro capture template`,
      run: () => executeAutomation(automation.id),
    })) ?? []),
    ...(pluginManager?.commands() ?? []),
    ...(includeFiles ? mdFilesAll
      .filter((file) => file.file_kind === "markdown")
      .map((file): AppCommand => ({
        id: `open:${file.path}`,
        title: `Open: ${file.path}`,
        keywords: `note file ${file.name}`,
        run: () => openNote(file.path),
      })) : []),
  ];
  return commands.map((command) => ({ ...command, shortcut: shortcuts.get(command.id) }));
}

function showHotkeysPanel() {
  closePreferences();
  const body = openFeaturePanel("Keyboard shortcuts");
  const help = document.createElement("p");
  help.className = "feature-help";
  help.textContent = "Click a shortcut field, then press the desired key combination. Conflicting assignments are rejected.";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset defaults";
  reset.addEventListener("click", () => {
    if (!confirm("Reset all keyboard shortcuts to their defaults?")) return;
    shortcuts.reset();
    showHotkeysPanel();
  });
  const list = document.createElement("div");
  list.className = "hotkey-list";
  for (const command of commandCatalog(false).sort((left, right) => left.title.localeCompare(right.title))) {
    const row = document.createElement("div");
    row.className = "hotkey-row";
    const label = document.createElement("label");
    label.textContent = command.title;
    label.htmlFor = `hotkey-${command.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.readOnly = true;
    input.value = shortcuts.get(command.id);
    input.placeholder = "Unassigned";
    input.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { input.blur(); return; }
      if (event.key === "Backspace" || event.key === "Delete") {
        shortcuts.set(command.id, "");
        input.value = "";
        return;
      }
      const value = shortcutFromEvent(event);
      if (!value) return;
      const conflict = shortcuts.set(command.id, value);
      if (conflict) {
        const other = commandCatalog(false).find((candidate) => candidate.id === conflict)?.title ?? conflict;
        setTransientStatus(`${value} is already assigned to ${other}`, "#e9ad55");
        return;
      }
      input.value = shortcuts.get(command.id);
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => { shortcuts.set(command.id, ""); input.value = ""; });
    row.append(label, input, clear);
    list.appendChild(row);
  }
  body.append(help, reset, list);
}

async function createDrawing() {
  const initialFolder = currentPath ? parentDir(currentPath) : "";
  const entered = promptName("New Excalidraw drawing", "Untitled.excalidraw");
  if (!entered) return;
  const filename = entered.endsWith(".excalidraw") ? entered : `${entered}.excalidraw`;
  const path = joinPath(initialFolder, filename);
  try {
    await invoke("create_file", { path, content: emptyExcalidrawFile() });
    await refreshTree();
    await openNote(path);
  } catch (error) {
    alert(String(error));
  }
}

async function createCanvas() {
  const initialFolder = currentPath ? parentDir(currentPath) : "";
  const entered = promptName("New canvas", "Untitled.canvas");
  if (!entered) return;
  const filename = entered.endsWith(".canvas") ? entered : `${entered}.canvas`;
  const path = joinPath(initialFolder, filename);
  try {
    await invoke("create_file", {
      path,
      content: serializeCanvas({ nodes: [], edges: [] }),
    });
    await refreshTree();
    await openNote(path);
  } catch (error) {
    alert(String(error));
  }
}

async function showTemplatePanel() {
  if (!currentPath || currentFileKind !== "markdown" || !editor) return;
  const targetPath = currentPath;
  const targetSelection = editor.getSelectionRange();
  const targetSelectionText = editor.getSelection();
  const body = openFeaturePanel("Apply template");
  const files = mdFilesAll
    .filter((file) => file.file_kind === "markdown" && file.path.startsWith("templates/"))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!files.length) {
    body.textContent = "No Markdown template files were found under /templates in this vault.";
    return;
  }
  const explanation = document.createElement("p");
  explanation.className = "feature-help";
  explanation.textContent = "YAML is merged into the current note; template body content is inserted at the caret.";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "template-search";
  search.placeholder = "Filter templates…";
  search.autocomplete = "off";
  search.spellcheck = false;
  const list = document.createElement("div");
  list.className = "template-list";
  let matches = files;
  let activeIndex = 0;

  const applyTemplate = async (path: string) => {
    if (!editor || currentPath !== targetPath) throw new Error("The active note changed while choosing a template");
    const template = await invoke<OpenFile>("read_file", { path });
    const result = await renderTemplateForCurrent(
      template.content,
      targetPath,
      targetSelectionText,
    );
    const application = planTemplateApplication(
      editor.getDoc(),
      targetSelection,
      result.text,
      result.cursor,
    );
    editor.applyChanges(application.changes, application.cursor);
    closeFeaturePanel();
    if (result.warnings.length) {
      alert(`Template applied with ${result.warnings.length} compatibility warning(s):\n\n${result.warnings.join("\n")}`);
    } else {
      setTransientStatus(`Applied ${template.path}`, "#5ecf9a");
    }
  };

  const renderMatches = () => {
    const query = search.value.trim().toLowerCase();
    matches = files.filter((file) => file.path.slice("templates/".length).toLowerCase().includes(query));
    activeIndex = Math.max(0, Math.min(activeIndex, matches.length - 1));
    list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "feature-empty";
      empty.textContent = "No matching templates.";
      list.appendChild(empty);
      return;
    }
    matches.forEach((file, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `template-choice${index === activeIndex ? " active" : ""}`;
      button.dataset.templateIndex = String(index);
      button.textContent = file.path.slice("templates/".length).replace(/\.(?:md|markdown)$/i, "");
      button.title = file.path;
      button.addEventListener("mouseenter", () => {
        activeIndex = index;
        list.querySelector(".template-choice.active")?.classList.remove("active");
        button.classList.add("active");
      });
      button.addEventListener("click", () => void applyTemplate(file.path).catch((error) => alert(String(error))));
      list.appendChild(button);
    });
  };
  search.addEventListener("input", () => {
    activeIndex = 0;
    renderMatches();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFeaturePanel();
      editor?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = matches.length ? (activeIndex + delta + matches.length) % matches.length : 0;
      renderMatches();
      list.querySelector<HTMLElement>(`[data-template-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && matches[activeIndex]) {
      event.preventDefault();
      void applyTemplate(matches[activeIndex].path).catch((error) => alert(String(error)));
    }
  });
  body.append(explanation, search, list);
  renderMatches();
  requestAnimationFrame(() => search.focus());
}

async function renderTemplateForCurrent(source: string, targetPath: string, selection?: string) {
  if (!editor) throw new Error("No active Markdown editor");
  return renderTemplater(source, {
    path: targetPath,
    content: editor.getDoc(),
    selection: selection ?? editor.getSelection(),
    readFile: async (requested) => {
      const resolved = await invoke<string | null>("resolve_wikilink", {
        target: requested,
        fromPath: targetPath,
      });
      if (!resolved) throw new Error(`Could not resolve template include: ${requested}`);
      return (await invoke<OpenFile>("read_file", { path: resolved })).content;
    },
    prompt: async (message, defaultValue) => window.prompt(message, defaultValue ?? ""),
  });
}

async function showTasksPanel() {
  const body = openFeaturePanel("Tasks");
  body.innerHTML = `<div class="feature-loading">Loading indexed tasks…</div>`;
  try {
    if (dirty) await saveFile(true);
    let view: TaskView = { ...DEFAULT_TASK_VIEW };
    let tasks = await loadIndexedTasks(view);
    let savedViews: TaskView[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(TASK_VIEWS_KEY) || "[]");
      if (Array.isArray(parsed)) savedViews = parsed;
    } catch { /* discard malformed local UI state */ }
    const selectedTasks = new Set<string>();
    let renderLimit = 200;
    body.replaceChildren();
    const controls = document.createElement("div");
    controls.className = "task-dashboard-controls";
    const saved = taskSelect(["", ...savedViews.map((candidate) => candidate.name)], "", "Saved view", "Saved views");
    const completion = taskSelect(["open", "completed", "all"], view.completion, "Completion");
    const scope = taskSelect(["global", "all"], view.scope, "Task scope");
    scope.options[0].textContent = taskScopeIsActive(taskScope) ? "Configured task scope" : "All checkboxes (no scope configured)";
    scope.options[1].textContent = "Ignore scope for this view";
    const observedStatuses = [...new Set(tasks.map((task) => task.status_char))];
    const status = taskStatusSelect(view.status, "Status", true, observedStatuses);
    const due = taskSelect(["all", "overdue", "today", "week", "none"], view.due, "Due date");
    const priority = taskSelect(["", "highest", "high", "medium", "low", "lowest"], "", "Priority", "All priorities");
    const sort = taskSelect(["due", "scheduled", "priority", "path"], view.sort, "Sort tasks");
    const group = taskSelect(["none", "agenda", "due", "priority", "path"], view.group, "Group tasks");
    const pathFilter = document.createElement("input");
    pathFilter.type = "search";
    pathFilter.placeholder = "Path…";
    pathFilter.setAttribute("aria-label", "Filter task path");
    const query = document.createElement("input");
    query.type = "search";
    query.placeholder = "Task text or tag…";
    query.setAttribute("aria-label", "Filter task text or tag");
    const saveView = document.createElement("button");
    saveView.type = "button";
    saveView.textContent = "Save view";
    const deleteView = document.createElement("button");
    deleteView.type = "button";
    deleteView.textContent = "Delete view";
    deleteView.disabled = true;
    const summary = document.createElement("span");
    const bulkStatus = taskStatusSelect("x", "Bulk status", false, observedStatuses);
    const applyBulk = document.createElement("button");
    applyBulk.type = "button";
    applyBulk.textContent = "Apply selected";
    controls.append(saved, completion, scope, status, due, priority, sort, group, pathFilter, query, saveView, deleteView, bulkStatus, applyBulk, summary);
    const list = document.createElement("div");
    list.className = "task-dashboard";
    body.append(controls, list);

    const readControls = () => {
      view = {
        ...view,
        completion: completion.value as TaskView["completion"],
        scope: scope.value as TaskView["scope"],
        status: status.value,
        due: due.value as TaskView["due"],
        priority: priority.value,
        sort: sort.value as TaskView["sort"],
        group: group.value as TaskView["group"],
        path: pathFilter.value,
        query: query.value,
      };
    };
    const writeControls = () => {
      completion.value = view.completion;
      scope.value = view.scope;
      status.value = view.status || "";
      due.value = view.due;
      priority.value = view.priority;
      sort.value = view.sort;
      group.value = view.group;
      pathFilter.value = view.path;
      query.value = view.query;
    };
    const persistViews = () => {
      localStorage.setItem(TASK_VIEWS_KEY, JSON.stringify(savedViews));
      saved.replaceChildren(...["", ...savedViews.map((candidate) => candidate.name)].map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name || "Saved views";
        return option;
      }));
    };
    const render = () => {
      readControls();
      const selected = selectTasks(tasks, view);
      const visible = selected.slice(0, renderLimit);
      const groups = groupTasks(visible, view.group);
      list.replaceChildren();
      summary.textContent = `${selected.length} indexed match${selected.length === 1 ? "" : "es"}`;
      if (!selected.length) list.innerHTML = `<div class="feature-empty">No tasks match this view.</div>`;
      for (const [label, rows] of groups) {
        if (view.group !== "none") {
          const heading = document.createElement("h3");
          heading.className = "task-dashboard-group";
          heading.textContent = `${label.replace(/^\d+ · /, "")} (${rows.length})`;
          list.appendChild(heading);
        }
        for (const task of rows) list.appendChild(renderTaskDashboardRow(task, selectedTasks, () => void refreshTasks()));
      }
      if (visible.length < selected.length) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "task-dashboard-more";
        more.textContent = `Show ${Math.min(200, selected.length - visible.length)} more (${selected.length - visible.length} remaining)`;
        more.addEventListener("click", () => { renderLimit += 200; render(); });
        list.appendChild(more);
      }
    };
    const refreshTasks = async () => {
      tasks = await loadIndexedTasks(view);
      selectedTasks.clear();
      renderLimit = 200;
      render();
    };
    completion.addEventListener("change", () => {
      readControls();
      void refreshTasks();
    });
    scope.addEventListener("change", () => {
      readControls();
      void refreshTasks();
    });
    for (const control of [status, due, priority, sort, group]) control.addEventListener("change", render);
    pathFilter.addEventListener("input", render);
    query.addEventListener("input", render);
    saved.addEventListener("change", () => {
      const selected = savedViews.find((candidate) => candidate.name === saved.value);
      if (!selected) return;
      view = { ...DEFAULT_TASK_VIEW, ...selected };
      writeControls();
      deleteView.disabled = false;
      void refreshTasks();
    });
    saveView.addEventListener("click", () => {
      readControls();
      const name = window.prompt("Saved task view name", view.name || "Task view")?.trim();
      if (!name) return;
      view.name = name;
      const existing = savedViews.findIndex((candidate) => candidate.name === name);
      if (existing >= 0) savedViews[existing] = { ...view };
      else savedViews.push({ ...view });
      persistViews();
      saved.value = name;
      deleteView.disabled = false;
    });
    deleteView.addEventListener("click", () => {
      if (!saved.value) return;
      savedViews = savedViews.filter((candidate) => candidate.name !== saved.value);
      persistViews();
      deleteView.disabled = true;
    });
    applyBulk.addEventListener("click", () => void (async () => {
      const selected = tasks
        .filter((task) => selectedTasks.has(`${task.path}:${task.task_id}`))
        .sort((left, right) => left.path.localeCompare(right.path) || right.task_id - left.task_id);
      if (!selected.length) return;
      applyBulk.disabled = true;
      try {
        for (const task of selected) {
          await invoke("set_task_status", {
            path: task.path,
            taskId: task.task_id,
            status: bulkStatus.value,
          });
        }
        await refreshTasks();
        if (currentPath && selected.some((task) => task.path === currentPath)) {
          await openNote(currentPath, { skipDirtyPrompt: true });
        }
      } catch (error) {
        alert(String(error));
      } finally {
        applyBulk.disabled = false;
      }
    })());
    render();
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

function loadIndexedTasks(view: TaskView): Promise<TaskRow[]> {
  const completed = view.completion === "open" ? false : view.completion === "completed" ? true : null;
  return invoke<TaskRow[]>("list_tasks", {
    completed,
    scope: view.scope === "all" || !taskScopeIsActive(taskScope) ? null : taskScope,
  });
}

function taskSelect(values: string[], selected: string, label: string, emptyLabel?: string) {
  const select = document.createElement("select");
  select.className = "feature-select task-dashboard-select";
  select.setAttribute("aria-label", label);
  select.title = label;
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value || emptyLabel || "All";
    option.selected = value === selected;
    select.appendChild(option);
  }
  return select;
}

function taskStatusSelect(
  selected: string,
  label: string,
  includeAll = false,
  extraStatuses: readonly string[] = [],
) {
  const options: Array<[string, string]> = [
    [" ", "Todo [ ]"], ["/", "In progress [/]"], ["-", "Cancelled [-]"],
    ["?", "Question [?]"], ["!", "Important [!]"], ["x", "Done [x]"],
  ];
  const known = new Set(options.map(([value]) => value));
  for (const value of [...extraStatuses, selected]) {
    if (value && !known.has(value)) {
      options.push([value, `Custom [${value}]`]);
      known.add(value);
    }
  }
  if (includeAll) options.unshift(["", "All statuses"]);
  const select = document.createElement("select");
  select.className = "feature-select task-dashboard-select";
  select.setAttribute("aria-label", label);
  select.title = label;
  for (const [value, text] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = value === selected;
    select.appendChild(option);
  }
  return select;
}

function renderTaskDashboardRow(
  task: TaskRow,
  selectedTasks: Set<string>,
  rerender: () => void,
) {
  const row = document.createElement("div");
  row.className = "task-dashboard-row";
  const taskKey = `${task.path}:${task.task_id}`;
  const selected = document.createElement("input");
  selected.type = "checkbox";
  selected.checked = selectedTasks.has(taskKey);
  selected.title = "Select task for bulk operation";
  selected.addEventListener("change", () => {
    if (selected.checked) selectedTasks.add(taskKey);
    else selectedTasks.delete(taskKey);
  });
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = task.completed;
  checkbox.title = "Write task status to Markdown";
  checkbox.addEventListener("change", () => void (async () => {
    checkbox.disabled = true;
    try {
      await invoke("set_task_completed", { path: task.path, taskId: task.task_id, completed: checkbox.checked });
      task.completed = checkbox.checked;
      if (currentPath === task.path) await openNote(task.path, { skipDirtyPrompt: true });
      rerender();
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      checkbox.disabled = false;
      alert(String(error));
    }
  })());
  const text = document.createElement("button");
  text.type = "button";
  text.className = "task-dashboard-text";
  text.textContent = task.text;
  text.addEventListener("click", () => void (async () => {
    closeFeaturePanel();
    await openNote(task.path);
    editor?.goToLine(task.line);
  })());
  const metadata = document.createElement("div");
  metadata.className = "task-dashboard-metadata";
  const scheduled = document.createElement("input");
  scheduled.type = "date";
  scheduled.value = task.scheduled || "";
  scheduled.title = "Scheduled date";
  const dueDate = document.createElement("input");
  dueDate.type = "date";
  dueDate.value = task.due || "";
  dueDate.title = "Due date";
  const priority = taskSelect(["", "highest", "high", "medium", "low", "lowest"], task.priority || "", "Task priority", "No priority");
  const status = taskStatusSelect(task.status_char, "Task status");
  status.addEventListener("change", () => void (async () => {
    status.disabled = true;
    try {
      await invoke("set_task_status", { path: task.path, taskId: task.task_id, status: status.value });
      if (currentPath === task.path) await openNote(task.path, { skipDirtyPrompt: true });
      rerender();
    } catch (error) {
      status.value = task.status_char;
      status.disabled = false;
      alert(String(error));
    }
  })());
  const update = async () => {
    const replacement = updateTaskMetadataLine(task.raw_line, {
      due: dueDate.value || null,
      scheduled: scheduled.value || null,
      priority: priority.value || null,
    });
    for (const control of [scheduled, dueDate, priority]) control.disabled = true;
    try {
      await invoke("replace_task_line", { path: task.path, taskId: task.task_id, replacement });
      task.raw_line = replacement;
      task.due = dueDate.value || null;
      task.scheduled = scheduled.value || null;
      task.priority = priority.value || null;
      if (currentPath === task.path) await openNote(task.path, { skipDirtyPrompt: true });
      rerender();
    } catch (error) {
      for (const control of [scheduled, dueDate, priority]) control.disabled = false;
      alert(String(error));
    }
  };
  scheduled.addEventListener("change", () => void update());
  dueDate.addEventListener("change", () => void update());
  priority.addEventListener("change", () => void update());
  metadata.append(status, scheduled, dueDate, priority);
  const source = document.createElement("span");
  source.className = "task-dashboard-source";
  source.textContent = `${task.path}:${task.line}`;
  row.append(selected, checkbox, text, metadata, source);
  return row;
}

async function showGitPanel() {
  const body = openFeaturePanel("Git");
  body.innerHTML = `<div class="feature-loading">Reading repository…</div>`;
  try {
    if (dirty) await saveFile(true);
    const status = await invoke<GitStatus>("git_status");
    if (!status.available) {
      body.innerHTML = `<div class="feature-error">Git is not installed or is not on Nephrite's PATH.</div>`;
      return;
    }
    if (!status.repository) {
      body.innerHTML = `<p>This vault is not a Git repository.</p>`;
      const initialize = document.createElement("button");
      initialize.textContent = "Initialize repository";
      initialize.addEventListener("click", () => void (async () => {
        await invoke("git_init");
        await showGitPanel();
      })().catch((error) => alert(String(error))));
      body.appendChild(initialize);
      return;
    }
    const [commits, branches, sync] = await Promise.all([
      invoke<GitCommit[]>("git_history", { limit: 30 }),
      invoke<GitBranches>("git_branches"),
      invoke<GitSyncStatus>("git_sync_status"),
    ]);
    renderGitPanel(body, status, commits, branches, sync);
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

function renderGitPanel(
  body: HTMLElement,
  status: GitStatus,
  commits: GitCommit[],
  branches: GitBranches,
  sync: GitSyncStatus,
) {
  body.replaceChildren();
  const branch = document.createElement("div");
  branch.className = "git-branch";
  branch.textContent = status.branch ?? "Detached HEAD";
  body.appendChild(branch);

  const syncCard = document.createElement("div");
  syncCard.className = "git-sync";
  const syncText = document.createElement("span");
  syncText.textContent = sync.upstream
    ? `${sync.upstream} · ${sync.ahead} ahead · ${sync.behind} behind`
    : sync.detached ? "Detached HEAD · no upstream" : "No upstream branch configured";
  const remote = document.createElement("small");
  remote.textContent = sync.remote_url ?? "Local repository";
  syncCard.append(syncText, remote);
  body.appendChild(syncCard);

  const conflicts = status.entries.filter((entry) => entry.conflicted);
  if (status.operation || conflicts.length) {
    const operation = document.createElement("div");
    operation.className = "git-operation";
    const message = document.createElement("strong");
    message.textContent = status.operation
      ? `${status.operation} in progress${conflicts.length ? ` · ${conflicts.length} unresolved` : " · ready to continue"}`
      : `${conflicts.length} unresolved conflict${conflicts.length === 1 ? "" : "s"}`;
    operation.appendChild(message);
    if (status.operation) {
      const proceed = document.createElement("button");
      proceed.textContent = "Continue";
      proceed.disabled = conflicts.length > 0;
      proceed.addEventListener("click", () => void runGitAction("git_continue"));
      const abort = document.createElement("button");
      abort.textContent = "Abort";
      abort.className = "danger";
      abort.addEventListener("click", () => {
        if (confirm(`Abort the current ${status.operation}?`)) void runGitAction("git_abort");
      });
      operation.append(proceed, abort);
    }
    body.appendChild(operation);
  }

  const branchActions = document.createElement("div");
  branchActions.className = "git-toolbar";
  const branchSelect = document.createElement("select");
  branchSelect.className = "feature-select";
  for (const name of branches.branches) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    option.selected = name === branches.current;
    branchSelect.appendChild(option);
  }
  const switchBranch = document.createElement("button");
  switchBranch.textContent = "Switch";
  switchBranch.disabled = !branchSelect.value || branchSelect.value === branches.current;
  branchSelect.addEventListener("change", () => {
    switchBranch.disabled = !branchSelect.value || branchSelect.value === branches.current;
  });
  switchBranch.addEventListener("click", () => void runGitAction("git_switch_branch", {
    name: branchSelect.value,
  }));
  const newBranch = document.createElement("button");
  newBranch.textContent = "New branch";
  newBranch.addEventListener("click", () => {
    const name = prompt("New branch name");
    if (name?.trim()) void runGitAction("git_create_branch", { name, checkout: true });
  });
  const pull = document.createElement("button");
  pull.textContent = "Pull";
  pull.title = "Fast-forward only; never creates an implicit merge commit";
  pull.addEventListener("click", () => void runGitAction("git_pull"));
  const push = document.createElement("button");
  push.textContent = "Push";
  push.addEventListener("click", () => void runGitAction("git_push"));
  const fetch = document.createElement("button");
  fetch.textContent = "Fetch";
  fetch.title = "Refresh remote tracking branches without changing working files";
  fetch.disabled = !sync.remote;
  fetch.addEventListener("click", () => void runGitAction("git_fetch"));
  branchActions.append(branchSelect, switchBranch, newBranch, fetch, pull, push);
  body.appendChild(branchActions);

  const changes = document.createElement("section");
  changes.innerHTML = `<h3>Changes (${status.entries.length})</h3>`;
  const changeList = document.createElement("div");
  changeList.className = "git-changes";
  const diff = document.createElement("pre");
  diff.className = "git-diff hidden";
  if (!status.entries.length) changeList.innerHTML = `<div class="feature-empty">Working tree clean.</div>`;
  for (const entry of status.entries) {
    const row = document.createElement("div");
    row.className = "git-change";
    const code = document.createElement("code");
    code.textContent = entry.status;
    const path = document.createElement("button");
    path.type = "button";
    path.className = "git-change-path";
    path.textContent = entry.path;
    path.title = "Show diff";
    path.addEventListener("click", () => void (async () => {
      diff.classList.remove("hidden");
      diff.textContent = "Loading diff…";
      const patch = await invoke<string>("git_diff", { path: entry.path });
      diff.textContent = patch || "No textual diff (the path may be untracked, binary, or renamed).";
    })().catch((error) => { diff.textContent = String(error); }));
    const actions = document.createElement("span");
    actions.className = "git-change-actions";
    const indexStatus = entry.status[0] ?? " ";
    const worktreeStatus = entry.status[1] ?? " ";
    const isUntracked = entry.status === "??";
    if (entry.conflicted) row.classList.add("conflicted");
    if (entry.conflicted) {
      const openConflict = document.createElement("button");
      openConflict.textContent = "Open";
      openConflict.addEventListener("click", () => void (async () => {
        closeFeaturePanel();
        await openNote(entry.path);
      })());
      const resolved = document.createElement("button");
      resolved.textContent = "Mark resolved";
      resolved.addEventListener("click", () => void runGitAction("git_resolve_conflict", {
        path: entry.path,
        resolution: "resolved",
      }));
      const ours = document.createElement("button");
      ours.textContent = "Use ours";
      ours.title = "Replace the file with the current branch version and stage it";
      ours.addEventListener("click", () => {
        if (confirm(`Replace ${entry.path} with our side and mark it resolved?`)) {
          void runGitAction("git_resolve_conflict", { path: entry.path, resolution: "ours" });
        }
      });
      const theirs = document.createElement("button");
      theirs.textContent = "Use theirs";
      theirs.title = "Replace the file with the incoming version and stage it";
      theirs.addEventListener("click", () => {
        if (confirm(`Replace ${entry.path} with their side and mark it resolved?`)) {
          void runGitAction("git_resolve_conflict", { path: entry.path, resolution: "theirs" });
        }
      });
      actions.append(openConflict, resolved, ours, theirs);
    }
    if (!entry.conflicted && (worktreeStatus !== " " || isUntracked)) {
      const stage = document.createElement("button");
      stage.textContent = "Stage";
      stage.addEventListener("click", () => void runGitAction("git_stage", { paths: [entry.path] }));
      actions.appendChild(stage);
    }
    if (!entry.conflicted && indexStatus !== " " && indexStatus !== "?") {
      const unstage = document.createElement("button");
      unstage.textContent = "Unstage";
      unstage.addEventListener("click", () => void runGitAction("git_unstage", { paths: [entry.path] }));
      actions.appendChild(unstage);
    }
    if (!entry.conflicted && !isUntracked && worktreeStatus !== " ") {
      const restore = document.createElement("button");
      restore.textContent = "Restore";
      restore.title = "Discard working-tree changes to this path";
      restore.addEventListener("click", () => {
        if (confirm(`Discard unstaged changes to ${entry.path}?`)) {
          void runGitAction("git_restore", { paths: [entry.path] });
        }
      });
      actions.appendChild(restore);
    }
    row.append(code, path, actions);
    changeList.appendChild(row);
  }
  changes.appendChild(changeList);
  changes.appendChild(diff);
  body.appendChild(changes);

  if (status.entries.length) {
    const commitRow = document.createElement("div");
    commitRow.className = "git-commit-form";
    const message = document.createElement("input");
    message.placeholder = "Commit message";
    const commit = document.createElement("button");
    commit.textContent = "Commit staged";
    commit.addEventListener("click", () => void (async () => {
      if (!message.value.trim()) return;
      commit.disabled = true;
      try {
        await invoke("git_commit_staged", { message: message.value });
        await showGitPanel();
      } catch (error) {
        commit.disabled = false;
        alert(String(error));
      }
    })());
    commitRow.append(message, commit);
    body.appendChild(commitRow);
  }

  const history = document.createElement("section");
  history.innerHTML = `<h3>History</h3>`;
  const historyList = document.createElement("div");
  historyList.className = "git-history";
  if (!commits.length) historyList.innerHTML = `<div class="feature-empty">No commits yet.</div>`;
  for (const item of commits) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "git-history-row";
    row.innerHTML = `<code>${escapeHtml(item.short_hash)}</code><span>${escapeHtml(item.subject)}</span><small>${escapeHtml(item.author)} · ${escapeHtml(new Date(item.timestamp).toLocaleString())}</small>`;
    row.addEventListener("click", () => void showCommitDetails(item.hash));
    historyList.appendChild(row);
  }
  history.appendChild(historyList);
  body.appendChild(history);
}

async function showCommitDetails(hash: string, restorePath?: string) {
  const body = openFeaturePanel(restorePath ? `Version of ${restorePath}` : "Commit details");
  body.innerHTML = `<div class="feature-loading">Loading commit…</div>`;
  try {
    const commit = await invoke<GitCommitDetails>("git_commit_details", { hash });
    body.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = commit.subject;
    const meta = document.createElement("div");
    meta.className = "git-commit-meta";
    meta.textContent = `${commit.hash.slice(0, 12)} · ${commit.author} <${commit.author_email}> · ${new Date(commit.timestamp).toLocaleString()}`;
    body.append(heading, meta);
    if (commit.body) {
      const message = document.createElement("p");
      message.className = "git-commit-body";
      message.textContent = commit.body;
      body.appendChild(message);
    }
    if (restorePath) {
      const restore = document.createElement("button");
      restore.textContent = "Restore this file version";
      restore.addEventListener("click", () => {
        if (confirm(`Restore ${restorePath} from ${commit.hash.slice(0, 12)} into the working tree?`)) {
          void (async () => {
            await invoke("git_restore_from_commit", { hash: commit.hash, path: restorePath });
            await refreshTree();
            if (currentPath === restorePath) await openNote(restorePath, { skipDirtyPrompt: true });
            await showFileHistory(restorePath);
          })().catch((error) => alert(String(error)));
        }
      });
      body.appendChild(restore);
    }
    const patch = document.createElement("pre");
    patch.className = "git-diff git-commit-patch";
    patch.textContent = commit.patch || "This commit has no textual patch.";
    body.appendChild(patch);
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

async function showFileHistory(path: string) {
  const body = openFeaturePanel(`History · ${path}`);
  body.innerHTML = `<div class="feature-loading">Reading file history…</div>`;
  try {
    const commits = await invoke<GitCommit[]>("git_file_history", { path, limit: 150 });
    body.replaceChildren();
    if (!commits.length) body.innerHTML = `<div class="feature-empty">No Git history for this path.</div>`;
    const list = document.createElement("div");
    list.className = "git-history";
    for (const commit of commits) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "git-history-row";
      row.innerHTML = `<code>${escapeHtml(commit.short_hash)}</code><span>${escapeHtml(commit.subject)}</span><small>${escapeHtml(new Date(commit.timestamp).toLocaleString())}</small>`;
      row.addEventListener("click", () => void showCommitDetails(commit.hash, path));
      list.appendChild(row);
    }
    body.appendChild(list);
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

async function runGitAction(command: string, args: Record<string, unknown> = {}) {
  try {
    await invoke(command, args);
    await refreshTree();
    await showGitPanel();
  } catch (error) {
    alert(String(error));
  }
}

// ─── Context menu actions ───────────────────────────────────────────

function folderForCreate(target: CtxTarget): string {
  if (target.kind === "folder") return target.path;
  if (target.kind === "file" || target.kind === "tab") return parentDir(target.path);
  return "";
}

function existingPaths(): Set<string> {
  return new Set(vaultFilesAll.map((f) => f.path));
}

function promptName(title: string, initial: string): string | null {
  const v = window.prompt(title, initial);
  if (v == null) return null;
  const t = v.trim();
  if (!t) return null;
  if (t.includes("..") || t.includes("\\")) {
    alert("Invalid name");
    return null;
  }
  return t;
}

async function handleCtxAction(action: CtxAction, target: CtxTarget) {
  try {
    await runCtxAction(action, target);
  } catch (e) {
    alert(String(e));
  }
}

async function runCtxAction(action: CtxAction, target: CtxTarget) {
  const dir = folderForCreate(target);

  switch (action) {
    case "close-tab": {
      await closeTab(target.path);
      return;
    }
    case "open-new-tab": {
      if (target.kind !== "file" && target.kind !== "tab") return;
      const entry = vaultFilesAll.find((file) => file.path === target.path);
      if (entry && !isDocumentEntry(entry)) {
        await invoke("open_with_default_app", { path: target.path });
        return;
      }
      if (!openTabs.includes(target.path)) openTabs.push(target.path);
      await openNote(target.path);
      renderTabBar();
      saveSession();
      return;
    }
    case "open-right": {
      if (target.kind !== "file") return;
      const entry = vaultFilesAll.find((file) => file.path === target.path);
      if (entry && !isDocumentEntry(entry)) {
        await invoke("open_with_default_app", { path: target.path });
        return;
      }
      rightPath = target.path;
      await updateRightPane();
      saveSession();
      return;
    }
    case "open-new-window": {
      if (target.kind !== "file") return;
      // System default app as a practical multi-window stand-in until multi-webview ships.
      await invoke("open_with_default_app", { path: target.path });
      return;
    }
    case "merge-file": {
      alert(
        "Merge entire file with… is not implemented yet (needs a note picker + merge UI).",
      );
      return;
    }
    case "version-history": {
      if (target.kind !== "file" && target.kind !== "tab") return;
      await showFileHistory(target.path);
      return;
    }
    case "open-default-app": {
      await invoke("open_with_default_app", { path: target.path });
      return;
    }
    case "new-note": {
      const name = promptName("New note name", "Untitled.md");
      if (!name) return;
      const file = name.endsWith(".md") ? name : `${name}.md`;
      const path = joinPath(dir, file);
      const title = file.replace(/\.md$/i, "");
      await invoke("create_file", {
        path,
        content: `# ${title}\n\n`,
      });
      await refreshTree();
      expanded.add(dir);
      saveExpanded();
      await openNote(path);
      return;
    }
    case "new-folder": {
      const name = promptName("New folder name", "New folder");
      if (!name) return;
      const path = joinPath(dir, name);
      await invoke("create_folder", { path });
      await refreshTree();
      expanded.add(path);
      saveExpanded();
      renderTree();
      return;
    }
    case "new-canvas": {
      const name = promptName("New canvas name", "Untitled.canvas");
      if (!name) return;
      const file = name.endsWith(".canvas") ? name : `${name}.canvas`;
      const path = joinPath(dir, file);
      await invoke("create_file", {
        path,
        content: JSON.stringify({ nodes: [], edges: [] }, null, 2) + "\n",
      });
      await refreshTree();
      expanded.add(dir);
      saveExpanded();
      await openNote(path);
      return;
    }
    case "new-drawing": {
      const name = promptName("New Excalidraw drawing", "Untitled.excalidraw");
      if (!name) return;
      const file = name.endsWith(".excalidraw") ? name : `${name}.excalidraw`;
      const path = joinPath(dir, file);
      await invoke("create_file", { path, content: emptyExcalidrawFile() });
      await refreshTree();
      expanded.add(dir);
      saveExpanded();
      await openNote(path);
      return;
    }
    case "new-base": {
      const name = promptName("New base name", "Untitled.base");
      if (!name) return;
      const file = name.endsWith(".base") ? name : `${name}.base`;
      const path = joinPath(dir, file);
      await invoke("create_file", {
        path,
        content:
          "filters:\n  and: []\nviews:\n  - type: table\n    name: Table\n",
      });
      await refreshTree();
      alert(`Created ${path} (Bases UI later).`);
      return;
    }
    case "new-kanban": {
      const name = promptName("New kanban board name", "Board.md");
      if (!name) return;
      const file = name.endsWith(".md") ? name : `${name}.md`;
      const path = joinPath(dir, file);
      const content =
        "---\n\nkanban-plugin: board\n\n---\n\n## Todo\n\n## Doing\n\n## Done\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\"}\n```\n%%\n";
      await invoke("create_file", { path, content });
      await refreshTree();
      expanded.add(dir);
      saveExpanded();
      await openNote(path);
      return;
    }
    case "make-copy": {
      if (!target.path) return;
      const to = uniqueCopyName(target.path, existingPaths());
      await invoke("copy_path", { from: target.path, to });
      await refreshTree();
      if (target.kind === "file" || target.kind === "tab") await openNote(to);
      return;
    }
    case "move-to": {
      if (!target.path) return;
      const destDir = promptName(
        target.kind === "folder" ? "Move folder to (vault path)" : "Move file to (folder path)",
        parentDir(target.path) || "",
      );
      if (destDir == null) return;
      const name = baseName(target.path);
      const to = joinPath(destDir.replace(/^\/+|\/+$/g, ""), name);
      await invoke("rename_path", { from: target.path, to });
      remapBookmarks(target.path, to, target.kind === "folder");
      if (currentPath === target.path) currentPath = to;
      openTabs = openTabs.map((t) => (t === target.path ? to : t));
      if (rightPath === target.path) rightPath = to;
      await refreshTree();
      renderTabBar();
      updateRightPane();
      return;
    }
    case "search-in-folder": {
      const folder =
        target.kind === "file" ? parentDir(target.path) : target.path;
      const input = $("file-filter") as HTMLInputElement;
      filterQuery = folder ? folder.toLowerCase() + "/" : "";
      input.value = folder ? folder + "/" : "";
      // Expand that folder
      if (folder) {
        expanded.add(folder);
        saveExpanded();
      }
      renderTree();
      input.focus();
      return;
    }
    case "bookmark": {
      if (!target.path && target.kind !== "empty") return;
      const path = target.path || "(vault root)";
      const list = loadBookmarks();
      if (!list.includes(path)) list.push(path);
      saveBookmarks(list);
      setTransientStatus(`Bookmarked: ${path}`, "#5ecf9a");
      return;
    }
    case "copy-path": {
      const path = target.path || ".";
      await navigator.clipboard.writeText(path);
      return;
    }
    case "show-explorer": {
      await invoke("reveal_in_explorer", { path: target.path || "" });
      return;
    }
    case "rename": {
      if (!target.path) return;
      const cur = baseName(target.path);
      let name = promptName("Rename to", cur);
      if (!name || name === cur) return;
      // Keep extension if the user drops it on a file rename
      if (target.kind === "file" || target.kind === "tab") {
        const dot = cur.lastIndexOf(".");
        if (dot > 0 && !name.includes(".")) {
          name = name + cur.slice(dot);
        }
      }
      const to = joinPath(parentDir(target.path), name);
      await invoke("rename_path", { from: target.path, to });
      remapBookmarks(target.path, to, target.kind === "folder");
      if (currentPath === target.path) {
        currentPath = to;
        updateChrome();
      }
      openTabs = openTabs.map((t) => (t === target.path ? to : t));
      if (rightPath === target.path) rightPath = to;
      await refreshTree();
      renderTabBar();
      await updateRightPane();
      saveSession();
      return;
    }
    case "delete": {
      if (!target.path) return;
      const ok = confirm(`Delete “${target.path}”? This cannot be undone.`);
      if (!ok) return;
      await invoke("delete_path", { path: target.path });
      removeBookmarksUnder(target.path, target.kind === "folder");
      if (currentPath === target.path) {
        currentPath = null;
        editor?.setDoc("");
        dirty = false;
      }
      openTabs = openTabs.filter((t) => t !== target.path);
      if (rightPath === target.path) rightPath = null;
      await refreshTree();
      renderTabBar();
      updateRightPane();
      updateChrome();
      saveSession();
      return;
    }
  }
}

function loadBookmarks(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function saveBookmarks(bookmarks: string[]) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
}

function remapBookmarks(from: string, to: string, includeChildren: boolean) {
  const prefix = `${from}/`;
  saveBookmarks(loadBookmarks().map((bookmark) => {
    if (bookmark === from) return to;
    if (includeChildren && bookmark.startsWith(prefix)) return `${to}${bookmark.slice(from.length)}`;
    return bookmark;
  }));
}

function removeBookmarksUnder(path: string, includeChildren: boolean) {
  const prefix = `${path}/`;
  saveBookmarks(loadBookmarks().filter((bookmark) =>
    bookmark !== path && !(includeChildren && bookmark.startsWith(prefix))
  ));
}

async function closeTab(path: string) {
  if (currentPath === path && dirty) {
    await saveFile(true);
    if (dirty) {
      const discard = confirm(`Automatic save of ${path} failed. Close and discard changes?`);
      if (!discard) return;
    }
  }
  openTabs = openTabs.filter((tab) => tab !== path);
  if (currentPath === path) {
    const next = openTabs[openTabs.length - 1];
    if (next) await openNote(next);
    else {
      currentPath = null;
      editor?.setDoc("");
      dirty = false;
      updateChrome();
      schedulePreview("");
      saveSession();
    }
  } else saveSession();
  renderTabBar();
}

function renderTabBar() {
  const bar = document.getElementById("tab-bar");
  if (!bar) return;
  bar.innerHTML = "";
  for (const path of openTabs) {
    const chip = document.createElement("div");
    chip.className = "tab-chip" + (path === currentPath ? " active" : "");
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, { kind: "tab", path }, handleCtxAction);
    });
    const label = document.createElement("button");
    label.type = "button";
    label.className = "tab-chip-label";
    label.textContent = baseName(path).replace(/\.md$/i, "");
    label.title = path;
    label.addEventListener("click", () => void openNote(path));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "tab-chip-x";
    x.textContent = "×";
    x.title = "Close tab";
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      await closeTab(path);
    });
    chip.appendChild(label);
    chip.appendChild(x);
    bar.appendChild(chip);
  }
}

async function updateRightPane() {
  const ws = document.getElementById("workspace");
  const body = document.getElementById("right-body");
  const pathEl = document.getElementById("right-path");
  if (!ws || !body || !pathEl) return;
  if (!rightPath) {
    ws.classList.remove("with-right");
    body.innerHTML = "";
    pathEl.textContent = "—";
    applyPaneSplit();
    return;
  }
  ws.classList.add("with-right");
  applyPaneSplit();
  pathEl.textContent = rightPath;
  try {
    const file = await invoke<OpenFile>("read_file", { path: rightPath });
    // Read-only preview of the note (full content, frontmatter handled in render)
    rememberPropertiesFoldState(body);
    body.innerHTML = renderPreview(file.content);
    bindPropertiesFoldState(body, file.path);
    const { body: markdownBody } = splitFrontmatter(file.content);
    await executeBlocksInPreview(
      markdownBody,
      body,
      makeEngineContext(file.path, file.content, (target) => void openWikilink(target)),
    );
    bindQueryUriLinks(body);
    bindExternalLinks(body);
    body.querySelectorAll<HTMLAnchorElement>("a.preview-wikilink").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        const t = a.dataset.wikilink;
        if (t) void openWikilink(t);
      });
    });
    bindLinkPreviews(body, {
      fromPath: file.path,
      openLink: (target) => void openWikilink(target),
    });
    void hydrateMarkdownImages(body, file.path)
      .catch((error) => console.warn("[right pane markdown image]", error));
    void hydrateExcalidrawEmbeds(body, file.path, (drawingPath) => void openNote(drawingPath))
      .then(() => hydrateNoteEmbeds(body, file.path, {
        openLink: (target) => void openWikilink(target),
      }))
      .catch((error) => console.warn("[right pane embed]", error));
    hydrateTableOfContents(body);
  } catch (e) {
    body.innerHTML = `<pre class="dv-error">${escapeHtml(String(e))}</pre>`;
  }
}

window.addEventListener("beforeunload", (e) => {
  saveSession();
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// Persist session periodically while running (crash safety)
setInterval(() => saveSession(), 15_000);

void renderShell();
