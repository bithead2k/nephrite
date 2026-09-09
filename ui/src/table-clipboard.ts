export type ClipboardGrid = { cells: string[][]; merged: boolean };

/** Quoted TSV supports embedded tabs/newlines and doubled quotation marks. */
export function parseTsv(text: string): string[][] | null {
  if (!text.includes("\t")) return null;
  const input = text.replace(/\r\n?/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += c;
      continue;
    }
    if (c === '\t' || c === '\n') {
      row.push(field); field = ""; closed = false;
      if (c === '\n') { rows.push(row); row = []; }
    } else if (closed) return null;
    else if (c === '"' && field === "") quoted = true;
    else field += c;
  }
  if (quoted) return null;
  if (field || row.length || !input.endsWith("\n")) { row.push(field); rows.push(row); }
  if (!rows.length || rows[0].length < 2 || rows.some(r => r.length !== rows[0].length)) return null;
  return rows;
}

export function clipboardGrid(html: string, text: string): ClipboardGrid | null {
  if (html && typeof DOMParser !== "undefined") {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    parsed.querySelectorAll("script,style").forEach(node => node.remove());
    const tables = [...parsed.querySelectorAll("table")].filter(table => !table.parentElement?.closest("table"));
    if (tables.length === 1) {
      const table = tables[0];
      const result: (string | undefined)[][] = [];
      let merged = false;
      const rows = [...table.querySelectorAll("tr")].filter(row => row.closest("table") === table);
      rows.forEach((row, r) => {
        result[r] ??= [];
        let c = 0;
        for (const cell of [...row.cells]) {
          while (result[r][c] !== undefined) c++;
          const width = Math.max(1, Math.min(1000, cell.colSpan || 1));
          const height = Math.max(1, Math.min(1000, cell.rowSpan || 1));
          merged ||= width > 1 || height > 1;
          const clone = cell.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("br").forEach(br => br.replaceWith(parsed.createTextNode("\n")));
          for (let y = r; y < r + height; y++) {
            result[y] ??= [];
            for (let x = c; x < c + width; x++) result[y][x] = y === r && x === c ? clone.textContent ?? "" : "";
          }
          c += width;
        }
      });
      const width = result.reduce((n, row) => Math.max(n, row.length), 0);
      if (width && result.length) return { cells: result.map(row => Array.from({ length: width }, (_, c) => row[c] ?? "")), merged };
    }
  }
  const cells = parseTsv(text);
  return cells ? { cells, merged: false } : null;
}

export function spreadsheetCell(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\|`*_\[\]]/g, "\\$&").replace(/\t/g, "&#9;").replace(/\r\n?|\n/g, "<br>");
}
