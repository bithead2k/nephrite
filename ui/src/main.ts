import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { NephriteEditor, type EditorPaneSnapshot, type FoldRange } from "./editor";
import { hydrateTableOfContents, renderBlockHtml, renderPreview } from "./preview";
import { planPreviewUpdate } from "./preview-blocks";
import { PreviewWorkerClient } from "./preview-worker-client";
import { patchPreviewHtml } from "./preview-patch";
import { findBooleanPropertyEdit, findScalarPropertyEdit, renderPropertiesHtml, splitFrontmatter, type PropertyType } from "./frontmatter";
import { splitWikilinkTarget } from "./wikilinks";
import {
  buildTree,
  filterTree,
  visibleFiles,
  type TreeNode,
} from "./tree";
import {
  DEFAULT_DAILY_NOTES,
  dateFromDailyPath,
  dailyPathForDate,
  existingDailyKeysForMonth,
  parseDailyNotesSettings,
  periodNotePath,
  renderDailyCalendar,
  shiftDate,
  type DailyNotesSettings,
  type PeriodKind,
} from "./daily-notes";
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
import { installZoomKeys } from "./zoom";
import { uiAlert, uiConfirm, uiPickFile, uiPrompt } from "./dialogs";
import { mergeTexts, showMergeEditor } from "./file-merge";
import {
  clearQueryDiagnostics,
  queryDiagnostic,
  queryDiagnosticText,
} from "./query-diagnostics";
import { installWindowStatePersistence } from "./window-state";
import {
  showContextMenu,
  showItemMenu,
  parentDir,
  joinPath,
  baseName,
  uniqueCopyName,
  type CtxAction,
  type CtxTarget,
} from "./context-menu";
import {
  headingSectionAt,
  headingSectionByOccurrence,
  newWikilinkPath,
  normalizeExtractHeading,
  planHeadingExtract,
  type HeadingSection,
  type NewFileSettings,
} from "./extract-heading";
import { shortestWikilinkTarget } from "./wikilinks";
import {
  clearScrollSync,
  CURSOR_SYNC_DELAY_MS,
  rebindScrollSync,
  setEditorDocumentEnd,
  withoutScrollSync,
} from "./scroll-sync";
import { bindLinkPreviews, dismissLinkPreview } from "./link-preview";
import { bindKanbanCardPreview, bindKanbanScrollPreviewGuard, dismissKanbanCardPreview } from "./kanban-card-preview";
import { clearKanbanCoverCache, hydrateKanbanCardCovers } from "./kanban-cover";
import { findNextTaskStatusEdit, hydratePreviewTaskMarkers } from "./tasks";
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
import { clearMediaSrcCache, hydrateMarkdownImages } from "./image-embed";
import { isAudioPath, isBasePath, isCodePath, isCsvPath, isImagePath, isPdfPath, isStructuredPath, isVideoPath } from "./file-kinds";
import { highlightPreviewCode } from "./syntax-highlight";
import { hydrateMermaid } from "./mermaid";
import { clearCodeView, renderCodeView } from "./code-view";
import { clearPdfView, renderPdfView } from "./pdf-view";
import { clearMediaView, renderAudioView, renderVideoView } from "./media-view";
import { clearCsvView, hydrateCsvFences, renderCsvView } from "./csv-view";
import { clearStructuredView, renderStructuredView } from "./structured-view";
import { renderAttachmentPanel } from "./attachment-panel";
import { renderSqlConsole } from "./sql-console";
import { emptyBaseSource } from "./bases";
import { hydrateBaseFences, pagesFromListRows, renderBaseView } from "./base-view";
import { renderPropertiesEditor } from "./properties-editor";
import type { SqlQueryResult } from "./dv-engine";
import { DeferredDocumentWork } from "./edit-scheduler";
import { claimOneTimeBinding, LatestPaneSwitch, missingAncestorPaths } from "./pane-switch";
import { PaneStateCache, type CachedPreview } from "./pane-cache";
import { RefreshGate } from "./refresh-gate";
import { resizedKanbanLaneWidth } from "./kanban-resize";
import { canPersistSession, editorTabTitle } from "./session-guard";
import { bindQueryUriLinks } from "./query-uri";
import {
  DeferredVaultChanges,
  vaultChangeInvalidatesPageCache,
  vaultChangeTouchesFileTree,
} from "./vault-change";
import {
  DirtyReactor,
  paneToRefresh,
  shouldCommitRightPane,
  shouldKeepPreviewWork,
  shouldRefreshPreviewFromOtherPages,
  shouldRefreshVaultStats,
  shouldReloadEditorFromVault,
} from "./editor-lock";
import { CanvasView, serializeCanvas } from "./canvas-view";
import { renderGraph } from "./graph-view";
import { renderLinkHealth } from "./link-health";
import { renderNoteContext, renderTagBrowser } from "./note-context";
import { collectPeople, renderAttendancePanel, type PersonRow } from "./people";
import {
  renderPersistentCommandBar,
  type AppCommand,
  type PersistentCommandBar,
} from "./command-bar";
import {
  PluginManager,
  type PluginDescriptor,
  type PluginViewResult,
} from "./plugin-host";
import { renderPluginManager } from "./plugin-manager";
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
import {
  APPEARANCE_FONTS_KEY,
  DEFAULT_APPEARANCE_FONTS,
  applyAppearanceFonts,
  loadAppearanceFonts,
  normalizeAppearanceFonts,
  type AppearanceFonts,
} from "./appearance";
import type {
  AttachmentRow,
  FileEntry,
  GitCommit,
  GitBranches,
  GitStatus,
  GitSyncStatus,
  GitCommitDetails,
  GitConflictSides,
  SearchResult,
  GraphData,
  LinkHealth,
  NoteContext,
  OpenFile,
  TagPage,
  VaultTag,
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
import "katex/dist/katex.min.css";

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
  pinned: string[];
  closed: string[];
  cursors: Record<string, number>;
};

const MAX_CLOSED_TABS = 20;

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
// Last bytes read or successfully written for each open file. Editor saves
// send this baseline to the backend so an external change cannot be silently
// overwritten by autosave.
const savedContentByPath = new Map<string, string>();
const paneStateCache = new PaneStateCache<EditorPaneSnapshot>(16);
const rightPaneStateCache = new PaneStateCache(8);
let pendingCursor: { line: number; col: number; totalLines: number } | null = null;
let pendingFolds = false;
let pendingChrome = false;
const deferredVaultChanges = new DeferredVaultChanges();
const dirtyReactor = new DirtyReactor(() => {
  const idle = dirtyReactor.consumeIdle(PREVIEW_DELAY_MS, AUTOSAVE_DELAY_MS);
  const reaction = dirtyReactor.consumeReaction();
  if (idle.save) void saveFile(true);
  if (idle.preview && editor && (viewMode === "split" || viewMode === "preview")) {
    const revision = ++previewRevision;
    void renderRightPane(editor.getDoc(), revision);
  }
  if (reaction && pendingCursor) {
    const { line, totalLines } = pendingCursor;
    pendingCursor = null;
    setEditorDocumentEnd(line === totalLines);
  }
  if (reaction && pendingFolds) {
    pendingFolds = false;
    rememberEditorFolds();
  }
  if (reaction && pendingChrome) {
    pendingChrome = false;
    updateChrome();
  }
  if (!dirtyReactor.isDirty && deferredVaultChanges.pending) {
    flushDeferredVaultChanges();
  }
});
dirtyReactor.start();
/** All markdown paths from the index (unfiltered). */
let mdFilesAll: FileEntry[] = [];
/** What the tree shows after dotfile + search filters. */
let mdFiles: FileEntry[] = [];
let dailyNotesSettings: DailyNotesSettings = { ...DEFAULT_DAILY_NOTES };
let filterQuery = "";
let sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
let showDotfiles = localStorage.getItem(DOTFILES_KEY) === "1";
let vimOn = localStorage.getItem(VIM_KEY) === "1";
let externalLinksInBrowser = localStorage.getItem(EXTERNAL_BROWSER_KEY) === "1";
let appearanceFonts = loadAppearanceFonts();
let viewMode: ViewMode = normalizeMode(localStorage.getItem(VIEW_KEY));
const previewWork = new DeferredDocumentWork(PREVIEW_DELAY_MS);
const previewRenderer = new PreviewWorkerClient();
const rightPreviewRenderer = new PreviewWorkerClient();
const vaultPreviewRefresh = new RefreshGate();
let previewRevision = 0;
let rightPaneRevision = 0;
/** Last markdown body committed to the preview (for trivial block patches). */
let lastPreviewBody: string | null = null;
let lastPreviewPath: string | null = null;
let statusHintTimer: number | null = null;
let autosaveTimer: number | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let vaultOpen = false;
let refreshInProgress = false;
let activeOpenPlan: VaultOpenPlan | null = null;
let vaultChangeQueue: Promise<void> = Promise.resolve();
let commandPrompt: PersistentCommandBar | null = null;
let expanded = loadExpanded();
let treeRoot: TreeNode = { name: "", path: "", kind: "dir", children: [] };
let kanbanBoard: KanbanBoard | null = null;
let kanbanCoverRevision = 0;
/** Open file tabs for this vault (restored on open). */
let openTabs: string[] = [];
let pinnedTabs = new Set<string>();
let closedTabs: string[] = [];
let tabCursors: Record<string, number> = {};
/** Secondary pane path for "Open to the right". */
let rightPath: string | null = null;
let renderedRightPath: string | null = null;
let renderedRightContent: string | null = null;
/** Editor share of split width (0.15–0.85). */
let paneSplit = loadPaneSplit();
/** Skip session writes during restore. */
let restoringSession = false;
/** True only after vault data, plugins, automation, and pane restoration finish. */
let sessionPersistenceReady = false;
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

function syncVisiblePaths() {
  const paths = new Set<string>();
  if (currentPath) paths.add(currentPath);
  if (rightPath) paths.add(rightPath);
  for (const path of openTabs) paths.add(path);
  void invoke("set_visible_paths", { paths: [...paths] }).catch(() => {
    /* vault not open yet */
  });
}

function saveSession() {
  // The last-vault key exists before automatic startup indexing finishes.
  // Do not let the crash-safety timer overwrite a valid saved workspace with
  // the still-empty startup state while a large index is opening.
  if (!canPersistSession(vaultOpen, restoringSession, sessionPersistenceReady)) return;
  const vault = localStorage.getItem(LAST_VAULT_KEY);
  if (!vault) return;
  const tabs = [...openTabs];
  if (currentPath && !tabs.includes(currentPath)) tabs.push(currentPath);
  const session: SessionState = {
    tabs,
    active: currentPath,
    right: rightPath,
    pinned: [...pinnedTabs],
    closed: closedTabs,
    cursors: rememberOpenCursors(),
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
      pinned: Array.isArray(s.pinned) ? s.pinned.filter((t) => typeof t === "string") : [],
      closed: Array.isArray(s.closed) ? s.closed.filter((t) => typeof t === "string") : [],
      cursors: parseCursorMap(s.cursors),
    };
  } catch {
    return null;
  }
}

function pathExistsInIndex(path: string): boolean {
  return mdFilesAll.some((f) => f.path === path);
}

function parseCursorMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[path] = value;
  }
  return out;
}

function rememberOpenCursors(): Record<string, number> {
  if (currentPath && editor) tabCursors[currentPath] = editor.getCursor();
  const kept: Record<string, number> = {};
  for (const path of openTabs) {
    if (tabCursors[path] != null) kept[path] = tabCursors[path];
  }
  return kept;
}

