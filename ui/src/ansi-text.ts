/** Render terminal SGR styling as escaped HTML; never execute terminal controls. */
export function renderAnsiText(source: string): string {
  const palette = ["#000000", "#aa0000", "#00aa00", "#aa5500", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa", "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff"];
  const indexed = (n: number): string | undefined => {
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    if (n < 16) return palette[n];
    if (n >= 232) { const c = 8 + (n - 232) * 10; return `rgb(${c},${c},${c})`; }
    const levels = [0, 95, 135, 175, 215, 255];
    n -= 16;
    return `rgb(${levels[Math.floor(n / 36)]},${levels[Math.floor(n / 6) % 6]},${levels[n % 6]})`;
  };
  let fg: string | undefined, bg: string | undefined;
  let bold = false, dim = false, italic = false, underline = false, strike = false, inverse = false;
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Keep ASCII runs compact; constrain non-ASCII graphemes to terminal columns.
  const boxes: Record<string, string> = {
    "─": "lr", "│": "ud", "┌": "rd", "┐": "ld", "└": "ru", "┘": "lu",
    "├": "urd", "┤": "uld", "┬": "lrd", "┴": "lru", "┼": "lrud",
  };
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const cells = (text: string): string => {
    if (!/[^\x00-\x7f]/.test(text)) return escape(text);
    let result = "";
    for (const { segment } of segmenter.segment(text)) {
      if (/^[\x00-\x7f]+$/.test(segment)) { result += escape(segment); continue; }
      const arms = boxes[segment];
      if (arms) {
        result += `<span class="terminal-cell terminal-box"><span>${segment}</span>${[...arms].map(a => `<i aria-hidden="true" class="terminal-arm-${a}"></i>`).join("")}</span>`;
        continue;
      }
      const cp = segment.codePointAt(0)!;
      const wide = /\p{Emoji_Presentation}/u.test(segment) || segment.includes("\ufe0f") ||
        (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
          (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
          (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
          (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
          (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
          (cp >= 0x20000 && cp <= 0x3fffd)));
      const zero = /^[\p{Mark}\u200b-\u200f\ufeff]+$/u.test(segment);
      result += `<span class="terminal-cell${wide ? " terminal-wide" : zero ? " terminal-zero" : ""}">${escape(segment)}</span>`;
    }
    return result;
  };
  const render = (s: string): string => {
    if (!s) return "";
    const styles: string[] = [];
    const foreground = inverse ? bg ?? "var(--ansi-background, #1e1e1e)" : fg;
    const background = inverse ? fg ?? "var(--ansi-foreground, #dedede)" : bg;
    if (foreground) styles.push(`color:${foreground}`);
    if (background) styles.push(`background-color:${background}`);
    if (bold) styles.push("font-weight:bold");
    if (dim) styles.push("opacity:0.65");
    if (italic) styles.push("font-style:italic");
    if (underline || strike) styles.push(`text-decoration:${[underline ? "underline" : "", strike ? "line-through" : ""].filter(Boolean).join(" ")}`);
    return styles.length ? `<span style="${styles.join(";")}">${cells(s)}</span>` : cells(s);
  };
  // OSC (including hyperlinks), DCS and non-SGR CSI controls are consumed, not interpreted.
  const controls = /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\|(?:\x1b\[|\x9b)([0-9:;?]*)([ -/]*)([@-~])|\x1b[@-_])/g;
  let html = "", offset = 0;
  for (const match of source.matchAll(controls)) {
    html += render(source.slice(offset, match.index));
    offset = match.index! + match[0].length;
    if (match[3] !== "m" || match[2] || !/^[0-9;]*$/.test(match[1])) continue;
    const args = match[1].split(";").map(Number);
    for (let i = 0; i < args.length; i++) {
      const n = args[i];
      if (n === 0) { fg = bg = undefined; bold = dim = italic = underline = strike = inverse = false; }
      else if (n === 1) bold = true;
      else if (n === 2) dim = true;
      else if (n === 3) italic = true;
      else if (n === 4) underline = true;
      else if (n === 7) inverse = true;
      else if (n === 9) strike = true;
      else if (n === 22) bold = dim = false;
      else if (n === 23) italic = false;
      else if (n === 24) underline = false;
      else if (n === 27) inverse = false;
      else if (n === 29) strike = false;
      else if (n === 39) fg = undefined;
      else if (n === 49) bg = undefined;
      else if (n >= 30 && n <= 37) fg = palette[n - 30];
      else if (n >= 90 && n <= 97) fg = palette[n - 90 + 8];
      else if (n >= 40 && n <= 47) bg = palette[n - 40];
      else if (n >= 100 && n <= 107) bg = palette[n - 100 + 8];
      else if (n === 38 || n === 48) {
        const mode = args[++i];
        let color: string | undefined;
        if (mode === 5) color = indexed(args[++i]);
        else if (mode === 2) {
          const rgb = args.slice(i + 1, i + 4); i += 3;
          if (rgb.length === 3 && rgb.every(c => Number.isInteger(c) && c >= 0 && c <= 255)) color = `rgb(${rgb.join(",")})`;
        } else break;
        if (color) { if (n === 38) fg = color; else bg = color; }
      }
    }
  }
  return html + render(source.slice(offset));
}
