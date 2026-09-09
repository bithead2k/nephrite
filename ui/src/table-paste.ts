import { EditorState, StateEffect, StateField, type Text, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { Decoration, EditorView, showPanel, type Panel } from "@codemirror/view";
import { clipboardGrid, spreadsheetCell, type ClipboardGrid } from "./table-clipboard";
import { tableLocation } from "./table-commands";
import { liveTableFormatting } from "./table-editing";
import { cellRegionState, setCellRegion, regionBounds, regionCells, regionLine, type CellRegion } from "./table-selection";
import { DEFAULT_TABLE_SETTINGS, type TableSettings } from "./table-settings";

export type TablePastePlan = {
  snapshot: Text; grid: ClipboardGrid; plain: string; header: boolean; settings: TableSettings;
  selection: { from: number; to: number }; region: CellRegion | null;
  from: number; to: number; before: string; after: string; cursor: number; summary: string;
  highlights: { from: number; to: number }[]; inTable: boolean;
};

export function planTablePaste(state: EditorState, grid: ClipboardGrid, plain: string, header = true,
  settings: TableSettings = DEFAULT_TABLE_SETTINGS): TablePastePlan | null {
  if (state.readOnly) return null;
  const selection = { from: state.selection.main.from, to: state.selection.main.to };
  const region = state.field(cellRegionState, false) ?? null;
  const bounds = region ? regionBounds(region) : null;
  const origin = region && bounds ? state.doc.line(regionLine(region.first, bounds.top)).from + 1 : selection.from;
  const location = tableLocation(state, origin);
  if (location && !location.valid) return null;
  const cells = grid.cells.map(row => row.map(spreadsheetCell));
  if (!cells.length || !cells[0].length || cells.some(row => row.length !== cells[0].length)) return null;
  const height = cells.length, width = cells[0].length;
  let from = selection.from, to = selection.to, draft: string, summary: string, cursor: number;
  const highlights: { from: number; to: number }[] = [];
  if (location) {
    const { table } = location;
    const startRow = bounds?.top ?? (location.row < 2 ? (location.row === 1 ? 1 : 0) : location.row - 1);
    const startCol = bounds?.left ?? location.col;
    const rows = table.rows.map(row => row.map(cell => cell.text));
    const oldRows = rows.length - 1, oldCols = rows[0].length;
    const columns = Math.max(oldCols, startCol + width);
    while (rows.length - 1 < startRow + height) rows.push(Array(columns).fill(""));
    rows.forEach((row, i) => { while (row.length < columns) row.push(i === 1 ? "---" : ""); });
    let overwritten = 0;
    for (let r = 0; r < height; r++) {
      const logicalRow = startRow + r;
      const physicalRow = logicalRow ? logicalRow + 1 : 0;
      for (let c = 0; c < width; c++) {
        const col = startCol + c;
        if (rows[physicalRow][col]) overwritten++;
        rows[physicalRow][col] = cells[r][c];
        if (physicalRow < table.rows.length && col < oldCols) {
          const line = state.doc.line(table.first + physicalRow), cell = table.rows[physicalRow][col];
          if (cell.to > cell.from) highlights.push({ from: line.from + cell.from, to: line.from + cell.to });
        }
      }
    }
    from = table.from; to = table.to;
    draft = rows.map(row => `| ${row.join(" | ")} |`).join("\n");
    summary = `Paste ${height} × ${width} starting at row ${startRow + 1}, column ${startCol + 1}. Replaces ${overwritten} populated cells; adds ${rows.length - 1 - oldRows} rows and ${columns - oldCols} columns.`;
    if (bounds && (height !== bounds.bottom - bounds.top + 1 || width !== bounds.right - bounds.left + 1)) {
      summary += ` Selection is ${bounds.bottom - bounds.top + 1} × ${bounds.right - bounds.left + 1}; paste uses its top-left cell and the clipboard dimensions.`;
    }
    cursor = from + 2;
  } else {
    const rows = header ? [cells[0], Array(width).fill("---"), ...cells.slice(1)]
      : [Array.from({ length: width }, (_, c) => `Column ${c + 1}`), Array(width).fill("---"), ...cells];
    draft = rows.map(row => `| ${row.join(" | ")} |`).join("\n");
    summary = `Insert ${height} × ${width} spreadsheet ${header ? "using the first row as headings" : "with generated headings"}.`;
    cursor = from + 2;
  }
  const formatter = EditorState.create({ extensions: [liveTableFormatting(() => false, () => ({ ...settings, liveFormatting: true }))] });
  let after = formatter.update({ changes: { from: 0, insert: draft }, userEvent: "input.table" }).newDoc.toString();
  if (!location) {
    const leading = state.doc.sliceString(state.doc.lineAt(from).from, from).trim() ? "\n\n" : "";
    const trailing = state.doc.sliceString(to, state.doc.lineAt(to).to).trim() ? "\n\n" : "\n";
    after = leading + after + trailing;
    cursor += leading.length;
  }
  if (grid.merged) summary += " Merged cells become a rectangular grid with blank covered cells.";
  if (grid.cells.some(row => row.some(cell => /[\r\n]/.test(cell)))) summary += " Multiline cells use <br> inside one Markdown row.";
  return { snapshot: state.doc, grid, plain, header, settings, selection, region,
    from, to, before: state.doc.sliceString(from, to), after, cursor, summary, highlights, inTable: !!location };
}

export const showTablePaste = StateEffect.define<TablePastePlan | null>();
export const tablePasteState = StateField.define<TablePastePlan | null>({
  create: () => null,
  update(plan, transaction) {
    if (transaction.docChanged) plan = null;
    for (const effect of transaction.effects) if (effect.is(showTablePaste)) plan = effect.value;
    return plan;
  },
  provide: field => [
    showPanel.from(field, plan => plan ? pastePanel : null),
    EditorView.decorations.compute([field], state => Decoration.set((state.field(field)?.highlights ?? [])
      .map(range => Decoration.mark({ class: "cm-table-paste-target" }).range(range.from, range.to)), true)),
  ],
});

export function offerTablePaste(view: EditorView, html: string, text: string, settings = DEFAULT_TABLE_SETTINGS): boolean {
  if (view.dom.classList.contains("cm-live-preview")) return false;
  const grid = clipboardGrid(html, text) ?? (view.state.field(cellRegionState, false) ? { cells: [[text]], merged: false } : null);
  if (!grid) return false;
  const plain = text || grid.cells.map(row => row.map(cell => /[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join("\t")).join("\n");
  const plan = planTablePaste(view.state, grid, plain, true, settings);
  if (!plan) return false;
  view.dispatch({ effects: showTablePaste.of(plan) });
  return true;
}
export function applyTablePaste(view: Pick<EditorView, "state" | "dispatch">, plain = false): boolean {
  const plan = view.state.field(tablePasteState, false);
  if (!plan || view.state.readOnly || view.state.doc !== plan.snapshot) return false;
  let spec: TransactionSpec;
  if (plain && plan.region) {
    const cells = regionCells(view.state, plan.region).flat();
    spec = { changes: cells.map(cell => ({ from: cell.from, to: cell.to, insert: spreadsheetCell(plan.plain) })) };
  } else if (plain) {
    spec = { changes: { from: plan.selection.from, to: plan.selection.to, insert: plan.plain }, selection: { anchor: plan.selection.from + plan.plain.replace(/\r\n/g, "\n").length } };
  } else spec = { changes: { from: plan.from, to: plan.to, insert: plan.after }, selection: { anchor: plan.cursor } };
  view.dispatch({ ...spec, effects: showTablePaste.of(null), userEvent: "input.table.paste", annotations: isolateHistory.of("full"), filter: false });
  return true;
}

function pastePanel(view: EditorView): Panel {
  const dom = document.createElement("section");
  dom.className = "cm-table-repair";
  dom.setAttribute("aria-label", "Spreadsheet paste proposal");
  let current: TablePastePlan | null = null;
  const render = () => {
    const plan = view.state.field(tablePasteState);
    if (!plan || current === plan) return;
    current = plan; dom.replaceChildren();
    const title = document.createElement("strong"); title.textContent = "Spreadsheet paste";
    const summary = document.createElement("p"); summary.textContent = plan.summary;
    dom.append(title, summary);
    if (!plan.inTable) {
      const label = document.createElement("label"), header = document.createElement("input");
      header.type = "checkbox"; header.checked = plan.header;
      header.addEventListener("change", () => {
        const anchored = view.state.update({ selection: { anchor: plan.selection.from, head: plan.selection.to }, effects: setCellRegion.of(plan.region) }).state;
        const next = planTablePaste(anchored, plan.grid, plan.plain, header.checked, plan.settings);
        view.dispatch({ effects: showTablePaste.of(next) });
      });
      label.append(header, " First row contains headings"); dom.append(label);
    }
    const before = document.createElement("details"), caption = document.createElement("summary"), original = document.createElement("pre");
    caption.textContent = "Current Markdown"; original.textContent = plan.before || "(insertion)"; before.append(caption, original); dom.append(before);
    const pre = document.createElement("pre"); pre.textContent = plan.after; pre.tabIndex = 0; dom.append(pre);
    for (const [label, action] of [
      [plan.inTable ? "Apply to highlighted cells" : "Insert table", () => applyTablePaste(view)],
      [plan.region ? "Fill selected cells with plain text" : "Paste plain text", () => applyTablePaste(view, true)],
      ["Cancel", () => view.dispatch({ effects: showTablePaste.of(null) })],
    ] as const) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.addEventListener("click", () => { action(); view.focus(); }); dom.append(button);
    }
  };
  dom.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); view.dispatch({ effects: showTablePaste.of(null) }); view.focus(); }
    if (event.key === "Enter" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault(); applyTablePaste(view); view.focus();
    }
  });
  render();
  return { dom, mount() { dom.querySelector("button")?.focus(); }, update: render };
}

export const tablePasteTheme = EditorView.baseTheme({
  ".cm-table-paste-target": { backgroundColor: "rgba(255,190,75,.28)", outline: "1px solid #e9ad55" },
});
