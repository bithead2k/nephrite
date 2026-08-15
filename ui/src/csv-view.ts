export type CsvTable = { headers: string[]; rows: string[][] };

export function parseCsv(source: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = source.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = (rows.shift() ?? []).map((cell, index) => cell.trim() || `Column ${index + 1}`);
  const width = Math.max(headers.length, ...rows.map((item) => item.length), 0);
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  return {
    headers,
    rows: rows.map((item) => {
      const copy = item.slice();
      while (copy.length < width) copy.push("");
      return copy.slice(0, width);
    }),
  };
}

export function renderCsvView(host: HTMLElement, path: string, source: string): void {
  host.replaceChildren();
  host.classList.add("csv-viewer");
  const header = document.createElement("div");
  header.className = "code-viewer-header";
  header.textContent = path;
  const wrap = document.createElement("div");
  wrap.className = "csv-viewer-body";
  try {
    const table = parseCsv(source);
    wrap.appendChild(csvTableElement(table));
  } catch (error) {
    wrap.textContent = `Could not parse CSV: ${String(error)}`;
    wrap.classList.add("feature-error");
  }
  host.append(header, wrap);
}

export function clearCsvView(host: HTMLElement): void {
  host.replaceChildren();
}

/** Turn ` ```csv ` fences into the same table used for .csv files. */
export function hydrateCsvFences(root: ParentNode): void {
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code"))) {
    const lang = (code.className.match(/language-(\S+)/)?.[1] ?? "").toLowerCase();
    if (lang !== "csv") continue;
    if (code.closest(".plugin-code-block, .dv-block, .csv-block")) continue;
    const pre = code.closest("pre");
    if (!pre?.parentNode) continue;
    const figure = document.createElement("figure");
    figure.className = "csv-block";
    try {
      figure.appendChild(csvTableElement(parseCsv(code.textContent ?? "")));
    } catch (error) {
      figure.classList.add("csv-error");
      figure.textContent = `Could not parse CSV: ${String(error)}`;
    }
    pre.replaceWith(figure);
  }
}

export function csvTableElement(table: CsvTable): HTMLTableElement {
  const el = document.createElement("table");
  el.className = "csv-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const name of table.headers) {
    const cell = document.createElement("th");
    cell.textContent = name;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  const body = document.createElement("tbody");
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  el.append(head, body);
  return el;
}
