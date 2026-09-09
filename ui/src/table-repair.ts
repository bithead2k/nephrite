import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, showPanel, type Panel } from "@codemirror/view";
import { liveTableFormatting, sourceTableAt } from "./table-editing";
import { tableAlignments } from "./markdown-tables";

export type TableRepairPlan = { from: number; to: number; before: string; after: string; issues: string[] };

export function planTableRepair(state: EditorState, pos: number): TableRepairPlan | null {
  const table = sourceTableAt(state, pos);
  if (!table) return null;
  const rows = table.rows.map(cells => cells.map(cell => cell.text));
  const issues: string[] = [];
  const hasSeparator = !!table.align;
  const damagedSeparator = !hasSeparator && rows[1].every(cell => /^[\s:-]*$/.test(cell)) && rows[1].some(cell => cell.includes("-"));
  if (!hasSeparator && !damagedSeparator) {
    rows.splice(1, 0, rows[0].map(() => "---"));
    issues.push("Missing separator: insert a separator beneath the header.");
  } else if (damagedSeparator) {
    rows[1] = rows[1].map(cell => tableAlignments(`| ${cell} |`) ? cell
      : cell.startsWith(":") && cell.endsWith(":") ? ":---:"
      : cell.endsWith(":") ? "---:" : cell.startsWith(":") ? ":---" : "---");
    issues.push("Malformed separator: replace invalid markers with standard alignment markers.");
  }
  const columns = Math.max(...rows.map(row => row.length));
  if (columns > rows[0].length) {
    issues.push(`Some rows have extra cells: expand the table to ${columns} columns so no content is discarded. If a pipe is literal text, cancel and escape it as \\| instead.`);
  }
  rows.forEach((row, index) => {
    if (row.length < columns) {
      issues.push(`${index === 0 ? "Header" : index === 1 ? "Separator" : `Row ${index}`} has ${row.length} cells; add ${columns - row.length} empty ${index === 1 ? "alignment markers" : "cells"}.`);
      while (row.length < columns) row.push(index === 1 ? "---" : "");
    }
  });
  const draft = rows.map(row => `| ${row.join(" | ")} |`).join("\n");
  const formatter = EditorState.create({ extensions: [liveTableFormatting()] });
  const after = formatter.update({ changes: { from: 0, insert: draft }, userEvent: "input.table" }).newDoc.toString();
  const before = state.doc.sliceString(table.from, table.to);
  if (!issues.length) issues.push(before === after ? "No repairs needed." : "No structural problems found. Align cell spacing.");
  return { from: table.from, to: table.to, before, after, issues };
}

const showRepair = StateEffect.define<TableRepairPlan | null>();
export const tableRepairState = StateField.define<TableRepairPlan | null>({
  create: () => null,
  update(value, transaction) {
    // A changed document invalidates the reviewed proposal; never apply stale offsets.
    if (transaction.docChanged) value = null;
    for (const effect of transaction.effects) if (effect.is(showRepair)) value = effect.value;
    return value;
  },
  provide: field => showPanel.from(field, value => value ? repairPanel : null),
});

export function openTableRepair(view: EditorView, pos = view.state.selection.main.head): boolean {
  const plan = planTableRepair(view.state, pos);
  if (!plan) return false;
  view.dispatch({ effects: showRepair.of(plan) });
  return true;
}

export function applyTableRepair(view: Pick<EditorView, "state" | "dispatch">): boolean {
  const plan = view.state.field(tableRepairState, false);
  if (!plan || view.state.readOnly || view.state.doc.sliceString(plan.from, plan.to) !== plan.before) return false;
  view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.after },
    selection: { anchor: plan.from + 2 }, effects: showRepair.of(null),
    userEvent: "input.table.repair", annotations: isolateHistory.of("full"), filter: false });
  return true;
}

function repairPanel(view: EditorView): Panel {
  const plan = view.state.field(tableRepairState)!;
  const dom = document.createElement("section");
  dom.className = "cm-table-repair";
  dom.setAttribute("aria-label", "Table repair proposal");
  const title = document.createElement("strong");
  title.textContent = "Table repair — review the Markdown before applying";
  const issues = document.createElement("ul");
  for (const text of plan.issues) {
    const li = document.createElement("li");
    li.textContent = text;
    issues.append(li);
  }
  const before = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Current Markdown";
  const original = document.createElement("pre");
  original.textContent = plan.before;
  before.append(summary, original);
  const label = document.createElement("div");
  label.textContent = "Proposed Markdown";
  const proposed = document.createElement("pre");
  proposed.textContent = plan.after;
  proposed.tabIndex = 0;
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "Apply repair";
  apply.disabled = view.state.readOnly || plan.before === plan.after;
  apply.addEventListener("click", () => { applyTableRepair(view); view.focus(); });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const close = () => { view.dispatch({ effects: showRepair.of(null) }); view.focus(); };
  cancel.addEventListener("click", close);
  dom.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !apply.disabled) {
      event.preventDefault(); apply.click();
    }
  });
  dom.append(title, issues, before, label, proposed, apply, cancel);
  return { dom, top: false, mount() { (apply.disabled ? cancel : apply).focus(); } };
}

export const tableRepairTheme = EditorView.baseTheme({
  ".cm-table-repair": { padding: "12px", maxHeight: "45vh", overflow: "auto", background: "#15202b", color: "#e7ecf3", borderTop: "1px solid #52657d", font: "13px system-ui" },
  ".cm-table-repair pre": { whiteSpace: "pre", overflowX: "auto", padding: "8px", background: "#0d141d", fontFamily: "var(--editor-font, monospace)" },
  ".cm-table-repair button": { padding: "5px 12px", marginRight: "8px", cursor: "pointer" },
});