/** Re-open tabs / active note / right pane after vault index is ready. */
async function restoreSession(vaultRoot: string) {
  const session = loadSession(vaultRoot);
  if (!session) return;

  restoringSession = true;
  try {
    const tabs = session.tabs.filter(pathExistsInIndex);
    const pinned = session.pinned.filter(pathExistsInIndex);
    pinnedTabs = new Set(pinned);
    openTabs = [
      ...pinned.filter((path) => tabs.includes(path)),
      ...tabs.filter((path) => !pinnedTabs.has(path)),
    ];
    closedTabs = session.closed.filter(pathExistsInIndex).slice(0, MAX_CLOSED_TABS);
    tabCursors = Object.fromEntries(
      Object.entries(session.cursors).filter(([path]) => pathExistsInIndex(path)),
    );
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
    syncVisiblePaths();
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

type ActivityId = "files" | "search" | "graph" | "links" | "tags" | "tasks" | "bookmarks" | "git" | "query-log" | "attachments" | "sql";

function activityIcon(name: ActivityId | "settings" | "file-search" | "panel-close" | "folder-open" | "refresh"): string {
  const paths: Record<string, string> = {
    files: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    graph: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
    links: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/>',
    tags: '<path d="M12 2 2 12l8 8 10-10V2Z"/><circle cx="8.5" cy="7.5" r="1"/>',
    tasks: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    bookmarks: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
    git: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M8 6h6a4 4 0 0 1 4 4v0"/>',
    "query-log": '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    attachments: '<path d="M21.4 11.6 10.1 22.9a5 5 0 0 1-7.1-7.1l12.7-12.7a3.5 3.5 0 0 1 5 5L9.1 19.7a2 2 0 1 1-2.8-2.8l10.6-10.6"/>',
    sql: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
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
          <button type="button" id="activity-links" class="activity-button" title="Links and outline" aria-label="Links and outline" aria-pressed="false" disabled>${activityIcon("links")}</button>
          <button type="button" id="activity-tags" class="activity-button" title="Tags" aria-label="Tags" aria-pressed="false" disabled>${activityIcon("tags")}</button>
          <button type="button" id="activity-tasks" class="activity-button" title="Tasks" aria-label="Tasks" aria-pressed="false" disabled>${activityIcon("tasks")}</button>
          <button type="button" id="activity-bookmarks" class="activity-button" title="Bookmarks" aria-label="Bookmarks" aria-pressed="false" disabled>${activityIcon("bookmarks")}</button>
          <button type="button" id="activity-git" class="activity-button" title="Git" aria-label="Git" aria-pressed="false" disabled>${activityIcon("git")}</button>
          <button type="button" id="activity-query-log" class="activity-button" title="Query log" aria-label="Query log" aria-pressed="false">${activityIcon("query-log")}</button>
          <button type="button" id="activity-attachments" class="activity-button" title="Attachments" aria-label="Attachments" aria-pressed="false" disabled>${activityIcon("attachments")}</button>
          <button type="button" id="activity-sql" class="activity-button" title="SQL console" aria-label="SQL console" aria-pressed="false" disabled>${activityIcon("sql")}</button>
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
              <strong>Appearance fonts</strong>
              <small>Enter a CSS font-family or fallback stack. Empty fields use Nephrite defaults; the editor then falls back to <code>guifont</code> from your Vim configuration.</small>
              <div class="preferences-font-grid">
                <label for="appearance-font-ui">Interface</label><input type="text" id="appearance-font-ui" placeholder='"Segoe UI", system-ui' />
                <label for="appearance-font-editor">Editor/code</label><input type="text" id="appearance-font-editor" placeholder='"DejaVu Sans Mono", monospace' />
                <label for="appearance-font-preview">Preview</label><input type="text" id="appearance-font-preview" placeholder='system-ui, sans-serif' />
                <label for="appearance-font-powerline">Powerline</label><input type="text" id="appearance-font-powerline" placeholder='"DejaVu Sans Mono", "PowerlineSymbols"' />
              </div>
              <div class="preferences-font-actions">
                <button type="button" id="appearance-font-save">Save fonts</button>
                <button type="button" id="appearance-font-reset">Reset</button>
              </div>
            </section>
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
              <div class="preferences-font-actions">
                <button type="button" id="preferences-plugin-browse">Browse plugins…</button>
                <button type="button" id="preferences-plugin-reload">Reload plugins</button>
              </div>
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
            <button type="button" id="btn-today-side" class="btn-today-side" disabled title="Daily notes calendar">📅</button>
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
        <div id="tab" class="tab"></div>
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
          <div id="media-workspace" class="media-workspace hidden">
            <div id="pdf-host" class="pdf-host hidden" tabindex="-1"></div>
            <div id="code-host" class="code-host hidden" tabindex="-1"></div>
            <div id="av-host" class="av-host hidden" tabindex="-1"></div>
            <div id="data-host" class="data-host hidden" tabindex="-1"></div>
          </div>
        </div>
        <footer class="command-footer" id="command-footer" aria-label="Command bar">
          <div id="persistent-command-bar"></div>
          <span id="status-hint" class="status-muted">${STATUS_HINT}</span>
        </footer>
      </section>
    </div>
    <div id="plugin-host" hidden></div>
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
  applyAppearanceFonts(appearanceFonts);
  commandPrompt = renderPersistentCommandBar(
    $("persistent-command-bar"),
    () => commandCatalog(true).filter((command) => command.id !== "command"),
    (command) => shFull(command),
  );

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
  $("btn-today-side").addEventListener("click", () => void showDailyCalendar());
  $("btn-drawing").addEventListener("click", () => void createDrawing());
  $("btn-canvas").addEventListener("click", () => void createCanvas());
  $("activity-search").addEventListener("click", () => void showSearchPanel());
  $("activity-graph").addEventListener("click", () => void showGraphPanel());
  $("activity-links").addEventListener("click", () => void showNoteContextPanel());
  $("activity-tags").addEventListener("click", () => void showTagBrowserPanel());
  $("canvas-add-text").addEventListener("click", () => canvasView?.addText());
  $("canvas-add-file").addEventListener("click", () => {
    void uiPrompt("Vault-relative note path", { defaultValue: currentPath?.replace(/\.canvas$/i, ".md") ?? "" }).then((path) => {
      if (path?.trim()) canvasView?.addFile(path.trim());
    });
  });
  $("canvas-add-link").addEventListener("click", () => {
    void uiPrompt("Link URL", { defaultValue: "https://" }).then(async (url) => {
      if (!url?.trim()) return;
      const label = await uiPrompt("Card label", { defaultValue: url.trim() });
      canvasView?.addLink(url.trim(), label?.trim() || url.trim());
    });
  });
  $("canvas-add-group").addEventListener("click", () => {
    void uiPrompt("Group label", { defaultValue: "Group" }).then((label) => {
      if (label?.trim()) canvasView?.addGroup(label.trim());
    });
  });
  $("canvas-delete").addEventListener("click", () => canvasView?.deleteSelected());
  $("canvas-edit-edge").addEventListener("click", () => {
    void (async () => {
      if (!(await canvasView?.editSelectedEdge())) setTransientStatus("Select a canvas edge first", "#e9ad55");
    })();
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
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const commands = commandCatalog(false);
    const id = shortcuts.match(event, commands.map((command) => command.id));
    if (!id) return;
    const command = commands.find((candidate) => candidate.id === id);
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    void Promise.resolve(command.run()).catch((error) => void uiAlert(String(error)));
  }, true);
  document.addEventListener("keydown", recordEditorInputTiming, true);
  $("activity-links").addEventListener("click", () => void showNoteContextPanel());
  $("activity-tags").addEventListener("click", () => void showTagBrowserPanel());
  $("activity-tasks").addEventListener("click", () => void showTasksPanel());
  $("activity-bookmarks").addEventListener("click", showBookmarksPanel);
  $("activity-git").addEventListener("click", () => void showGitPanel());
  $("activity-query-log").addEventListener("click", showQueryLogPanel);
  $("activity-attachments").addEventListener("click", () => void showAttachmentsPanel());
  $("activity-sql").addEventListener("click", () => showSqlConsole());
  $("btn-preferences").addEventListener("click", togglePreferences);
  ($("task-scope-folders") as HTMLInputElement).value = taskScope.folders.join(", ");
  ($("task-scope-tags") as HTMLInputElement).value = taskScope.tags.join(", ");
  ($("task-scope-property") as HTMLInputElement).value = taskScope.property;
  $("task-scope-save").addEventListener("click", saveTaskScopePreferences);
  $("appearance-font-save").addEventListener("click", saveAppearanceFontPreferences);
  $("appearance-font-reset").addEventListener("click", resetAppearanceFontPreferences);
  $("preferences-plugin-reload").addEventListener("click", () => void reloadPlugins().then(renderPreferencesPlugins));
  $("preferences-plugin-browse").addEventListener("click", () => {
    closePreferences();
    void showPluginManager();
  });
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
    if (uri) void openUrl(uri).catch((error) => void uiAlert(String(error)));
  });
  document.addEventListener("nephrite-open-external", (event) => {
    const detail = (event as CustomEvent<{ uri?: string }>).detail;
    if (detail?.uri) openExternalView(detail.uri);
  });
  $("right-close").addEventListener("click", () => {
    closeRightPane();
  });
  installPaneSplitter();
  applyPaneSplit();
  $("vim-toggle").addEventListener("change", (e) => {
    vimOn = (e.target as HTMLInputElement).checked;
    localStorage.setItem(VIM_KEY, vimOn ? "1" : "0");
    editor?.setVim(vimOn);
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
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && dirty) void saveFile(true);
  });
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
    createFile: async (path, content) => {
      await invoke("create_file", { path, content });
      await refreshTree();
    },
    renamePath: async (from, to) => {
      if (from === currentPath && dirty) throw new Error("Save or discard current edits before a plugin renames this file");
      await invoke("rename_path", { from, to });
      if (from === currentPath) await openNote(to, { skipDirtyPrompt: true });
      await refreshTree();
    },
    deletePath: async (path) => {
      if (path === currentPath && dirty) throw new Error("Save or discard current edits before a plugin deletes this file");
      await invoke("delete_path", { path });
      await refreshTree();
    },
    queryIndex: (sql) => invoke("query_vault_sql", { sql }),
    pageMetadata: async (path) => {
      const rows = await invoke<Array<Record<string, unknown>>>("list_pages", { source: null });
      return rows.find((row) => row.path === path || row.path === `${path}.md`) ?? null;
    },
    metadataSnapshot: () => invoke<Array<Record<string, unknown>>>("list_pages", { source: null }),
    resolveLink: async (link, sourcePath) => {
      const path = await invoke<string | null>("resolve_wikilink", { target: link, fromPath: sourcePath });
      return path ? mdFilesAll.find((file) => file.path === path) ?? {
        path,
        name: path.replace(/^.*\//, ""),
        parent_path: path.includes("/") ? path.replace(/\/[^/]+$/, "") : "",
        file_kind: "markdown",
      } : null;
    },
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
    executeCommand: async (id) => {
      const command = commandCatalog(false).find((candidate) => candidate.id === id);
      if (!command) throw new Error(`Unknown command: ${id}`);
      await command.run();
    },
    pluginInfo: (id) => {
      const statuses = pluginManager?.statuses() ?? [];
      return id == null ? statuses : statuses.find((plugin) => plugin.id === id) ?? null;
    },
    showView: showPluginView,
    readPluginData: async (id) => {
      try {
        const file = await invoke<OpenFile>("read_file", { path: `.obsidian/plugins/${id}/data.json` });
        return JSON.parse(file.content);
      } catch {
        return null;
      }
    },
    writePluginData: async (id, value) => {
      await invoke("write_file", {
        path: `.obsidian/plugins/${id}/data.json`,
        content: `${JSON.stringify(value ?? {}, null, 2)}\n`,
      });
    },
    persistPluginEnabled: async (id, enabled) => {
      const compatibility = pluginManager?.statuses().find((plugin) => plugin.id === id)?.compatibility
        ?? "obsidian";
      if (compatibility !== "obsidian") return;
      await invoke("set_community_plugin_enabled", { id, enabled });
    },
    executeShell: (command, args) => invoke("shell_command", {
      command: [command, ...args].map(shellArgument).join(" "), cwd: null, timeoutMs: 60_000,
    }),
    requestUrl: (request) => invoke("plugin_http_request", { request }),
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
        const changed = dirty !== d;
        dirty = d;
        if (d) dirtyReactor.markDirty();
        else dirtyReactor.clearDirty();
        if (changed || !d) {
          pendingChrome = true;
          dirtyReactor.requestReaction();
        }
      },
      onSave: () => saveFile(false),
      onVimMessage: (message, isError) =>
        setTransientStatus(message, isError ? "#e9ad55" : "#5ecf9a"),
      onCursor: (line, col, totalLines) => {
        pendingCursor = { line, col, totalLines };
        dirtyReactor.requestReaction();
      },
      onOpenWikilink: (target) => void openWikilink(target),
      onFoldsChanged: () => {
        pendingFolds = true;
        dirtyReactor.requestReaction();
      },
      onSaveAttachments: async (files) => {
        if (!currentPath) return [];
        const { saveDroppedFiles } = await import("./attachments");
        return saveDroppedFiles(files, currentPath);
      },
    },
    vimOn,
    userVimrc,
  );
  editor.view.dom.addEventListener("contextmenu", (event) => {
    if (!editor || currentFileKind !== "markdown") return;
    const pos = editor.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return;
    const section = headingSectionAt(editor.getDoc(), pos);
    if (!section) return;
    event.preventDefault();
    showItemMenu(event.clientX, event.clientY, [
      { id: "extract-heading", label: "Extract Heading" },
    ], (id) => {
      if (id === "extract-heading") void extractHeadingSectionToNote(section);
    });
  });
  schedulePreview("");
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

const appearanceFontInputs: Record<keyof AppearanceFonts, string> = {
  ui: "appearance-font-ui",
  editor: "appearance-font-editor",
  preview: "appearance-font-preview",
  powerline: "appearance-font-powerline",
};

function loadAppearanceFontInputs() {
  for (const [key, id] of Object.entries(appearanceFontInputs) as Array<[keyof AppearanceFonts, string]>) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = appearanceFonts[key];
  }
}

function saveAppearanceFontPreferences() {
  const candidate = Object.fromEntries(
    (Object.entries(appearanceFontInputs) as Array<[keyof AppearanceFonts, string]>).map(
      ([key, id]) => [key, (document.getElementById(id) as HTMLInputElement).value],
    ),
  );
  appearanceFonts = normalizeAppearanceFonts(candidate);
  localStorage.setItem(APPEARANCE_FONTS_KEY, JSON.stringify(appearanceFonts));
  applyAppearanceFonts(appearanceFonts);
  loadAppearanceFontInputs();
  setTransientStatus("Appearance fonts saved", "#5ecf9a");
}

function resetAppearanceFontPreferences() {
  appearanceFonts = { ...DEFAULT_APPEARANCE_FONTS };
  localStorage.removeItem(APPEARANCE_FONTS_KEY);
  applyAppearanceFonts(appearanceFonts);
  loadAppearanceFontInputs();
  setTransientStatus("Appearance fonts reset", "#5ecf9a");
}

