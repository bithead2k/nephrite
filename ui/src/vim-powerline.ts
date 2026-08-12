import { invoke } from "@tauri-apps/api/core";

type RenderResult = {
  screen: string;
  stderr: string;
  rows: number;
  columns: number;
  ok: boolean;
};

type CellStyle = {
  fg: number | null;
  bg: number | null;
  bold: boolean;
};

type Cell = CellStyle & { text: string };

export type VimPowerlineContext = {
  enabled: boolean;
  path: string | null;
  line: number;
  column: number;
  dirty: boolean;
};

export class VimPowerlineClient {
  private timer: number | null = null;
  private revision = 0;
  private contextKey = "";
  private element: HTMLElement;
  private rendering = false;
  private latestContext: VimPowerlineContext | null = null;
  private hasRenderedStatus = false;

  constructor() {
    this.element = document.getElementById("status-powerline")!;
  }

  update(context: VimPowerlineContext) {
    this.latestContext = context;
    this.element.classList.toggle("vim-dirty", context.dirty);
    if (context.enabled && context.path && context.dirty) this.element.hidden = false;
    else if (!this.hasRenderedStatus) this.element.hidden = true;
    if (!context.enabled || !context.path) {
      this.hide();
      return;
    }
    const columns = Math.max(40, Math.min(240, Math.floor(window.innerWidth / 9)));
    const key = JSON.stringify({ ...context, columns });
    if (key === this.contextKey) return;
    this.contextKey = key;
    if (this.timer != null) window.clearTimeout(this.timer);
    const revision = ++this.revision;
    // Vim startup is deliberately kept off the cursor hot path. A settled
    // cursor refreshes Powerline; Nephrite's native cursor field updates now.
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.render(context, columns, revision);
    }, 900);
  }

  private async render(context: VimPowerlineContext, columns: number, revision: number) {
    if (this.rendering) return;
    this.rendering = true;
    try {
      const result = await invoke<RenderResult>("render_vim_powerline", {
        path: context.path,
        line: context.line,
        column: context.column,
        dirty: context.dirty,
        columns,
      });
      if (revision !== this.revision) return;
      const cells = terminalStatusRow(result.screen, result.rows, result.columns);
      if (cells.length === 0) {
        this.hide();
        if (result.stderr.trim()) console.warn("[vim-powerline]", result.stderr.trim());
        return;
      }
      renderCells(this.element, cells);
      this.hasRenderedStatus = true;
      this.element.hidden = false;
      this.element.title = "Rendered by the user's Powerline Vim binding";
    } catch (error) {
      if (revision !== this.revision) return;
      this.hide();
      console.debug("[vim-powerline] unavailable", error);
    } finally {
      this.rendering = false;
      if (revision !== this.revision && this.latestContext?.enabled) {
        const latest = this.latestContext;
        this.contextKey = "";
        this.update(latest);
      }
    }
  }

  private hide() {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    this.contextKey = "";
    this.latestContext = null;
    this.hasRenderedStatus = false;
    this.element.classList.remove("vim-dirty");
    this.revision++;
    this.element.hidden = true;
    this.element.replaceChildren();
  }
}

