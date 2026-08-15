import {
  evaluateBase,
  pageFromIndexRow,
  parseBase,
  type BaseFile,
  type BasePage,
  type BaseTable,
} from "./bases";

export function renderBaseView(
  host: HTMLElement,
  source: string,
  pages: readonly BasePage[],
  options: { path?: string; onOpen?: (path: string) => void } = {},
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
  const draw = () => {
    tabs.replaceChildren();
    parsed.views.forEach((view, index) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `base-view-tab${index === active ? " active" : ""}`;
      tab.textContent = view.name;
      tab.addEventListener("click", () => {
        active = index;
        draw();
      });
      tabs.appendChild(tab);
    });
    const table = evaluateBase(parsed, pages, active);
    const view = parsed.views[active] ?? parsed.views[0];
    body.replaceChildren(renderBaseResult(table, view?.type ?? "table", options.onOpen));
  };
  draw();
}

export function hydrateBaseFences(
  root: ParentNode,
  pages: readonly BasePage[],
  onOpen?: (path: string) => void,
): void {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code"))) {
    const lang = (code.className.match(/language-(\S+)/)?.[1] ?? "").toLowerCase();
    if (lang !== "base" && lang !== "bases") continue;
    const pre = code.parentElement;
    if (!(pre instanceof HTMLElement)) continue;
    const mount = document.createElement("div");
    renderBaseView(mount, code.textContent || "", pages, { onOpen });
    pre.replaceWith(mount);
  }
}

export function pagesFromListRows(rows: readonly {
  path: string;
  name: string;
  folder?: string;
  size_bytes?: number;
  tags?: unknown;
  links?: unknown;
  properties?: Record<string, unknown> | null;
}[]): BasePage[] {
  return rows.map((row) => pageFromIndexRow(row));
}

function renderBaseResult(
  table: BaseTable,
  type: string,
  onOpen?: (path: string) => void,
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
  if (type === "cards") {
    wrap.appendChild(renderCards(table, onOpen));
    return wrap;
  }
  if (type === "list") {
    wrap.appendChild(renderList(table, onOpen));
    return wrap;
  }
  wrap.appendChild(renderTable(table, onOpen));
  return wrap;
}

function renderTable(table: BaseTable, onOpen?: (path: string) => void): HTMLElement {
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
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    table.columns.forEach((column, index) => {
      const td = document.createElement("td");
      td.appendChild(cellNode(row.cells[index], row.path, column.id, onOpen));
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  el.append(head, body);
  return el;
}

function renderList(table: BaseTable, onOpen?: (path: string) => void): HTMLElement {
  const list = document.createElement("div");
  list.className = "base-list";
  for (const row of table.rows) {
    list.appendChild(openButton(row.path, String(row.cells[0] ?? row.path), onOpen));
  }
  return list;
}

function renderCards(table: BaseTable, onOpen?: (path: string) => void): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "base-cards";
  for (const row of table.rows) {
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

function cellNode(
  value: unknown,
  path: string,
  columnId: string,
  onOpen?: (path: string) => void,
): Node {
  const text = formatCell(value);
  if (onOpen && (columnId === "file.name" || columnId === "file.path" || columnId === "name" || columnId === "path")) {
    return openButton(path, text || path, onOpen);
  }
  return document.createTextNode(text);
}

function openButton(path: string, label: string, onOpen?: (path: string) => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "base-link";
  button.textContent = label;
  if (onOpen) button.addEventListener("click", () => onOpen(path));
  return button;
}

function formatCell(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => formatCell(item)).filter(Boolean).join(", ");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