function togglePreferences() {
  const popover = $("preferences-popover");
  const opening = popover.classList.contains("hidden");
  popover.classList.toggle("hidden", !opening);
  if (opening) {
    loadPreviewCssEditor();
    loadAppearanceFontInputs();
  }
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
  if (shouldKeepPreviewWork(mode) && editor) {
    schedulePreview(editor.getDoc());
  } else {
    cancelPreviewWork();
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

function schedulePreview(text: string) {
  schedulePreviewRead(() => text);
}

function scheduleEditorPreview() {
  schedulePreviewRead(() => editor?.getDoc() ?? "");
}

function cancelPreviewWork(): void {
  previewRevision++;
  previewWork.cancel();
  previewRenderer.cancel();
}

function schedulePreviewRead(read: () => string) {
  previewWork.cancel();
  previewRenderer.cancel();
  const revision = ++previewRevision;
  if (!shouldKeepPreviewWork(viewMode)) return;
  previewWork.schedule(read, (text) => {
    void renderRightPane(text, revision);
  });
}

function forceRenderCurrentDocument(): void {
  lastPreviewBody = null;
  lastPreviewPath = null;
  previewWork.cancel();
  previewRenderer.cancel();
  const revision = ++previewRevision;
  void renderRightPane(editor?.getDoc() ?? "", revision);
}

function refreshCurrentPane(): void {
  const rightHost = document.getElementById("right-body");
  const target = paneToRefresh({
    rightOpen: Boolean(rightPath),
    rightFocused: Boolean(rightHost && document.activeElement && rightHost.contains(document.activeElement)),
    kanbanVisible: Boolean(
      currentFileKind === "markdown" &&
      kanbanBoard &&
      !$("kanban").classList.contains("hidden"),
    ),
    viewMode,
  });
  if (target === "right") {
    void updateRightPane();
    setTransientStatus("Refreshed right pane", "#5ecf9a");
    return;
  }
  if (target === "kanban") {
    clearKanbanCoverCache();
    forceRenderCurrentDocument();
    setTransientStatus("Refreshed board", "#5ecf9a");
    return;
  }
  if (target === "preview") {
    forceRenderCurrentDocument();
    setTransientStatus("Refreshed preview", "#5ecf9a");
    return;
  }
  if (!currentPath) return;
  if (currentFileKind === "markdown") {
    if (dirty) {
      setTransientStatus("Unsaved edits — not reloading source", "#e9ad55");
      return;
    }
    void openNote(currentPath, { skipDirtyPrompt: true, forceReload: true }).then(() => {
      setTransientStatus("Reloaded from disk", "#5ecf9a");
    }).catch((error) => {
      setTransientStatus(`Reload failed: ${String(error)}`, "#e9ad55");
    });
    return;
  }
  void openNote(currentPath, { forceReload: true });
  setTransientStatus("Refreshed", "#5ecf9a");
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
        if (!/```(?:pgsql\b|dataview|dataviewjs|js|javascript|tasks\b)/i.test(block)) continue;
        const node = previewEl.querySelector(
          `:scope > .md-block[data-block-index="${index}"]`,
        ) as HTMLElement | null;
        if (!node) continue;
        const tpl = document.createElement("template");
        tpl.innerHTML = renderBlockHtml(block, index).trim();
        const fresh = tpl.content.firstElementChild as HTMLElement | null;
        if (!fresh) continue;
        if (pluginManager?.hasPostProcessors() || pluginManager?.hasCodeBlockProcessors()) {
          const processed = await applyPluginPreviewProcessors(fresh.outerHTML, path);
          const reprocessed = document.createElement("template");
          reprocessed.innerHTML = processed;
          node.replaceWith(reprocessed.content.firstElementChild ?? fresh);
        } else {
          node.replaceWith(fresh);
        }
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
      bindPreviewContent(previewEl, path, revision);
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
        if (pluginManager?.hasPostProcessors() || pluginManager?.hasCodeBlockProcessors()) {
          const processed = await applyPluginPreviewProcessors(node.outerHTML, path);
          const reprocessed = document.createElement("template");
          reprocessed.innerHTML = processed;
          existing.replaceWith(reprocessed.content.firstElementChild ?? node);
        } else {
          existing.replaceWith(node);
        }
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
        bindPreviewContent(previewEl, path, revision);
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
  await yieldToUi();
  if (!path || !isPreviewRevisionCurrent(path, revision)) {
    queryDiagnostic("preview.worker.discard", { path, revision, previewRevision });
    return;
  }
  const commitStarted = performance.now();
  const forceFull = previewEl.dataset.previewPath !== path;
  const host = document.getElementById("preview-host");
  const scrollTop = host?.scrollTop ?? 0;
  const scrollLeft = host?.scrollLeft ?? 0;
  let commitHtml = markup.html;
  try {
    commitHtml = await applyPluginPreviewProcessors(markup.html, path);
  } catch (error) {
    queryDiagnostic("preview.plugin-processor.error", {
      path,
      revision,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!path || !isPreviewRevisionCurrent(path, revision)) {
    queryDiagnostic("preview.worker.discard", { path, revision, previewRevision });
    return;
  }
  const patch = patchPreviewHtml(previewEl, commitHtml, forceFull);
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
    bindPreviewContent(previewEl, path, revision);
    void renderDynamicPreview(text, path, revision, previewEl);
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
    void openUrl(uri).catch((error) => void uiAlert(String(error)));
    return;
  }
  if (externalLinksInBrowser) {
    void openUrl(parsed.href).catch((error) => void uiAlert(String(error)));
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

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

const previewHydrationTickets = new WeakMap<HTMLElement, number>();
let previewHydrationTicket = 0;

function scheduleDeferredPreviewHydration(
  root: HTMLElement,
  path: string,
  live: () => boolean,
): void {
  const ticket = ++previewHydrationTicket;
  previewHydrationTickets.set(root, ticket);
  root.dataset.previewHydrated = "0";
  requestAnimationFrame(() => {
    if (!live() || previewHydrationTickets.get(root) !== ticket) return;
    // The source and primary interactions have painted. These processors can
    // scan large subtrees or cross the Tauri boundary, so keep them out of the
    // pane-click frame.
    const images = hydrateMarkdownImages(root, path)
      .catch((error) => console.warn("[markdown image]", error));
    const drawings = hydrateExcalidrawEmbeds(root, path, (drawingPath) => void openNote(drawingPath))
      .catch((error) => console.warn("[excalidraw embed]", error));
    const notes = hydrateNoteEmbeds(root, path, {
      openLink: (target) => void openWikilink(target),
      shouldContinue: live,
    }).catch((error) => console.warn("[note embed]", error));
    if (!live()) return;
    highlightPreviewCode(root);
    hydrateCsvFences(root);
    const bases = loadBasePages()
      .then((pages) => {
        if (live()) hydrateBaseFences(root, pages, (target) => void openNote(target));
      })
      .catch((error) => console.warn("[base fence]", error));
    const diagrams = hydrateMermaid(root).catch((error) => console.warn("[mermaid]", error));
    bindLinkPreviews(root, {
      fromPath: path,
      openLink: (target) => void openWikilink(target),
    });
    hydrateTableOfContents(root);
    bindPreviewHeadingExtract(root, path);
    void Promise.allSettled([images, drawings, notes, bases, diagrams]).then(() => {
      if (live() && previewHydrationTickets.get(root) === ticket) {
        root.dataset.previewHydrated = "1";
      }
    });
  });
}

function bindPreviewContent(
  root: HTMLElement,
  path: string,
  revision?: number,
  liveOverride?: () => boolean,
) {
  const live = liveOverride ?? (() =>
    revision == null || isPreviewRevisionCurrent(path, revision));
  if (!live()) return;
  bindPropertiesFoldState(root, path);
  bindQueryUriLinks(root);
  bindExternalLinks(root);
  hydratePreviewTaskMarkers(root);
  root.querySelectorAll<HTMLInputElement>("li > input[type=checkbox]:not(.prop-bool)").forEach(
    (checkbox) => {
      if (checkbox.dataset.taskBound === "1") return;
      checkbox.dataset.taskBound = "1";
      const taskIndex = Number(checkbox.dataset.taskIndex);
      checkbox.disabled = path !== currentPath || !editor;
      checkbox.title = checkbox.disabled
        ? "Open this note to change the task"
        : "Click to cycle task status";
      checkbox.addEventListener("click", (event) => {
        event.preventDefault();
        if (!editor || path !== currentPath) return;
        const edit = findNextTaskStatusEdit(
          editor.getDoc(),
          taskIndex,
          checkbox.closest<HTMLElement>("li")?.dataset.taskStatus || " ",
        );
        if (!edit) {
          setTransientStatus("Could not safely locate this task in Markdown", "#e9ad55");
          return;
        }
        editor.replaceRange(edit.from, edit.to, edit.insert);
      });
    },
  );
  root.querySelectorAll<HTMLButtonElement>("button.task-status-marker").forEach((button) => {
    if (button.dataset.taskBound === "1") return;
    button.dataset.taskBound = "1";
    const taskIndex = Number(button.dataset.taskIndex);
    button.disabled = path !== currentPath || !editor;
    button.addEventListener("click", () => {
      if (!editor || path !== currentPath) return;
      const edit = findNextTaskStatusEdit(
        editor.getDoc(),
        taskIndex,
        button.dataset.taskStatus || " ",
      );
      if (!edit) {
        setTransientStatus("Could not safely locate this task in Markdown", "#e9ad55");
        return;
      }
      editor.replaceRange(edit.from, edit.to, edit.insert);
    });
  });
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
  root.querySelectorAll<HTMLInputElement>("input.prop-value[data-property-key]").forEach(
    (input) => {
      if (input.dataset.propertyBound === "1") return;
      input.dataset.propertyBound = "1";
      input.disabled = path !== currentPath || !editor;
      input.addEventListener("change", () => {
        if (!editor || path !== currentPath) return;
        const key = input.dataset.propertyKey;
        const type = input.dataset.propertyType as PropertyType | undefined;
        const edit = key && type
          ? findScalarPropertyEdit(editor.getDoc(), key, input.value, type)
          : null;
        if (!edit) {
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
  scheduleDeferredPreviewHydration(root, path, live);
}

function bindPreviewHeadingExtract(root: HTMLElement, path: string) {
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
    .filter((heading) => !heading.closest(".note-embed"));
  headings.forEach((heading) => {
    if (heading.dataset.extractBound === "1") return;
    heading.dataset.extractBound = "1";
    heading.addEventListener("contextmenu", (event) => {
      if (path !== currentPath || !editor) return;
      event.preventDefault();
      event.stopPropagation();
      const label = heading.textContent?.trim() || "";
      const wanted = normalizeExtractHeading(label);
      const occurrence = headings
        .filter((el) => normalizeExtractHeading(el.textContent || "") === wanted)
        .indexOf(heading);
      const section = headingSectionByOccurrence(editor.getDoc(), label, occurrence);
      if (!section) {
        setTransientStatus("Could not locate this heading in Markdown", "#e9ad55");
        return;
      }
      showItemMenu(event.clientX, event.clientY, [
        { id: "extract-heading", label: "Extract Heading" },
      ], (id) => {
        if (id === "extract-heading") void extractHeadingSectionToNote(section);
      });
    });
  });
}

async function readNewFileSettings(): Promise<NewFileSettings> {
  try {
    const file = await invoke<{ content: string }>("read_file", { path: ".obsidian/app.json" });
    return JSON.parse(file.content) as NewFileSettings;
  } catch {
    return {};
  }
}

function extractHeadingAtCursor() {
  if (!editor || currentFileKind !== "markdown") {
    setTransientStatus("Open a Markdown note to extract a heading", "#e9ad55");
    return;
  }
  const section = headingSectionAt(editor.getDoc(), editor.getCursor());
  if (!section) {
    setTransientStatus("Place the cursor on a heading line", "#e9ad55");
    return;
  }
  void extractHeadingSectionToNote(section);
}

async function extractHeadingSectionToNote(section: HeadingSection) {
  if (!editor || !currentPath || currentFileKind !== "markdown") return;
  const markdown = editor.getDoc();
  const settings = await readNewFileSettings();
  const existing = vaultFilesAll.map((file) => file.path);
  const planned = planHeadingExtract({
    markdown,
    section,
    currentPath,
    settings,
    existingPaths: existing,
    linkFor: (path) => shortestWikilinkTarget(path, [...vaultFilesAll, { path }]),
  });
  if ("error" in planned) {
    setTransientStatus(planned.error, "#e9ad55");
    return;
  }
  try {
    await invoke("create_file", { path: planned.path, content: planned.content });
  } catch (error) {
    setTransientStatus(String(error), "#e9ad55");
    return;
  }
  editor.replaceRange(planned.from, planned.to, planned.insert);
  await refreshTree();
  setTransientStatus(`Extracted heading to ${planned.path}`, "#5ecf9a");
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
      () => isPreviewRevisionCurrent(path, revision),
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
    sourceBlocks: target.querySelectorAll("pre > code.language-pgsql, pre > code.language-dataview, pre > code.language-dataviewjs").length,
  });
  bindPreviewContent(target, path, revision);
  requestAnimationFrame(() => setupScrollSync());
}

function isPreviewRevisionCurrent(path: string, revision: number): boolean {
  return revision === previewRevision && currentPath === path &&
    (viewMode === "split" || viewMode === "preview");
}

/**
 * Run plugin markdown post-processors and code-block processors over rendered
 * preview HTML before it is committed. Transforming the HTML string (rather
 * than mutating the live DOM after commit) keeps patchPreviewHtml's block keys
 * stable across re-renders. Returns the input unchanged when no plugin has
 * registered a processor.
 */
async function applyPluginPreviewProcessors(html: string, path: string): Promise<string> {
  if (!pluginManager) return html;
  if (!pluginManager.hasPostProcessors() && !pluginManager.hasCodeBlockProcessors()) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;

  // Code-block processors: replace matching fences with plugin output.
  for (const codeEl of Array.from(root.querySelectorAll<HTMLElement>("pre > code"))) {
    const cls = codeEl.className || "";
    const lang = ((cls.match(/language-(\S+)/) || [])[1] || "").toLowerCase();
    if (!lang || lang === "mermaid" || lang === "mmd") continue;
    if (!pluginManager.hasCodeBlockProcessor(lang)) continue;
    const pre = codeEl.closest("pre");
    if (!pre) continue;
    const output = await pluginManager.runCodeBlockProcessor(lang, codeEl.textContent || "", path);
    if (output == null) continue;
    const wrapper = document.createElement("div");
    wrapper.className = `plugin-code-block plugin-code-block-${lang}`;
    wrapper.dataset.pluginLanguage = lang;
    wrapper.innerHTML = output;
    pre.replaceWith(wrapper);
  }

  // Post-processors: run over each top-level markdown block in order.
  if (pluginManager.hasPostProcessors()) {
    for (const block of Array.from(root.querySelectorAll<HTMLElement>(":scope > .md-block"))) {
      const processed = await pluginManager.runPostProcessors(block.innerHTML, path);
      if (processed !== block.innerHTML) block.innerHTML = processed;
    }
  }

  return template.innerHTML;
}

function acceptKanbanDrop(event: DragEvent, toCol: number): void {
  event.preventDefault();
  const raw =
    event.dataTransfer?.getData("application/x-nephrite-kanban") ||
    event.dataTransfer?.getData("text/plain") ||
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
  if (fromCol === toCol) return;
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
      const landEv: KanbanCardMovedEvent = {
        ...leaveEv,
        columns: nextCols,
        phase: "land",
      };
      await fireKanbanCardMoved(landEv);
      setHookStatus(`Hooks done: ${card.label.slice(0, 40)} → ${toName}`);
    } catch (err) {
      setHookStatus(
        `Hook failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  })();
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
  bindKanbanScrollPreviewGuard(host);
  bindKanbanScrollPreviewGuard(scroller);
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
    bindKanbanScrollPreviewGuard(list);

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      list.classList.add("drag-over");
    });
    list.addEventListener("dragleave", () => list.classList.remove("drag-over"));
    colEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (colEl.classList.contains("kanban-col-collapsed")) colEl.classList.add("drag-over");
    });
    colEl.addEventListener("dragleave", (e) => {
      if (e.relatedTarget instanceof Node && colEl.contains(e.relatedTarget)) return;
      colEl.classList.remove("drag-over");
      list.classList.remove("drag-over");
    });
    colEl.addEventListener("drop", (e) => {
      list.classList.remove("drag-over");
      colEl.classList.remove("drag-over");
      acceptKanbanDrop(e, colIdx);
    });

    col.cards.forEach((card, cardIdx) => {
      const cardEl = document.createElement("article");
      cardEl.className = "kanban-card" + (card.checked ? " done" : "");
      cardEl.draggable = true;
      cardEl.dataset.col = String(colIdx);
      cardEl.dataset.idx = String(cardIdx);
      cardEl.dataset.searchMatch = "false";
      if (card.link) cardEl.dataset.kanbanLink = card.link;

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
  const coverPass = ++kanbanCoverRevision;
  void hydrateKanbanCardCovers(host, currentPath, () => coverPass === kanbanCoverRevision)
    .catch((error) => console.warn("[kanban cover]", error));
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
  editor.replaceDocument(md);
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
  tab.textContent = editorTabTitle(
    currentPath,
    dirty,
    openTabs.length,
    sessionPersistenceReady,
  );
  if (dirty) return;
  const hasVault = mdFiles.length > 0 || !!localStorage.getItem(LAST_VAULT_KEY);
  ($("btn-refresh") as HTMLButtonElement).disabled = !vaultOpen || refreshInProgress;
  ($("btn-today") as HTMLButtonElement).disabled = !hasVault && mdFiles.length === 0;
  ($("btn-today-side") as HTMLButtonElement).disabled = mdFiles.length === 0;
  ($("btn-drawing") as HTMLButtonElement).disabled = !hasVault;
  ($("btn-canvas") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-search") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-graph") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-links") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-tags") as HTMLButtonElement).disabled = !hasVault;
  ($("btn-template") as HTMLButtonElement).disabled = !hasVault || currentFileKind !== "markdown" || !currentPath;
  ($("activity-tasks") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-bookmarks") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-git") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-attachments") as HTMLButtonElement).disabled = !hasVault;
  ($("activity-sql") as HTMLButtonElement).disabled = !hasVault;
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
      const proceed = await uiConfirm(`Automatic save of ${currentPath} failed. Open another vault anyway?`, { danger: true });
      if (!proceed) return;
    }
  }
  // Preserve the old vault before entering the non-persistable loading state.
  // From this point until the final commit, unload must not serialize the
  // deliberately cleared intermediate workspace.
  saveSession();
  sessionPersistenceReady = false;
  rememberPropertiesFoldState($("preview"));
  rememberEditorFolds();
  const previousRightBody = document.getElementById("right-body");
  if (previousRightBody) rememberPropertiesFoldState(previousRightBody);
  propertiesFoldState.clear();
  propertiesFoldStorageKey = null;
  delete $("preview").dataset.propertiesPath;
  if (previousRightBody) delete previousRightBody.dataset.propertiesPath;
  let plan: VaultOpenPlan = {
    rebuild: false,
    action: "Checking the vault index…",
    migrations: [],
  };
  try {
    plan = await invoke<VaultOpenPlan>("vault_open_plan", { path });
  } catch {
    /* open_vault will provide the authoritative path error. */
  }
  activeOpenPlan = plan;
  const isBackfill = plan.migrations.length > 0;
  $("vault-label").textContent = plan.rebuild
    ? "Rebuilding index…"
    : isBackfill
      ? "Backfilling index…"
      : "Indexing…";
  $("index-stats").textContent = plan.rebuild
    ? "Large vaults can take a minute on first open"
    : isBackfill
      ? "One-time re-parse; your files are unchanged"
      : "Checking the vault for changed files";
  showIndexProgress(plan.action);
  // Let WebKit paint the progress UI before the synchronous index command starts.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  let info: VaultInfo;
  try {
    info = await invoke<VaultInfo>("open_vault", { path });
  } finally {
    activeOpenPlan = null;
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
  paneSwitcher.invalidate();
  paneStateCache.clear();
  rightPaneStateCache.clear();
  renderedRightPath = null;
  currentFileKind = "markdown";
  drawingContent = "";
  drawingDocument = null;
  canvasContent = "";
  dirty = false;
  openTabs = [];
  pinnedTabs = new Set();
  closedTabs = [];
  tabCursors = {};
  rightPath = null;
  editor?.setDoc("");
  excalidrawView?.clear();
  canvasView?.clear();
  showDrawingWorkspace(false);
  showCanvasWorkspace(false);
  updateChrome();
  renderTabBar();
  await refreshTree();
  await loadDailyNotesSettings();
  await reloadPlugins(info.root);
  await reloadAutomations();
  // Restore tabs + active note + right pane from last session for this vault.
  await restoreSession(path);
  await runAutomationLifecycle("onVaultOpen");
  sessionPersistenceReady = true;
  updateChrome();
  saveSession();
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
  return ["markdown", "excalidraw", "canvas"].includes(entry.file_kind)
    || isPdfPath(entry.path)
    || isAudioPath(entry.path)
    || isVideoPath(entry.path)
    || isCsvPath(entry.path)
    || isStructuredPath(entry.path)
    || isBasePath(entry.path)
    || isCodePath(entry.path);
}

