import { bindImmediateKanbanDrag } from "./kanban-drag";
import { horizontalCellDelta } from "./accessibility";
import {
  baseTableCsv,
  evaluateBase,
  pageFromIndexRow,
  parseBase,
  type BaseFile,
  type BaseGroup,
  type BasePage,
  type BaseRow,
  type BaseTable,
  type BaseView,
} from "./bases";

export type BaseViewOptions = {
  path?: string;
  onOpen?: (path: string) => void;
  onMove?: (path: string, groupProperty: string, groupValue: unknown) => Promise<void>;
  onExport?: (suggestedName: string, csv: string) => Promise<void>;
};

export function renderBaseView(
  host: HTMLElement,
  source: string,
  pages: readonly BasePage[],
  options: BaseViewOptions = {},
): void {
  host.replaceChildren();
  host.classList.add("base-viewer");
  let parsed: BaseFile;
  try {
    parsed = parseBase(source);
  } catch (error) {
    host.innerHTML = `<div class="feature-error">Could not parse base: ${escapeHtml(String(error))}</div>`;
    return;
  }
  const header = document.createElement("div");
  header.className = "base-viewer-header";
  if (options.path) {
    const path = document.createElement("code");
    path.textContent = options.path;
    header.appendChild(path);
  }
  const tabs = document.createElement("div");
  tabs.className = "base-view-tabs";
  const body = document.createElement("div");
  body.className = "base-viewer-body";
  host.append(header, tabs, body);

  let active = 0;
  const collapsed = new Set<string>();
  const draw = () => {
    tabs.replaceChildren();
    parsed.views.forEach((view, index) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `base-view-tab${index === active ? " active" : ""}`;
      tab.textContent = view.name;
      tab.addEventListener("click", () => {
        active = index;
        collapsed.clear();
        draw();
      });
      tabs.appendChild(tab);
    });
    const table = evaluateBase(parsed, pages, active);
    const view = parsed.views[active] ?? parsed.views[0];
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "base-export";
    exportButton.textContent = "Export CSV…";
    exportButton.addEventListener("click", () => {
      const stem = options.path?.replace(/^.*\//, "").replace(/\.base$/i, "") || table.name || "base";
      void options.onExport?.(`${stem}-${safeFilePart(table.name)}.csv`, baseTableCsv(table));
    });
    exportButton.disabled = !options.onExport;
    tabs.appendChild(exportButton);
    body.replaceChildren(renderBaseResult(table, view, options, collapsed));
  };
  draw();
}

export async function hydrateBaseFencesWhenNeeded(
  root: ParentNode,
  loadPages: () => Promise<readonly BasePage[]>,
  live: () => boolean = () => true,
  ...options: Parameters<typeof hydrateBaseFences> extends [unknown, unknown, ...infer R] ? R : never
): Promise<void> {
  if (!live() || !Array.from(root.querySelectorAll<HTMLElement>("pre > code")).some(code =>
    /^(base|bases)$/i.test(code.className.match(/language-(\S+)/)?.[1] ?? ""))) return;
  const pages = await loadPages();
  if (live()) hydrateBaseFences(root, pages, ...options);
}

export function hydrateBaseFences(
  root: ParentNode,
  pages: readonly BasePage[],
  onOpen?: (path: string) => void,
  onMove?: BaseViewOptions["onMove"],
  onExport?: BaseViewOptions["onExport"],
): void {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code"))) {
    const lang = (code.className.match(/language-(\S+)/)?.[1] ?? "").toLowerCase();
    if (lang !== "base" && lang !== "bases") continue;
    const pre = code.parentElement;
    if (!(pre instanceof HTMLElement)) continue;
    const mount = document.createElement("div");
    renderBaseView(mount, code.textContent || "", pages, { onOpen, onMove, onExport });
    pre.replaceWith(mount);
  }
}

export function pagesFromListRows(rows: readonly {
  path: string; name: string; folder?: string; size_bytes?: number;
  tags?: unknown; links?: unknown; properties?: Record<string, unknown> | null;
}[]): BasePage[] {
  return rows.map((row) => pageFromIndexRow(row));
}

