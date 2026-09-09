import { StateEffect, StateField, Prec, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, keymap, showPanel, type DecorationSet, type Panel } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { tableLocation } from "./table-commands";
import { tableCells } from "./markdown-tables";

export type CellRegion = { first: number; last: number; columns: number; anchorRow: number; anchorCol: number; headRow: number; headCol: number };
export const setCellRegion = StateEffect.define<CellRegion | null>();
export function regionBounds(region: CellRegion) {
  return { top: Math.min(region.anchorRow, region.headRow), bottom: Math.max(region.anchorRow, region.headRow),
    left: Math.min(region.anchorCol, region.headCol), right: Math.max(region.anchorCol, region.headCol) };
}
export const regionLine = (first: number, row: number) => first + (row ? row + 1 : 0);
export function regionCells(state: EditorState, region: CellRegion) {
  const bounds = regionBounds(region);
  const rows: { from: number; to: number; text: string; rawFrom: number; rawTo: number }[][] = [];
  for (let r = bounds.top; r <= bounds.bottom; r++) {
    const line = state.doc.line(regionLine(region.first, r));
    const cells = tableCells(line.text)!;
    rows.push(cells.slice(bounds.left, bounds.right + 1).map(cell => {
      const raw = line.text.slice(cell.from, cell.to);
      const from = line.from + cell.from + (cell.text ? raw.length - raw.trimStart().length : Math.min(1, raw.length));
      return { from, to: from + cell.text.length, text: cell.text, rawFrom: line.from + cell.from, rawTo: line.from + cell.to };
    }));
  }
  return rows;
}
function decorations(state: EditorState, region: CellRegion | null): DecorationSet {
  if (!region) return Decoration.none;
  const marks = regionCells(state, region).flat().map(cell => {
    const from = cell.to > cell.from ? cell.from : cell.rawFrom;
    const to = cell.to > cell.from ? cell.to : cell.rawTo;
    return to > from ? Decoration.mark({ class: "cm-table-selected-cell" }).range(from, to) : null;
  }).filter((mark): mark is NonNullable<typeof mark> => mark !== null);
  return Decoration.set(marks, true);
}
export const cellRegionState = StateField.define<CellRegion | null>({
  create: () => null,
  update(region, transaction) {
    if (transaction.docChanged) region = null;
    for (const effect of transaction.effects) if (effect.is(setCellRegion)) region = effect.value;
    return region;
  },
  provide: field => [
    EditorView.decorations.compute([field], state => decorations(state, state.field(field))),
    showPanel.from(field, region => region ? regionPanel : null),
  ],
});

