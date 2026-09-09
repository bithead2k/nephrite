import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { Command } from "@codemirror/view";
import { sourceTableAt } from "./table-editing";
import { tableCells } from "./markdown-tables";

export type SourceTable = NonNullable<ReturnType<typeof sourceTableAt>>;
export type TableAction =
  | "row-above" | "row-below" | "row-duplicate" | "row-delete" | "row-up" | "row-down"
  | "column-before" | "column-after" | "column-duplicate" | "column-delete" | "column-left" | "column-right"
  | "sort-ascending" | "sort-descending"
  | "align-left" | "align-center" | "align-right" | "align-justify";

export function tableLocation(state: EditorState, pos: number) {
  const table = sourceTableAt(state, pos);
  if (!table) return null;
  const line = state.doc.lineAt(pos);
  const row = line.number - table.first;
  const cells = table.rows[row];
  const offset = pos - line.from;
  const found = cells.findIndex(cell => offset <= cell.to);
  const col = found < 0 ? cells.length - 1 : found;
  const valid = !!table.align && table.rows.every(cells => cells.length === table.align!.length);
  return { table, row, col, valid };
}

function cellSelection(state: EditorState, table: SourceTable, row: number, col: number) {
  const line = state.doc.line(table.first + row);
  const cell = table.rows[row][col];
  const raw = line.text.slice(cell.from, cell.to);
  const leading = cell.text ? raw.length - raw.trimStart().length : Math.min(1, raw.length);
  const from = line.from + cell.from + leading;
  return EditorSelection.single(from, from + cell.text.length);
}

export function tableNavigation(state: EditorState, direction: 1 | -1): TransactionSpec | null {
  if (state.readOnly || state.selection.ranges.length !== 1) return null;
  const range = state.selection.main;
  const location = tableLocation(state, range.head);
  if (!location?.valid) return null;
  const { table, row, col } = location;
  const cell = table.rows[row][col];
  const line = state.doc.line(table.first + row);
  // A selection spanning cells keeps ordinary editor Tab behavior.
  if (range.from < line.from + cell.from || range.to > line.from + cell.to) return null;
  const columns = table.rows[0].length;
  let index = (row === 0 ? 0 : row - 1) * columns + col + direction;
  if (row === 1) index = direction === 1 ? columns : columns - 1;
  if (index < 0) return { selection: cellSelection(state, table, 0, 0) };
  const targetRow = Math.floor(index / columns);
  if (targetRow >= table.rows.length - 1) {
    const insert = "\n|" + "  |".repeat(columns);
    return { changes: { from: table.to, insert }, selection: { anchor: table.to + 3 },
      userEvent: "input.table", annotations: isolateHistory.of("full"), scrollIntoView: true };
  }
  return { selection: cellSelection(state, table, targetRow === 0 ? 0 : targetRow + 1, index % columns), scrollIntoView: true };
}

export const nextTableCell: Command = view => {
  const spec = tableNavigation(view.state, 1);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
};
export const previousTableCell: Command = view => {
  const spec = tableNavigation(view.state, -1);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
};

export function tableMenuChoices(state: EditorState, pos: number) {
  const at = tableLocation(state, pos);
  if (!at) return [];
  const items: { id: string; label: string; danger?: boolean }[] = [{ id: "table-repair", label: "Inspect / repair table…" }];
  if (!at.valid) return items;
  items.push({ id: "table-select-cells", label: "Select table cells" }, { id: "table-format", label: "Format this table" });
  const { row, col, table } = at;
  const add = (id: TableAction, label: string, danger = false) => items.push({ id: `table-${id}`, label, danger });
  const columnName = table.rows[0][col].text || `column ${col + 1}`;
  add("sort-ascending", `Sort rows by ${columnName}: ascending`);
  add("sort-descending", `Sort rows by ${columnName}: descending`);
  if (row !== 1) {
    if (row > 1) add("row-above", "Row: insert above");
    add("row-below", "Row: insert below");
    if (row > 1) {
      add("row-duplicate", "Row: duplicate");
      if (row > 2) add("row-up", "Row: move up");
      if (row < table.rows.length - 1) add("row-down", "Row: move down");
      add("row-delete", "Row: delete", true);
    }
  }
  add("column-before", "Column: insert before");
  add("column-after", "Column: insert after");
  add("column-duplicate", "Column: duplicate");
  if (col > 0) add("column-left", "Column: move left");
  if (col < table.rows[0].length - 1) add("column-right", "Column: move right");
  if (table.rows[0].length > 1) add("column-delete", "Column: delete", true);
  for (const align of ["left", "center", "right", "justify"] as const) {
    const current = (table.align![col] ?? "left") === align;
    add(`align-${align}`, `Align column: ${align === "justify" ? "block justified" : align}${current ? " ✓" : ""}`);
  }
  return items;
}

