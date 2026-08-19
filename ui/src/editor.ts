import { EditorState, Compartment, Extension, Prec } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  dropCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  selectAll,
  selectCharLeft,
  selectCharRight,
  selectLineDown,
  selectLineUp,
  undo,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import {
  defaultHighlightStyle,
  foldEffect,
  foldGutter,
  foldKeymap,
  foldService,
  foldedRanges,
  syntaxHighlighting,
  indentOnInput,
  indentUnit,
  bracketMatching,
  unfoldEffect,
} from "@codemirror/language";
import { CodeMirror, Vim, getCM, vim } from "@replit/codemirror-vim";
import type { CodeMirrorV } from "@replit/codemirror-vim";
import { cycleTaskLine } from "./tasks";
import { formatTimestampPart, type TimestampPart } from "./timestamp-shortcuts";
import { shortestWikilinkTarget, wikilinkAt, wikilinkPlugin } from "./wikilinks";
import { sectionBreakPlugin } from "./section-breaks";
import { yamlBooleanPlugin } from "./yaml-booleans";
import { livePreviewPlugin } from "./live-preview";
import { parseVimrc, type ParsedVimrc } from "./vimrc";
import { wikilinkCompletionSource } from "./wikilink-completion";
import { slashCompletionSource } from "./slash-commands";
import type { FileEntry, UserVimrc } from "./types";
import { smartPasteText } from "./smart-paste";

export type EditorCallbacks = {
  onDirty: (dirty: boolean) => void;
  onSave: () => void | Promise<void>;
  onVimMessage?: (message: string, isError?: boolean) => void;
  onCursor: (line: number, col: number, totalLines: number) => void;
  onOpenWikilink: (target: string) => void;
  onFoldsChanged?: () => void;
  onSaveAttachments?: (files: File[]) => Promise<string[]>;
};

export type FoldRange = { from: number; to: number };
export type EditorChange = { from: number; to: number; insert: string };
export type EditorPaneSnapshot = {
  state: EditorState;
  scrollTop: number;
  scrollLeft: number;
  documentRevision: number;
};

/** Fold only a well-formed frontmatter block that starts on the first line. */
export function frontmatterFoldRange(
  doc: Pick<EditorState["doc"], "lines" | "line">,
): FoldRange | null {
  if (doc.lines < 3 || doc.line(1).text.replace(/\r$/, "") !== "---") return null;
  for (let number = 2; number <= doc.lines; number++) {
    const line = doc.line(number);
    const text = line.text.replace(/\r$/, "");
    if (text === "---" || text === "...") {
      const opening = doc.line(1);
      return line.from > opening.to ? { from: opening.to, to: line.from } : null;
    }
  }
  return null;
}

export class NephriteEditor {
  readonly view: EditorView;
  private vimCompartment = new Compartment();
  private languageCompartment = new Compartment();
  private livePreviewCompartment = new Compartment();
  private vimOn = false;
  private suppressDirty = false;
  private callbacks: EditorCallbacks;
  private parsedVimrc: ParsedVimrc;
  private vimrcPath: string | null;
  private vimrcSourcedPaths: string[];
  private vimrcSourceWarnings: string[];
  private completionFiles: FileEntry[] = [];
  private documentRevision = 0;
  private documentDirty = false;
  private lastCursorLine = -1;
  private lastDocumentLines = -1;

