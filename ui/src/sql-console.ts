import type { SqlQueryResult } from "./dv-engine";

export function renderSqlConsole(
  host: HTMLElement,
  options: {
    run: (sql: string) => Promise<SqlQueryResult>;
    onOpen?: (path: string) => void;
  },
): void {
  host.replaceChildren();
  host.classList.add("sql-console");
  const help = document.createElement("p");
  help.className = "feature-help";
  help.textContent = "Read-only PostgreSQL over the vault index. One SELECT. Same engine as ```pgsql fences.";
  const editor = document.createElement("textarea");
  editor.className = "sql-console-input";
  editor.spellcheck = false;
  editor.rows = 8;
  editor.placeholder = "SELECT path, title FROM pages LIMIT 20";
  const actions = document.createElement("div");
  actions.className = "sql-console-actions";
  const run = document.createElement("button");
  run.type = "button";
  run.textContent = "Run";
  const status = document.createElement("span");
  status.className = "sql-console-status";
  const results = document.createElement("div");
  results.className = "sql-console-results";
  actions.append(run, status);
  host.append(help, editor, actions, results);

  const execute = async () => {
    const sql = editor.value.trim();
    if (!sql) return;
    status.textContent = "Running…";
    try {
      const result = await options.run(sql);
      status.textContent = `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""}`;
      results.replaceChildren(sqlResultTable(result, options.onOpen));
    } catch (error) {
      status.textContent = "Error";
      results.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
    }
  };
  run.addEventListener("click", () => void execute());
  editor.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void execute();
    }
  });
}

export function sqlResultTable(
  result: SqlQueryResult,
  onOpen?: (path: string) => void,
): HTMLElement {
  if (!result.columns.length) {
    const empty = document.createElement("div");
    empty.className = "feature-empty";
    empty.textContent = "Query returned no columns.";
    return empty;
  }
  const table = document.createElement("table");
  table.className = "sql-console-table";
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  for (const column of result.columns) {
    const cell = document.createElement("th");
    cell.textContent = column;
    header.appendChild(cell);
  }
  head.appendChild(header);
  const body = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    result.columns.forEach((column, index) => {
      const td = document.createElement("td");
      const value = Array.isArray(row) ? row[index] : (row as Record<string, unknown>)[column];
      const text = value == null ? "" : String(value);
      td.textContent = text;
      if (onOpen && (column === "path" || /\/.+\.md$/i.test(text))) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "sql-console-link";
        link.textContent = text;
        link.addEventListener("click", () => onOpen(text));
        td.replaceChildren(link);
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
  table.append(head, body);
  return table;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
