import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { MarkedExtension, Token, Tokens } from "marked";

export const HIGHLIGHT_COLORS = [
  { emoji: "🔴", name: "red", label: "Red" },
  { emoji: "🟠", name: "orange", label: "Orange" },
  { emoji: "🟢", name: "green", label: "Green" },
  { emoji: "🔵", name: "blue", label: "Blue" },
  { emoji: "🟣", name: "purple", label: "Purple" },
] as const;

export type HighlightColor = typeof HIGHLIGHT_COLORS[number]["name"];

type ColoredHighlightToken = Tokens.Generic & {
  type: "coloredHighlight";
  raw: string;
  color: HighlightColor | null;
  tokens: Token[];
};

const colorByEmoji = new Map<string, HighlightColor>(
  HIGHLIGHT_COLORS.map(({ emoji, name }) => [emoji, name]),
);

export function highlightColorForEmoji(emoji: string | undefined): HighlightColor | null {
  return emoji ? colorByEmoji.get(emoji) ?? null : null;
}

export const coloredHighlightExtension: MarkedExtension = {
  extensions: [{
    name: "coloredHighlight",
    level: "inline",
    start(src: string) {
      const index = src.indexOf("==");
      return index >= 0 ? index : undefined;
    },
    tokenizer(src: string) {
      const match = /^==(?:(🔴|🟠|🟢|🔵|🟣)\s*)?([^=\n](?:[^\n]*?[^=\n])?)==/.exec(src);
      if (!match) return undefined;
      return {
        type: "coloredHighlight",
        raw: match[0],
        color: highlightColorForEmoji(match[1]),
        tokens: this.lexer.inlineTokens(match[2]),
      } as ColoredHighlightToken;
    },
    renderer(token) {
      const highlight = token as ColoredHighlightToken;
      const color = highlight.color ? ` highlight-${highlight.color}` : "";
      const attribute = highlight.color ? ` data-highlight-color="${highlight.color}"` : "";
      return `<mark class="markdown-highlight${color}"${attribute}>${this.parser.parseInline(highlight.tokens)}</mark>`;
    },
  }],
};

export type ColoredHighlightMatch = {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  color: HighlightColor | null;
};

/** Find single-line Obsidian highlights for editor decorations. */
export function coloredHighlightMatches(text: string, offset = 0): ColoredHighlightMatch[] {
  const matches: ColoredHighlightMatch[] = [];
  const pattern = /==(?:(🔴|🟠|🟢|🔵|🟣)\s*)?([^=\n](?:[^\n]*?[^=\n])?)==/g;
  for (let match; (match = pattern.exec(text));) {
    const prefix = match[0].length - match[2].length - 2;
    matches.push({
      from: offset + match.index,
      to: offset + match.index + match[0].length,
      contentFrom: offset + match.index + prefix,
      contentTo: offset + match.index + prefix + match[2].length,
      color: highlightColorForEmoji(match[1]),
    });
  }
  return matches;
}

export function highlightCompletionSource(): CompletionSource {
  const options: Completion[] = HIGHLIGHT_COLORS.map(({ emoji, label }) => ({
    label: `${emoji} ${label}`,
    detail: `${label.toLowerCase()} highlight`,
    type: "keyword",
    apply: `${emoji} `,
  }));
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);
    if (!/==$/.test(before)) return null;
    return { from: context.pos, options, filter: false };
  };
}