  constructor(
    parent: HTMLElement,
    callbacks: EditorCallbacks,
    vimOn = false,
    userVimrc: UserVimrc | null = null,
  ) {
    this.callbacks = callbacks;
    this.vimOn = vimOn;
    this.parsedVimrc = parseVimrc(userVimrc?.content || "");
    this.vimrcPath = userVimrc?.path || null;
    this.vimrcSourcedPaths = userVimrc?.sourced_paths || [];
    this.vimrcSourceWarnings = userVimrc?.source_warnings || [];
    // The Vim core routes :write through this host hook. The CM6 adapter
    // intentionally leaves it undefined until the embedding app supplies it.
    CodeMirror.commands.save = () => this.requestSave("vim :write");
    // Nephrite owns its application theme; do not silently accept a no-op.
    Vim.defineEx("colorscheme", "colo", (_cm, params) => {
      const requested = params.args?.[0];
      this.callbacks.onVimMessage?.(
        requested
          ? `Vim colorscheme “${requested}” is unavailable; Nephrite controls the application theme.`
          : "Nephrite controls the application theme.",
        true,
      );
    });
    for (const userCommand of this.parsedVimrc.userCommands) {
      Vim.defineEx(userCommand.name, userCommand.name, (cm) => {
        try {
          Vim.handleEx(cm as CodeMirrorV, userCommand.command);
        } catch (error) {
          this.callbacks.onVimMessage?.(`:${userCommand.name} failed: ${String(error)}`, true);
        }
      });
    }
    this.auditVimHostBridge();
    const state = EditorState.create({
      doc: "",
      extensions: this.buildExtensions(),
    });
    this.view = new EditorView({ state, parent });
    if (this.vimOn) this.applyVimrcCommands();
    this.reportVimrc();
  }

