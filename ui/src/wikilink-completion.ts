import { pickedCompletion } from "@codemirror/autocomplete";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { invoke } from "@tauri-apps/api/core";

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

export type LinkSuggestion = {path: string; target: string; name: string; folder: string; drawing: boolean};
export function wikilinkCompletionSource(
  search: (query: string, embed: boolean) => Promise<LinkSuggestion[]> =
    (query, embed) => invoke("complete_wikilink", {query, embed}),
): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const match = wikilinkCompletionMatch(context.state.sliceDoc(line.from, context.pos), context.pos);
    if (!match) return null;
    const found = await search(match.query, match.embed);
    if (context.aborted) return null;
    const options = found.map((item): Completion => ({
      label: item.target, displayLabel: item.name,
      detail: `${item.drawing ? "drawing" : "note"} · ${item.folder || "vault root"}`,
      type: item.drawing ? "class" : "text",
      apply(view, completion, from, to) {
        const hasCloser = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length)) === "]]";
        const insert = `${completion.label}${hasCloser ? "" : "]]"}`;
        view.dispatch({changes: {from, to, insert}, selection: {anchor: from + completion.label.length + 2},
          userEvent: "input.complete", annotations: pickedCompletion.of(completion)});
      },
    }));
    // A fresh bounded database query on each edit keeps every note reachable.
    return {from: match.from, to: context.pos, options, filter: false};
  };
}
