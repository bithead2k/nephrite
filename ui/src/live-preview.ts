import { syntaxTree } from "@codemirror/language";
import { StateEffect, type EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { DirtyGatedWork } from "./edit-scheduler";

const headingClasses: Record<string, string> = {
  ATXHeading1: "cm-live-h1",
  ATXHeading2: "cm-live-h2",
  ATXHeading3: "cm-live-h3",
  ATXHeading4: "cm-live-h4",
  ATXHeading5: "cm-live-h5",
  ATXHeading6: "cm-live-h6",
  SetextHeading1: "cm-live-h1",
  SetextHeading2: "cm-live-h2",
};

const inlineClasses: Record<string, string> = {
  Emphasis: "cm-live-emphasis",
  StrongEmphasis: "cm-live-strong",
  Strikethrough: "cm-live-strike",
  InlineCode: "cm-live-code",
  Link: "cm-live-link",
};

const syntaxMarks = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "LinkMark",
]);

/** Lines containing a caret or selection remain literal and fully editable. */
export function livePreviewSourceLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
}

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const sourceLines = livePreviewSourceLines(state);
  const ranges: Array<ReturnType<Decoration["range"]>> = [];

  syntaxTree(state).iterate({
    enter(node) {
      const name = node.type.name;
      const headingClass = headingClasses[name];
      if (headingClass) {
        const line = state.doc.lineAt(node.from);
        ranges.push(Decoration.line({ class: `cm-live-heading ${headingClass}` }).range(line.from));
      }

      const inlineClass = inlineClasses[name];
      if (inlineClass && node.to > node.from) {
        ranges.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
      }

      if (syntaxMarks.has(name) && node.to > node.from) {
        const startLine = state.doc.lineAt(node.from).number;
        const endLine = state.doc.lineAt(node.to).number;
        if (!sourceLines.has(startLine) && !sourceLines.has(endLine)) {
          ranges.push(Decoration.replace({}).range(node.from, node.to));
        }
      }
    },
  });

  // Wikilinks are an Obsidian extension rather than CommonMark syntax. Keep
  // the target/alias editable as ordinary document text, but hide delimiters
  // when the caret is elsewhere just like the Markdown syntax marks above.
  for (const visible of view.visibleRanges) {
    const text = state.sliceDoc(visible.from, visible.to);
    const pattern = /(!?)\[\[([^\]\n]+)\]\]/g;
    for (let match; (match = pattern.exec(text));) {
      const from = visible.from + match.index;
      const to = from + match[0].length;
      const line = state.doc.lineAt(from).number;
      if (sourceLines.has(line)) continue;
      const openLength = match[1] ? 3 : 2;
      ranges.push(Decoration.replace({}).range(from, from + openLength));
      ranges.push(Decoration.replace({}).range(to - 2, to));
      ranges.push(Decoration.mark({ class: "cm-live-wikilink" }).range(from + openLength, to - 2));
    }
  }

  return Decoration.set(ranges, true);
}

const refreshLivePreview = StateEffect.define<null>();

/**
 * Live preview decoration construction walks the syntax tree. Map the old
 * ranges through a keystroke immediately, then rebuild only after isDirty is
 * false. This keeps the CM6 update transaction free of document-wide work.
 */
export function livePreviewPlugin(isDirty: () => boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly deferred = new DirtyGatedWork();

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        const refresh = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(refreshLivePreview))
        );
        if (refresh) {
          this.decorations = buildDecorations(update.view);
          return;
        }
        if (update.docChanged) this.decorations = this.decorations.map(update.changes);
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.deferred.request(isDirty, () => {
            update.view.dispatch({ effects: refreshLivePreview.of(null) });
          });
        }
      }

      destroy() {
        this.deferred.cancel();
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
