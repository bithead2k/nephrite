/**
 * Daily notes: Obsidian `.obsidian/daily-notes.json` plus vault heuristics.
 * Files stay ordinary Markdown.
 */

import type { FileEntry } from "./types";

export type DailyNotesSettings = {
  folder: string;
  format: string;
  template: string;
};

export const DEFAULT_DAILY_NOTES: DailyNotesSettings = {
  folder: "journals",
  format: "YYYY_MM_DD",
  template: "",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseDailyNotesSettings(source: string): DailyNotesSettings {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const folder = typeof parsed.folder === "string" ? parsed.folder.replace(/^\/+|\/+$/g, "") : "";
  const format = typeof parsed.format === "string" && parsed.format.trim()
    ? parsed.format.trim()
    : DEFAULT_DAILY_NOTES.format;
  let template = typeof parsed.template === "string" ? parsed.template.trim() : "";
  if (template && !/\.md$/i.test(template)) template = `${template}.md`;
  return {
    folder: folder || DEFAULT_DAILY_NOTES.folder,
    format,
    template,
  };
}

export function formatDailyPath(date: Date, settings: DailyNotesSettings): string {
  const name = formatMoment(date, settings.format);
  const file = name.endsWith(".md") ? name : `${name}.md`;
  return settings.folder ? `${settings.folder}/${file}` : file;
}

export function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function parseLocalDateKey(key: string): Date | null {
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shiftDate(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The day after tomorrow. Official Nephrite vocabulary. */
export function overmorrow(date = new Date()): Date {
  return shiftDate(date, 2);
}

/** The day before yesterday. Official Nephrite vocabulary. */
export function ereyesterday(date = new Date()): Date {
  return shiftDate(date, -2);
}

export type PeriodKind = "week" | "month" | "quarter";

/** Flat vault-root names: `2026-W02.md`, `2026-08.md`, `2026-Q03.md`. */
export function periodNotePath(date: Date, kind: PeriodKind): string {
  if (kind === "week") {
    const { year, week } = isoWeek(date);
    return `${year}-W${String(week).padStart(2, "0")}.md`;
  }
  if (kind === "month") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}.md`;
  }
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  return `${date.getFullYear()}-Q${String(quarter).padStart(2, "0")}.md`;
}

export function isoWeek(date: Date): { year: number; week: number } {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const year = utc.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year, week };
}

export function formatMoment(date: Date, format: string): string {
  let output = "";
  let i = 0;
  while (i < format.length) {
    if (format[i] === "[") {
      const close = format.indexOf("]", i + 1);
      if (close < 0) {
        output += format[i];
        i += 1;
        continue;
      }
      output += format.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    const token = takeToken(format, i);
    if (token) {
      output += tokenValue(date, token);
      i += token.length;
    } else {
      output += format[i];
      i += 1;
    }
  }
  return output;
}

const TOKENS = ["YYYY", "dddd", "MMMM", "ddd", "MMM", "YY", "MM", "DD", "M", "D"];

function takeToken(format: string, index: number): string | null {
  return TOKENS.find((token) => format.startsWith(token, index)) ?? null;
}

function tokenValue(date: Date, token: string): string {
  const month = date.getMonth();
  const day = date.getDate();
  switch (token) {
    case "YYYY": return String(date.getFullYear());
    case "YY": return String(date.getFullYear()).slice(-2);
    case "MMMM": return MONTHS[month];
    case "MMM": return MONTHS_SHORT[month];
    case "MM": return String(month + 1).padStart(2, "0");
    case "M": return String(month + 1);
    case "dddd": return WEEKDAYS[date.getDay()];
    case "ddd": return WEEKDAYS_SHORT[date.getDay()];
    case "DD": return String(day).padStart(2, "0");
    case "D": return String(day);
    default: return token;
  }
}

export function dailyPathForDate(
  files: readonly FileEntry[],
  date: Date,
  settings: DailyNotesSettings,
): { path: string; exists: boolean } {
  const configured = formatDailyPath(date, settings);
  const set = new Set(files.map((file) => file.path));
  if (set.has(configured)) return { path: configured, exists: true };
  const guessed = findExistingDailyPath(files, date);
  if (guessed) return { path: guessed, exists: true };
  return { path: configured, exists: false };
}

export function findExistingDailyPath(files: readonly FileEntry[], date: Date): string | null {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const candidates = [
    `journals/${y}_${m}_${d}.md`,
    `journals/${y}-${m}-${d}.md`,
    `journals/${y}/${m}_${d}.md`,
    `journals/${y}/${m}-${d}.md`,
    `journal/${y}_${m}_${d}.md`,
    `Daily/${y}-${m}-${d}.md`,
    `daily/${y}-${m}-${d}.md`,
    `moody/${y}_${m}_${d}.md`,
    `moody/${y}-${m}-${d}.md`,
  ];
  const set = new Set(files.map((file) => file.path));
  for (const path of candidates) {
    if (set.has(path)) return path;
  }
  const dayNames = [`${y}_${m}_${d}.md`, `${y}-${m}-${d}.md`, `${m}_${d}.md`, `${m}-${d}.md`];
  for (const file of files) {
    const parent = file.parent_path.toLowerCase();
    if (
      dayNames.some((name) => name.toLowerCase() === file.name.toLowerCase()) &&
      (parent.includes("journal") || parent.includes("daily") || parent.includes("moody"))
    ) {
      return file.path;
    }
  }
  return null;
}

export function existingDailyKeysForMonth(
  files: readonly FileEntry[],
  settings: DailyNotesSettings,
  year: number,
  month: number,
): Set<string> {
  const keys = new Set<string>();
  const last = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= last; day++) {
    const date = new Date(year, month, day);
    if (dailyPathForDate(files, date, settings).exists) keys.add(localDateKey(date));
  }
  return keys;
}

export function isDailyNotePath(
  path: string,
  files: readonly FileEntry[],
  settings: DailyNotesSettings,
): boolean {
  const date = dateFromDailyPath(path, settings);
  if (!date) return false;
  return dailyPathForDate(files, date, settings).path === path;
}

export function dateFromDailyPath(path: string, settings: DailyNotesSettings): Date | null {
  const configured = settings.folder ? `${settings.folder}/` : "";
  if (configured && !path.startsWith(configured)) {
    const name = path.replace(/^.*\//, "").replace(/\.md$/i, "").replace(/_/g, "-");
    return /^\d{4}-\d{2}-\d{2}$/.test(name) ? parseLocalDateKey(name) : null;
  }
  const name = path.slice(configured.length).replace(/\.md$/i, "");
  const iso = name.replace(/_/g, "-");
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return parseLocalDateKey(iso);
  return null;
}

export type CalendarCell = {
  date: Date;
  key: string;
  inMonth: boolean;
  isToday: boolean;
  hasNote: boolean;
};

export function monthCells(year: number, month: number, existing: ReadonlySet<string>, today = new Date()): CalendarCell[] {
  const first = new Date(year, month, 1);
  const start = shiftDate(first, -first.getDay());
  const todayKey = localDateKey(today);
  const cells: CalendarCell[] = [];
  for (let index = 0; index < 42; index++) {
    const date = shiftDate(start, index);
    const key = localDateKey(date);
    cells.push({
      date,
      key,
      inMonth: date.getMonth() === month,
      isToday: key === todayKey,
      hasNote: existing.has(key),
    });
  }
  return cells;
}

export function renderDailyCalendar(
  host: HTMLElement,
  options: {
    year: number;
    month: number;
    existing: ReadonlySet<string>;
    currentKey?: string | null;
    onSelect: (date: Date) => void;
    onMonth: (year: number, month: number) => void;
  },
): void {
  host.replaceChildren();
  host.classList.add("daily-calendar");
  const heading = document.createElement("div");
  heading.className = "daily-calendar-head";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "‹";
  prev.title = "Previous month";
  const label = document.createElement("strong");
  label.textContent = `${MONTHS[options.month]} ${options.year}`;
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "›";
  next.title = "Next month";
  prev.addEventListener("click", () => {
    const date = new Date(options.year, options.month - 1, 1);
    options.onMonth(date.getFullYear(), date.getMonth());
  });
  next.addEventListener("click", () => {
    const date = new Date(options.year, options.month + 1, 1);
    options.onMonth(date.getFullYear(), date.getMonth());
  });
  heading.append(prev, label, next);
  const grid = document.createElement("div");
  grid.className = "daily-calendar-grid";
  for (const day of WEEKDAYS_SHORT) {
    const name = document.createElement("div");
    name.className = "daily-calendar-dow";
    name.textContent = day;
    grid.appendChild(name);
  }
  for (const cell of monthCells(options.year, options.month, options.existing)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "daily-calendar-day";
    if (!cell.inMonth) button.classList.add("outside");
    if (cell.isToday) button.classList.add("today");
    if (cell.hasNote) button.classList.add("has-note");
    if (options.currentKey === cell.key) button.classList.add("current");
    button.textContent = String(cell.date.getDate());
    button.title = cell.key;
    button.addEventListener("click", () => options.onSelect(cell.date));
    grid.appendChild(button);
  }
  host.append(heading, grid);
}