export function terminalStatusRow(screen: string, rows: number, columns: number): Cell[] {
  const blank = (): Cell => ({ text: " ", fg: null, bg: null, bold: false });
  const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, blank));
  let row = 0;
  let column = 0;
  let style: CellStyle = { fg: null, bg: null, bold: false };

  for (let index = 0; index < screen.length;) {
    const character = screen[index];
    if (character === "\x1b") {
      if (screen[index + 1] === "[") {
        const match = screen.slice(index + 2).match(/^([0-9;?=>]*)([ -/]*)?([@-~])/);
        if (match) {
          const params = match[1].replace(/^[?=>]/, "").split(";").map((value) => Number(value || 0));
          const final = match[3];
          if (final === "H" || final === "f") {
            row = clamp((params[0] || 1) - 1, 0, rows - 1);
            column = clamp((params[1] || 1) - 1, 0, columns - 1);
          } else if (final === "A") row = clamp(row - (params[0] || 1), 0, rows - 1);
          else if (final === "B") row = clamp(row + (params[0] || 1), 0, rows - 1);
          else if (final === "C") column = clamp(column + (params[0] || 1), 0, columns - 1);
          else if (final === "D") column = clamp(column - (params[0] || 1), 0, columns - 1);
          else if (final === "G") column = clamp((params[0] || 1) - 1, 0, columns - 1);
          else if (final === "d") row = clamp((params[0] || 1) - 1, 0, rows - 1);
          else if (final === "J" && (params[0] === 2 || params[0] === 0)) {
            for (const line of grid) for (let cell = 0; cell < columns; cell++) line[cell] = blank();
          } else if (final === "K") {
            const from = params[0] === 1 || params[0] === 2 ? 0 : column;
            const to = params[0] === 1 ? column + 1 : columns;
            for (let cell = from; cell < to; cell++) grid[row][cell] = blank();
          } else if (final === "m") {
            style = applySgr(style, params.length ? params : [0]);
          }
          index += 2 + match[0].length;
          continue;
        }
      } else if (screen[index + 1] === "]") {
        const bell = screen.indexOf("\x07", index + 2);
        const terminator = screen.indexOf("\x1b\\", index + 2);
        const end = bell >= 0 && (terminator < 0 || bell < terminator) ? bell + 1 : terminator + 2;
        index = end > 1 ? end : index + 2;
        continue;
      }
      index += 2;
      continue;
    }
    if (character === "\r") {
      column = 0;
      index++;
      continue;
    }
    if (character === "\n") {
      row = clamp(row + 1, 0, rows - 1);
      index++;
      continue;
    }
    if (character >= " " && row < rows && column < columns) {
      const codePoint = screen.codePointAt(index)!;
      const text = String.fromCodePoint(codePoint);
      grid[row][column] = { text, ...style };
      column++;
      index += text.length;
      continue;
    }
    index++;
  }

  // Vim's statusline is the penultimate terminal row; the final row is the
  // command line. Trim only unstyled trailing blanks used for terminal fill.
  const status = grid[Math.max(0, rows - 2)];
  let end = status.length;
  while (end > 0 && status[end - 1].text === " " && status[end - 1].bg == null) end--;
  return status.slice(0, end);
}

function applySgr(current: CellStyle, params: number[]): CellStyle {
  const next = { ...current };
  for (let index = 0; index < params.length; index++) {
    const code = params[index];
    if (code === 0) Object.assign(next, { fg: null, bg: null, bold: false });
    else if (code === 1) next.bold = true;
    else if (code === 22) next.bold = false;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 39) next.fg = null;
    else if (code === 49) next.bg = null;
    else if ((code === 38 || code === 48) && params[index + 1] === 5) {
      const color = params[index + 2];
      if (Number.isInteger(color)) {
        if (code === 38) next.fg = color;
        else next.bg = color;
      }
      index += 2;
    }
  }
  return next;
}

function renderCells(parent: HTMLElement, cells: Cell[]) {
  parent.replaceChildren();
  let run: Cell[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const span = document.createElement("span");
    span.textContent = run.map((cell) => cell.text).join("");
    const first = run[0];
    const text = span.textContent || "";
    const isDivider = /^[\s\uE0B0-\uE0B3]+$/u.test(text);
    if (first.fg != null) {
      span.style.color = first.bg != null && !isDivider
        ? readableForeground(first.fg, first.bg)
        : ansi256(first.fg);
    }
    if (first.bg != null) span.style.backgroundColor = ansi256(first.bg);
    if (first.bold) span.style.fontWeight = "700";
    parent.append(span);
    run = [];
  };
  for (const cell of cells) {
    const first = run[0];
    if (first && (first.fg !== cell.fg || first.bg !== cell.bg || first.bold !== cell.bold)) flush();
    run.push(cell);
  }
  flush();
}

function ansi256(value: number): string {
  const [red, green, blue] = ansi256Rgb(value);
  return `rgb(${red},${green},${blue})`;
}

function ansi256Rgb(value: number): [number, number, number] {
  const base = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
    [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
    [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ];
  if (value < 16) return base[value] as [number, number, number];
  if (value >= 232) {
    const channel = 8 + (value - 232) * 10;
    return [channel, channel, channel];
  }
  const cube = value - 16;
  const channel = (part: number) => part === 0 ? 0 : 55 + part * 40;
  return [
    channel(Math.floor(cube / 36)),
    channel(Math.floor(cube / 6) % 6),
    channel(cube % 6),
  ];
}

function readableForeground(foreground: number, background: number): string {
  const foregroundRgb = ansi256Rgb(foreground);
  const backgroundRgb = ansi256Rgb(background);
  if (contrastRatio(foregroundRgb, backgroundRgb) >= 4.5) return ansi256(foreground);
  const black: [number, number, number] = [0, 0, 0];
  const white: [number, number, number] = [255, 255, 255];
  return contrastRatio(black, backgroundRgb) >= contrastRatio(white, backgroundRgb)
    ? "#000000"
    : "#ffffff";
}

function contrastRatio(left: [number, number, number], right: [number, number, number]): number {
  const brighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (brighter + 0.05) / (darker + 0.05);
}

function luminance(rgb: [number, number, number]): number {
  const channels = rgb.map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