function renderBaseResult(
  table: BaseTable,
  view: BaseView,
  options: BaseViewOptions,
  collapsed: Set<string>,
): HTMLElement {
  const wrap = document.createElement("div");
  const summary = document.createElement("p");
  summary.className = "feature-help";
  summary.textContent = `${table.rows.length} row${table.rows.length === 1 ? "" : "s"} · ${table.name}`;
  wrap.appendChild(summary);
  if (!table.rows.length) {
    const empty = document.createElement("div");
    empty.className = "feature-empty";
    empty.textContent = "No notes match this base.";
    wrap.appendChild(empty);
    return wrap;
  }
  if (view.type.toLowerCase() === "kanban") {
    wrap.appendChild(renderKanban(table, options));
    return wrap;
  }
  if (!table.groupBy) {
    wrap.appendChild(renderRows(table, table.rows, view.type, options.onOpen));
    return wrap;
  }
  const grouped = document.createElement("div");
  grouped.className = "base-groups";
  for (const group of table.groups) {
    const details = document.createElement("details");
    details.className = "base-group";
    details.open = !collapsed.has(group.key);
    const summaryNode = document.createElement("summary");
    summaryNode.textContent = `${group.label} (${group.rows.length})`;
    details.append(summaryNode, renderRows(table, group.rows, view.type, options.onOpen));
    details.addEventListener("toggle", () => {
      if (details.open) collapsed.delete(group.key);
      else collapsed.add(group.key);
    });
    grouped.appendChild(details);
  }
  return grouped;
}

function renderRows(table: BaseTable, rows: BaseRow[], type: string, onOpen?: (path: string) => void): HTMLElement {
  if (type.toLowerCase() === "cards") return renderCards(table, rows, onOpen);
  if (type.toLowerCase() === "list") return renderList(rows, onOpen);
  return renderTable(table, rows, onOpen);
}

function renderKanban(table: BaseTable, options: BaseViewOptions): HTMLElement {
  const board = document.createElement("div");
  board.className = "base-kanban kanban-scroll";
  const groups: BaseGroup[] = table.groupBy
    ? table.groups
    : [{ key: "", label: "All", value: null, rows: table.rows }];
  groups.forEach((group, columnIndex) => {
    const column = document.createElement("section");
    column.className = "base-kanban-column kanban-col";
    column.dataset.col = String(columnIndex);
    const heading = document.createElement("header");
    heading.className = "kanban-col-head";
    heading.innerHTML = `<span>${escapeHtml(group.label || "All")}</span><span class="kanban-count">${group.rows.length}</span>`;
    const cards = document.createElement("div");
    cards.className = "base-kanban-cards kanban-cards";
    group.rows.forEach((row, rowIndex) => {
      const card = renderBaseKanbanCard(table, row, options.onOpen);
      cards.appendChild(card);
      if (table.groupBy?.property === "file.folder" && options.onMove) {
        bindImmediateKanbanDrag(card, { fromCol: columnIndex, fromIdx: rowIndex }, {
          onDrop: (_origin, targetColumn) => {
            const target = groups[targetColumn];
            if (!target || target.key === group.key) return;
            card.setAttribute("aria-busy", "true");
            void options.onMove?.(row.path, "file.folder", target.value).catch((error) => {
              const message = document.createElement("div");
              message.className = "feature-error base-move-error";
              message.setAttribute("role", "alert");
              message.textContent = `Could not move ${row.path}: ${String(error)}`;
              board.prepend(message);
            }).finally(() => card.removeAttribute("aria-busy"));
          },
        });
      }
    });
    column.append(heading, cards);
    board.appendChild(column);
  });
  if (table.groupBy && table.groupBy.property !== "file.folder") {
    const help = document.createElement("p");
    help.className = "feature-help base-kanban-help";
    help.textContent = `Grouped by ${table.groupBy.property}. Dragging between columns is currently available for file.folder groups.`;
    board.prepend(help);
  }
  return board;
}