function focusActiveDocumentPane() {
  if (currentFileKind === "excalidraw") {
    document.getElementById("excalidraw-host")?.focus();
  } else if (currentFileKind === "canvas") {
    document.getElementById("canvas-host")?.focus();
  } else if (currentFileKind === "pdf") {
    document.getElementById("pdf-host")?.focus();
  } else if (currentFileKind === "audio" || currentFileKind === "video") {
    document.getElementById("av-host")?.focus();
  } else if (currentFileKind === "csv" || currentFileKind === "data" || currentFileKind === "base") {
    document.getElementById("data-host")?.focus();
  } else if (currentFileKind === "code") {
    document.getElementById("code-host")?.focus();
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
  const count = progress.total > 0 ? ` ${progress.done}/${progress.total}` : "";
  const path = progress.path ? ` · ${progress.path}` : "";
  // While a one-time feature backfill is running, keep the truthful migration
  // action text instead of the generic "Indexing vault" label.
  const pendingBackfill =
    activeOpenPlan && !activeOpenPlan.rebuild && activeOpenPlan.migrations.length
      ? activeOpenPlan
      : null;
  const phase = pendingBackfill
    ? pendingBackfill.migrations[0].action
    : progress.phase === "scan"
      ? "Scanning vault"
      : progress.phase === "index"
        ? "Indexing vault"
        : "Resolving links";
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
  if (!manual && dirtyReactor.isDirty) {
    deferredVaultChanges.defer(change);
    return;
  }
  if (vaultChangeTouchesFileTree(change, mdFilesAll.map((file) => file.path))) {
    await refreshTree();
  }
  const changed = new Set(change.paths);
  for (const path of changed) {
    paneStateCache.delete(path);
    rightPaneStateCache.delete(path);
  }
  if (changed.size > 0) {
    // Any indexed page can feed a query in an inactive pane. Keep source/editor
    // snapshots, but require dynamic preview state to be rebuilt on revisit.
    paneStateCache.invalidatePreviews();
    rightPaneStateCache.invalidatePreviews();
  }
  const kanbanVisible = Boolean(
    currentFileKind === "markdown" &&
    kanbanBoard &&
    !$("kanban").classList.contains("hidden"),
  );
  const pageCacheStale = vaultChangeInvalidatesPageCache(change, currentPath);
  if (pageCacheStale) {
    lastPreviewBody = null;
    lastPreviewPath = null;
    paneStateCache.invalidatePreviews();
    rightPaneStateCache.invalidatePreviews();
    clearKanbanCoverCache();
    if (change.paths.some(isImagePath)) {
      clearMediaSrcCache();
    }
  }

  if (currentPath && changed.has(currentPath) && change.removed > 0 && !pathExistsInIndex(currentPath)) {
    if (dirty) {
      setTransientStatus(
        `${currentPath} was deleted externally; the unsaved editor was left intact`,
        "#e9ad55",
      );
    } else {
      const removedPath = currentPath;
      openTabs = openTabs.filter((path) => path !== removedPath);
      pinnedTabs.delete(removedPath);
      currentPath = null;
      editor?.setDoc("");
      renderTabBar();
      updateChrome();
      setTransientStatus(`${removedPath} was deleted externally`, "#e9ad55");
    }
  } else if (shouldReloadEditorFromVault(currentPath, currentFileKind, dirty, changed)) {
    const file = await invoke<OpenFile>("read_file", { path: currentPath! });
    savedContentByPath.set(file.path, file.content);
    if (editor && file.content !== editor.getDoc()) editor.reloadDoc(file.content);
    if (
      pageCacheStale &&
      (shouldKeepPreviewWork(viewMode) || kanbanVisible) &&
      vaultPreviewRefresh.request()
    ) {
      scheduleEditorPreview();
    }
  } else if (
    shouldRefreshPreviewFromOtherPages(currentPath, viewMode, changed) ||
    (pageCacheStale && (shouldKeepPreviewWork(viewMode) || kanbanVisible))
  ) {
    if (vaultPreviewRefresh.request()) scheduleEditorPreview();
  }

  if (rightPath && (changed.has(rightPath) || pageCacheStale)) await updateRightPane(true);

  if (shouldRefreshVaultStats(manual, change.updated, change.removed)) {
    try {
      const info = await invoke<VaultInfo>("vault_stats");
      $("index-stats").textContent =
        `v${info.project_version} · ${info.file_count} files · ${info.task_count} tasks`;
    } catch {
      /* stale stats are non-fatal */
    }
  }

  const total = change.updated + change.removed;
  if (manual) {
    setTransientStatus(
      total === 0 ? "Vault index is already current" :
        `Vault refreshed: ${change.updated} updated, ${change.removed} removed`,
      "#5ecf9a",
    );
  } else if (total > 0) {
    setTransientStatus(
      `External changes indexed: ${change.updated} updated, ${change.removed} removed`,
      "#5ecf9a",
    );
  }
}

function flushDeferredVaultChanges(): void {
  const change = deferredVaultChanges.takeIfClean(dirtyReactor.isDirty);
  if (!change) return;
  vaultChangeQueue = vaultChangeQueue
    .then(() => applyVaultChange(change, false))
    .catch((error) => console.warn("[vault tracker]", error));
}

function rebuildVisibleTree() {
  mdFiles = visibleFiles(vaultFilesAll, showDotfiles);
  treeRoot = buildTree(mdFiles);
  renderTree();
}

function renderTree() {
  const host = $("file-tree");
  host.innerHTML = "";
  installTreeHostListeners(host);

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

function installTreeHostListeners(host: HTMLElement): void {
  if (!claimOneTimeBinding(host.dataset, "hostListenersBound")) return;
  host.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  host.addEventListener("drop", (event) => {
    if (event.target !== host) return;
    event.preventDefault();
    const from = event.dataTransfer?.getData("application/x-nephrite-path")
      || event.dataTransfer?.getData("text/plain");
    if (from) void moveVaultPath(from, baseName(from));
  });
  host.addEventListener("contextmenu", (event) => {
    if (event.target !== host) return;
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, { kind: "empty", path: "" }, handleCtxAction);
  });
}

function updateActivePaneChrome(previousPath: string | null, nextPath: string): void {
  document.querySelectorAll<HTMLElement>("#file-tree .tree-file.active").forEach((node) => {
    if (node.dataset.path !== nextPath) node.classList.remove("active");
  });
  document.querySelectorAll<HTMLElement>("#file-tree .tree-file").forEach((node) => {
    if (node.dataset.path === nextPath) node.classList.add("active");
  });
  document.querySelectorAll<HTMLElement>("#tab-bar .tab-chip").forEach((node) => {
    node.classList.toggle("active", node.dataset.path === nextPath);
  });
  if (previousPath === nextPath) focusActiveDocumentPane();
}

function bindCtx(el: HTMLElement, target: CtxTarget) {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, target, handleCtxAction);
  });
}

