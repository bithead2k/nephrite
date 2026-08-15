import { pickedCompletion } from "@codemirror/autocomplete";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { FileEntry } from "./types";
import { shortestWikilinkTarget } from "./wikilinks";

export type WikilinkCompletionMatch = {
  embed: boolean;
  query: string;
  from: number;
};

export function wikilinkCompletionMatch(
  lineBeforeCursor: string,
  cursorPosition: number,
): WikilinkCompletionMatch | null {
  const match = lineBeforeCursor.match(/(!?)\[\[([^\]\n|]*)$/);
  if (!match || match[2].includes("#")) return null;
  return {
    embed: match[1] === "!",
    query: match[2],
    from: cursorPosition - match[2].length,
  };
}

export function wikilinkCompletionSource(
  files: () => readonly FileEntry[],
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const match = wikilinkCompletionMatch(
      context.state.sliceDoc(line.from, context.pos),
      context.pos,
    );
    if (!match) return null;

    const catalog = files();
    const options = catalog.map((file): Completion => {
      const target = shortestWikilinkTarget(file.path, catalog);
      const filename = file.path.replace(/^.*\//, "").replace(/\.md$/i, "");
      const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "vault root";
      const drawing = file.file_kind === "excalidraw" || /\.excalidraw\.md$/i.test(file.path);
      return {
        label: target,
        displayLabel: filename,
        detail: `${drawing ? "drawing" : "note"} · ${folder}`,
        type: drawing ? "class" : "text",
        boost: match.embed && drawing ? 20 : 0,
        apply(view, completion, from, to) {
          const hasCloser = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length)) === "]]";
          const insert = `${completion.label}${hasCloser ? "" : "]]"}`;
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + completion.label.length + 2 },
            userEvent: "input.complete",
            annotations: pickedCompletion.of(completion),
          });
        },
      };
    });

    return {
      from: match.from,
      to: context.pos,
      options,
      validFor: /^[^\]\n|#]*$/,
    };
  };
}