function renderBaseKanbanCard(table: BaseTable, row: BaseRow, onOpen?: (path: string) => void): HTMLElement {
  const card = document.createElement("article");
  card.className = "base-kanban-card kanban-card";
  const titleIndex = table.columns.findIndex((column) => ["file.name", "file.path", "name", "path"].includes(column.id));
  card.appendChild(openButton(row.path, formatCell(row.cells[titleIndex >= 0 ? titleIndex : 0]) || row.path, onOpen));
  table.columns.forEach((column, index) => {
    if (index === titleIndex) return;
    const line = document.createElement("div");
    line.className = "base-kanban-field";
    const label = document.createElement("small");
    label.textContent = column.label;
    line.append(label, document.createTextNode(formatCell(row.cells[index])));
    card.appendChild(line);
  });
  return card;
}

function renderTable(table: BaseTable, rows: BaseRow[], onOpen?: (path: string) => void): HTMLElement {
  const scroller = document.createElement("div");
  scroller.className = "base-table-scroll";
  const el = document.createElement("table");
  el.className = "base-table";
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  for (const column of table.columns) {
    const th = document.createElement("th");
    th.textContent = column.label;
    header.appendChild(th);
  }
  head.appendChild(header);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    table.columns.forEach((column, index) => {
      const td = document.createElement("td");
      td.tabIndex = 0;
      td.dataset.column = String(index);
      td.appendChild(cellNode(row.cells[index], row.path, column.id, onOpen));
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  el.append(head, body);
  el.addEventListener("keydown", (event) => {
    const ElementClass = el.ownerDocument.defaultView?.Element;
    if (!ElementClass || !(event.target instanceof ElementClass)) return;
    const cell = event.target.closest<HTMLTableCellElement>("td");
    if (!cell || !el.contains(cell)) return;
    const row = cell.parentElement;
    if (!row) return;
    let target: HTMLElement | null = null;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const sibling = event.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
      target = sibling?.children.item(cell.cellIndex) as HTMLElement | null;
    } else {
      const explicitDirection = el.closest<HTMLElement>("[dir]")?.dir;
      const delta = horizontalCellDelta(event.key, explicitDirection === "rtl" || getComputedStyle(el).direction === "rtl");
      if (delta) target = row.children.item(cell.cellIndex + delta) as HTMLElement | null;
    }
    if (!target) return;
    (target.querySelector<HTMLElement>("button, a, input, select, textarea") ?? target).focus();
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    event.preventDefault();
  });
  scroller.appendChild(el);
  return scroller;
}

function renderList(rows: BaseRow[], onOpen?: (path: string) => void): HTMLElement {
  const list = document.createElement("div");
  list.className = "base-list";
  for (const row of rows) list.appendChild(openButton(row.path, formatCell(row.cells[0]) || row.path, onOpen));
  return list;
}

function renderCards(table: BaseTable, rows: BaseRow[], onOpen?: (path: string) => void): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "base-cards";
  for (const row of rows) {
    const card = document.createElement("article");
    card.className = "base-card";
    table.columns.forEach((column, index) => {
      const line = document.createElement("div");
      const label = document.createElement("small");
      label.textContent = column.label;
      line.append(label, cellNode(row.cells[index], row.path, column.id, onOpen));
      card.appendChild(line);
    });
    grid.appendChild(card);
  }
  return grid;
}

function cellNode(value: unknown, path: string, columnId: string, onOpen?: (path: string) => void): Node {
  const text = formatCell(value);
  return onOpen && ["file.name", "file.path", "name", "path"].includes(columnId)
    ? openButton(path, text || path, onOpen)
    : document.createTextNode(text);
}

function openButton(path: string, label: string, onOpen?: (path: string) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "base-link";
  button.textContent = label;
  button.disabled = !onOpen;
  if (onOpen) button.addEventListener("click", () => onOpen(path));
  return button;
}

function formatCell(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(formatCell).filter(Boolean).join(", ");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-") || "view";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
