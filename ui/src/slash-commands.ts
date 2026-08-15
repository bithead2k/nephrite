import { pickedCompletion } from "@codemirror/autocomplete";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";

type SlashSnippet = {
  label: string;
  detail: string;
  keywords: string;
  insert: string;
  cursor?: number;
};

const SNIPPETS: SlashSnippet[] = [
  { label: "heading1", detail: "Heading 1", keywords: "h1 title", insert: "# ", cursor: 2 },
  { label: "heading2", detail: "Heading 2", keywords: "h2", insert: "## ", cursor: 3 },
  { label: "heading3", detail: "Heading 3", keywords: "h3", insert: "### ", cursor: 4 },
  { label: "task", detail: "Task item", keywords: "todo checkbox", insert: "- [ ] ", cursor: 6 },
  { label: "bullet", detail: "Bullet list", keywords: "ul list", insert: "- ", cursor: 2 },
  { label: "numbered", detail: "Numbered list", keywords: "ol list", insert: "1. ", cursor: 3 },
  { label: "quote", detail: "Block quote", keywords: "blockquote", insert: "> ", cursor: 2 },
  { label: "divider", detail: "Horizontal rule", keywords: "hr ---", insert: "---\n", cursor: 4 },
  {
    label: "table",
    detail: "Table",
    keywords: "grid",
    insert: "| Column | Column |\n| --- | --- |\n|  |  |\n",
    cursor: 2,
  },
  {
    label: "code",
    detail: "Code fence",
    keywords: "fence pre",
    insert: "```\n\n```\n",
    cursor: 4,
  },
  {
    label: "math",
    detail: "Math fence",
    keywords: "latex katex tex",
    insert: "```math\n\n```\n",
    cursor: 8,
  },
  {
    label: "mermaid",
    detail: "Mermaid diagram",
    keywords: "flowchart sequence",
    insert: "```mermaid\nflowchart LR\n  A --> B\n```\n",
    cursor: 12,
  },
  {
    label: "callout",
    detail: "Callout",
    keywords: "note tip warning",
    insert: "> [!note]\n> ",
    cursor: 12,
  },
  {
    label: "link",
    detail: "Wikilink",
    keywords: "wiki note",
    insert: "[[]]",
    cursor: 2,
  },
  {
    label: "date",
    detail: "Today's date",
    keywords: "today iso",
    insert: isoDate(),
  },
];

export function slashCompletionMatch(
  lineBeforeCursor: string,
  cursorPosition: number,
): { query: string; from: number } | null {
  const match = lineBeforeCursor.match(/(^|\s)\/([A-Za-z0-9_-]*)$/);
  if (!match) return null;
  const query = match[2];
  return { query, from: cursorPosition - query.length - 1 };
}

export function slashCompletionSource(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);
    if (before.includes("[[") && !before.slice(before.lastIndexOf("[[")).includes("]]")) {
      return null;
    }
    const match = slashCompletionMatch(before, context.pos);
    if (!match) return null;
    const query = match.query.toLowerCase();
    const options = SNIPPETS
      .filter((snippet) => {
        if (!query) return true;
        const hay = `${snippet.label} ${snippet.detail} ${snippet.keywords}`.toLowerCase();
        return hay.includes(query) || snippet.label.startsWith(query);
      })
      .map((snippet): Completion => ({
        label: `/${snippet.label}`,
        displayLabel: snippet.detail,
        detail: `/${snippet.label}`,
        type: "keyword",
        apply(view, completion, from, to) {
          const cursor = from + (snippet.cursor ?? snippet.insert.length);
          view.dispatch({
            changes: { from, to, insert: snippet.insert },
            selection: { anchor: cursor },
            userEvent: "input.complete",
            annotations: pickedCompletion.of(completion),
          });
        },
      }));
    if (!options.length) return null;
    return {
      from: match.from,
      to: context.pos,
      options,
      validFor: /^\/[A-Za-z0-9_-]*$/,
    };
  };
}

function isoDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