  private buildExtensions(): Extension[] {
    const self = this;
    const config = this.parsedVimrc.settings;
    const configuredFont = config.fontFamily
      ? `"${config.fontFamily.replace(/"/g, "\\\"")}", `
      : "";
    const vimrcFontStack =
      `${configuredFont}ui-monospace, "Cascadia Code", "Hack", "DejaVu Sans Mono", ` +
      `"SF Mono", Menlo, Consolas, monospace`;
    const editorFontStack = `var(--editor-font, ${vimrcFontStack})`;
    const gutters = config.lineNumbers
      ? lineNumbers({
          formatNumber: config.relativeLineNumbers
            ? (lineNo, state) => {
                const current = state.doc.lineAt(state.selection.main.head).number;
                return String(lineNo === current ? lineNo : Math.abs(lineNo - current));
              }
            : undefined,
        })
      : [];
    return [
      this.vimCompartment.of(this.vimOn ? vim({ status: config.showStatus }) : []),
      this.livePreviewCompartment.of([]),
      this.mswinKeymapExtension(),
      this.vimrcAbbreviationExtension(),
      EditorState.tabSize.of(config.tabSize),
      indentUnit.of(config.expandTab ? " ".repeat(config.shiftWidth) : "\t"),
      gutters,
      config.cursorLine ? highlightActiveLine() : [],
      config.cursorLine ? highlightActiveLineGutter() : [],
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      indentOnInput(),
      bracketMatching(),
      foldService.of((state, lineStart) =>
        lineStart === 0 ? frontmatterFoldRange(state.doc) : null
      ),
      foldGutter(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      this.languageCompartment.of(markdown()),
      autocompletion({
        override: [
          slashCompletionSource(),
          wikilinkCompletionSource(() => this.completionFiles),
        ],
        // Only pop when a source returns a result ([[ or /). Never scan the
        // vault on ordinary letters.
        activateOnTyping: true,
        maxRenderedOptions: 80,
      }),
      wikilinkPlugin(),
      sectionBreakPlugin(),
      yamlBooleanPlugin,
      highlightSelectionMatches({ minSelectionLength: 4, wholeWords: true }),
      Prec.highest(keymap.of([
        {
          key: "Alt-d",
          run: (view) => this.insertTimestampPart(view, "date"),
        },
        {
          key: "Alt-t",
          run: (view) => this.insertTimestampPart(view, "time"),
        },
      ])),
      Prec.high(keymap.of(completionKeymap)),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            self.requestSave("keyboard save");
            return true;
          },
        },
        {
          key: "Ctrl-Enter",
          run: (view) => cycleTaskLine(view),
        },
        {
          key: "Mod-Enter",
          run: (view) => cycleTaskLine(view),
        },
        {
          key: "Mod-Click",
          run: () => false,
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.domEventHandlers({
        click(event, view) {
          if (!(event.metaKey || event.ctrlKey)) return false;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          // Wikilinks cannot span lines. Avoid serializing a large document
          // merely because the user Ctrl/Cmd-clicked in the editor.
          const line = view.state.doc.lineAt(pos);
          const target = wikilinkAt(line.text, pos - line.from);
          if (!target) return false;
          event.preventDefault();
          self.callbacks.onOpenWikilink(target);
          return true;
        },
        paste(event, view) {
          return self.handlePaste(view, event);
        },
        drop(event, view) {
          return self.handleDrop(view, event);
        },
        dragover(event) {
          if (event.dataTransfer?.types.includes("Files")) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) self.documentRevision++;
        // Keystroke path: flip dirty. Preview, save, and chrome react off-thread.
        if (u.docChanged && !self.suppressDirty) {
          self.documentDirty = true;
          self.callbacks.onDirty(true);
        }
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          // The host only needs line/EOF transitions for scroll sympathy.
          // Ordinary characters on the same line must not enqueue UI work.
          if (
            line.number !== self.lastCursorLine ||
            u.state.doc.lines !== self.lastDocumentLines
          ) {
            self.lastCursorLine = line.number;
            self.lastDocumentLines = u.state.doc.lines;
            self.callbacks.onCursor(line.number, head - line.from + 1, u.state.doc.lines);
          }
        }
        if (!self.suppressDirty && u.transactions.some((transaction) =>
          transaction.effects.some((effect) =>
            effect.is(foldEffect) || effect.is(unfoldEffect)
          )
        )) self.callbacks.onFoldsChanged?.();
      }),
      // Native caret + CM6 cursor layer (thin bar and Vim fat cursor)
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: `${config.fontSize ?? 14.5}px`,
        },
        ".cm-scroller": {
          fontFamily: editorFontStack,
          lineHeight: "1.55",
        },
        "&.cm-focused": { outline: "none" },
        ".cm-content": {
          caretColor: "#5ecf9a",
          backgroundImage: config.colorColumns
            .map((column) => {
              const offset = Math.max(0, column - 1);
              return `linear-gradient(to right, transparent calc(${offset}ch + 4px), rgba(126, 200, 255, 0.3) calc(${offset}ch + 4px), rgba(126, 200, 255, 0.3) calc(${offset}ch + 5px), transparent calc(${offset}ch + 5px))`;
            })
            .join(", ") || "none",
          backgroundRepeat: "no-repeat",
        },
        "&.cm-focused .cm-cursor": {
          borderLeftColor: "#5ecf9a",
          borderLeftWidth: "2px",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "#5ecf9a",
          borderLeftWidth: "2px",
        },
        /* @replit/codemirror-vim fat cursor */
        ".cm-fat-cursor": {
          backgroundColor: "#5ecf9a !important",
          color: "#0c1016 !important",
          outline: "none",
        },
        ".cm-fat-cursor-mark": {
          backgroundColor: "rgba(94, 207, 154, 0.35)",
        },
        ".cm-hide-cursor .cm-cursor": {
          display: "none !important",
        },
        ".cm-activeLine": { backgroundColor: "rgba(94, 207, 154, 0.06)" },
        ".cm-activeLineGutter": { backgroundColor: "rgba(94, 207, 154, 0.08)" },
        ".cm-selectionMatch": { backgroundColor: "rgba(94, 207, 154, 0.18)" },
        ".cm-selectionBackground": {
          backgroundColor: "rgba(94, 207, 154, 0.28) !important",
        },
        "&.cm-focused .cm-selectionBackground": {
          backgroundColor: "rgba(94, 207, 154, 0.35) !important",
        },
        ".cm-tooltip-autocomplete": {
          border: "1px solid #53677e",
          backgroundColor: "#0d141d",
          color: "#e7ecf3",
          boxShadow: "0 10px 28px rgba(0, 0, 0, 0.52)",
        },
        ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
          backgroundColor: "#1e4b3b",
          color: "#ffffff",
        },
        ".cm-completionDetail": { color: "#91a2b5", fontStyle: "normal" },
        ".cm-gutters": {
          backgroundColor: "#0f1318",
          color: "#6b7a8d",
          border: "none",
        },
        ".cm-wikilink": {
          color: "#7ec8ff",
          textDecoration: "underline",
          textDecorationColor: "rgba(126, 200, 255, 0.45)",
          textUnderlineOffset: "2px",
        },
        ".cm-wikilink-embed": {
          color: "#c9a0ff",
        },
        ".cm-section-break": {
          color: "#071018",
          backgroundColor: "#8ed8ff",
          borderRadius: "3px",
          boxShadow: "0 0 0 1px #bce9ff, 0 0 10px rgba(126, 200, 255, 0.55)",
          fontWeight: "900",
          letterSpacing: "0.14em",
          padding: "0 0.25em",
        },
        ".cm-line:has(.cm-section-break)": {
          backgroundColor: "rgba(126, 200, 255, 0.16)",
          borderTop: "1px solid rgba(142, 216, 255, 0.75)",
          borderBottom: "1px solid rgba(142, 216, 255, 0.42)",
          boxShadow: "inset 0 0 14px rgba(126, 200, 255, 0.1)",
        },
        ".cm-panels": {
          backgroundColor: "#070a0f",
          color: "#f4f7fb",
        },
        ".cm-vim-panel": {
          boxSizing: "border-box",
          minHeight: "2rem",
          padding: "0.35rem 0.65rem !important",
          borderTop: "2px solid #5ecf9a",
          backgroundColor: "#070a0f !important",
          color: "#f4f7fb !important",
          boxShadow: "0 -4px 14px rgba(0, 0, 0, 0.55)",
          fontSize: "0.9rem",
          fontWeight: "650",
          fontFamily: editorFontStack,
          alignItems: "center",
          gap: "0.35rem",
        },
        ".cm-vim-panel input": {
          flex: "1",
          minWidth: "4rem",
          padding: "0.18rem 0.35rem !important",
          border: "1px solid #52657d !important",
          borderRadius: "3px",
          outline: "none !important",
          backgroundColor: "#111923 !important",
          color: "#ffffff !important",
          caretColor: "#6dffb2",
          font: "inherit",
          fontWeight: "650",
        },
        ".cm-vim-panel input:focus": {
          borderColor: "#6dffb2 !important",
          boxShadow: "0 0 0 2px rgba(94, 207, 154, 0.25)",
        },
        ".cm-vim-panel input::selection": {
          backgroundColor: "#2d6f55",
          color: "#ffffff",
        },
      }),
      EditorView.editable.of(true),
    ];
  }

  private requestSave(source: string) {
    void Promise.resolve(this.callbacks.onSave()).catch((error) => {
      console.error(`[${source}] save failed`, error);
    });
  }

  private insertTimestampPart(view: EditorView, part: TimestampPart): boolean {
    view.dispatch(view.state.replaceSelection(formatTimestampPart(part)));
    return true;
  }

  private auditVimHostBridge() {
    const commands = CodeMirror.commands as Record<string, unknown>;
    const required = [
      "save",
      "undo",
      "redo",
      "newlineAndIndent",
      "indentAuto",
      "toggleLineComment",
      "cursorCharLeft",
    ];
    const missing = required.filter((name) => typeof commands[name] !== "function");
    if (missing.length === 0) return;
    const message = `Vim host integration missing: ${missing.join(", ")}`;
    console.error(message);
    this.callbacks.onVimMessage?.(message, true);
  }

  private applyVimrcCommands() {
    const cm = getCM(this.view);
    if (!cm) return;
    for (const command of this.parsedVimrc.commands) {
      try {
        Vim.handleEx(cm as CodeMirrorV, command);
      } catch (error) {
        console.warn(`[vimrc] failed: ${command}`, error);
      }
    }
  }

  private reportVimrc() {
    if (!this.vimrcPath) return;
    const applied = this.parsedVimrc.commands.length +
      this.parsedVimrc.abbreviations.length +
      this.parsedVimrc.userCommands.length +
      this.parsedVimrc.appliedSettings;
    const skipped = this.parsedVimrc.skipped.length;
    const fileCount = 1 + this.vimrcSourcedPaths.length;
    console.info(
      `[vimrc] ${this.vimrcPath}: loaded ${fileCount} file(s), applied ${applied}, skipped ${skipped}`,
    );
    if (this.vimrcSourcedPaths.length) {
      console.info("[vimrc] sourced files", this.vimrcSourcedPaths);
    }
    if (this.vimrcSourceWarnings.length) {
      console.warn("[vimrc] source warnings", this.vimrcSourceWarnings);
    }
    if (skipped) console.debug("[vimrc] skipped lines", this.parsedVimrc.skipped);
    this.callbacks.onVimMessage?.(
      `Loaded ${fileCount} Vim config file${fileCount === 1 ? "" : "s"}: ${applied} applied` +
        `${skipped ? `, ${skipped} unsupported` : ""}` +
        `${this.vimrcSourceWarnings.length ? `, ${this.vimrcSourceWarnings.length} source warning(s)` : ""}`,
      this.vimrcSourceWarnings.length > 0,
    );
  }

  private vimrcAbbreviationExtension(): Extension {
    // A spelling vimrc can contain thousands of abbreviations. Vim resolves
    // the token immediately before the delimiter, so use indexed lookups
    // instead of scanning every abbreviation on each keystroke.
    const abbreviations = new Map<string, string>();
    for (const { lhs, rhs } of this.parsedVimrc.abbreviations) {
      abbreviations.set(lhs, rhs);
    }
    if (abbreviations.size === 0) return [];
    return EditorView.inputHandler.of((view, from, to, text) => {
      if (from !== to || text.length !== 1 || !/[\s.,;:!?)}\]]/.test(text)) {
        return false;
      }
      const cm = getCM(view);
      if (!cm?.state.vim?.insertMode) return false;
      const line = view.state.doc.lineAt(from);
      const before = view.state.sliceDoc(line.from, from);
      const candidates = new Set<string>();
      const keyword = before.match(/[\p{L}\p{N}_]+$/u)?.[0];
      const nonSpace = before.match(/\S+$/u)?.[0];
      if (keyword) candidates.add(keyword);
      if (nonSpace) candidates.add(nonSpace);
      const lhs = [...candidates]
        .filter((candidate) => abbreviations.has(candidate))
        .sort((a, b) => b.length - a.length)[0];
      if (lhs) {
        const rhs = abbreviations.get(lhs)!;
        const start = from - lhs.length;
        const previous = start > line.from ? view.state.sliceDoc(start - 1, start) : "";
        if (!previous || !/[\p{L}\p{N}_]/u.test(previous)) {
          view.dispatch({
            changes: { from: start, to, insert: rhs + text },
            selection: { anchor: start + rhs.length + text.length },
            userEvent: "input.type",
          });
          return true;
        }
      }
      return false;
    });
  }

  private mswinKeymapExtension(): Extension {
    if (!this.parsedVimrc.settings.mswin) return [];
    const whenVim = (command: (view: EditorView) => boolean) =>
      (view: EditorView) => this.vimOn ? command(view) : false;
    return Prec.highest(keymap.of([
      { key: "Ctrl-a", run: whenVim(selectAll) },
      { key: "Ctrl-z", run: whenVim(undo) },
      { key: "Ctrl-s", run: whenVim(() => { this.requestSave("mswin Ctrl-S"); return true; }) },
      { key: "Ctrl-f", run: whenVim(openSearchPanel) },
      { key: "Shift-ArrowLeft", run: whenVim(selectCharLeft) },
      { key: "Shift-ArrowRight", run: whenVim(selectCharRight) },
      { key: "Shift-ArrowUp", run: whenVim(selectLineUp) },
      { key: "Shift-ArrowDown", run: whenVim(selectLineDown) },
      { key: "Ctrl-c", run: whenVim((view) => this.copySelection(view, false)) },
      { key: "Ctrl-Insert", run: whenVim((view) => this.copySelection(view, false)) },
      { key: "Ctrl-x", run: whenVim((view) => this.copySelection(view, true)) },
      { key: "Shift-Delete", run: whenVim((view) => this.copySelection(view, true)) },
      { key: "Ctrl-v", run: whenVim((view) => this.pasteClipboard(view)) },
      { key: "Shift-Insert", run: whenVim((view) => this.pasteClipboard(view)) },
    ]));
  }

  private copySelection(view: EditorView, cut: boolean): boolean {
    const selections = view.state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => view.state.sliceDoc(range.from, range.to));
    if (selections.length === 0) return true;
    if (!navigator.clipboard) {
      this.callbacks.onVimMessage?.("System clipboard access is unavailable", true);
      return true;
    }
    void navigator.clipboard.writeText(selections.join("\n")).then(() => {
      if (cut) view.dispatch(view.state.replaceSelection(""));
    }).catch((error) => {
      console.warn("[vimrc] system clipboard write failed", error);
      this.callbacks.onVimMessage?.("Could not write to the system clipboard", true);
    });
    return true;
  }

  private handlePaste(view: EditorView, event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!data) return false;
    const images = Array.from(data.files || []).filter((file) => file.type.startsWith("image/"));
    if (images.length && this.callbacks.onSaveAttachments) {
      event.preventDefault();
      void this.insertAttachments(view, images);
      return true;
    }
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    if (!html && !text) return false;
    const selection = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    const next = smartPasteText({ html, text, selection });
    if (next === text && !html) return false;
    event.preventDefault();
    view.dispatch(view.state.replaceSelection(next));
    return true;
  }

  private handleDrop(view: EditorView, event: DragEvent): boolean {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!files.length || !this.callbacks.onSaveAttachments) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos != null) {
      view.dispatch({ selection: { anchor: pos } });
    }
    void this.insertAttachments(view, files);
    return true;
  }

  private async insertAttachments(view: EditorView, files: File[]): Promise<void> {
    try {
      const paths = await this.callbacks.onSaveAttachments?.(files) ?? [];
      if (!paths.length) return;
      const snippet = paths
        .map((path) => `![[${shortestWikilinkTarget(path, [...this.completionFiles, { path }])}]]`)
        .join("\n");
      view.dispatch(view.state.replaceSelection(snippet));
    } catch (error) {
      this.callbacks.onVimMessage?.(`Could not save attachment: ${String(error)}`, true);
    }
  }

  private pasteClipboard(view: EditorView): boolean {
    if (!navigator.clipboard) {
      this.callbacks.onVimMessage?.("System clipboard access is unavailable", true);
      return true;
    }
    void this.readSmartClipboard().then((content) => {
      view.dispatch(view.state.replaceSelection(content));
    }).catch((error) => {
      console.warn("[vimrc] system clipboard read failed", error);
      this.callbacks.onVimMessage?.("Could not read the system clipboard", true);
    });
    return true;
  }

  private async readSmartClipboard(): Promise<string> {
    let html = "";
    let text = "";
    if (navigator.clipboard.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (!html && item.types.includes("text/html")) {
            html = await (await item.getType("text/html")).text();
          }
          if (!text && item.types.includes("text/plain")) {
            text = await (await item.getType("text/plain")).text();
          }
        }
      } catch {
        /* fall back to readText */
      }
    }
    if (!text) text = await navigator.clipboard.readText();
    const selection = this.view.state.sliceDoc(
      this.view.state.selection.main.from,
      this.view.state.selection.main.to,
    );
    return smartPasteText({ html, text, selection });
  }

  setVim(on: boolean) {
    this.vimOn = on;
    this.view.dispatch({
      effects: this.vimCompartment.reconfigure(
        on ? vim({ status: this.parsedVimrc.settings.showStatus }) : [],
      ),
    });
    if (on) this.applyVimrcCommands();
  }

  setLivePreview(on: boolean) {
    this.view.dispatch({
      effects: this.livePreviewCompartment.reconfigure(
        on ? livePreviewPlugin(() => this.documentDirty) : [],
      ),
    });
    this.view.dom.classList.toggle("cm-live-preview", on);
  }

  openFind() {
    this.view.focus();
    return openSearchPanel(this.view);
  }

  /** Load full file bytes as text — never strip frontmatter or anything else. */
  setDoc(text: string) {
    const unfold = this.getFoldedRanges().map((range) => unfoldEffect.of(range));
    this.suppressDirty = true;
    this.documentDirty = false;
    this.view.dispatch({
      changes: {
        from: 0,
        to: this.view.state.doc.length,
        insert: text, // exact vault content
      },
      selection: { anchor: 0 },
      effects: [
        ...unfold,
        this.languageCompartment.reconfigure(text.length > 80_000 ? [] : markdown()),
      ],
    });
    this.suppressDirty = false;
    this.callbacks.onDirty(false);
  }

  snapshotPane(): EditorPaneSnapshot {
    return {
      state: this.view.state,
      scrollTop: this.view.scrollDOM.scrollTop,
      scrollLeft: this.view.scrollDOM.scrollLeft,
      documentRevision: this.documentRevision,
    };
  }

  restorePane(snapshot: EditorPaneSnapshot): void {
    this.suppressDirty = true;
    this.documentDirty = false;
    this.documentRevision = snapshot.documentRevision;
    this.lastCursorLine = -1;
    this.lastDocumentLines = -1;
    this.view.setState(snapshot.state);
    this.suppressDirty = false;
    this.callbacks.onDirty(false);
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = snapshot.scrollTop;
      this.view.scrollDOM.scrollLeft = snapshot.scrollLeft;
    });
  }

  /** Replace a clean document after an external edit without throwing the
   * user's cursor and viewport back to the top. */
  reloadDoc(text: string) {
    const selection = this.view.state.selection.main;
    const anchor = Math.min(selection.anchor, text.length);
    const head = Math.min(selection.head, text.length);
    const scrollTop = this.view.scrollDOM.scrollTop;
    this.suppressDirty = true;
    this.documentDirty = false;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor, head },
      effects: this.languageCompartment.reconfigure(text.length > 80_000 ? [] : markdown()),
    });
    this.suppressDirty = false;
    this.callbacks.onDirty(false);
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = scrollTop;
    });
  }

  /** Replace the whole source as a user edit, preserving dirty semantics. */
  replaceDocument(text: string): void {
    const head = Math.min(this.view.state.selection.main.head, text.length);
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: head },
      effects: this.languageCompartment.reconfigure(text.length > 80_000 ? [] : markdown()),
    });
  }

  getDoc(): string {
    return this.view.state.doc.toString();
  }

  getDocumentRevision(): number {
    return this.documentRevision;
  }

  /** Clear dirty-gated editor work only if this exact revision reached disk. */
  markSaved(documentRevision: number | null): void {
    if (documentRevision === this.documentRevision) this.documentDirty = false;
  }

  getFoldedRanges(): FoldRange[] {
    const ranges: FoldRange[] = [];
    foldedRanges(this.view.state).between(0, this.view.state.doc.length, (from, to) => {
      ranges.push({ from, to });
    });
    return ranges;
  }

  setFoldedRanges(ranges: readonly FoldRange[]) {
    const docLength = this.view.state.doc.length;
    const effects = ranges
      .filter(({ from, to }) => from >= 0 && to > from && to <= docLength)
      .map((range) => foldEffect.of(range));
    if (effects.length > 0) this.view.dispatch({ effects });
  }

  defaultFrontmatterFold(): FoldRange | null {
    return frontmatterFoldRange(this.view.state.doc);
  }

  setCompletionFiles(files: readonly FileEntry[]) {
    this.completionFiles = [...files];
  }

  getSelection(): string {
    const range = this.view.state.selection.main;
    return this.view.state.sliceDoc(range.from, range.to);
  }

  getSelectionRange(): { from: number; to: number } {
    const range = this.view.state.selection.main;
    return { from: range.from, to: range.to };
  }

  applyChanges(changes: readonly EditorChange[], cursor: number) {
    this.view.dispatch({
      changes,
      selection: { anchor: cursor },
      userEvent: "input",
    });
    this.view.focus();
  }

  replaceSelection(insert: string, cursorOffset?: number | null) {
    const range = this.view.state.selection.main;
    const anchor = range.from + (cursorOffset == null ? insert.length : cursorOffset);
    this.view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor },
      userEvent: "input",
    });
  }

  goToLine(lineNumber: number) {
    const line = this.view.state.doc.line(Math.max(1, Math.min(lineNumber, this.view.state.doc.lines)));
    this.view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    this.view.focus();
  }

  getCursor(): number {
    return this.view.state.selection.main.head;
  }

  setCursor(position: number) {
    const anchor = Math.max(0, Math.min(position, this.view.state.doc.length));
    this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
  }

  /** Apply a surgical source edit while retaining the current selection. */
  replaceRange(from: number, to: number, insert: string) {
    if (from < 0 || to < from || to > this.view.state.doc.length) return;
    this.view.dispatch({
      changes: { from, to, insert },
      userEvent: "input",
    });
  }

  /** Scrollable container for sync with preview. */
  scrollElement(): HTMLElement | null {
    return this.view.scrollDOM;
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    this.view.destroy();
  }
}