export function beginCellSelection(view: EditorView, pos = view.state.selection.main.head): boolean {
  if (view.dom.classList.contains("cm-live-preview")) return false;
  const at = tableLocation(view.state, pos);
  if (!at?.valid) return false;
  const row = at.row < 2 ? 0 : at.row - 1;
  view.dispatch({ effects: setCellRegion.of({ first: at.table.first, last: at.table.last, columns: at.table.rows[0].length,
    anchorRow: row, headRow: row, anchorCol: at.col, headCol: at.col }), selection: { anchor: pos } });
  view.focus();
  return true;
}
export function extendCellSelection(view: EditorView, dr: number, dc: number): boolean {
  const region = view.state.field(cellRegionState, false);
  if (!region) return false;
  const headRow = Math.max(0, Math.min(region.last - region.first - 1, region.headRow + dr));
  const headCol = Math.max(0, Math.min(region.columns - 1, region.headCol + dc));
  const line = view.state.doc.line(regionLine(region.first, headRow));
  const cell = tableCells(line.text)![headCol];
  view.dispatch({ effects: setCellRegion.of({ ...region, headRow, headCol }),
    selection: { anchor: line.from + cell.from + Math.min(1, cell.to - cell.from) }, scrollIntoView: true });
  return true;
}
export function clearCellSelection(view: Pick<EditorView, "state" | "dispatch">): boolean {
  const region = view.state.field(cellRegionState, false);
  if (!region || view.state.readOnly) return false;
  const changes = regionCells(view.state, region).flat().map(cell => ({ from: cell.from, to: cell.to, insert: "" }));
  view.dispatch({ changes, effects: setCellRegion.of(null), userEvent: "delete.table", annotations: isolateHistory.of("full") });
  return true;
}
export function selectedCellsTsv(state: EditorState): string | null {
  const region = state.field(cellRegionState, false);
  if (!region) return null;
  const quote = (text: string) => {
    // Decode our spreadsheet cell escaping while preserving authored Markdown formatting.
    const plain = text.replace(/<br\s*\/?>/gi, "\n").replace(/\\([\\|`*_\[\]])/g, "$1")
      .replace(/&#9;/g, "\t").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return /[\t\n\r"]/.test(plain) ? `"${plain.replace(/"/g, '""')}"` : plain;
  };
  return regionCells(state, region).map(row => row.map(cell => quote(cell.text)).join("\t")).join("\n");
}
function regionPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-table-region-hint";
  const text = document.createElement("span");
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "Exit selection";
  close.addEventListener("click", () => { view.dispatch({ effects: setCellRegion.of(null) }); view.focus(); });
  dom.append(text, close);
  const update = () => {
    const region = view.state.field(cellRegionState);
    if (!region) return;
    const b = regionBounds(region);
    text.textContent = `${b.bottom - b.top + 1} × ${b.right - b.left + 1} cells · Shift-click or Shift+Arrow extend · Ctrl+C copy TSV · Delete clear · Esc exit `;
  };
  update();
  return { dom, update };
}

export const cellSelectionExtension = [
  cellRegionState,
  Prec.highest(keymap.of([
    { key: "Shift-ArrowLeft", run: view => extendCellSelection(view, 0, -1) },
    { key: "Shift-ArrowRight", run: view => extendCellSelection(view, 0, 1) },
    { key: "Shift-ArrowUp", run: view => extendCellSelection(view, -1, 0) },
    { key: "Shift-ArrowDown", run: view => extendCellSelection(view, 1, 0) },
    { key: "Delete", run: clearCellSelection }, { key: "Backspace", run: clearCellSelection },
    { key: "Escape", run: view => {
      if (!view.state.field(cellRegionState)) return false;
      view.dispatch({ effects: setCellRegion.of(null) }); return true;
    } },
  ])),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const region = view.state.field(cellRegionState);
      if (!region || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const at = pos == null ? null : tableLocation(view.state, pos);
      if (!at?.valid || at.table.first !== region.first) {
        view.dispatch({ effects: setCellRegion.of(null) }); return false;
      }
      event.preventDefault();
      const row = at.row < 2 ? 0 : at.row - 1;
      view.dispatch({ effects: setCellRegion.of({ ...region,
        anchorRow: event.shiftKey ? region.anchorRow : row, anchorCol: event.shiftKey ? region.anchorCol : at.col,
        headRow: row, headCol: at.col }), selection: { anchor: pos! } });
      view.focus(); return true;
    },
    copy(event, view) {
      const text = selectedCellsTsv(view.state);
      if (text == null || !event.clipboardData) return false;
      event.preventDefault(); event.clipboardData.setData("text/plain", text); return true;
    },
    cut(event, view) {
      const text = selectedCellsTsv(view.state);
      if (text == null || !event.clipboardData) return false;
      event.preventDefault(); event.clipboardData.setData("text/plain", text); clearCellSelection(view); return true;
    },
  }),
  EditorView.baseTheme({
    ".cm-table-selected-cell": { backgroundColor: "rgba(94,207,154,.3)", outline: "1px solid #5ecf9a" },
    ".cm-table-region-hint": { padding: "6px 10px", backgroundColor: "#15202b", color: "#e7ecf3", font: "12px system-ui" },
  }),
];
