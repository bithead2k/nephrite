import { EditorSelection, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { classifyTaskStatus, nextTaskStatusChar } from "./task-status";

export type TaskCheckboxEdit = {
  from: number;
  to: number;
  insert: string;
};

const TASK_LINE = /^(?:\s*>\s*)*\s*[-*+]\s+\[([^\]])\]/;

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
  return findTaskStatusEdit(markdown, taskIndex, checked ? "x" : " ");
}

export function findTaskStatusEdit(
  markdown: string,
  taskIndex: number,
  insert: string,
): TaskCheckboxEdit | null {
  if (!Number.isInteger(taskIndex) || taskIndex < 0) return null;
  if (insert.length !== 1) return null;

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

    // Ordinary and blockquoted task items, including custom status chars.
    const match = text.match(TASK_LINE);
    if (match) {
      if (found === taskIndex) {
        const marker = (match.index ?? 0) + match[0].length - 2;
        return {
          from: offset + marker,
          to: offset + marker + 1,
          insert,
        };
      }
      found++;
    }
    offset += line.length;
  }
  return null;
}

export function findNextTaskStatusEdit(
  markdown: string,
  taskIndex: number,
  current: string,
): TaskCheckboxEdit | null {
  return findTaskStatusEdit(markdown, taskIndex, nextTaskStatusChar(current));
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
 * plain → todo → in progress → forwarded → scheduled → question →
 * important → done → cancelled → todo …
 * After a full cycle, cancelled wraps to todo. A second Ctrl-Enter on a
 * cancelled task is still a status change, not a drop to plain text.
 * Use nextTaskForm's list-without-checkbox path to leave the task list.
 */
export function nextTaskForm(line: string): string | null {
  const m = line.match(/^(\s*)([-*+])\s+\[([^\]])\]\s?(.*)$/);
  if (m) {
    const indent = m[1];
    const bullet = m[2];
    const status = m[3];
    const body = m[4];
    if (status === "-") {
      const plain = `${indent}${body}`.replace(/\s+$/, "");
      return plain.length ? plain : indent.trimEnd();
    }
    const next = nextTaskStatusChar(status);
    return `${indent}${bullet} [${next}] ${body}`;
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

/** Mark GFM and custom-status tasks so preview clicks share one source index. */
export function hydratePreviewTaskMarkers(root: ParentNode): void {
  let index = 0;
  for (const item of Array.from(root.querySelectorAll("li"))) {
    const checkbox = item.querySelector<HTMLInputElement>(":scope > input[type=checkbox]:not(.prop-bool)");
    if (checkbox) {
      const status = checkbox.checked ? "x" : " ";
      item.classList.add("task-list-item");
      item.dataset.taskIndex = String(index);
      item.dataset.taskStatus = status;
      checkbox.dataset.taskIndex = String(index);
      index += 1;
      continue;
    }
    const custom = matchCustomTaskMarker(item);
    if (!custom) continue;
    const info = classifyTaskStatus(custom.char);
    item.classList.add("task-list-item");
    item.dataset.taskIndex = String(index);
    item.dataset.taskStatus = custom.char;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-status-marker";
    button.dataset.taskIndex = String(index);
    button.dataset.taskStatus = custom.char;
    button.title = `${info.label} — click to cycle`;
    button.textContent = custom.char === " " ? "·" : custom.char;
    custom.node.replaceWith(button, document.createTextNode(custom.rest ? ` ${custom.rest}` : ""));
    index += 1;
  }
}

function matchCustomTaskMarker(item: HTMLElement): { char: string; rest: string; node: ChildNode } | null {
  const node = item.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  const match = text.match(/^\s*\[([^\]])\](?:\s+|(?=\s*$))/);
  if (!match) return null;
  return { char: match[1], rest: text.slice(match[0].length), node };
}
