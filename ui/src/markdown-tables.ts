import type { TokenizerAndRendererExtension, Tokens } from "marked";

export type TableAlignment = "left" | "center" | "right" | "justify" | null;
export type TableCell = { from: number; to: number; text: string };

/** Split only structural pipes, keeping escaped pipes, code and wiki aliases intact. */
export function tableCells(line: string): TableCell[] | null {
  if (!line.includes("|") || !/^ {0,3}\S/.test(line)) return null;
  const pipes: number[] = [];
  let ticks = 0;
  let wiki = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "`") {
      let end = i + 1;
      while (line[end] === "`") end++;
      const size = end - i;
      if (!ticks) {
        // An unmatched backtick is ordinary text, not an open code span.
        if (line.slice(end).includes("`".repeat(size))) ticks = size;
      } else if (ticks === size) ticks = 0;
      i = end - 1;
      continue;
    }
    if (ticks) continue;
    if (line.slice(i, i + 2) === "[[") { wiki = true; i++; continue; }
    if (wiki && line.slice(i, i + 2) === "]]") { wiki = false; i++; continue; }
    if (line[i] === "|" && !wiki) pipes.push(i);
  }
  if (!pipes.length) return null;
  const boundaries = [-1, ...pipes, line.length];
  const cells = boundaries.slice(0, -1).map((p, i) => ({
    from: p + 1, to: boundaries[i + 1], text: line.slice(p + 1, boundaries[i + 1]).trim(),
  }));
  if (!cells[0].text) cells.shift();
  if (cells.length && !cells[cells.length - 1].text) cells.pop();
  return cells.length ? cells : null;
}

export function tableAlignments(line: string): TableAlignment[] | null {
  const cells = tableCells(line);
  if (!cells || cells.some(({ text }) => !/^(?::-+:?|-+:?|-:-+:-)$/.test(text))) return null;
  return cells.map(({ text }) => /^-:-+:-$/.test(text) ? "justify"
    : text.startsWith(":") ? (text.endsWith(":") ? "center" : "left")
    : text.endsWith(":") ? "right" : null);
}

/** Marked extension: source is never normalized to make the custom marker parse. */
export const justifiedTableExtension: TokenizerAndRendererExtension = {
  name: "justifiedTable",
  level: "block",
  start(src) {
    if (!/-:-+:-/.test(src)) return undefined;
    const lines = src.split("\n");
    // Marked probes start() with the first character removed. Only advertise
    // later line starts, never a truncated first header.
    let offset = lines[0].length + 1;
    for (let i = 1; i + 1 < lines.length; i++) {
      const align = tableAlignments(lines[i + 1]);
      if (align?.includes("justify") && tableCells(lines[i])?.length === align.length) return offset;
      offset += lines[i].length + 1;
    }
    return undefined;
  },
  tokenizer(src) {
    const newline = src.indexOf("\n");
    if (newline < 0) return undefined;
    const nextNewline = src.indexOf("\n", newline + 1);
    const delimiter = src.slice(newline + 1, nextNewline < 0 ? src.length : nextNewline);
    if (!/-:-+:-/.test(delimiter)) return undefined;
    const align = tableAlignments(delimiter);
    const header = tableCells(src.slice(0, newline));
    if (!align?.includes("justify") || !header || header.length !== align.length) return undefined;
    const lines = src.split("\n");
    const rows = [header];
    let end = 2;
    while (end < lines.length) {
      const row = tableCells(lines[end]);
      if (!row || /^(?: {0,3})(?:>|#|`{3,}|~{3,}|[-+*] )/.test(lines[end])) break;
      rows.push(row);
      end++;
    }
    const raw = lines.slice(0, end).join("\n") + (end < lines.length ? "\n" : "");
    return {
      type: "justifiedTable", raw, align,
      rows: rows.map(row => align.map((_, i) => ({
        tokens: this.lexer.inline(row[i]?.text.replace(/\\\|/g, "|") ?? ""),
      }))),
    };
  },
  renderer(token) {
    const align = token.align as TableAlignment[];
    const rows = token.rows as { tokens: Tokens.Generic[] }[][];
    const renderRow = (row: typeof rows[number], tag: "th" | "td") => `<tr>${row.map((cell, i) => {
      const style = align[i] ? ` style="text-align:${align[i]}${align[i] === "justify" ? ";text-align-last:justify" : ""}"` : "";
      return `<${tag}${style}>${this.parser.parseInline(cell.tokens)}</${tag}>`;
    }).join("")}</tr>\n`;
    return `<table>\n<thead>\n${renderRow(rows[0], "th")}</thead>\n<tbody>\n${rows.slice(1).map(row => renderRow(row, "td")).join("")}</tbody>\n</table>\n`;
  },
};

/** Stretch prose gaps, never spaces inside code, wiki aliases, links, or HTML tags. */
export function justifyCell(text: string, width = 0): { text: string; map: (offset: number) => number } {
  const gaps: { from: number; to: number }[] = [];
  let ticks = 0;
  let brackets = 0;
  let parens = 0;
  let tag = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") {
      let end = i + 1;
      while (text[end] === "`") end++;
      if (!ticks) ticks = end - i;
      else if (ticks === end - i) ticks = 0;
      i = end - 1;
      continue;
    }
    if (ticks) continue;
    if (c === "<") tag = true;
    if (c === ">") tag = false;
    if (tag) continue;
    if (c === "[") brackets++;
    if (c === "]") brackets = Math.max(0, brackets - 1);
    if (c === "(") parens++;
    if (c === ")") parens = Math.max(0, parens - 1);
    if (c === " " && !brackets && !parens) {
      let end = i + 1;
      while (text[end] === " ") end++;
      gaps.push({ from: i, to: end });
      i = end - 1;
    }
  }
  if (!gaps.length) return { text, map: offset => offset };
  const length = text.length - gaps.reduce((sum, gap) => sum + gap.to - gap.from - 1, 0);
  const extra = Math.max(0, width - length);
  const replacements = gaps.map((gap, i) => ({ ...gap,
    size: 1 + Math.floor(extra / gaps.length) + (i < extra % gaps.length ? 1 : 0),
  }));
  let result = "", last = 0;
  for (const gap of replacements) {
    result += text.slice(last, gap.from) + " ".repeat(gap.size);
    last = gap.to;
  }
  result += text.slice(last);
  return { text: result, map(offset) {
    let delta = 0;
    for (const gap of replacements) {
      if (offset < gap.from) break;
      if (offset < gap.to) return gap.from + delta + Math.min(offset - gap.from, gap.size);
      delta += gap.size - (gap.to - gap.from);
    }
    return offset + delta;
  } };
}