function bindTreeDrag(el: HTMLElement, path: string, kind: "file" | "folder") {
  el.draggable = true;
  el.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/plain", path);
    event.dataTransfer?.setData("application/x-nephrite-path", path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  if (kind !== "folder") return;
  el.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    el.classList.add("tree-drop");
  });
  el.addEventListener("dragleave", () => el.classList.remove("tree-drop"));
  el.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    el.classList.remove("tree-drop");
    const from = event.dataTransfer?.getData("application/x-nephrite-path")
      || event.dataTransfer?.getData("text/plain");
    if (from) void moveVaultPath(from, joinPath(path, baseName(from)));
  });
}

async function moveVaultPath(from: string, to: string) {
  if (!from || from === to) return;
  if (to === from || to.startsWith(`${from}/`)) {
    setTransientStatus("Cannot move a folder into itself", "#e9ad55");
    return;
  }
  try {
    const rewritten = await invoke<string[]>("rename_path", { from, to });
    remapOpenPaths(from, to);
    await refreshTree();
    renderTabBar();
    updateRightPane();
    const count = rewritten?.length ?? 0;
    setTransientStatus(
      count
        ? `Moved ${from} → ${to} · updated ${count} note${count === 1 ? "" : "s"}`
        : `Moved ${from} → ${to}`,
      "#5ecf9a",
    );
  } catch (error) {
    void uiAlert(String(error));
  }
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
    bindTreeDrag(btn, node.path, "file");
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
  bindTreeDrag(row, node.path, "folder");
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

type OpenNoteOptions = {
  skipDirtyPrompt?: boolean;
  fromSession?: boolean;
  forceReload?: boolean;
};

type OpenNoteRequest = { path: string; opts?: OpenNoteOptions };

function stashCurrentMarkdownPane(includePreview: boolean): void {
  if (!currentPath || currentFileKind !== "markdown" || !editor || dirty) return;
  const content = editor.getDoc();
  if (savedContentByPath.get(currentPath) !== content) return;
  let preview: CachedPreview | undefined;
  const previewEl = document.getElementById("preview");
  if (
    includePreview &&
    previewEl &&
    previewEl.dataset.previewHydrated === "1" &&
    previewEl.dataset.previewPath === currentPath &&
    lastPreviewPath === currentPath &&
    lastPreviewBody === content
  ) {
    const host = document.getElementById("preview-host");
    const fragment = document.createDocumentFragment();
    fragment.append(...Array.from(previewEl.childNodes));
    preview = {
      fragment,
      source: content,
      scrollTop: host?.scrollTop ?? 0,
      scrollLeft: host?.scrollLeft ?? 0,
    };
    previewEl.dataset.previewPath = "";
    lastPreviewBody = null;
    lastPreviewPath = null;
  }
  paneStateCache.set({
    path: currentPath,
    content,
    fileKind: currentFileKind,
    editor: editor.snapshotPane(),
    preview,
  });
}

function restoreCachedPreview(
  preview: CachedPreview | undefined,
  path: string,
  source: string,
): boolean {
  if (!preview || preview.source !== source || !shouldKeepPreviewWork(viewMode)) return false;
  const previewEl = document.getElementById("preview");
  if (!previewEl) return false;
  cancelPreviewWork();
  previewEl.replaceChildren(preview.fragment);
  previewEl.dataset.previewPath = path;
  lastPreviewBody = source;
  lastPreviewPath = path;
  const host = document.getElementById("preview-host");
  requestAnimationFrame(() => {
    if (!host || currentPath !== path) return;
    host.scrollTop = preview.scrollTop;
    host.scrollLeft = preview.scrollLeft;
    setupScrollSync();
  });
  return true;
}

const paneSwitcher = new LatestPaneSwitch<OpenNoteRequest>(
  ({ path, opts }, isCurrent) => openNoteSerialized(path, opts, isCurrent),
);

async function openNote(
  path: string,
  opts?: OpenNoteOptions,
) {
  if (!opts?.forceReload && path === currentPath) {
    focusActiveDocumentPane();
    return;
  }
  return paneSwitcher.request({ path, opts }).then(() => undefined).catch((error) => {
    console.error("[openNote]", error);
    throw error;
  });
}

async function openNoteSerialized(
  path: string,
  opts: OpenNoteOptions | undefined,
  isCurrent: () => boolean,
) {
  dismissLinkPreview();
  dismissKanbanCardPreview();
  const requestedAt = performance.now();
  const hadDirtyEdits = dirty;
  // Cancel pending autosave before any await so it cannot fire mid-switch.
  if (autosaveTimer != null) {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  if (!opts?.skipDirtyPrompt && dirty && currentPath) {
    const savingPath = currentPath;
    await saveFile(true);
    if (dirty && currentPath === savingPath) {
      const discard = await uiConfirm(`Automatic save of ${savingPath} failed. Discard changes?`, { danger: true });
      if (!discard) return;
      dirty = false;
    }
  }
  if (!isCurrent()) return;
  rememberEditorFolds();
  const cached = opts?.forceReload ? undefined : paneStateCache.get(path);
  const file = cached
    ? { path: cached.path, content: cached.content }
    : isPdfPath(path) || isAudioPath(path) || isVideoPath(path)
      ? { path, content: "" }
      : await invoke<OpenFile>("read_file", { path });
  if (!isCurrent()) return;
  const previousPath = currentPath;
  if (!(opts?.forceReload && previousPath === path)) {
    stashCurrentMarkdownPane(!hadDirtyEdits);
  } else {
    paneStateCache.delete(path);
  }
  if (file.content !== "" || !(isPdfPath(path) || isAudioPath(path) || isVideoPath(path))) {
    savedContentByPath.set(file.path, file.content);
  }
  if (currentPath && editor && currentPath !== file.path) {
    tabCursors[currentPath] = editor.getCursor();
  }
  currentPath = file.path;
  currentFileKind = cached?.fileKind ?? (isPdfPath(file.path) ? "pdf"
    : isAudioPath(file.path) ? "audio"
    : isVideoPath(file.path) ? "video"
    : isCsvPath(file.path) ? "csv"
    : isStructuredPath(file.path) ? "data"
    : isBasePath(file.path) ? "base"
    : isCodePath(file.path) ? "code"
    : mdFilesAll.find((entry) => entry.path === file.path)?.file_kind ??
    (file.path.toLowerCase().endsWith(".excalidraw") ? "excalidraw" :
      file.path.toLowerCase().endsWith(".canvas") ? "canvas" : "markdown"));
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
  const tabAdded = !openTabs.includes(file.path);
  if (tabAdded) {
    openTabs.push(file.path);
  }
  closedTabs = closedTabs.filter((path) => path !== file.path);
  if (tabAdded) syncVisiblePaths();
  if (currentFileKind === "excalidraw") {
    canvasContent = "";
    canvasView?.clear();
    showMediaWorkspace(null);
    showCanvasWorkspace(false);
    drawingContent = file.content;
    showDrawingWorkspace(true);
    try {
      drawingDocument = parseExcalidrawDocument(file.path, file.content);
      const drawingView = await ensureExcalidrawView();
      if (!isCurrent()) return;
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
      void uiAlert(`Could not open Excalidraw drawing: ${String(error)}`);
    }
  } else if (currentFileKind === "canvas") {
    drawingContent = "";
    drawingDocument = null;
    excalidrawView?.clear();
    showMediaWorkspace(null);
    showDrawingWorkspace(false);
    canvasContent = file.content;
    showCanvasWorkspace(true);
    try {
      canvasView?.open(file.content);
    } catch (error) {
      setTransientStatus(`Invalid canvas: ${String(error)}`, "#e07070");
    }
  } else if (currentFileKind === "pdf") {
    drawingContent = "";
    drawingDocument = null;
    excalidrawView?.clear();
    showDrawingWorkspace(false);
    showCanvasWorkspace(false);
    canvasContent = "";
    canvasView?.clear();
    clearCodeView($("code-host"));
    showMediaWorkspace("pdf");
    try {
      await renderPdfView($("pdf-host"), file.path);
    } catch (error) {
      setTransientStatus(`Could not open PDF: ${String(error)}`, "#e07070");
    }
  } else if (currentFileKind === "audio" || currentFileKind === "video") {
    drawingContent = "";
    drawingDocument = null;
    excalidrawView?.clear();
    showDrawingWorkspace(false);
    showCanvasWorkspace(false);
    canvasContent = "";
    canvasView?.clear();
    showMediaWorkspace(currentFileKind);
    try {
      if (currentFileKind === "audio") await renderAudioView($("av-host"), file.path);
      else await renderVideoView($("av-host"), file.path);
    } catch (error) {
      setTransientStatus(`Could not open media: ${String(error)}`, "#e07070");
    }
  } else if (currentFileKind === "csv" || currentFileKind === "data" || currentFileKind === "base") {
    drawingContent = "";
    drawingDocument = null;
    excalidrawView?.clear();
    showDrawingWorkspace(false);
    showCanvasWorkspace(false);
    canvasContent = "";
    canvasView?.clear();
    showMediaWorkspace(currentFileKind);
    if (currentFileKind === "csv") renderCsvView($("data-host"), file.path, file.content);
    else if (currentFileKind === "base") {
      try {
        const pages = await loadBasePages();
        if (!isCurrent()) return;
        renderBaseView($("data-host"), file.content, pages, {
          path: file.path,
          onOpen: (path) => void openNote(path),
        });
      } catch (error) {
        $("data-host").innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
      }
    } else renderStructuredView($("data-host"), file.path, file.content);
  } else if (currentFileKind === "code") {
    drawingContent = "";
    drawingDocument = null;
    excalidrawView?.clear();
    showDrawingWorkspace(false);
    showCanvasWorkspace(false);
    canvasContent = "";
    canvasView?.clear();
    clearPdfView($("pdf-host"));
    showMediaWorkspace("code");
    renderCodeView($("code-host"), file.path, file.content);
  } else {
    drawingContent = "";
    drawingDocument = null;
    excalidrawView?.clear();
    showDrawingWorkspace(false);
    showCanvasWorkspace(false);
    showMediaWorkspace(null);
    canvasContent = "";
    canvasView?.clear();
    // Full vault file into the editor — frontmatter, --- fences, Dataview, everything.
    if (cached?.editor && cached.editor.state.doc.toString() === file.content) {
      editor?.restorePane(cached.editor);
      editor?.setVim(vimOn);
      editor?.setLivePreview(viewMode === "live");
    } else {
      editor?.setDoc(file.content);
      restoreEditorFolds(file.path);
      const savedCursor = tabCursors[file.path];
      if (savedCursor != null) editor?.setCursor(savedCursor);
    }
    if (viewMode !== "preview") editor?.focus();
  }
  if (!isCurrent()) return;
  // Opening a note peels open only its ancestor folders (and remembers that).
  const missingAncestors = missingAncestorPaths(path, expanded);
  const expandedChanged = missingAncestors.length > 0;
  for (const ancestor of missingAncestors) expanded.add(ancestor);
  if (expandedChanged) saveExpanded();
  updateChrome();
  if (expandedChanged) renderTree();
  else updateActivePaneChrome(previousPath, file.path);
  if (tabAdded) renderTabBar();
  else updateActivePaneChrome(previousPath, file.path);
  let previewRestored = false;
  if (currentFileKind === "markdown") {
    previewRestored = restoreCachedPreview(cached?.preview, file.path, file.content);
    if (!previewRestored) {
      schedulePreview(file.content);
    }
  }
  saveSession();
  queryDiagnostic("pane.switch", {
    path: file.path,
    warm: Boolean(cached),
    editorRestored: Boolean(cached?.editor),
    previewRestored,
    treeRebuilt: expandedChanged,
    tabAdded,
    elapsedMs: Number((performance.now() - requestedAt).toFixed(1)),
  });
  void runAutomationLifecycle("onNoteOpen");
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

function showMediaWorkspace(kind: "pdf" | "code" | "audio" | "video" | "csv" | "data" | "base" | null) {
  $("panes").classList.toggle("media-active", kind !== null);
  $("media-workspace").classList.toggle("hidden", kind === null);
  $("pdf-host").classList.toggle("hidden", kind !== "pdf");
  $("code-host").classList.toggle("hidden", kind !== "code");
  $("av-host").classList.toggle("hidden", kind !== "audio" && kind !== "video");
  $("data-host").classList.toggle("hidden", kind !== "csv" && kind !== "data" && kind !== "base");
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((button) => {
    button.disabled = kind !== null;
  });
  if (kind) clearScrollSync();
  if (kind !== "pdf") clearPdfView($("pdf-host"));
  if (kind !== "code") clearCodeView($("code-host"));
  if (kind !== "audio" && kind !== "video") clearMediaView($("av-host"));
  if (kind !== "csv" && kind !== "data" && kind !== "base") {
    clearCsvView($("data-host"));
    clearStructuredView($("data-host"));
  }
}

async function ensureExcalidrawView() {
  if (excalidrawView) return excalidrawView;
  $("excalidraw-host").innerHTML = `<div class="feature-loading excalidraw-loading">Loading Excalidraw…</div>`;
  const { ExcalidrawView } = await import("./excalidraw-view");
  excalidrawView = new ExcalidrawView($("excalidraw-host"));
  return excalidrawView;
}

async function loadDailyNotesSettings() {
  dailyNotesSettings = { ...DEFAULT_DAILY_NOTES };
  try {
    const file = await invoke<OpenFile>("read_file", { path: ".obsidian/daily-notes.json" });
    dailyNotesSettings = parseDailyNotesSettings(file.content);
  } catch {
    /* Vaults without Daily Notes core settings keep the journal heuristics. */
  }
}

async function openToday() {
  await openDailyNote(new Date(), { confirmCreate: true });
}

async function openAdjacentDaily(days: number) {
  const current = currentPath
    ? dateFromDailyPath(currentPath, dailyNotesSettings)
    : null;
  await openDailyNote(shiftDate(current ?? new Date(), days), { confirmCreate: true });
}

async function openPeriodNote(kind: PeriodKind, date = new Date()) {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  const path = periodNotePath(date, kind);
  const exists = mdFilesAll.some((file) => file.path === path);
  if (!exists) {
    const create = await uiConfirm(`No ${kind} note yet.\nCreate ${path}?`);
    if (!create) return;
    const title = path.replace(/\.md$/i, "");
    await invoke("write_file", {
      path,
      content: `---\ntitle: ${title}\ntags:\n  - journal\n  - ${kind}\n---\n\n`,
    });
    await refreshTree();
  }
  await openNote(path);
}

async function openDailyNote(date: Date, options: { confirmCreate?: boolean } = {}) {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  const found = dailyPathForDate(mdFilesAll, date, dailyNotesSettings);
  let path = found.path;
  if (!found.exists) {
    if (options.confirmCreate) {
      const create = await uiConfirm(`No daily note for ${date.toDateString()}.\nCreate ${path}?`);
      if (!create) return;
    }
    const content = await dailyNoteStub(path, date);
    await invoke("write_file", { path, content });
    await refreshTree();
  }
  await openNote(path);
}

async function dailyNoteStub(path: string, date: Date): Promise<string> {
  if (dailyNotesSettings.template) {
    try {
      const resolved = await invoke<string | null>("resolve_wikilink", {
        target: dailyNotesSettings.template,
        fromPath: path,
      });
      if (resolved) {
        const file = await invoke<OpenFile>("read_file", { path: resolved });
        const rendered = await renderTemplater(file.content, {
          path,
          content: "",
          readFile: async (requested) => {
            const target = await invoke<string | null>("resolve_wikilink", {
              target: requested,
              fromPath: resolved,
            });
            if (!target) throw new Error(`Could not resolve template include: ${requested}`);
            return (await invoke<OpenFile>("read_file", { path: target })).content;
          },
          prompt: async (message, defaultValue) =>
            uiPrompt(message, { defaultValue: defaultValue ?? "" }),
        });
        if (rendered.text.trim()) return rendered.text;
      }
    } catch (error) {
      console.warn("[daily notes template]", error);
    }
  }
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `---\ntitle: Personal Journal\ndate: ${iso}\ntags:\n  - journal\n---\n\n`;
}

function showDailyCalendar() {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  const body = openFeaturePanel("Daily notes");
  const toolbar = document.createElement("div");
  toolbar.className = "daily-calendar-toolbar";
  const ere = document.createElement("button");
  ere.type = "button";
  ere.textContent = "Ereyesterday";
  ere.title = "The day before yesterday";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "Yesterday";
  const today = document.createElement("button");
  today.type = "button";
  today.textContent = "Today";
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Tomorrow";
  const over = document.createElement("button");
  over.type = "button";
  over.textContent = "Overmorrow";
  over.title = "The day after tomorrow";
  ere.addEventListener("click", () => void openAdjacentDaily(-2));
  prev.addEventListener("click", () => void openAdjacentDaily(-1));
  today.addEventListener("click", () => void openToday());
  next.addEventListener("click", () => void openAdjacentDaily(1));
  over.addEventListener("click", () => void openAdjacentDaily(2));
  const week = document.createElement("button");
  week.type = "button";
  week.textContent = "This week";
  const monthBtn = document.createElement("button");
  monthBtn.type = "button";
  monthBtn.textContent = "This month";
  const quarter = document.createElement("button");
  quarter.type = "button";
  quarter.textContent = "This quarter";
  week.addEventListener("click", () => void openPeriodNote("week"));
  monthBtn.addEventListener("click", () => void openPeriodNote("month"));
  quarter.addEventListener("click", () => void openPeriodNote("quarter"));
  toolbar.append(ere, prev, today, next, over, week, monthBtn, quarter);
  const mount = document.createElement("div");
  body.append(toolbar, mount);
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  const current = currentPath ? dateFromDailyPath(currentPath, dailyNotesSettings) : null;
  if (current) {
    year = current.getFullYear();
    month = current.getMonth();
  }
  const draw = () => {
    renderDailyCalendar(mount, {
      year,
      month,
      existing: existingDailyKeysForMonth(mdFilesAll, dailyNotesSettings, year, month),
      currentKey: current
        ? `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`
        : null,
      onSelect: (date) => void openDailyNote(date),
      onMonth: (nextYear, nextMonth) => {
        year = nextYear;
        month = nextMonth;
        draw();
      },
    });
  };
  draw();
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
      void uiAlert(`Could not resolve [[${target}]]`);
      return;
    }
    const settings = await readNewFileSettings();
    const path = newWikilinkPath(note, currentPath ?? "", settings);
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
    void uiAlert(String(e));
  }
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
  expectedContent: string | null;
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
  if (
    currentFileKind === "pdf"
    || currentFileKind === "code"
    || currentFileKind === "audio"
    || currentFileKind === "video"
    || currentFileKind === "csv"
    || currentFileKind === "data"
    || currentFileKind === "base"
  ) return Promise.resolve();
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
    expectedContent: savedContentByPath.get(currentPath) ?? null,
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
  const { path, kind, content, expectedContent, documentRevision, automatic } = pending;
  try {
    await invoke("write_file", { path, content, expectedContent });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setTransientStatus(`Save failed: ${message}`, "#e07070");
    console.error("[save] failed", error);
    if (!automatic) void uiAlert(`Save failed: ${message}`);
    return;
  }
  savedContentByPath.set(path, content);
  const unchanged =
    currentPath === path &&
    currentFileKind === kind &&
    (kind === "excalidraw"
      ? drawingContent === content
      : kind === "canvas"
        ? canvasContent === content
        : editor?.getDocumentRevision() === documentRevision);
  if (unchanged) {
    editor?.markSaved(documentRevision);
    dirty = false;
    dirtyReactor.clearDirty();
    pendingChrome = true;
    dirtyReactor.requestReaction();
  }
  if (!unchanged) updateChrome();
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
  pluginManager?.hideAllSettings();
  closePreferences();
  const activityByTitle: Partial<Record<string, ActivityId>> = {
    Bookmarks: "bookmarks",
    "Query rendering log": "query-log",
    "Search vault contents": "search",
    "Vault graph": "graph",
    "Links and outline": "links",
    Tags: "tags",
    Tasks: "tasks",
    Git: "git",
    Attachments: "attachments",
    "SQL console": "sql",
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
  pluginManager?.hideAllSettings();
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

async function showNoteContextPanel() {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  if (!currentPath) {
    void uiAlert("Open a note to see its outline and links.");
    return;
  }
  const body = openFeaturePanel("Links and outline");
  body.innerHTML = `<div class="feature-loading">Reading links…</div>`;
  try {
    const context = await invoke<NoteContext>("note_context", { path: currentPath });
    renderNoteContext(body, context, {
      onOpen: (path, line) => {
        closeFeaturePanel();
        void (pathExistsInIndex(path) ? openNote(path) : openWikilink(path)).then(() => {
          if (line && currentFileKind === "markdown") editor?.goToLine(line);
        });
      },
      onHeading: (line) => {
        closeFeaturePanel();
        editor?.goToLine(line);
      },
      onTag: (tag) => {
        closeFeaturePanel();
        void showTagNotes(tag);
      },
    });
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

async function showTagBrowserPanel() {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  const body = openFeaturePanel("Tags");
  body.innerHTML = `<div class="feature-loading">Reading tags…</div>`;
  try {
    const tags = await invoke<VaultTag[]>("vault_tags");
    renderTagBrowser(body, tags, (tag) => {
      closeFeaturePanel();
      void showTagNotes(tag);
    });
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

async function showTagNotes(tag: string) {
  const body = openFeaturePanel(`Tag #${tag.replace(/^#/, "")}`);
  body.innerHTML = `<div class="feature-loading">Finding notes…</div>`;
  try {
    const pages = await invoke<TagPage[]>("pages_for_tag", { tag });
    body.replaceChildren();
    const heading = document.createElement("p");
    heading.className = "feature-help";
    heading.textContent = `${pages.length} note${pages.length === 1 ? "" : "s"} tagged #${tag.replace(/^#/, "")}.`;
    body.append(heading);
    if (!pages.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No notes use this tag.";
      body.append(empty);
      return;
    }
    const list = document.createElement("div");
    list.className = "note-context-list";
    for (const page of pages) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-health-row";
      button.innerHTML = `<strong></strong><code></code>`;
      button.querySelector("strong")!.textContent = page.title;
      button.querySelector("code")!.textContent = page.path;
      button.addEventListener("click", () => {
        closeFeaturePanel();
        void openNote(page.path);
      });
      list.append(button);
    }
    body.append(list);
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
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

async function showLinkHealthPanel() {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  const body = openFeaturePanel("Orphans and placeholders");
  body.innerHTML = `<div class="feature-loading">Reading the link index…</div>`;
  try {
    const health = await invoke<LinkHealth>("link_health");
    renderLinkHealth(body, health, {
      onOpen: (path) => {
        closeFeaturePanel();
        void openNote(path);
      },
      onCreate: (target, source) => {
        closeFeaturePanel();
        void openWikilinkFrom(target, source);
      },
    });
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

async function openWikilinkFrom(target: string, source: string) {
  const previous = currentPath;
  currentPath = source;
  try {
    await openWikilink(target);
  } finally {
    if (currentPath === source) currentPath = previous;
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
    paneStateCache.invalidatePreviews();
    rightPaneStateCache.invalidatePreviews();
    lastPreviewBody = null;
    lastPreviewPath = null;
    renderPreferencesPlugins();
    if (rightPath) void updateRightPane(true);
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
      const value = await uiPrompt(prompt.label, { defaultValue: fallback });
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
    prompt: async (message: string, defaultValue?: string) => uiPrompt(message, { defaultValue: defaultValue ?? "" }),
  };
}

function remapOpenPaths(from: string, to: string) {
  paneStateCache.clear();
  rightPaneStateCache.clear();
  remapBookmarks(from, to, true);
  const rewrite = (path: string | null) => {
    if (!path) return path;
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
    return path;
  };
  currentPath = rewrite(currentPath);
  rightPath = rewrite(rightPath);
  openTabs = openTabs.map((path) => rewrite(path) ?? path);
  pinnedTabs = new Set([...pinnedTabs].map((path) => rewrite(path) ?? path));
  closedTabs = closedTabs.map((path) => rewrite(path) ?? path);
  renderTabBar();
  saveSession();
}

async function showPluginManager() {
  if (!vaultOpen) {
    void uiAlert("Open a vault to manage plugins.");
    return;
  }
  const body = openFeaturePanel("Plugins");
  renderPluginManager(body, {
    installed: () => pluginManager?.statuses() ?? [],
    reload: async () => {
      await reloadPlugins();
    },
    setEnabled: async (id, enabled) => {
      await pluginManager?.setEnabled(id, enabled);
      await reloadPlugins();
    },
    openSettings: (id) => void showPluginSettings(id),
  });
}

let basePagesCache: { at: number; pages: ReturnType<typeof pagesFromListRows> } | null = null;

async function loadBasePages() {
  if (basePagesCache && Date.now() - basePagesCache.at < 4000) return basePagesCache.pages;
  const rows = await invoke<Array<{
    path: string;
    name: string;
    folder?: string;
    size_bytes?: number;
    tags?: unknown;
    links?: unknown;
    properties?: Record<string, unknown> | null;
  }>>("list_pages", { source: null });
  const pages = pagesFromListRows(rows);
  basePagesCache = { at: Date.now(), pages };
  return pages;
}

async function showAttachmentsPanel() {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  const body = openFeaturePanel("Attachments");
  body.innerHTML = `<div class="feature-loading">Reading attachment index…</div>`;
  try {
    const rows = await invoke<AttachmentRow[]>("list_attachments");
    renderAttachmentPanel(body, rows, (path) => {
      closeFeaturePanel();
      void openVaultEntry(path);
    });
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

function showSqlConsole() {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  const body = openFeaturePanel("SQL console");
  renderSqlConsole(body, {
    run: (sql) => invoke<SqlQueryResult>("query_vault_sql", { sql }),
    onOpen: (path) => {
      closeFeaturePanel();
      void openNote(path);
    },
  });
}

function showPropertiesPanel() {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  if (!currentPath || currentFileKind !== "markdown" || !editor) {
    void uiAlert("Open a Markdown note to edit its properties.");
    return;
  }
  const path = currentPath;
  const body = openFeaturePanel("Note properties");
  renderPropertiesEditor(body, editor.getDoc(), (next) => {
    if (!editor || currentPath !== path || currentFileKind !== "markdown") {
      void uiAlert("The note is no longer active.");
      return;
    }
    editor.replaceDocument(next);
    setTransientStatus("Properties updated", "#5ecf9a");
  });
}

async function showPluginSettings(id?: string) {
  if (!vaultOpen || !pluginManager) {
    void uiAlert("Open a vault first.");
    return;
  }
  const available = pluginManager.statuses().filter((plugin) => plugin.hasSettings && plugin.enabled);
  const target = id
    ? available.find((plugin) => plugin.id === id)
    : available.length === 1 ? available[0] : null;
  if (!target) {
    const body = openFeaturePanel("Plugin settings");
    if (!available.length) {
      body.innerHTML = `<div class="feature-empty">No loaded plugin registered a settings tab. Use Plugins → Data… for data.json.</div>`;
      return;
    }
    const list = document.createElement("div");
    list.className = "plugin-manager-list";
    for (const plugin of available) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-health-row";
      button.innerHTML = `<strong></strong><code></code>`;
      button.querySelector("strong")!.textContent = plugin.name;
      button.querySelector("code")!.textContent = plugin.id;
      button.addEventListener("click", () => void showPluginSettings(plugin.id));
      list.appendChild(button);
    }
    body.appendChild(list);
    return;
  }
  const body = openFeaturePanel(`${target.name} settings`);
  body.classList.add("plugin-settings-body");
  body.innerHTML = `<div class="feature-loading">Opening settings…</div>`;
  try {
    const plugin = pluginManager.get(target.id);
    if (!plugin) {
      body.innerHTML = `<div class="feature-error">Plugin is not loaded.</div>`;
      return;
    }
    body.replaceChildren();
    const iframe = await pluginManager.showSettings(target.id, body);
    if (!iframe) {
      body.innerHTML = `<div class="feature-error">Plugin is not loaded.</div>`;
      return;
    }
    if (plugin.error) {
      const note = document.createElement("p");
      note.className = "feature-help";
      note.textContent = plugin.error;
      body.prepend(note);
    }
  } catch (error) {
    body.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
  }
}

async function createBase() {
  const initialFolder = currentPath ? parentDir(currentPath) : "";
  const entered = await promptName("New base", "Untitled.base");
  if (!entered) return;
  const filename = entered.endsWith(".base") ? entered : `${entered}.base`;
  const path = joinPath(initialFolder, filename);
  try {
    await invoke("create_file", { path, content: emptyBaseSource() });
    await refreshTree();
    await openNote(path);
  } catch (error) {
    void uiAlert(String(error));
  }
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
    const switchLabel = document.createElement("label");
    switchLabel.className = "preferences-switch";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = plugin.enabled;
    const track = document.createElement("span");
    track.className = "preferences-switch-track";
    switchLabel.append(toggle, track);
    toggle.addEventListener("change", () => void pluginManager?.setEnabled(plugin.id, toggle.checked).then(renderPreferencesPlugins));
    const name = document.createElement("span");
    name.textContent = `${plugin.name} ${plugin.version}${plugin.compatibility === "obsidian" ? " · Obsidian" : ""}`;
    const state = document.createElement("small");
    state.textContent = plugin.error || (plugin.loaded ? "Loaded" : plugin.enabled ? "Starting" : "Disabled");
    label.append(switchLabel, name, state);
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
.preview img, .preview .mermaid-block svg { max-width: 100%; height: auto; }
.preview .mermaid-block {
  margin: 0.8em 0;
  padding: 0.5em;
  background: #1a2029;
  border-radius: 6px;
}
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

  const holder = document.createElement("div");
  holder.innerHTML = renderPreview(markdown, {
    includeFrontmatter: include,
    openFrontmatter: include,
  });
  hydrateCsvFences(holder);
  await hydrateMermaid(holder);
  const bodyHtml = holder.innerHTML;
  const title =
    currentPath.split("/").pop()?.replace(/\.md$/i, "") || currentPath || "note";
  printHtmlAsPdf(title, bodyHtml, collectExportCss());
  setTransientStatus(
    include ? "Print dialog opened (with frontmatter)" : "Print dialog opened (body only)",
    "#5ecf9a",
  );
}

function showCommandBar() {
  if (!$("feature-panel").classList.contains("hidden")) closeFeaturePanel();
  closePreferences();
  commandPrompt?.focus();
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
    {
      id: "extract-heading",
      title: "Extract Heading",
      keywords: "create note from header section heading split",
      run: () => void extractHeadingAtCursor(),
    },
    {
      id: "refresh-pane",
      title: "Refresh current pane",
      keywords: "reload preview board f5 rescan",
      run: refreshCurrentPane,
    },
    { id: "mode-source", title: "View: Source", keywords: "editor", run: () => setViewMode("source") },
    { id: "mode-live", title: "View: Live Preview", keywords: "editor rendered markdown", run: () => setViewMode("live") },
    { id: "mode-split", title: "View: Split", keywords: "editor preview", run: () => setViewMode("split") },
    { id: "mode-preview", title: "View: Preview", keywords: "render", run: () => setViewMode("preview") },
    { id: "search", title: "Search vault", keywords: "find", run: showSearchPanel },
    { id: "graph", title: "Open graph", keywords: "links backlinks local", run: showGraphPanel },
    { id: "links", title: "Open links and outline", keywords: "backlinks outgoing unlinked mentions headings", run: () => void showNoteContextPanel() },
    { id: "tags", title: "Open tags", keywords: "tag pane filter", run: () => void showTagBrowserPanel() },
    { id: "orphans", title: "Open orphans and placeholders", keywords: "unresolved missing links foam", run: () => void showLinkHealthPanel() },
    { id: "reopen-tab", title: "Reopen closed tab", keywords: "undo close recent", run: () => void reopenClosedTab() },
    { id: "tasks", title: "Open tasks", keywords: "todo agenda", run: showTasksPanel },
    { id: "bookmarks", title: "Open bookmarks", run: showBookmarksPanel },
    { id: "git", title: "Open Git history", keywords: "versions source control", run: showGitPanel },
    { id: "templates", title: "Apply template", keywords: "templater automation", run: showTemplatePanel },
    { id: "attendance", title: "Insert attendance list", keywords: "people company tag roster check-in", run: () => void showAttendancePanel() },
    { id: "today", title: "Open today's journal", keywords: "daily note", run: openToday },
    { id: "daily-calendar", title: "Daily notes calendar", keywords: "journal month", run: showDailyCalendar },
    { id: "ereyesterday", title: "Open ereyesterday", keywords: "vorgestern day before yesterday journal", run: () => void openAdjacentDaily(-2) },
    { id: "daily-prev", title: "Open yesterday", keywords: "previous journal", run: () => void openAdjacentDaily(-1) },
    { id: "daily-next", title: "Open tomorrow", keywords: "next journal", run: () => void openAdjacentDaily(1) },
    { id: "overmorrow", title: "Open overmorrow", keywords: "übermorgen day after tomorrow journal", run: () => void openAdjacentDaily(2) },
    { id: "this-week", title: "Open this week", keywords: "weekly journal 2026-W02", run: () => void openPeriodNote("week") },
    { id: "this-month", title: "Open this month", keywords: "monthly journal", run: () => void openPeriodNote("month") },
    { id: "this-quarter", title: "Open this quarter", keywords: "quarterly journal 2026-Q03", run: () => void openPeriodNote("quarter") },
    { id: "canvas", title: "Create canvas", run: createCanvas },
    { id: "drawing", title: "Create Excalidraw drawing", keywords: "draw", run: createDrawing },
    { id: "sidebar", title: sidebarCollapsed ? "Show file sidebar" : "Hide file sidebar", keywords: "files", run: () => setSidebarCollapsed(!sidebarCollapsed) },
    { id: "vim", title: vimOn ? "Disable Vim mode" : "Enable Vim mode", run: () => {
      vimOn = !vimOn;
      localStorage.setItem(VIM_KEY, vimOn ? "1" : "0");
      ($("vim-toggle") as HTMLInputElement).checked = vimOn;
      editor?.setVim(vimOn);
    } },
    { id: "preferences", title: "Open preferences", keywords: "settings", run: togglePreferences },
    { id: "plugins", title: "Manage plugins", keywords: "extensions permissions install browse community", run: () => void showPluginManager() },
    { id: "plugin-settings", title: "Plugin settings", keywords: "obsidian configure options addsettingtab", run: () => void showPluginSettings() },
    { id: "attachments", title: "Open attachments", keywords: "orphans images media inventory", run: () => void showAttachmentsPanel() },
    { id: "sql", title: "Open SQL console", keywords: "pgsql postgres query index", run: () => showSqlConsole() },
    { id: "properties", title: "Edit note properties", keywords: "yaml frontmatter nested metadata", run: () => showPropertiesPanel() },
    { id: "base", title: "Create base", keywords: "obsidian bases table query", run: () => void createBase() },
    { id: "hotkeys", title: "Preferences: Keyboard shortcuts", keywords: "keys bindings", run: showHotkeysPanel },
    ...(automationConfig?.commands.map((automation): AppCommand => ({
      id: `automation:${automation.id}`,
      title: automation.name,
      keywords: `${automation.description ?? ""} automation macro capture template`,
      run: () => executeAutomation(automation.id),
    })) ?? []),
    ...(pluginManager?.commands() ?? []),
    ...(includeFiles ? vaultFilesAll
      .filter((file) =>
        file.file_kind === "markdown"
        || isPdfPath(file.path)
        || isBasePath(file.path)
        || isCodePath(file.path),
      )
      .map((file): AppCommand => ({
        id: `open:${file.path}`,
        title: `Open: ${file.path}`,
        keywords: `note file ${file.name} ${
          isPdfPath(file.path) ? "pdf"
          : isAudioPath(file.path) ? "audio"
          : isVideoPath(file.path) ? "video"
          : isCsvPath(file.path) ? "csv"
          : isStructuredPath(file.path) ? "json yaml"
          : isBasePath(file.path) ? "base"
          : isCodePath(file.path) ? "code" : ""
        }`,
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
    void uiConfirm("Reset all keyboard shortcuts to their defaults?").then((ok) => {
      if (!ok) return;
      shortcuts.reset();
      showHotkeysPanel();
    });
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
  const entered = await promptName("New Excalidraw drawing", "Untitled.excalidraw");
  if (!entered) return;
  const filename = entered.endsWith(".excalidraw") ? entered : `${entered}.excalidraw`;
  const path = joinPath(initialFolder, filename);
  try {
    await invoke("create_file", { path, content: emptyExcalidrawFile() });
    await refreshTree();
    await openNote(path);
  } catch (error) {
    void uiAlert(String(error));
  }
}

async function createCanvas() {
  const initialFolder = currentPath ? parentDir(currentPath) : "";
  const entered = await promptName("New canvas", "Untitled.canvas");
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
    void uiAlert(String(error));
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
      void uiAlert(`Template applied with ${result.warnings.length} compatibility warning(s):\n\n${result.warnings.join("\n")}`);
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
      button.addEventListener("click", () => void applyTemplate(file.path).catch((error) => void uiAlert(String(error))));
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
      void applyTemplate(matches[activeIndex].path).catch((error) => void uiAlert(String(error)));
    }
  });
  body.append(explanation, search, list);
  renderMatches();
  requestAnimationFrame(() => search.focus());
}

async function showAttendancePanel() {
  if (!vaultOpen) {
    void uiAlert("Open a vault first.");
    return;
  }
  if (!currentPath || currentFileKind !== "markdown" || !editor) {
    void uiAlert("Open a Markdown note before inserting an attendance list.");
    return;
  }
  const targetPath = currentPath;
  const targetSelection = editor.getSelectionRange();
  let people: ReturnType<typeof collectPeople>;
  try {
    const rows = await invoke<PersonRow[]>("list_pages", { source: null });
    people = collectPeople(rows);
  } catch (error) {
    void uiAlert(String(error));
    return;
  }
  const body = openFeaturePanel("Insert attendance list");
  if (!people.length) {
    body.innerHTML = '<div class="feature-empty">No people notes found under /people in this vault.</div>';
    return;
  }
  renderAttendancePanel(body, {
    people,
    onInsert: (text) => {
      if (!text) return;
      if (!editor || currentPath !== targetPath) {
        void uiAlert("The active note changed while choosing the list.");
        return;
      }
      editor.applyChanges(
        [{ from: targetSelection.from, to: targetSelection.to, insert: text }],
        targetSelection.from + text.length,
      );
      closeFeaturePanel();
      const count = text.split("\n").filter((line) => line.includes("- [ ]")).length;
      setTransientStatus(`Inserted ${count} person${count === 1 ? "" : "s"}`, "#5ecf9a");
    },
  });
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
    prompt: async (message, defaultValue) => uiPrompt(message, { defaultValue: defaultValue ?? "" }),
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
    const group = taskSelect(["none", "agenda", "due", "priority", "path", "project", "recurrence"], view.group, "Group tasks");
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
      void uiPrompt("Saved task view name", { defaultValue: view.name || "Task view" }).then((name) => {
        if (!name?.trim()) return;
        view.name = name.trim();
        const existing = savedViews.findIndex((candidate) => candidate.name === name.trim());
        if (existing >= 0) savedViews[existing] = { ...view };
        else savedViews.push({ ...view });
        persistViews();
        saved.value = name.trim();
        deleteView.disabled = false;
      });
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
          await openNote(currentPath, { skipDirtyPrompt: true, forceReload: true });
        }
      } catch (error) {
        void uiAlert(String(error));
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
    [" ", "Todo [ ]"], ["/", "In progress [/]"], [">", "Forwarded [>]"],
    ["<", "Scheduled [<]"], ["?", "Question [?]"], ["!", "Important [!]"],
    ["x", "Done [x]"], ["-", "Cancelled [-]"],
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
      void uiAlert(String(error));
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
  const recurrence = document.createElement("input");
  recurrence.type = "text";
  recurrence.value = task.recurrence || "";
  recurrence.placeholder = "🔁 recurring";
  recurrence.title = "Recurrence rule (e.g. every week, every day)";
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
      void uiAlert(String(error));
    }
  })());
  const update = async () => {
    const replacement = updateTaskMetadataLine(task.raw_line, {
      due: dueDate.value || null,
      scheduled: scheduled.value || null,
      priority: priority.value || null,
      recurrence: recurrence.value || null,
    });
    for (const control of [scheduled, dueDate, priority, recurrence]) control.disabled = true;
    try {
      await invoke("replace_task_line", { path: task.path, taskId: task.task_id, replacement });
      task.raw_line = replacement;
      task.due = dueDate.value || null;
      task.scheduled = scheduled.value || null;
      task.priority = priority.value || null;
      task.recurrence = recurrence.value || null;
      if (currentPath === task.path) await openNote(task.path, { skipDirtyPrompt: true });
      rerender();
    } catch (error) {
      for (const control of [scheduled, dueDate, priority, recurrence]) control.disabled = false;
      void uiAlert(String(error));
    }
  };
  scheduled.addEventListener("change", () => void update());
  dueDate.addEventListener("change", () => void update());
  priority.addEventListener("change", () => void update());
  recurrence.addEventListener("change", () => void update());
  metadata.append(status, scheduled, dueDate, priority, recurrence);
  const source = document.createElement("span");
  source.className = "task-dashboard-source";
  source.textContent = `${task.path}:${task.line}`;
  row.append(selected, checkbox, text, metadata, source);
  return row;
}

function mergeDialogHost(): HTMLElement {
  let host = document.querySelector(".nephrite-dialog-host") as HTMLElement | null;
  if (!host) {
    host = document.createElement("div");
    host.className = "nephrite-dialog-host";
    document.body.appendChild(host);
  }
  return host;
}

async function mergeVaultFileWith(path: string) {
  if (dirty && currentPath === path) {
    await saveFile(true);
    if (dirty) {
      void uiAlert(`Save ${path} before merging.`);
      return;
    }
  }
  const other = await uiPickFile(
    mdFilesAll.map((file) => ({ path: file.path })),
    { title: `Merge ${path} with…`, exclude: path },
  );
  if (!other) return;
  const [left, right] = await Promise.all([
    invoke<OpenFile>("read_file", { path }),
    invoke<OpenFile>("read_file", { path: other }),
  ]);
  const result = await showMergeEditor({
    title: `Merge ${path}`,
    leftLabel: path,
    rightLabel: other,
    left: left.content,
    right: right.content,
  }, mergeDialogHost());
  if (!result) return;
  await invoke("write_file", { path, content: result.content });
  if (currentPath === path) await openNote(path, { skipDirtyPrompt: true });
}

async function openGitConflictMerge(path: string) {
  const sides = await invoke<GitConflictSides>("git_conflict_sides", { path });
  const ours = sides.ours ?? sides.working ?? "";
  const theirs = sides.theirs ?? "";
  const result = await showMergeEditor({
    title: `Resolve ${path}`,
    leftLabel: "Ours",
    rightLabel: "Theirs",
    left: ours,
    right: theirs,
    base: sides.base,
    result: mergeTexts(ours, theirs, sides.base),
  }, mergeDialogHost());
  if (!result) return;
  await invoke("write_file", { path, content: result.content });
  await invoke("git_resolve_conflict", { path, resolution: "resolved" });
  if (currentPath === path) await openNote(path, { skipDirtyPrompt: true });
  await showGitPanel();
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
      })().catch((error) => void uiAlert(String(error))));
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
        void uiConfirm(`Abort the current ${status.operation}?`, { danger: true }).then((ok) => {
          if (ok) void runGitAction("git_abort");
        });
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
    void uiPrompt("New branch name").then((name) => {
      if (name?.trim()) void runGitAction("git_create_branch", { name: name.trim(), checkout: true });
    });
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
      const mergeEditor = document.createElement("button");
      mergeEditor.textContent = "Merge editor";
      mergeEditor.title = "Compare ours, theirs, and edit the resolved file";
      mergeEditor.addEventListener("click", () => void openGitConflictMerge(entry.path));
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
        void uiConfirm(`Replace ${entry.path} with our side and mark it resolved?`, { danger: true }).then((ok) => {
          if (ok) void runGitAction("git_resolve_conflict", { path: entry.path, resolution: "ours" });
        });
      });
      const theirs = document.createElement("button");
      theirs.textContent = "Use theirs";
      theirs.title = "Replace the file with the incoming version and stage it";
      theirs.addEventListener("click", () => {
        void uiConfirm(`Replace ${entry.path} with their side and mark it resolved?`, { danger: true }).then((ok) => {
          if (ok) void runGitAction("git_resolve_conflict", { path: entry.path, resolution: "theirs" });
        });
      });
      actions.append(openConflict, mergeEditor, resolved, ours, theirs);
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
        void uiConfirm(`Discard unstaged changes to ${entry.path}?`, { danger: true }).then((ok) => {
          if (ok) void runGitAction("git_restore", { paths: [entry.path] });
        });
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
        void uiAlert(String(error));
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
        void uiConfirm(`Restore ${restorePath} from ${commit.hash.slice(0, 12)} into the working tree?`, { danger: true }).then((ok) => {
          if (!ok) return;
          void (async () => {
            await invoke("git_restore_from_commit", { hash: commit.hash, path: restorePath });
            await refreshTree();
            if (currentPath === restorePath) await openNote(restorePath, { skipDirtyPrompt: true });
            await showFileHistory(restorePath);
          })().catch((error) => void uiAlert(String(error)));
        });
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
    void uiAlert(String(error));
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

async function promptName(title: string, initial: string): Promise<string | null> {
  const v = await uiPrompt(title, { defaultValue: initial });
  if (v == null) return null;
  const t = v.trim();
  if (!t) return null;
  if (t.includes("..") || t.includes("\\")) {
    void uiAlert("Invalid name");
    return null;
  }
  return t;
}

async function handleCtxAction(action: CtxAction, target: CtxTarget) {
  try {
    await runCtxAction(action, target);
  } catch (e) {
    void uiAlert(String(e));
  }
}

async function runCtxAction(action: CtxAction, target: CtxTarget) {
  const dir = folderForCreate(target);

  switch (action) {
    case "close-tab": {
      await closeTab(target.path);
      return;
    }
    case "pin-tab": {
      pinTab(target.path, true);
      return;
    }
    case "unpin-tab": {
      pinTab(target.path, false);
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
      if (target.kind !== "file" && target.kind !== "tab") return;
      await mergeVaultFileWith(target.path);
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
      const name = await promptName("New note name", "Untitled.md");
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
      const name = await promptName("New folder name", "New folder");
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
      const name = await promptName("New canvas name", "Untitled.canvas");
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
      const name = await promptName("New Excalidraw drawing", "Untitled.excalidraw");
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
      const name = await promptName("New base name", "Untitled.base");
      if (!name) return;
      const file = name.endsWith(".base") ? name : `${name}.base`;
      const path = joinPath(dir, file);
      await invoke("create_file", {
        path,
        content:
          "filters:\n  and: []\nviews:\n  - type: table\n    name: Table\n",
      });
      await refreshTree();
      void uiAlert(`Created ${path} (Bases UI later).`);
      return;
    }
    case "new-kanban": {
      const name = await promptName("New kanban board name", "Board.md");
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
      const destDir = await promptName(
        target.kind === "folder" ? "Move folder to (vault path)" : "Move file to (folder path)",
        parentDir(target.path) || "",
      );
      if (destDir == null) return;
      const name = baseName(target.path);
      const to = joinPath(destDir.replace(/^\/+|\/+$/g, ""), name);
      await moveVaultPath(target.path, to);
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
      let name = await promptName("Rename to", cur);
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
      paneStateCache.clear();
      rightPaneStateCache.clear();
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
      const ok = await uiConfirm(`Delete “${target.path}”? This cannot be undone.`, { danger: true });
      if (!ok) return;
      await invoke("delete_path", { path: target.path });
      paneStateCache.clear();
      rightPaneStateCache.clear();
      removeBookmarksUnder(target.path, target.kind === "folder");
      if (currentPath === target.path) {
        currentPath = null;
        editor?.setDoc("");
        dirty = false;
      }
      openTabs = openTabs.filter((t) => t !== target.path);
      if (rightPath === target.path) closeRightPane();
      syncVisiblePaths();
      await refreshTree();
      renderTabBar();
      if (rightPath) void updateRightPane();
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

function pinTab(path: string, pinned: boolean) {
  if (pinned) pinnedTabs.add(path);
  else pinnedTabs.delete(path);
  if (pinned && !openTabs.includes(path)) openTabs.push(path);
  openTabs = [
    ...openTabs.filter((tab) => pinnedTabs.has(tab)),
    ...openTabs.filter((tab) => !pinnedTabs.has(tab)),
  ];
  renderTabBar();
  saveSession();
}

async function reopenClosedTab() {
  while (closedTabs.length) {
    const path = closedTabs.shift();
    if (!path) break;
    if (!pathExistsInIndex(path)) continue;
    if (!openTabs.includes(path)) openTabs.push(path);
    await openNote(path);
    renderTabBar();
    saveSession();
    return;
  }
  void uiAlert("No recently closed tab.");
}

async function closeTab(path: string) {
  if (currentPath === path && dirty) {
    await saveFile(true);
    if (dirty) {
      const discard = await uiConfirm(`Automatic save of ${path} failed. Close and discard changes?`, { danger: true });
      if (!discard) return;
    }
  }
  if (!closedTabs.includes(path)) {
    closedTabs.unshift(path);
    closedTabs = closedTabs.slice(0, MAX_CLOSED_TABS);
  }
  pinnedTabs.delete(path);
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
  paneStateCache.delete(path);
  renderTabBar();
}

function renderTabBar() {
  const bar = document.getElementById("tab-bar");
  if (!bar) return;
  bar.innerHTML = "";
  for (const path of openTabs) {
    const chip = document.createElement("div");
    chip.className = "tab-chip" + (path === currentPath ? " active" : "") + (pinnedTabs.has(path) ? " pinned" : "");
    chip.dataset.path = path;
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, { kind: "tab", path, pinned: pinnedTabs.has(path) }, handleCtxAction);
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

function hideRightPane(): void {
  const ws = document.getElementById("workspace");
  const body = document.getElementById("right-body");
  const pathEl = document.getElementById("right-path");
  ws?.classList.remove("with-right");
  if (body) body.innerHTML = "";
  renderedRightPath = null;
  renderedRightContent = null;
  if (pathEl) pathEl.textContent = "—";
  applyPaneSplit();
}

function closeRightPane(): void {
  const body = document.getElementById("right-body");
  if (body) stashRenderedRightPane(body);
  rightPath = null;
  rightPaneRevision++;
  rightPreviewRenderer.cancel();
  hideRightPane();
  saveSession();
}

function stashRenderedRightPane(body: HTMLElement): void {
  if (
    !renderedRightPath ||
    renderedRightContent == null ||
    body.childNodes.length === 0 ||
    body.dataset.previewHydrated !== "1"
  ) return;
  const fragment = document.createDocumentFragment();
  fragment.append(...Array.from(body.childNodes));
  rightPaneStateCache.set({
    path: renderedRightPath,
    content: renderedRightContent,
    fileKind: "markdown",
    preview: {
      fragment,
      source: renderedRightContent,
      scrollTop: body.scrollTop,
      scrollLeft: body.scrollLeft,
    },
  });
  renderedRightPath = null;
  renderedRightContent = null;
}

async function updateRightPane(force = false) {
  const ws = document.getElementById("workspace");
  const body = document.getElementById("right-body");
  const pathEl = document.getElementById("right-path");
  if (!ws || !body || !pathEl) return;
  const revision = ++rightPaneRevision;
  const live = () => shouldCommitRightPane(revision, rightPaneRevision, rightPath);
  if (!rightPath) {
    rightPreviewRenderer.cancel();
    hideRightPane();
    return;
  }
  const path = rightPath;
  ws.classList.add("with-right");
  applyPaneSplit();
  pathEl.textContent = path;
  if (force) {
    rightPaneStateCache.delete(path);
    body.replaceChildren();
    renderedRightPath = null;
    renderedRightContent = null;
  } else if (renderedRightPath === path) {
    return;
  } else {
    stashRenderedRightPane(body);
    const cached = rightPaneStateCache.get(path);
    if (cached?.preview && cached.preview.source === cached.content) {
      rightPreviewRenderer.cancel();
      body.replaceChildren(cached.preview.fragment);
      renderedRightPath = path;
      renderedRightContent = cached.content;
      const { scrollTop, scrollLeft } = cached.preview;
      requestAnimationFrame(() => {
        if (rightPath !== path) return;
        body.scrollTop = scrollTop;
        body.scrollLeft = scrollLeft;
      });
      return;
    }
  }
  try {
    const file = await invoke<OpenFile>("read_file", { path });
    if (!live()) return;
    savedContentByPath.set(file.path, file.content);
    rememberPropertiesFoldState(body);
    let markup;
    try {
      markup = await rightPreviewRenderer.render(file.content);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
    if (!live()) return;
    await yieldToUi();
    if (!live()) return;
    body.innerHTML = markup.html;
    renderedRightPath = file.path;
    renderedRightContent = file.content;
    bindPropertiesFoldState(body, file.path);
    const { body: markdownBody } = splitFrontmatter(file.content);
    await executeBlocksInPreview(
      markdownBody,
      body,
      makeEngineContext(file.path, file.content, (target) => void openWikilink(target)),
      live,
    );
    if (!live()) return;
    bindPreviewContent(body, file.path, undefined, live);
  } catch (e) {
    if (!live()) return;
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
