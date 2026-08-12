import { EditorSelection, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type TaskCheckboxEdit = {
  from: number;
  to: number;
  insert: " " | "x";
};

/**
 * Locate the task represented by a rendered Markdown checkbox.
 *
 * Marked emits task checkboxes in source order but does not retain source
 * positions in its HTML. Walk the authoritative Markdown using the same order,
 * excluding frontmatter and fenced code where task-looking text is literal.
 */
export function findTaskCheckboxEdit(
  markdown: string,
  taskIndex: number,
  checked: boolean,
): TaskCheckboxEdit | null {
  if (!Number.isInteger(taskIndex) || taskIndex < 0) return null;

  const lines = markdown.split(/(?<=\n)/);
  let offset = 0;
  let found = 0;
  let inFrontmatter = lines[0]?.replace(/\r?\n$/, "") === "---";
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    const text = line.replace(/\r?\n$/, "");

    if (inFrontmatter) {
      if (lineNumber > 0 && /^(?:---|\.\.\.)\s*$/.test(text)) inFrontmatter = false;
      offset += line.length;
      continue;
    }

    const fenceMatch = text.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      offset += line.length;
      continue;
    }
    if (fence) {
      offset += line.length;
      continue;
    }

    // Supports ordinary and blockquoted GFM task-list items. Marked recognizes
    // only the space/x states as interactive task checkboxes.
    const match = text.match(/^(?:\s*>\s*)*\s*[-*+]\s+\[([ xX])\]/);
    if (match) {
      if (found === taskIndex) {
        // The status is always the byte immediately before the closing `]`.
        // Deriving it from the full match avoids confusing a blank status with
        // indentation or the required space after the list marker.
        const marker = (match.index ?? 0) + match[0].length - 2;
        return { from: offset + marker, to: offset + marker + 1, insert: checked ? "x" : " " };
      }
      found++;
    }
    offset += line.length;
  }
  return null;
}

/** Logseq-style Ctrl-Enter cycle on the current line. */
export function cycleTaskLine(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const text = line.text;
  const next = nextTaskForm(text);
  if (next === null) return false;

  const selection = EditorSelection.cursor(line.from + Math.min(next.length, line.length));
  const spec: TransactionSpec = {
    changes: { from: line.from, to: line.to, insert: next },
    selection,
    userEvent: "input",
  };
  view.dispatch(spec);
  return true;
}

/**
 * plain → task todo → half → done → plain
 * Preserves list marker (- * +) and indent when present.
 */
export function nextTaskForm(line: string): string | null {
  const m = line.match(/^(\s*)([-*+])\s+\[([^\]])\]\s?(.*)$/);
  if (m) {
    const indent = m[1];
    const bullet = m[2];
    const status = m[3];
    const body = m[4];
    const cycle: Record<string, string> = {
      " ": `${indent}${bullet} [/] ${body}`,
      "/": `${indent}${bullet} [x] ${body}`,
      "-": `${indent}${bullet} [x] ${body}`,
      x: `${indent}${body}`.replace(/\s+$/, "") || indent + body,
      X: `${indent}${body}`.replace(/\s+$/, "") || indent + body,
    };
    if (status === "x" || status === "X") {
      // done → plain line (drop checkbox, keep indent + body)
      const plain = `${indent}${body}`.replace(/\s+$/, "");
      return plain.length ? plain : indent.trimEnd();
    }
    return cycle[status] ?? `${indent}${bullet} [ ] ${body}`;
  }

  // Already a list item without checkbox → make task
  const list = line.match(/^(\s*)([-*+])\s+(.*)$/);
  if (list) {
    return `${list[1]}${list[2]} [ ] ${list[3]}`;
  }

  // Plain line → task
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const body = line.slice(indent.length);
  if (!body.trim()) {
    return `${indent}- [ ] `;
  }
  return `${indent}- [ ] ${body}`;
}
