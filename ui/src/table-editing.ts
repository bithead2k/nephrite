import { EditorSelection, EditorState, StateEffect, type ChangeSpec, type Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { justifyCell, tableAlignments, tableCells, type TableAlignment } from "./markdown-tables";

/** Check lexical containers even when syntax highlighting is disabled for large notes. */
function protectedTable(doc: Text, first: number): boolean {
  let fence = "";
  let frontmatter = doc.line(1).text === "---";
  for (let n = 1; n <= first; n++) {
    const text = doc.line(n).text;
    if (frontmatter) {
      if (n > 1 && /^(---|\.\.\.)\s*$/.test(text)) frontmatter = false;
      continue;
    }
    if (fence) {
      const close = text.match(/^ {0,3}(`+|~+)\s*$/)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = "";
    } else {
      fence = text.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? "";
    }
  }
  return frontmatter || !!fence;
}

/** A source table candidate; callers decide whether malformed rows are allowed. */
export function sourceTableAt(state: EditorState, pos: number) {
  const doc = state.doc;
  const candidate = doc.lineAt(pos).number;
  if (!tableCells(doc.line(candidate).text)) return null;
  let first = candidate, last = candidate;
  while (first > 1 && tableCells(doc.line(first - 1).text)) first--;
  while (last < doc.lines && tableCells(doc.line(last + 1).text)) last++;
  if (first === last || protectedTable(doc, first)) return null;
  let node = syntaxTree(state).resolveInner(doc.line(first).from, 1);
  for (;;) {
    if (["HTMLBlock", "CodeBlock", "FencedCode", "ListItem", "Blockquote"].includes(node.name)) return null;
    if (!node.parent) break;
    node = node.parent;
  }
  const rows = Array.from({ length: last - first + 1 }, (_, i) => tableCells(doc.line(first + i).text)!);
  const align = tableAlignments(doc.line(first + 1).text);
  return { first, last, from: doc.line(first).from, to: doc.line(last).to, rows, align };
}

function separator(align: TableAlignment, original: string, width: number): string {
  if (align === "justify") return `-:${"-".repeat(width - 4)}:-`;
  const left = original.startsWith(":") ? ":" : "";
  const right = original.endsWith(":") ? ":" : "";
  return left + "-".repeat(width - left.length - right.length) + right;
}

/** React to editing transactions; loading, selection, undo and redo never format files. */
export const formatTableRanges = StateEffect.define<readonly { from: number; to: number }[]>();

export function liveTableFormatting(
  isComposing: () => boolean = () => false,
  options: () => { liveFormatting: boolean; padding: number } = () => ({ liveFormatting: true, padding: 1 }),
) {
  return EditorState.transactionFilter.of(transaction => {
    const forced = transaction.effects.find(effect => effect.is(formatTableRanges));
    const settings = options();
    const edge = settings.padding;
    if (!forced && (!settings.liveFormatting || !transaction.docChanged || isComposing() ||
        !(transaction.isUserEvent("input") || transaction.isUserEvent("delete")))) return transaction;
    const doc = transaction.newDoc;
    const candidates = new Set<number>();
    const include = (from: number, to: number) => {
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(to).number;
      for (let n = first; n <= last; n++) candidates.add(n);
    };
    if (forced?.is(formatTableRanges)) forced.value.forEach(range => include(range.from, range.to));
    else transaction.changes.iterChangedRanges((_a, _b, from, to) => include(from, to));
    const changes: ChangeSpec[] = [];
    const maps: { from: number; to: number; insert: string; map: (pos: number) => number }[] = [];
    const visited = new Set<number>();
    for (const candidate of candidates) {
      if (visited.has(candidate) || !tableCells(doc.line(candidate).text)) continue;
      const table = sourceTableAt(transaction.state, doc.line(candidate).from);
      if (!table) continue;
      const { first, last, rows, align } = table;
      for (let n = first; n <= last; n++) visited.add(n);
      if (!align) continue;
      if (rows.some(row => row.length !== align.length)) continue;
      const widths = align.map((a, col) => rows.reduce((width, row, index) => index === 1 ? width
        : Math.max(width, a === "justify" ? justifyCell(row[col].text).text.length : row[col].text.length),
      a === "justify" ? 5 : 3));
      for (let row = 0; row < rows.length; row++) {
        const line = doc.line(first + row);
        visited.add(first + row);
        const cells = rows[row];
        // Preserve structural pipes and inline syntax; only pad cells, size
        // separator hyphens, and stretch prose gaps in justified columns.
        cells.forEach((cell, col) => {
          const original = line.text.slice(cell.from, cell.to);
          const leading = original.length - original.trimStart().length;
          const justified = align[col] === "justify" && row !== 1 ? justifyCell(cell.text, widths[col]) : null;
          let content = justified?.text ?? cell.text;
          let padding = widths[col] - content.length;
          const before = row === 1 ? edge : align[col] === "right" ? padding + edge
            : align[col] === "center" ? Math.floor(padding / 2) + edge : edge;
          if (row === 1) { content = separator(align[col], content, widths[col]); padding = 0; }
          let insert = " ".repeat(before) + content + " ".repeat(row === 1 ? edge : padding + 2 * edge - before);
          // Retain whitespace being typed at the end of a cell, so typing the next word is natural.
          const from = line.from + cell.from;
          const to = line.from + cell.to;
          let trailingCaret = 0;
          for (const range of forced ? [] : transaction.newSelection.ranges) {
            if (range.empty && range.head >= from + leading + cell.text.length && range.head <= to) {
              trailingCaret = Math.max(trailingCaret, range.head - from - leading - cell.text.length);
            }
          }
          if (row !== 1 && trailingCaret > insert.length - before - content.length) {
            insert += " ".repeat(trailingCaret - (insert.length - before - content.length));
          }
          if (insert === original) return;
          changes.push({ from, to, insert });
          maps.push({ from, to, insert, map: pos => from + before + Math.max(0, Math.min(
            justified ? justified.map(pos - from - leading) : pos - from - leading,
            content.length + trailingCaret)) });
        });
      }
    }
    if (!changes.length) return transaction;
    maps.sort((a, b) => a.from - b.from);
    const mapPosition = (pos: number) => {
      let offset = 0;
      for (const change of maps) {
        if (pos < change.from) break;
        if (pos <= change.to) return change.map(pos) + offset;
        offset += change.insert.length - (change.to - change.from);
      }
      return pos + offset;
    };
    const selection = EditorSelection.create(transaction.newSelection.ranges.map(range =>
      EditorSelection.range(mapPosition(range.anchor), mapPosition(range.head))), transaction.newSelection.mainIndex);
    return [transaction, { changes, selection, sequential: true }];
  });
}