/** Canonical structural edits preserve every cell's text and move its separator with it. */
export function tableAction(state: EditorState, pos: number, action: TableAction): TransactionSpec | null {
  if (state.readOnly) return null;
  const at = tableLocation(state, pos);
  if (!at?.valid) return null;
  if (action === "sort-ascending" || action === "sort-descending") return sortSourceTable(state, pos, action === "sort-ascending" ? 1 : -1);
  const { table } = at;
  let { row, col } = at;
  const rows = table.rows.map(cells => cells.map(cell => cell.text));
  const blank = () => rows[0].map(() => "");
  if (action.startsWith("align-")) {
    rows[1][col] = ({ "align-left": ":---", "align-center": ":---:", "align-right": "---:", "align-justify": "-:---:-" } as Record<string, string>)[action];
  } else if (action.startsWith("row-")) {
    if (row === 1 || (row === 0 && action !== "row-below")) return null;
    switch (action) {
      case "row-above": rows.splice(row, 0, blank()); break;
      case "row-below": row = row === 0 ? 2 : row + 1; rows.splice(row, 0, blank()); break;
      case "row-duplicate": rows.splice(row + 1, 0, [...rows[row]]); row++; break;
      case "row-delete": rows.splice(row, 1); row = Math.min(row, rows.length - 1); if (row === 1) row = 0; break;
      case "row-up": if (row <= 2) return null; [rows[row - 1], rows[row]] = [rows[row], rows[row - 1]]; row--; break;
      case "row-down": if (row >= rows.length - 1) return null; [rows[row + 1], rows[row]] = [rows[row], rows[row + 1]]; row++; break;
    }
  } else {
    if (action === "column-delete" && rows[0].length === 1) return null;
    if (action === "column-left" && col === 0) return null;
    if (action === "column-right" && col === rows[0].length - 1) return null;
    rows.forEach((cells, r) => {
      switch (action) {
        case "column-before": cells.splice(col, 0, r === 1 ? "---" : ""); break;
        case "column-after": cells.splice(col + 1, 0, r === 1 ? "---" : ""); break;
        case "column-duplicate": cells.splice(col + 1, 0, cells[col]); break;
        case "column-delete": cells.splice(col, 1); break;
        case "column-left": [cells[col - 1], cells[col]] = [cells[col], cells[col - 1]]; break;
        case "column-right": [cells[col + 1], cells[col]] = [cells[col], cells[col + 1]]; break;
      }
    });
    if (["column-after", "column-duplicate", "column-right"].includes(action)) col++;
    if (action === "column-left") col--;
    col = Math.min(col, rows[0].length - 1);
  }
  const lines = rows.map(cells => `| ${cells.join(" | ")} |`);
  const insert = lines.join("\n");
  const target = tableCells(lines[row])![col];
  const anchor = table.from + lines.slice(0, row).reduce((n, line) => n + line.length + 1, 0) + target.from + 1;
  return { changes: { from: table.from, to: table.to, insert }, selection: { anchor },
    userEvent: "input.table", annotations: isolateHistory.of("full"), scrollIntoView: true };
}

export type TableFormatScope = "current" | "selection" | "note";
export function tableFormatTargets(state: EditorState, scope: TableFormatScope) {
  const ranges: { from: number; to: number }[] = [];
  let skipped = 0;
  const selection = state.selection.main;
  let n = scope === "note" ? 1 : state.doc.lineAt(selection.from).number;
  const end = scope === "note" ? state.doc.lines : state.doc.lineAt(scope === "current" ? selection.from : selection.to).number;
  if (scope === "selection" && selection.empty) return { ranges, skipped };
  for (; n <= end; n++) {
    const table = sourceTableAt(state, state.doc.line(n).from);
    if (!table) continue;
    n = table.last;
    if (!table.align || table.rows.some(row => row.length !== table.align!.length)) { skipped++; continue; }
    ranges.push({ from: table.from, to: table.to });
  }
  return { ranges, skipped };
}

/** Sort whole source rows; never interpret formulas or modify header/marker text. */
export function sortSourceTable(state: EditorState, pos: number, direction: 1 | -1): TransactionSpec | null {
  const at = tableLocation(state, pos);
  if (state.readOnly || !at?.valid || at.table.rows.length < 3) return null;
  const { table, col } = at;
  const rows = table.rows.slice(2).map((cells, i) => ({ value: cells[col].text,
    line: state.doc.line(table.first + i + 2).text, original: i }));
  const filled = rows.filter(row => row.value !== "");
  const numeric = filled.length > 0 && filled.every(row => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(row.value) && Number.isFinite(Number(row.value)));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  rows.sort((a, b) => {
    if (!a.value || !b.value) return a.value ? -1 : b.value ? 1 : a.original - b.original;
    const order = numeric ? Number(a.value) - Number(b.value) : collator.compare(a.value, b.value);
    return direction * order || a.original - b.original;
  });
  const from = state.doc.line(table.first + 2).from;
  const insert = rows.map(row => row.line).join("\n");
  let anchor = state.selection.main.head;
  if (at.row >= 2) {
    const target = rows.findIndex(row => row.original === at.row - 2);
    const cell = tableCells(rows[target].line)![col];
    anchor = from + rows.slice(0, target).reduce((n, row) => n + row.line.length + 1, 0) + cell.from + 1;
  }
  return { changes: { from, to: table.to, insert }, selection: { anchor }, filter: false,
    annotations: isolateHistory.of("full"), userEvent: "input.table.sort", scrollIntoView: true };
}
