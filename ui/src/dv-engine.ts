import { marked } from "marked";
import { DateTime, Duration } from "luxon";
import { bindQueryUriLinks, formatQueryUri } from "./query-uri";
import { queryDiagnostic } from "./query-diagnostics";
import { ObsidianApp, type AppFile } from "./app-api";

/**
 * Nephrite JS view engine — DataviewJS-compatible surface for fenced blocks
 * and inline backtick commands.
 *
 * Recognized fence languages (see extractScriptBlocks):
 *   dataviewjs | dataview | js | javascript | pgsql | (empty)
 *
 * `sql`, `sqlpostgresql`, `postgresql`, `postgres`, and `psql` are highlighter
 * tags. Only `pgsql` runs the vault query engine.
 *
 * Empty / bare ``` fences run only if the body references `dv` (safe default).
 */

export type DvPage = {
  path: string;
  file: {
    path: string;
    name: string;
    folder: string;
    link: string;
    mtime: Date | null;
    ctime: Date | null;
    day: Date | null;
    /** Size in bytes when known (index or filesystem). */
    bytes?: number | null;
    size?: number | null;
    user?: string | null;
    group?: string | null;
    tags?: string[];
    etags?: string[];
    aliases?: string[];
    tasks?: DvTask[];
    frontmatter?: Record<string, unknown>;
    outlinks?: string[];
    inlinks?: string[];
  };
  [key: string]: unknown;
};

export type DvApi = {
  current: () => DvPage;
  pages: (source?: string) => DvPageList;
  page: (path: string) => DvPage | null;
  pagePaths: (source?: string) => DvDataArray<string>;
  pagesFromTags: (tags: string | string[]) => DvPageList;
  pagesFromPath: (path: string | string[]) => DvPageList;
  pagesFromLinks: (link: string | string[]) => DvPageList;
  array: <T>(value: T | Iterable<T> | null | undefined) => DvDataArray<T>;
  compare: (left: unknown, right: unknown) => number;
  equal: (left: unknown, right: unknown) => boolean;
  clone: <T>(value: T) => T;
  fileLink: (path: string, embed?: boolean, display?: string) => string;
  sectionLink: (path: string, section: string, embed?: boolean, display?: string) => string;
  blockLink: (path: string, block: string, embed?: boolean, display?: string) => string;
  date: (input?: unknown) => Date | null;
  duration: (s: string) => unknown;
  paragraph: (html: unknown) => void;
  list: (items: unknown) => void;
  table: (headers: string[], rows: unknown[][]) => void;
  taskList: (tasks: Iterable<DvTask>, groupByFile?: boolean) => void;
  markdownTable: (headers: string[], rows: unknown[][]) => string;
  markdownList: (items: Iterable<unknown>) => string;
  markdownTaskList: (tasks: Iterable<DvTask>) => string;
  query: (source: string) => Promise<{ successful: boolean; value?: unknown; error?: string }>;
  tryQuery: (source: string) => Promise<unknown>;
  execute: (source: string) => Promise<void>;
  executeJs: (source: string) => Promise<void>;
  evaluate: (expression: string, context?: Record<string, unknown>) => { successful: boolean; value?: unknown; error?: string };
  tryEvaluate: (expression: string, context?: Record<string, unknown>) => unknown;
  io: {
    load: (path: string) => Promise<string>;
    csv: (path: string) => Promise<DvDataArray<Record<string, string>>>;
    normalize: (path: string, origin?: string) => string;
  };
  el: (tag: string, text?: string) => HTMLElement;
  span: (text: string) => HTMLElement;
  header: (level: number, text: string) => void;
  view: (path: string, input?: unknown) => Promise<void>;
};

export type DvTask = Record<string, unknown> & {
  path: string;
  task_id: number;
  text?: string;
  completed?: boolean;
};

export type DvDataArray<T> = Array<T> & {
  where: (predicate: (value: T, index: number) => unknown) => DvDataArray<T>;
  limit: (n: number) => DvDataArray<T>;
  distinct: (key?: (value: T) => unknown) => DvDataArray<T>;
  groupBy: (key: (value: T) => unknown) => DvDataArray<{ key: unknown; rows: DvDataArray<T> }>;
  first: () => T | undefined;
  last: () => T | undefined;
  mutate: (mapper: (value: T) => unknown) => DvDataArray<T>;
  values: T[];
  array: () => T[];
};

export type DvPageList = DvDataArray<DvPage> & { file: Record<string, DvDataArray<unknown>> };

export type EngineContext = {
  currentPath: string;
  currentSource: string;
  loadPages: (source?: string) => Promise<DvPage[]>;
  loadPage: (path: string) => Promise<DvPage | null>;
  runSql: (sql: string) => Promise<SqlQueryResult>;
  readFile?: (path: string) => Promise<string>;
  setTaskCompleted?: (path: string, taskId: number, completed: boolean) => Promise<unknown>;
  resolveLink: (target: string) => void;
};

export type SqlQueryResult = {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
};

export type ScriptBlock = {
  lang: string;
  code: string;
  start: number;
  end: number;
};

const FENCE_RE = /^[ \t]{0,3}```([^\n`]*)\n([\s\S]*?)^[ \t]{0,3}```/gm;

/** Only the `pgsql` fence runs the vault query engine. */
const SQL_LANGS = new Set(["pgsql"]);

/** Languages that always run through the Nephrite JS engine. */
const ALWAYS_ENGINE = new Set([
  "dataviewjs",
  "dataview",
  "js",
  "javascript",
  "nephrite",
  "nephritejs",
  ...SQL_LANGS,
]);

export function extractScriptBlocks(markdown: string): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(FENCE_RE.source, "gm");
  while ((m = re.exec(markdown)) != null) {
    const lang = (m[1] || "").trim().toLowerCase().split(/\s+/)[0] || "";
    const code = m[2];
    const use =
      ALWAYS_ENGINE.has(lang) ||
      (lang === "" && /\bdv\b/.test(code));
    if (use) {
      out.push({
        lang: lang || "dataviewjs",
        code,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return out;
}

/**
 * Turn executable fences into stable DOM mounts before Markdown rendering.
 * Query execution must never depend on rediscovering a rendered <pre><code>
 * element after the preview has already been committed to the screen.
 */
/** A single-backtick code span is an inline script; longer delimiters stay literal. */
function extractInlineScriptFlags(markdown: string): boolean[] {
  const flags: boolean[] = [];
  const tokens = marked.lexer(markdown);
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "codespan") return;
    const delimiter = token.raw.match(/^`+/)?.[0].length ?? 0;
    flags.push(delimiter === 1);
  });
  return flags;
}

export function wrapDataArray<T>(values: Iterable<T>): DvDataArray<T> {
  const target = Array.from(values) as DvDataArray<T>;
  const wrap = (items: Iterable<T>) => wrapDataArray(items);
  Object.defineProperties(target, {
    where: { value: (predicate: (value: T, index: number) => unknown) => wrap(target.filter(predicate)), enumerable: false },
    limit: { value: (n: number) => wrap(target.slice(0, Math.max(0, n))), enumerable: false },
    distinct: { value: (key: (value: T) => unknown = (value) => value) => {
      const seen = new Set<unknown>();
      return wrap(target.filter((value) => { const identity = key(value); if (seen.has(identity)) return false; seen.add(identity); return true; }));
    }, enumerable: false },
    groupBy: { value: (key: (value: T) => unknown) => {
      const groups = new Map<unknown, T[]>();
      for (const value of target) { const identity = key(value); groups.set(identity, [...(groups.get(identity) ?? []), value]); }
      return wrapDataArray([...groups].map(([identity, rows]) => ({ key: identity, rows: wrap(rows) })));
    }, enumerable: false },
    first: { value: () => target[0], enumerable: false },
    last: { value: () => target.at(-1), enumerable: false },
    mutate: { value: (mapper: (value: T) => unknown) => {
      for (let index = 0; index < target.length; index++) {
        const next = mapper(target[index]);
        if (next === undefined) continue;
        if (target[index] && typeof target[index] === "object" && !Array.isArray(target[index])) {
          Object.assign(target[index] as object, next as object);
        } else {
          target[index] = next as T;
        }
      }
      return target;
    }, enumerable: false },
    values: { get: () => target.slice(), enumerable: false },
    array: { value: () => target.slice(), enumerable: false },
  });
  return new Proxy(target, {
    get(array, property, receiver) {
      if (property === "then") return undefined;
      if (property === "filter") return (predicate: (value: T, index: number) => unknown) => wrap(array.filter(predicate));
      if (property === "map") return <U>(mapper: (value: T, index: number) => U) => wrapDataArray(array.map(mapper));
      if (property === "flatMap") return <U>(mapper: (value: T, index: number) => U | U[]) => wrapDataArray(array.flatMap(mapper));
      if (property === "concat") return (...items: (T | ConcatArray<T>)[]) => wrap(array.concat(...items));
      if (property === "slice") return (start?: number, end?: number) => wrap(array.slice(start, end));
      if (property === "sort") return (keyOrComparator?: ((value: T, other?: T) => unknown), direction?: string) => {
        const copy = array.slice();
        if (keyOrComparator && direction) {
          const sign = direction.toLowerCase() === "desc" ? -1 : 1;
          copy.sort((left, right) => compareValues(keyOrComparator(left), keyOrComparator(right)) * sign);
        } else if (keyOrComparator) copy.sort(keyOrComparator as (left: T, right: T) => number);
        else copy.sort();
        return wrap(copy);
      };
      if (typeof property === "string" && !(property in array)) {
        const swizzled = array.flatMap((value) => {
          const child = value == null ? null : (value as Record<string, unknown>)[property];
          return Array.isArray(child) ? child : [child];
        });
        return wrapDataArray(swizzled);
      }
      return Reflect.get(array, property, receiver);
    },
  });
}

function wrapList(pages: DvPage[]): DvPageList {
  return wrapDataArray(pages) as DvPageList;
}

export type DurationParts = {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
};

/** Obsidian Dataview `normalizeDuration`: decompose into calendar units then normalize overflow. */
function normalizeDuration(duration: Duration): Duration {
  return duration.shiftToAll().normalize();
}

class DvDate extends Date {
  get year() { return this.getFullYear(); }
  get month() { return this.getMonth() + 1; }
  get day() { return this.getDate(); }

  toString(): string {
    return `${this.year}-${String(this.month).padStart(2, "0")}-${String(this.day).padStart(2, "0")}`;
  }

  /** Luxon `DateTime.toFormat` — used by vault scripts such as Tracker - Water. */
  toFormat(fmt: string): string {
    return DateTime.fromJSDate(this).toFormat(fmt);
  }

  toISODate(): string {
    return this.toString();
  }

  /**
   * Calendar arithmetic, matching Obsidian Dataview's luxon-backed `date.plus(...)`.
   * Adding 80 years to 1968-11-14 lands on 2048-11-14 (not a millisecond offset).
   */
  plus(parts: DurationParts | DvDuration): DvDate {
    const duration = parts instanceof DvDuration ? parts.duration : Duration.fromObject(parts);
    return toDvDate(DateTime.fromJSDate(this).plus(duration).toJSDate()) ?? new DvDate(this.getTime());
  }

  minus(parts: DurationParts | DvDuration): DvDate {
    const duration = parts instanceof DvDuration ? parts.duration : Duration.fromObject(parts);
    return toDvDate(DateTime.fromJSDate(this).minus(duration).toJSDate()) ?? new DvDate(this.getTime());
  }

  /** Date minus date → decomposed calendar duration (Obsidian `date - date`). */
  diff(other: Date): DvDuration {
    const units: (keyof DurationParts)[] = ["years", "months", "days", "hours", "minutes", "seconds", "milliseconds"];
    const duration = DateTime.fromJSDate(this).diff(DateTime.fromJSDate(other), units);
    return new DvDuration(normalizeDuration(duration));
  }

  /** Luxon-compatible surface (DateTimeProxy.plus accepts a Duration or plain object). */
  toDateTime(): DateTime { return DateTime.fromJSDate(this); }
}

class DvDuration {
  constructor(readonly duration: Duration) {}

  static fromMillis(milliseconds: number): DvDuration {
    return new DvDuration(Duration.fromMillis(milliseconds));
  }

  static fromParts(parts: DurationParts): DvDuration {
    return new DvDuration(Duration.fromObject(parts));
  }

  /** Total of this duration in one unit (Obsidian `duration.day`, `.days`, ... getters). */
  private total(unit: keyof DurationParts): number {
    return this.duration.shiftTo(unit).get(unit);
  }

  get years() { return this.total("years"); }
  get months() { return this.total("months"); }
  get weeks() { return this.total("weeks"); }
  /** Matches Obsidian: `dur(...).days` is the luxon `shiftTo("days").days` total. */
  get days() { return this.total("days"); }
  get hours() { return this.total("hours"); }
  get minutes() { return this.total("minutes"); }
  get seconds() { return this.total("seconds"); }
  get milliseconds() { return this.total("milliseconds"); }

  plus(other: DvDuration): DvDuration {
    return new DvDuration(normalizeDuration(this.duration.plus(other.duration)));
  }
  minus(other: DvDuration): DvDuration {
    return new DvDuration(normalizeDuration(this.duration.minus(other.duration)));
  }
  mapUnits(mapper: (value: number) => number): DvDuration {
    return new DvDuration(normalizeDuration(this.duration.mapUnits(mapper)));
  }

  toHuman(): string { return this.duration.toHuman(); }
  toString(): string { return this.duration.toHuman(); }
  valueOf() { return this.duration.as("milliseconds"); }
}

function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function startOfLocalDay(date = new Date()): DvDate {
  return new DvDate(date.getFullYear(), date.getMonth(), date.getDate());
}

function namedDvDate(raw: string): DvDate | null {
  const key = raw.trim().toLowerCase();
  const now = new Date();
  const shiftDays = (days: number) =>
    startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
  switch (key) {
    case "today":
      return startOfLocalDay(now);
    case "yesterday":
      return shiftDays(-1);
    case "tomorrow":
      return shiftDays(1);
    case "now":
      return new DvDate();
    case "sow":
    case "start-of-week": {
      const weekday = now.getDay() || 7;
      return shiftDays(1 - weekday);
    }
    case "eow":
    case "end-of-week": {
      const weekday = now.getDay() || 7;
      return shiftDays(7 - weekday);
    }
    case "som":
    case "start-of-month":
      return new DvDate(now.getFullYear(), now.getMonth(), 1);
    case "eom":
    case "end-of-month":
      return new DvDate(now.getFullYear(), now.getMonth() + 1, 0);
    case "soy":
    case "start-of-year":
      return new DvDate(now.getFullYear(), 0, 1);
    case "eoy":
    case "end-of-year":
      return new DvDate(now.getFullYear(), 11, 31);
    default:
      return null;
  }
}

function toDvDate(input: unknown): DvDate | null {
  if (input instanceof DvDate) return input;
  if (input instanceof Date) return new DvDate(input.getTime());
  if (typeof input === "object" && input && "toJSDate" in input) {
    try {
      return toDvDate((input as { toJSDate: () => Date }).toJSDate());
    } catch {
      return null;
    }
  }
  if (typeof input === "string") {
    const named = namedDvDate(input);
    if (named) return named;
    const plain = input.match(/^(\d{4})[-_/](\d{2})[-_/](\d{2})(?:$|T)/);
    if (plain) {
      return new DvDate(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
    }
  }
  if (typeof input === "string" || typeof input === "number") {
    const d = new DvDate(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function normalizePage(page: DvPage): DvPage {
  for (const [key, value] of Object.entries(page)) {
    if (value instanceof Date) page[key] = toDvDate(value);
    const lower = key.toLowerCase();
    if (!(lower in page)) page[lower] = page[key];
  }
  for (const key of ["mtime", "ctime", "day"] as const) {
    const value = page.file[key];
    if (value instanceof Date) page.file[key] = toDvDate(value);
  }
  return page;
}

function luxonish(d: Date | null): Date | null {
  return d;
}

export type NoteFileInfo = {
  path: string;
  name: string;
  folder: string;
  link: string;
  mtime: Date | null;
  ctime: Date | null;
  mdate: Date | null;
  cdate: Date | null;
  day: Date | null;
  extension: string;
  basename: string;
  bytes: number | null;
  size: number | null;
  user: string | null;
  group: string | null;
  permissions: {
    readable: boolean;
    writable: boolean;
    mode: number | null;
  };
};

export type ThisNote = DvPage & {
  file: NoteFileInfo;
  path: string;
  mdate: Date | null;
  cdate: Date | null;
  mtime: Date | null;
  ctime: Date | null;
  bytes?: number | null;
  user?: string | null;
  group?: string | null;
};


/** Build the note-level `this` object for DataviewJS. */
export type NoteFileMeta = {
  path: string;
  bytes: number;
  user?: string | null;
  group?: string | null;
  mode?: number | null;
  mtime_ms?: number | null;
  ctime_ms?: number | null;
};

export function makeThisNote(
  page: DvPage,
  ctx: EngineContext,
  meta?: NoteFileMeta | null,
): ThisNote {
  const path = page.path || ctx.currentPath;
  const name = page.file?.name || path.replace(/^.*\//, "").replace(/\.md$/i, "");
  const folder = page.file?.folder ?? (path.includes("/") ? path.replace(/\/[^/]+$/, "") : "");
  const extension = (path.match(/\.([^.]+)$/) || [, ""])[1] || "md";
  const basename = name;
  let mtime = page.file?.mtime ?? null;
  let ctime = page.file?.ctime ?? null;
  if (meta?.mtime_ms != null) mtime = new Date(meta.mtime_ms);
  if (meta?.ctime_ms != null) ctime = new Date(meta.ctime_ms);
  const pageBytes =
    typeof page.file?.bytes === "number"
      ? page.file.bytes
      : typeof page.file?.size === "number"
        ? page.file.size
        : null;
  const bytes = meta?.bytes ?? pageBytes;
  const file: NoteFileInfo = {
    path,
    name,
    folder,
    link: page.file?.link || `[[${path.replace(/\.md$/i, "")}]]`,
    mtime,
    ctime,
    mdate: mtime,
    cdate: ctime,
    day: page.file?.day ?? mtime,
    extension,
    basename,
    bytes,
    size: bytes,
    user: meta?.user ?? null,
    group: meta?.group ?? null,
    permissions: {
      readable: true,
      writable: true,
      mode: meta?.mode ?? null,
    },
  };
  return {
    ...page,
    path,
    file,
    mdate: mtime,
    cdate: ctime,
    mtime,
    ctime,
    bytes,
    user: meta?.user ?? null,
    group: meta?.group ?? null,
  };
}


export async function runScriptBlock(
  code: string,
  container: HTMLElement,
  ctx: EngineContext,
  inline = false,
  scriptInput?: unknown,
): Promise<void> {
  queryDiagnostic("dataviewjs.invoke", { path: ctx.currentPath, inline });
  const outputs: HTMLElement[] = [];

  const pushHtml = (html: string) => {
    const output = document.createElement(inline ? "span" : "div");
    output.className = inline ? "dv-inline-out" : "dv-out";
    output.innerHTML = html;
    outputs.push(output);
    container.appendChild(output);
  };

  const current = normalizePage(
    (await ctx.loadPage(ctx.currentPath)) ?? stubPage(ctx.currentPath),
  );

  // Note-level `this` (Obsidian Dataview-style). Bound as AsyncFunction `this`
  // and also available as the explicit `note` argument.
  let fileMeta: NoteFileMeta | null = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    fileMeta = await invoke<NoteFileMeta>("note_file_meta", { path: ctx.currentPath });
  } catch {
    fileMeta = null;
  }
  const thisNote = makeThisNote(current, ctx, fileMeta);

  if (inline && /^\s*=/.test(code)) {
    try {
      pushHtml(stringifyInline(evaluateDql(code.replace(/^\s*=\s*/, ""), thisNote, thisNote)));
    } catch (error) {
      const failure = document.createElement("span");
      failure.className = "dv-error";
      failure.textContent = `Inline query error: ${error instanceof Error ? error.message : String(error)}`;
      container.appendChild(failure);
    }
    bindPreviewLinks(container, ctx);
    return;
  }

  const dv: DvApi = {
    current: () => thisNote,
    pages: (source?: string) => {
      const pages = (dv as unknown as { _pages: DvPage[] })._pages || [];
      return wrapList(filterPagesBySource(pages, source, ctx.currentPath));
    },
    page: (path: string) => {
      const pages = (dv as unknown as { _pages: DvPage[] })._pages || [];
      return pages.find((p) => p.path === path || p.path === path + ".md") ?? null;
    },
    pagePaths: (source?: string) => wrapDataArray(dv.pages(source).map((page) => page.path)),
    pagesFromTags: (tags) => {
      const wanted = (Array.isArray(tags) ? tags : String(tags).split(",")).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean);
      const pages = (dv as unknown as { _pages: DvPage[] })._pages || [];
      return wrapList(pages.filter((page) =>
        wanted.some((tag) => (page.file.tags ?? []).some((candidate) =>
          candidate.toLocaleLowerCase() === tag || candidate.toLocaleLowerCase().startsWith(`${tag}/`)))));
    },
    pagesFromPath: (path) => {
      const folders = (Array.isArray(path) ? path : [path]).map((folder) =>
        String(folder).trim().replace(/^\/+|\/+$/g, "").toLocaleLowerCase()).filter(Boolean);
      const pages = (dv as unknown as { _pages: DvPage[] })._pages || [];
      return wrapList(pages.filter((page) =>
        folders.some((folder) =>
          page.file.folder.toLocaleLowerCase() === folder ||
          page.path.toLocaleLowerCase().startsWith(`${folder}/`))));
    },
    pagesFromLinks: (link) => {
      const wanted = (Array.isArray(link) ? link : [link]).map((value) => String(value).trim());
      const pages = (dv as unknown as { _pages: DvPage[] })._pages || [];
      return wrapList(pages.filter((page) =>
        (page.file.outlinks ?? []).some((outlink) => wanted.some((target) => linksEqual(outlink, target)))));
    },
    array: <T>(value: T | Iterable<T> | null | undefined) => {
      if (value == null) return wrapDataArray<T>([]);
      if (typeof value !== "string" && Symbol.iterator in Object(value)) return wrapDataArray(value as Iterable<T>);
      return wrapDataArray([value as T]);
    },
    compare: compareValues,
    equal: (left, right) => compareValues(left, right) === 0,
    clone: <T>(value: T): T => typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value)) as T,
    fileLink: (path, embed = false, display) => makeWikilink(path, embed, display),
    sectionLink: (path, section, embed = false, display) => makeWikilink(`${path}#${section}`, embed, display),
    blockLink: (path, block, embed = false, display) => makeWikilink(`${path}^${block}`, embed, display),
    date: (input?: unknown) => {
      if (input == null || input === "") return startOfLocalDay();
      return toDvDate(input);
    },
    duration: (s: string) => parseDuration(s),
    paragraph: (html: unknown) => {
      if (typeof html === "string") {
        const withLinks = stringifyInline(html);
        pushHtml(marked.parse(withLinks, { async: false }) as string);
      } else {
        pushHtml(`<p>${stringify(html)}</p>`);
      }
    },
    list: (items: unknown) => {
      const arr = normalizeItems(items);
      const lis = arr
        .map((it) => {
          if (typeof it === "string" && it.startsWith("[[")) {
            const inner = it.slice(2, -2);
            const [t, a] = inner.split("|");
            return `<li><a href="#" class="preview-wikilink" data-wikilink="${esc(t)}">${esc(a || t)}</a></li>`;
          }
          return `<li>${stringify(it)}</li>`;
        })
        .join("");
      pushHtml(`<ul class="dv-list">${lis}</ul>`);
    },
    table: (headers: string[], rows: unknown[][]) => {
      const th = headers.map((h) => `<th>${esc(String(h))}</th>`).join("");
      const tr = rows
        .map(
          (r) =>
            `<tr>${r.map((c, index) => `<td>${stringify(c, headers[index])}</td>`).join("")}</tr>`,
        )
        .join("");
      pushHtml(`<table class="dv-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`);
    },
    taskList: (tasks, _groupByFile = false) => {
      const mount = document.createElement("div");
      outputs.push(mount);
      container.appendChild(mount);
      renderTaskQuery(mount, [...tasks].map((task) => ({ ...task, task })), ctx);
    },
    markdownTable: (headers, rows) => markdownTable(headers, rows),
    markdownList: (items) => [...items].map((item) => `- ${plainString(item)}`).join("\n"),
    markdownTaskList: (tasks) => [...tasks].map((task) => `- [${task.completed ? "x" : " "}] ${task.text ?? ""}`).join("\n"),
    query: async (source) => queryDqlForApi(source, ctx),
    tryQuery: async (source) => {
      const result = await queryDqlForApi(source, ctx);
      if (!result.successful) throw new Error(result.error);
      return result.value;
    },
    execute: async (source) => {
      const mount = document.createElement("div");
      outputs.push(mount);
      container.appendChild(mount);
      await runDqlBlock(source, mount, ctx);
    },
    executeJs: async (source) => {
      const mount = document.createElement("div");
      outputs.push(mount);
      container.appendChild(mount);
      await runScriptBlock(source, mount, ctx);
    },
    evaluate: (expression, context = {}) => {
      try { return { successful: true, value: evaluateDql(expression, { ...thisNote, ...context }, thisNote) }; }
      catch (error) { return { successful: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    tryEvaluate: (expression, context = {}) => evaluateDql(expression, { ...thisNote, ...context }, thisNote),
    io: {
      load: async (path) => {
        if (!ctx.readFile) throw new Error("Vault file access is unavailable in this view");
        return ctx.readFile(normalizeIoPath(path, ctx.currentPath));
      },
      csv: async (path) => {
        if (!ctx.readFile) throw new Error("Vault file access is unavailable in this view");
        return wrapDataArray(parseCsv(await ctx.readFile(normalizeIoPath(path, ctx.currentPath))));
      },
      normalize: (path, origin = ctx.currentPath) => normalizeIoPath(path, origin),
    },
    view: async (path, input) => {
      if (!ctx.readFile) throw new Error("Vault file access is unavailable in this view");
      const normalized = normalizeIoPath(path.endsWith(".js") ? path : `${path}.js`, ctx.currentPath);
      const source = await ctx.readFile(normalized);
      const mount = document.createElement("div");
      mount.className = "dv-custom-view";
      outputs.push(mount);
      container.appendChild(mount);
      await runScriptBlock(source, mount, ctx, false, input);
    },
    el: (tag: string, text?: string) => {
      const el = document.createElement(tag);
      if (text) el.textContent = text;
      outputs.push(el);
      container.appendChild(el);
      return el;
    },
    span: (text: string) => {
      const el = document.createElement("span");
      el.textContent = text;
      outputs.push(el);
      container.appendChild(el);
      return el;
    },
    header: (level: number, text: string) => {
      const l = Math.min(6, Math.max(1, level));
      pushHtml(`<h${l}>${esc(text)}</h${l}>`);
    },
  };

  // Dataview's JavaScript API is synchronous. Preload the disposable page index
  // once, then evaluate every source expression against that immutable snapshot.
  const all = (await ctx.loadPages()).map(normalizePage);
  (dv as unknown as { _pages: DvPage[] })._pages = all;
  const app = new ObsidianApp({
    listFiles: () => all.map((page): AppFile => ({
      path: page.path,
      name: page.file.name,
      parent_path: page.file.folder,
      file_kind: "markdown",
      extension: "md",
      basename: page.file.name,
    })),
    readFile: (path) => {
      if (!ctx.readFile) throw new Error("Vault file access is unavailable in this view");
      return ctx.readFile(path);
    },
    queryIndex: (sql) => ctx.runSql(sql),
    pageMetadata: (path) => all.find((page) => linksEqual(page.path, path)) ?? null,
    resolveLink: (link, sourcePath) => {
      const page = findPage(all, link || sourcePath);
      return page ? {
        path: page.path,
        name: page.file.name,
        parent_path: page.file.folder,
        file_kind: "markdown",
        extension: "md",
        basename: page.file.name,
      } : null;
    },
    editorState: () => ({ path: ctx.currentPath, content: ctx.currentSource, selection: "" }),
    openPath: (path) => ctx.resolveLink(path),
    pluginInfo: (id) => id == null || id === "dataview" || id === "obsidian-dataview"
      ? { id: "dataview", api: dv }
      : null,
  }, ["vault.read", "index.query", "editor.read"]);

  // Global helpers seen in vaults
  const dateformat = (d: unknown, fmt?: string) => {
    const dt = d instanceof Date ? d : dv.date(d);
    if (!dt) return "";
    if (fmt && fmt !== "DDDD") {
      const year = String(dt.getFullYear());
      const month = String(dt.getMonth() + 1).padStart(2, "0");
      const day = String(dt.getDate()).padStart(2, "0");
      return fmt
        .replace(/yyyy|y/g, year)
        .replace(/MM/g, month)
        .replace(/dd/g, day);
    }
    try {
      return dt.toLocaleDateString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return dt.toISOString().slice(0, 10);
    }
  };

  const dur = (s: unknown) => parseDuration(s);

  const choice = (condition: unknown, whenTrue: unknown, whenFalse: unknown) =>
    condition ? whenTrue : whenFalse;

  try {
    const result = await runDataviewJs(
      inline ? wrapInlineExpression(code) : code,
      thisNote,
      dv,
      dateformat,
      dur,
      choice,
      scriptInput,
      app,
    );
    if (inline && outputs.length === 0 && result !== undefined) {
      pushHtml(stringifyInline(result));
    }
    queryDiagnostic("dataviewjs.result", { path: ctx.currentPath, outputs: outputs.length, inline });
  } catch (e) {
    queryDiagnostic("dataviewjs.error", {
      path: ctx.currentPath,
      error: e instanceof Error ? e.message : String(e),
      inline,
    });
    const err = document.createElement(inline ? "span" : "pre");
    err.className = "dv-error";
    err.textContent = `${inline ? "Inline script" : "DataviewJS"} error: ${e instanceof Error ? e.message : String(e)}`;
    container.appendChild(err);
  }

  container.querySelectorAll<HTMLAnchorElement>("a[data-wikilink]").forEach((a) => {
    a.dataset.openLinkBound = "1";
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const t = a.dataset.wikilink;
      if (t) ctx.resolveLink(t);
    });
  });
  bindQueryUriLinks(container);
}

type DqlColumn = { expression: string; label: string };
export type DqlQuery = {
  kind: "TABLE" | "LIST" | "TASK" | "CALENDAR";
  withoutId: boolean;
  columns: DqlColumn[];
  expression: string | null;
  source: string | null;
  where: string[];
  flatten: { expression: string; alias: string }[];
  group: { expression: string; alias: string } | null;
  operations: (
    | { kind: "where"; expression: string }
    | { kind: "flatten"; expression: string; alias: string }
    | { kind: "group"; expression: string; alias: string }
  )[];
  sort: { expression: string; descending: boolean }[];
  limit: number | null;
};

type DqlRow = Record<string, unknown> & { file?: DvPage["file"]; path?: string };

/** Execute the common Dataview DQL surface without treating DQL as JavaScript. */
export async function runDqlBlock(
  code: string,
  container: HTMLElement,
  ctx: EngineContext,
): Promise<void> {
  queryDiagnostic("dataview.invoke", { path: ctx.currentPath });
  try {
    const current = normalizePage(
      (await ctx.loadPage(ctx.currentPath)) ?? stubPage(ctx.currentPath),
    );
    const query = parseDql(code);
    const loaded = (await ctx.loadPages()).map(normalizePage);
    let rows: DqlRow[] = filterPagesBySource(loaded, query.source, ctx.currentPath);
    if (query.kind === "TASK") {
      rows = rows.flatMap((page) => (page.file?.tasks ?? []).map((task) => ({
        ...page,
        ...task,
        task,
        file: page.file,
        path: page.path,
      })));
    }
    for (const operation of query.operations) {
      if (operation.kind === "where") {
        rows = rows.filter((row) => Boolean(evaluateDql(operation.expression, row, current)));
      } else if (operation.kind === "flatten") {
        rows = rows.flatMap((row) => {
          const value = evaluateDql(operation.expression, row, current);
          const values = Array.isArray(value) ? value : [value];
          return values.map((item) => ({ ...row, [operation.alias]: item }));
        });
      } else {
        const groups = new Map<unknown, DqlRow[]>();
        for (const row of rows) {
          const key = evaluateDql(operation.expression, row, current);
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        rows = [...groups].map(([key, members]) => ({
          key,
          [operation.alias]: key,
          rows: wrapDataArray(members),
        }));
      }
    }
    if (query.sort.length > 0) rows.sort((left, right) => {
      for (const sort of query.sort) {
        const comparison = compareValues(
          evaluateDql(sort.expression, left, current),
          evaluateDql(sort.expression, right, current),
        );
        if (comparison !== 0) return sort.descending ? -comparison : comparison;
      }
      return 0;
    });
    if (query.limit != null) rows = rows.slice(0, query.limit);

    if (query.kind === "LIST") {
      const items = rows.map((row) => query.expression
        ? evaluateDql(query.expression, row, current)
        : row);
      container.innerHTML = `<ul class="dv-list">${items.map((item) =>
        `<li>${stringify(item)}</li>`).join("")}</ul>`;
    } else if (query.kind === "TASK") {
      renderTaskQuery(container, rows, ctx);
    } else if (query.kind === "CALENDAR") {
      renderCalendarQuery(container, rows, query.expression, current);
    } else {
      const columns = query.columns;
      const includeId = !query.withoutId;
      const headers = [
        ...(includeId ? ["File"] : []),
        ...columns.map((column) => column.label),
      ];
      const cells = rows.map((row) => [
        ...(includeId ? [row] : []),
        ...columns.map((column) => evaluateDql(column.expression, row, current)),
      ]);
      const hints = [
        ...(includeId ? ["file"] : []),
        ...columns.map((column) => `${column.expression} ${column.label}`),
      ];
      container.innerHTML = `<table class="dv-table"><thead><tr>${headers.map((header) =>
        `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${cells.map((row) =>
        `<tr>${row.map((value, index) => `<td>${stringify(value, hints[index])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
    queryDiagnostic("dataview.result", {
      path: ctx.currentPath,
      rows: container.querySelectorAll("tbody tr, .dv-list li").length,
    });
  } catch (error) {
    queryDiagnostic("dataview.error", {
      path: ctx.currentPath,
      error: error instanceof Error ? error.message : String(error),
    });
    const failure = document.createElement("pre");
    failure.className = "dv-error";
    failure.textContent = `Dataview error: ${error instanceof Error ? error.message : String(error)}`;
    container.replaceChildren(failure);
  }

  container.querySelectorAll<HTMLAnchorElement>("a[data-wikilink]").forEach((link) => {
    link.dataset.openLinkBound = "1";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = link.dataset.wikilink;
      if (target) ctx.resolveLink(target);
    });
  });
  bindQueryUriLinks(container);
}

function renderTaskQuery(container: HTMLElement, rows: DqlRow[], ctx: EngineContext): void {
  container.innerHTML = `<ul class="dv-task-list">${rows.map((row) => {
    const task = (row.task ?? row) as DvTask;
    return `<li><label><input type="checkbox" data-task-path="${esc(String(task.path ?? row.path ?? ""))}" data-task-id="${Number(task.task_id ?? task.id ?? 0)}" ${task.completed ? "checked" : ""}><span>${stringify(task.text ?? "")}</span></label> <span class="dv-task-source">${stringify(row as unknown)}</span></li>`;
  }).join("")}</ul>`;
  container.querySelectorAll<HTMLInputElement>("input[data-task-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const path = checkbox.dataset.taskPath ?? "";
      const taskId = Number(checkbox.dataset.taskId);
      if (!ctx.setTaskCompleted || !path || !Number.isFinite(taskId)) return;
      checkbox.disabled = true;
      try { await ctx.setTaskCompleted(path, taskId, checkbox.checked); }
      catch { checkbox.checked = !checkbox.checked; }
      finally { checkbox.disabled = false; }
    });
  });
}

function renderCalendarQuery(
  container: HTMLElement,
  rows: DqlRow[],
  expression: string | null,
  current: DvPage,
): void {
  const dated = rows.map((row) => ({ row, date: toDvDate(evaluateDql(expression || "file.day", row, current)) }))
    .filter((entry): entry is { row: DqlRow; date: DvDate } => entry.date != null);
  const months = new Map<string, typeof dated>();
  for (const entry of dated) {
    const key = `${entry.date.year}-${String(entry.date.month).padStart(2, "0")}`;
    months.set(key, [...(months.get(key) ?? []), entry]);
  }
  container.innerHTML = [...months].sort(([left], [right]) => left.localeCompare(right)).map(([key, entries]) => {
    const [year, month] = key.split("-").map(Number);
    const first = new Date(year, month - 1, 1).getDay();
    const days = new Date(year, month, 0).getDate();
    const cells = Array.from({ length: first }, () => "<div class=\"dv-calendar-empty\"></div>");
    for (let day = 1; day <= days; day++) {
      const matches = entries.filter((entry) => entry.date.day === day);
      cells.push(`<div class="dv-calendar-day"><strong>${day}</strong>${matches.map((entry) => `<div>${stringify(entry.row)}</div>`).join("")}</div>`);
    }
    return `<section class="dv-calendar"><h3>${new Date(year, month - 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3><div class="dv-calendar-grid">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => `<b>${day}</b>`).join("")}${cells.join("")}</div></section>`;
  }).join("") || "<div class=\"dv-empty\">No dated pages.</div>";
}

/** Execute native read-only vault SQL and render it like every other query table. */

/**
 * Expand note-level references in page SQL before execution.
 * Supports Dataview-style `this.file.path` / `this.path` and automation-style
 * `{{active.path}}` placeholders. Values are single-quoted SQL string literals.
 */
export function expandSqlNoteRefs(sql: string, currentPath: string): string {
  const lit = sqlStringLiteral(currentPath);
  const folder = currentPath.includes("/")
    ? currentPath.replace(/\/[^/]+$/, "")
    : "";
  const title = currentPath
    .replace(/^.*\//, "")
    .replace(/\.md$/i, "");
  const folderLit = sqlStringLiteral(folder);
  const titleLit = sqlStringLiteral(title);

  return sql
    .replace(/\bthis\.file\.path\b/gi, lit)
    .replace(/\bthis\.path\b/gi, lit)
    .replace(/\bthis\.file\.folder\b/gi, folderLit)
    .replace(/\bthis\.file\.name\b/gi, titleLit)
    .replace(/\{\{\s*active\.path\s*\}\}/gi, lit)
    .replace(/\{\{\s*active\.folder\s*\}\}/gi, folderLit)
    .replace(/\{\{\s*active\.title\s*\}\}/gi, titleLit);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function runSqlBlock(
  code: string,
  container: HTMLElement,
  ctx: EngineContext,
): Promise<void> {
  queryDiagnostic("sql.invoke", { path: ctx.currentPath });
  try {
    const expanded = expandSqlNoteRefs(code, ctx.currentPath);
    const result = await ctx.runSql(expanded);
    container.innerHTML = `<table class="dv-table sql-table"><thead><tr>${result.columns.map(
      (column) => `<th>${esc(column)}</th>`,
    ).join("")}</tr></thead><tbody>${result.rows.map((row) =>
      `<tr>${row.map((value, index) =>
        `<td>${stringify(value, result.columns[index] || "")}</td>`).join("")}</tr>`,
    ).join("")}</tbody></table>${result.truncated
      ? `<div class="query-truncated">Showing the first 1,000 rows.</div>`
      : ""}`;
    bindQueryUriLinks(container);
    queryDiagnostic("sql.result", {
      path: ctx.currentPath,
      columns: result.columns.length,
      rows: result.rows.length,
      truncated: result.truncated,
    });
  } catch (error) {
    queryDiagnostic("sql.error", {
      path: ctx.currentPath,
      error: error instanceof Error ? error.message : String(error),
    });
    const failure = document.createElement("pre");
    failure.className = "dv-error sql-error";
    failure.textContent = `SQL error: ${error instanceof Error ? error.message : String(error)}`;
    container.replaceChildren(failure);
  }
}

export function parseDql(code: string): DqlQuery {
  const lines = code.replace(/\r/g, "").split("\n");
  const clauses: { marker: string; value: string }[] = [];
  let active = "";
  for (const original of lines) {
    const line = original.trim();
    if (!line || line.startsWith("//")) continue;
    const marker = line.match(/^(TABLE|LIST|TASK|CALENDAR|FROM|WHERE|FLATTEN|GROUP\s+BY|SORT|LIMIT)\b(.*)$/i);
    if (marker) {
      active = marker[1].toUpperCase().replace(/\s+/g, " ");
      clauses.push({ marker: active, value: marker[2].trim() });
    } else if (active) {
      clauses[clauses.length - 1].value = `${clauses.at(-1)?.value ?? ""} ${line}`.trim();
    }
  }
  const header = clauses.find((clause) => ["TABLE", "LIST", "TASK", "CALENDAR"].includes(clause.marker));
  if (!header) throw new Error("Expected TABLE, LIST, TASK, or CALENDAR");
  let headerText = header.value;
  const withoutId = /^WITHOUT\s+ID\b/i.test(headerText);
  headerText = headerText.replace(/^WITHOUT\s+ID\b/i, "").trim();
  const columns = header.marker === "TABLE" && headerText
    ? splitDqlList(headerText).map(parseDqlColumn)
    : [];
  const sorts = clauses.filter((clause) => clause.marker === "SORT");
  const sort = sorts.flatMap((clause) =>
    splitDqlList(clause.value).map((part) => {
        const match = part.trim().match(/^(.*?)(?:\s+(ASC|DESC))?$/i)!;
        return { expression: match[1].trim(), descending: match[2]?.toUpperCase() === "DESC" };
      }),
  );
  const limitText = clauses.find((clause) => clause.marker === "LIMIT")?.value ?? "";
  const parsedLimit = Number.parseInt(limitText, 10);
  const expression = header.marker === "LIST" || header.marker === "CALENDAR"
    ? headerText || null
    : null;
  const operationClauses = clauses.filter((clause) => ["WHERE", "FLATTEN", "GROUP BY"].includes(clause.marker));
  return {
    kind: header.marker as DqlQuery["kind"],
    withoutId,
    columns,
    expression,
    source: clauses.find((clause) => clause.marker === "FROM")?.value || null,
    where: clauses.filter((clause) => clause.marker === "WHERE").map((clause) => clause.value),
    flatten: clauses.filter((clause) => clause.marker === "FLATTEN").map((clause) => parseDqlBinding(clause.value)),
    group: clauses.find((clause) => clause.marker === "GROUP BY")
      ? parseDqlBinding(clauses.find((clause) => clause.marker === "GROUP BY")!.value)
      : null,
    operations: operationClauses.map((clause) => {
      if (clause.marker === "WHERE") return { kind: "where" as const, expression: clause.value };
      const binding = parseDqlBinding(clause.value);
      return { kind: clause.marker === "FLATTEN" ? "flatten" as const : "group" as const, ...binding };
    }),
    sort,
    limit: Number.isFinite(parsedLimit) ? Math.max(0, parsedLimit) : null,
  };
}

function parseDqlBinding(value: string): { expression: string; alias: string } {
  const match = value.match(/^(.*?)\s+AS\s+(?:"([^"]+)"|'([^']+)'|([\w-]+))$/i);
  const expression = (match?.[1] ?? value).trim();
  const alias = (match?.[2] ?? match?.[3] ?? match?.[4] ?? expression.split(".").at(-1) ?? "value").trim();
  return { expression, alias };
}

function parseDqlColumn(part: string): DqlColumn {
  const match = part.trim().match(/^(.*)\s+AS\s+(?:"([^"]*)"|'([^']*)'|(.+))$/i);
  const expression = (match?.[1] ?? part).trim();
  const label = (match?.[2] ?? match?.[3] ?? match?.[4] ?? expression).trim();
  return { expression, label };
}

function splitDqlList(value: string): string[] {
  const output: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      output.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  output.push(value.slice(start).trim());
  return output.filter(Boolean);
}

/** Normalize Dataview function names to Nephrite's canonical query functions. */
export function lowerDqlFunctionAliases(expression: string): string {
  let output = "";
  let quote = "";
  for (let index = 0; index < expression.length;) {
    const char = expression[index];
    if (quote) {
      output += char;
      if (char === quote && expression[index - 1] !== "\\") quote = "";
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      index++;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < expression.length && /[A-Za-z0-9_]/.test(expression[end])) end++;
      const identifier = expression.slice(index, end);
      let next = end;
      while (next < expression.length && /\s/.test(expression[next])) next++;
      const isCall = expression[next] === "(";
      const prev = expression.slice(0, index).replace(/\s+$/, "").at(-1);
      const propertyAccess = prev === "." || prev === "?";
      const mapped = identifier.toLowerCase() === "default" && isCall ? "coalesce" : identifier;
      if (isCall && !propertyAccess && DQL_HELPER_NAMES.has(mapped.toLowerCase())) {
        output += `helpers.${mapped}`;
      } else {
        output += mapped;
      }
      index = end;
      continue;
    }
    output += char;
    index++;
  }
  return output;
}

const DQL_HELPER_NAMES: ReadonlySet<string> = new Set([
  "contains", "icontains", "econtains", "containsword", "startswith", "endswith",
  "string", "number", "length", "choice", "coalesce", "regexmatch", "regextest",
  "regexreplace", "replace", "lower", "upper", "split", "substring", "truncate",
  "padleft", "padright", "typeof", "list", "join", "sum", "min", "max", "average",
  "product", "round", "floor", "ceil", "trunc", "any", "all", "none", "filter",
  "map", "reduce", "flat", "slice", "nonnull", "firstvalue", "unique", "distinct",
  "reverse", "sort", "date", "dur", "dateformat", "object", "extract", "meta",
  "link", "default",
]);

/** Apply Dataview's page-source selectors to an already-loaded page collection. */
export function filterPagesBySource(
  pages: DvPage[],
  source?: string | null,
  currentPath = "",
): DvPage[] {
  const text = source?.trim();
  if (!text) return pages.slice();
  return pages.filter((page) => matchesSource(page, text, pages, currentPath));
}

function matchesSource(page: DvPage, raw: string, pages: DvPage[], currentPath: string): boolean {
  let source = stripOuterParens(raw.trim());
  const or = splitSourceOperator(source, "OR");
  if (or.length > 1) return or.some((part) => matchesSource(page, part, pages, currentPath));
  const and = splitSourceOperator(source, "AND");
  if (and.length > 1) return and.every((part) => matchesSource(page, part, pages, currentPath));
  if (/^(?:NOT\s+|-)/i.test(source)) {
    source = source.replace(/^(?:NOT\s+|-)/i, "");
    return !matchesSource(page, source, pages, currentPath);
  }
  const quoted = source.match(/^["'](.*)["']$/);
  if (quoted) {
    const folder = quoted[1].replace(/^\/+|\/+$/g, "").toLocaleLowerCase();
    return page.file.folder.toLocaleLowerCase() === folder || page.path.toLocaleLowerCase().startsWith(`${folder}/`);
  }
  if (source.startsWith("#")) {
    const tag = source.toLocaleLowerCase();
    return (page.file.tags ?? []).some((candidate) => candidate.toLocaleLowerCase() === tag || candidate.toLocaleLowerCase().startsWith(`${tag}/`));
  }
  const outgoing = source.match(/^outgoing\s*\(\s*\[\[([^\]]+)\]\]\s*\)$/i);
  if (outgoing) {
    const owner = findPage(pages, outgoing[1] === "this.file" ? currentPath : outgoing[1]);
    return Boolean(owner?.file.outlinks?.some((target) => linksEqual(target, page.path)));
  }
  const link = source.match(/^\[\[([^\]]+)\]\]$/);
  if (link) return (page.file.outlinks ?? []).some((target) => linksEqual(target, link[1]));
  return true;
}

function stripOuterParens(value: string): string {
  if (!value.startsWith("(") || !value.endsWith(")")) return value;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    if (value[index] === ")") depth--;
    if (depth === 0 && index < value.length - 1) return value;
  }
  return stripOuterParens(value.slice(1, -1).trim());
}

function splitSourceOperator(value: string, operator: "AND" | "OR"): string[] {
  const output: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  const pattern = new RegExp(`\\s+${operator}\\s+`, "iy");
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) { if (char === quote && value[index - 1] !== "\\") quote = ""; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0) {
      pattern.lastIndex = index;
      const match = pattern.exec(value);
      if (match) { output.push(value.slice(start, index).trim()); start = pattern.lastIndex; index = pattern.lastIndex - 1; }
    }
  }
  output.push(value.slice(start).trim());
  return output;
}

function linksEqual(left: string, right: string): boolean {
  const clean = (value: string) => value.split(/[|#^]/)[0].replace(/\.md$/i, "").replace(/\\/g, "/").toLocaleLowerCase();
  const a = clean(left); const b = clean(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function findPage(pages: DvPage[], path: string): DvPage | undefined {
  return pages.find((page) => linksEqual(page.path, path));
}

/* ------------------------------------------------------------------ */
/* DQL date/duration arithmetic rewriting                             */
/*                                                                     */
/* Obsidian evaluates `date - date`, `date + dur`, `dur - dur`,        */
/* `dur * n`, … through luxon calendar arithmetic. Plain JavaScript     */
/* would coerce dates to milliseconds, so rewrite binary `+ - * /`     */
/* between non-literal operands into a runtime dispatch helper that    */
/* reproduces Obsidian's semantics.                                    */
/* ------------------------------------------------------------------ */

type JToken =
  | { type: "num"; value: string }
  | { type: "str"; value: string }
  | { type: "id"; value: string }
  | { type: "op"; value: string }
  | { type: "eof"; value: string };

type JNode =
  | { kind: "lit"; value: string }
  | { kind: "id"; value: string }
  | { kind: "group"; expr: JNode }
  | { kind: "unary"; op: string; operand: JNode }
  | { kind: "member"; object: JNode; prop: string; computed: JNode | null }
  | { kind: "call"; callee: JNode; args: JNode[] }
  | { kind: "binary"; op: string; left: JNode; right: JNode };

const JS_BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
  "+": 4, "-": 4,
  "*": 5, "/": 5, "%": 5,
};

const DATE_ARITHMETIC_OPS = new Set(["+", "-", "*", "/"]);

function jsTokens(source: string): JToken[] {
  const tokens: JToken[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === '"' || char === "'") {
      const quote = char; let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") j += 2;
        else if (source[j] === quote) { j++; break; }
        else j++;
      }
      tokens.push({ type: "str", value: source.slice(i, j) });
      i = j; continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      let j = i;
      while (j < source.length && /[0-9._]/.test(source[j])) j++;
      tokens.push({ type: "num", value: source.slice(i, j) });
      i = j; continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j++;
      tokens.push({ type: "id", value: source.slice(i, j) });
      i = j; continue;
    }
    const two = source.slice(i, i + 2);
    if (["&&", "||", "==", "!=", "<=", ">=", "**", "??"].includes(two)) {
      tokens.push({ type: "op", value: two }); i += 2; continue;
    }
    tokens.push({ type: "op", value: char });
    i++;
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class JsParser {
  private pos = 0;
  constructor(private readonly tokens: JToken[]) {}

  peek(): JToken { return this.tokens[this.pos]; }
  private advance(): JToken { const token = this.tokens[this.pos]; if (token.type !== "eof") this.pos++; return token; }

  parseExpression(minPrec: number): JNode {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      const precedence = token.type === "op" ? JS_BINARY_PRECEDENCE[token.value] : undefined;
      if (precedence === undefined || precedence < minPrec) break;
      this.advance();
      const right = this.parseExpression(precedence + 1);
      left = { kind: "binary", op: token.value, left, right };
    }
    return left;
  }

  private parseUnary(): JNode {
    const token = this.peek();
    if (token.type === "op" && (token.value === "-" || token.value === "!")) {
      this.advance();
      return { kind: "unary", op: token.value, operand: this.parseUnary() };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePrimary(): JNode {
    const token = this.advance();
    if (token.type === "num" || token.type === "str") return { kind: "lit", value: token.value };
    if (token.type === "id") return { kind: "id", value: token.value };
    if (token.type === "op" && token.value === "(") {
      const expr = this.parseExpression(0);
      const close = this.advance();
      if (close.type !== "op" || close.value !== ")") throw new Error("unbalanced paren");
      return { kind: "group", expr };
    }
    throw new Error("unexpected token");
  }

  private parsePostfix(base: JNode): JNode {
    let node = base;
    for (;;) {
      const token = this.peek();
      if (token.type === "op" && token.value === ".") {
        this.advance();
        const prop = this.advance();
        if (prop.type !== "id") throw new Error("bad member");
        node = { kind: "member", object: node, prop: prop.value, computed: null };
      } else if (token.type === "op" && token.value === "[") {
        this.advance();
        const index = this.parseExpression(0);
        const close = this.advance();
        if (close.type !== "op" || close.value !== "]") throw new Error("unbalanced bracket");
        node = { kind: "member", object: node, prop: "", computed: index };
      } else if (token.type === "op" && token.value === "(") {
        this.advance();
        const args: JNode[] = [];
        if (this.peek().type !== "op" || this.peek().value !== ")") {
          do { args.push(this.parseExpression(0)); } while (this.peek().type === "op" && this.peek().value === "," && this.advance());
        }
        const close = this.advance();
        if (close.type !== "op" || close.value !== ")") throw new Error("unbalanced call");
        node = { kind: "call", callee: node, args };
      } else break;
    }
    return node;
  }
}

function isLiteralJsNode(node: JNode): boolean {
  return node.kind === "lit";
}

function serializeJsNode(node: JNode): string {
  switch (node.kind) {
    case "lit": return node.value;
    case "id": return node.value;
    case "group": return `(${serializeJsNode(node.expr)})`;
    case "unary": return `(${node.op}${serializeJsNode(node.operand)})`;
    case "member":
      return node.computed
        ? `${serializeJsNode(node.object)}[${serializeJsNode(node.computed)}]`
        : `${serializeJsNode(node.object)}.${node.prop}`;
    case "call":
      return `${serializeJsNode(node.callee)}(${node.args.map(serializeJsNode).join(", ")})`;
    case "binary": {
      if (DATE_ARITHMETIC_OPS.has(node.op) && !(isLiteralJsNode(node.left) && isLiteralJsNode(node.right))) {
        return `(helpers.dateop("${node.op}", ${serializeJsNode(node.left)}, ${serializeJsNode(node.right)}))`;
      }
      return `(${serializeJsNode(node.left)} ${node.op} ${serializeJsNode(node.right)})`;
    }
  }
}

/** Rewrite `+ - * /` between date/duration-capable operands into `helpers.dateop` dispatch. */
function rewriteDateArithmetic(source: string): string {
  try {
    const parser = new JsParser(jsTokens(source));
    const node = parser.parseExpression(0);
    if (parser.peek().type !== "eof") return source;
    return serializeJsNode(node);
  } catch {
    return source;
  }
}

/** Runtime `+ - * /` dispatcher mirroring Obsidian Dataview's date/duration binary ops. */
function dateArithmetic(op: string, a: unknown, b: unknown): unknown {
  switch (op) {
    case "+":
      if (a instanceof Date && b instanceof DvDuration) return toDvDate(a)?.plus(b) ?? a;
      if (a instanceof DvDuration && b instanceof Date) return toDvDate(b)?.plus(a) ?? b;
      if (a instanceof DvDuration && b instanceof DvDuration) return a.plus(b);
      return (a as any) + (b as any);
    case "-":
      if (a instanceof Date && b instanceof Date) return toDvDate(a)?.diff(b) ?? a;
      if (a instanceof Date && b instanceof DvDuration) return toDvDate(a)?.minus(b) ?? a;
      if (a instanceof DvDuration && b instanceof DvDuration) return a.minus(b);
      return (a as number) - (b as number);
    case "*":
      if (a instanceof DvDuration && typeof b === "number") return a.mapUnits((value) => value * b);
      if (typeof a === "number" && b instanceof DvDuration) return b.mapUnits((value) => value * a);
      return (a as number) * (b as number);
    case "/":
      if (a instanceof DvDuration && typeof b === "number") return a.mapUnits((value) => value / b);
      return (a as number) / (b as number);
    default:
      return Number.NaN;
  }
}

/** Evaluate one DQL expression after lowering compatibility aliases to the IR vocabulary. */
export function evaluateDql(expression: string, row: DqlRow, current: DvPage): unknown {
  const javascript = lowerDqlFunctionAliases(expression)
    .replace(/\bdate\(\s*(today|now)\s*\)/gi, 'date("$1")')
    .replace(/\bdate\(\s*(\d{4}-\d{2}-\d{2}(?:T[^)\s]+)?)\s*\)/gi, 'date("$1")')
    .replace(/\bdur\(\s*(-?\d+(?:\.\d+)?)\s+(years?|months?|weeks?|days?|hours?|minutes?|seconds?)\s*\)/gi, 'dur("$1 $2")')
    .replace(/\bthis\./gi, "current.")
    .replace(/\bAND\b/gi, "&&")
    .replace(/\bOR\b/gi, "||")
    .replace(/\bNOT\b/gi, "!")
    .replace(/(?<![<>=!])=(?!=)/g, "==");
  const javascriptRewritten = rewriteDateArithmetic(javascript);
  const helpers = {
    current,
    contains: dqlContains,
    icontains: (haystack: unknown, needle: unknown) => String(haystack ?? "").toLocaleLowerCase().includes(String(needle ?? "").toLocaleLowerCase()),
    econtains: (haystack: unknown, needle: unknown) => Array.isArray(haystack) ? haystack.includes(needle) : String(haystack ?? "") === String(needle ?? ""),
    containsword: (haystack: unknown, needle: unknown) => new RegExp(`(?:^|\\W)${escapeRegex(String(needle ?? ""))}(?:$|\\W)`, "iu").test(String(haystack ?? "")),
    startswith: (value: unknown, prefix: unknown) => String(value ?? "").startsWith(String(prefix ?? "")),
    endswith: (value: unknown, suffix: unknown) => String(value ?? "").endsWith(String(suffix ?? "")),
    string: (value: unknown) => String(value ?? ""),
    number: (value: unknown) => Number(value),
    length: (value: unknown) => value == null ? 0 : Array.isArray(value) || typeof value === "string" ? value.length : typeof value === "object" ? Object.keys(value).length : String(value).length,
    choice: (condition: unknown, yes: unknown, no: unknown) => condition ? yes : no,
    coalesce: (...values: unknown[]) => values.find((value) => value != null),
    regexmatch: (pattern: string, value: unknown) => new RegExp(pattern).test(String(value ?? "")),
    regextest: (pattern: string, value: unknown) => new RegExp(pattern).test(String(value ?? "")),
    regexreplace: (value: unknown, pattern: string, replacement: string) => String(value ?? "").replace(new RegExp(pattern, "g"), replacement),
    replace: (value: unknown, pattern: unknown, replacement: unknown) => String(value ?? "").split(String(pattern ?? "")).join(String(replacement ?? "")),
    lower: (value: unknown) => String(value ?? "").toLocaleLowerCase(),
    upper: (value: unknown) => String(value ?? "").toLocaleUpperCase(),
    split: (value: unknown, separator: unknown) => String(value ?? "").split(String(separator ?? "")),
    substring: (value: unknown, start: number, end?: number) => String(value ?? "").slice(start, end),
    truncate: (value: unknown, length: number, suffix = "…") => {
      const text = String(value ?? ""); return text.length <= length ? text : text.slice(0, Math.max(0, length - suffix.length)) + suffix;
    },
    padleft: (value: unknown, length: number, fill = " ") => String(value ?? "").padStart(length, fill),
    padright: (value: unknown, length: number, fill = " ") => String(value ?? "").padEnd(length, fill),
    typeof: (value: unknown) => dqlTypeof(value),
    list: (...values: unknown[]) => values,
    join: (values: unknown[], separator = ", ") => values.filter((value) => value != null).join(separator),
    sum: (values: unknown[]) => values.reduce<number>((total, value) => total + Number(value ?? 0), 0),
    min: (values: unknown[]) => values.reduce((best, value) => compareValues(value, best) < 0 ? value : best, values[0]),
    max: (values: unknown[]) => values.reduce((best, value) => compareValues(value, best) > 0 ? value : best, values[0]),
    average: (values: unknown[]) => values.length ? values.reduce<number>((total, value) => total + Number(value ?? 0), 0) / values.length : null,
    product: (values: unknown[]) => values.reduce<number>((total, value) => total * Number(value ?? 1), 1),
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    trunc: Math.trunc,
    any: (values: unknown[], predicate?: (value: unknown) => unknown) => predicate ? values.some((value) => Boolean(predicate(value))) : values.some(Boolean),
    all: (values: unknown[], predicate?: (value: unknown) => unknown) => predicate ? values.every((value) => Boolean(predicate(value))) : values.every(Boolean),
    none: (values: unknown[]) => !values.some(Boolean),
    filter: (values: unknown[], predicate: (value: unknown) => unknown) => values.filter((value) => Boolean(predicate(value))),
    map: (values: unknown[], mapper: (value: unknown) => unknown) => values.map(mapper),
    reduce: (values: unknown[], reducer: (total: unknown, value: unknown) => unknown, initial?: unknown) => initial === undefined ? values.reduce(reducer) : values.reduce(reducer, initial),
    flat: (values: unknown[], depth = 1) => values.flat(depth),
    slice: (values: unknown[], start?: number, end?: number) => values.slice(start, end),
    nonnull: (values: unknown[]) => values.filter((value) => value != null),
    firstvalue: (values: unknown[]) => values.find((value) => value != null),
    unique: (values: unknown[]) => [...new Set(values)],
    distinct: (values: unknown[]) => [...new Set(values)],
    reverse: (values: unknown[]) => values.slice().reverse(),
    sort: (values: unknown[]) => values.slice().sort(compareValues),
    date: (value?: unknown) => value == null || value === "" ? startOfLocalDay() : toDvDate(value),
    dur: parseDuration,
    dateformat: formatDvDate,
    dateop: dateArithmetic,
    object: (...pairs: unknown[]) => Object.fromEntries(pairs.filter(Array.isArray).map((pair) => [String(pair[0]), pair[1]])),
    extract: (value: unknown, ...keys: string[]) => Object.fromEntries(keys.map((key) => [key, value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null])),
    meta: (value: unknown) => linkMetadata(value),
    link: (value: unknown, label?: unknown) => {
      const target = typeof value === "object" && value && "path" in value
        ? String((value as { path: unknown }).path)
        : String(value ?? "").replace(/^\[\[|\]\]$/g, "");
      return `[[${target}${label == null ? "" : `|${String(label)}`}]]`;
    },
  };
  const evaluator = new Function(
    "row",
    "helpers",
    `with (helpers) { with (row) { return (${javascriptRewritten}); } }`,
  ) as (row: DqlRow, helpers: Record<string, unknown>) => unknown;
  return evaluator(row, helpers);
}

/**
 * Dataview `contains`: object key, list membership (recursive), or substring.
 * `file.tags` is `#tag`, but vault queries often pass `tag` without the hash.
 */
export function dqlContains(haystack: unknown, needle: unknown): boolean {
  if (haystack == null) return false;
  if (Array.isArray(haystack)) {
    return haystack.some((item) =>
      compareValues(item, needle) === 0 || dqlContains(item, needle)
    );
  }
  if (typeof haystack === "object" && !(haystack instanceof Date)) {
    return Object.prototype.hasOwnProperty.call(haystack, String(needle ?? ""));
  }
  return String(haystack).includes(String(needle ?? ""));
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function dqlTypeof(value: unknown): string {
  if (value == null) return "null";
  if (value instanceof Date) return "date";
  if (value instanceof DvDuration) return "duration";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
function parseDuration(value: unknown): DvDuration {
  if (value instanceof DvDuration) return value;
  if (typeof value === "number") return DvDuration.fromMillis(value);
  const match = String(value ?? "").trim().match(/^(-?\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?|hours?|minutes?|seconds?)$/i);
  if (!match) return DvDuration.fromMillis(0);
  const amount = Number(match[1]); const unit = match[2].toLocaleLowerCase();
  const parts: DurationParts = unit.startsWith("year") ? { years: amount }
    : unit.startsWith("month") ? { months: amount }
    : unit.startsWith("week") ? { weeks: amount }
    : unit.startsWith("day") ? { days: amount }
    : unit.startsWith("hour") ? { hours: amount }
    : unit.startsWith("minute") ? { minutes: amount }
    : { seconds: amount };
  return DvDuration.fromParts(parts);
}
function formatDvDate(value: unknown, format = "yyyy-MM-dd"): string {
  const date = toDvDate(value); if (!date) return "";
  if (format === "DDDD") {
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return format.replace(/yyyy|y/g, String(date.year)).replace(/MMMM/g, names[date.month - 1]).replace(/MM/g, String(date.month).padStart(2, "0")).replace(/dd/g, String(date.day).padStart(2, "0"));
}
function linkMetadata(value: unknown): Record<string, unknown> {
  const raw = typeof value === "object" && value && "path" in value
    ? String((value as { path: unknown }).path)
    : String(value ?? "");
  const embed = raw.startsWith("![[");
  const inner = raw.replace(/^!?\[\[|\]\]$/g, "");
  const [target, display] = inner.split("|");
  const [pathAndSubpath, blockId] = target.split("^");
  const [path, subpath] = pathAndSubpath.split("#");
  return {
    path,
    display: display ?? null,
    embed,
    subpath: subpath ?? null,
    type: blockId ? "block" : subpath ? "header" : "file",
  };
}

function stubPage(path: string): DvPage {
  const name = (path.split("/").pop() || path).replace(/\.md$/i, "");
  return {
    path,
    file: {
      path,
      name,
      folder: path.includes("/") ? path.replace(/\/[^/]+$/, "") : "",
      link: `[[${path.replace(/\.md$/, "")}]]`,
      mtime: null,
      ctime: null,
      day: null,
    },
  };
}

function normalizeItems(items: unknown): unknown[] {
  if (items == null) return [];
  if (Array.isArray(items)) return items;
  if (typeof items === "object" && items !== null && "values" in (items as object)) {
    try {
      return [...(items as Iterable<unknown>)];
    } catch {
      /* fall through */
    }
  }
  return [items];
}

async function queryDqlForApi(
  source: string,
  ctx: EngineContext,
): Promise<{ successful: boolean; value?: unknown; error?: string }> {
  const mount = document.createElement("div");
  await runDqlBlock(source, mount, ctx);
  const error = mount.querySelector(".dv-error")?.textContent;
  if (error) return { successful: false, error };
  const table = mount.querySelector("table");
  if (table) {
    return {
      successful: true,
      value: {
        type: "table",
        headers: [...table.querySelectorAll("thead th")].map((cell) => cell.textContent ?? ""),
        values: [...table.querySelectorAll("tbody tr")].map((row) =>
          [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")),
      },
    };
  }
  return {
    successful: true,
    value: {
      type: mount.querySelector(".dv-task-list") ? "task" : mount.querySelector(".dv-calendar") ? "calendar" : "list",
      values: [...mount.querySelectorAll("li, .dv-calendar-day > div")].map((item) => item.textContent ?? ""),
    },
  };
}

function normalizeIoPath(path: string, origin: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path.startsWith("./") && !path.startsWith("../")) return clean.replace(/^\//, "");
  const parts = `${origin.replace(/\/[^/]*$/, "")}/${clean}`.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function parseCsv(source: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index <= source.length; index++) {
    const char = source[index] ?? "\n";
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  const headers = rows.shift() ?? [];
  return rows.filter((values) => values.some(Boolean)).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function stringify(v: unknown, fieldHint?: string): string {
  if (v == null) return "";
  if (typeof v === "string") {
    if (v.startsWith("[[") && v.endsWith("]]")) {
      const inner = v.slice(2, -2);
      const [t, a] = inner.split("|");
      return `<a href="#" class="preview-wikilink" data-wikilink="${esc(t)}">${esc(a || t)}</a>`;
    }
    const uri = formatQueryUri(v, fieldHint);
    if (uri) return uri;
    return esc(v);
  }
  if (v instanceof Date) return esc(v.toISOString().slice(0, 10));
  if (v instanceof DvDuration) return esc(v.toHuman());
  if (Array.isArray(v)) return v.map((value) => stringify(value, fieldHint)).filter(Boolean).join(", ");
  if (typeof v === "object" && v && "file" in (v as object)) {
    const p = v as DvPage;
    return `<a href="#" class="preview-wikilink" data-wikilink="${esc(p.path)}">${esc(p.file.name)}</a>`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "";
    return esc(JSON.stringify(v));
  }
  return esc(String(v));
}

function stringifyInline(v: unknown): string {
  if (typeof v !== "string") return stringify(v);
  return v.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) =>
    `<a href="#" class="preview-wikilink" data-wikilink="${esc(String(target).trim())}">${esc(String(alias || target).trim())}</a>`,
  );
}

/** Host globals shadowed so DataviewJS cannot reach WebView/Tauri internals. */
const DATAVIEW_JS_PARAMS = [
  "dv", "dateformat", "dur", "date", "choice", "luxonish", "note", "input", "app",
  "window", "document", "globalThis", "self", "parent", "top", "frames",
  "fetch", "XMLHttpRequest", "WebSocket", "Worker",
  "localStorage", "sessionStorage", "indexedDB",
  "Function",
] as const;

function wrapInlineExpression(code: string): string {
  return code
    .trim()
    .replace(/^\$?=\s*/, "")
    .replace(
      /\bdur\(\s*(-?\d+(?:\.\d+)?)\s+(years?|months?|weeks?|days?|hours?|minutes?)\s*\)/gi,
      'dur("$1 $2")',
    )
    .replace(
      /(date\([^)]*\)|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\+\s*(dur\("[^"]+"\))/g,
      "$1.plus($2)",
    );
}

function runDataviewJs(
  source: string,
  thisNote: DvPage,
  dv: { date: (value: unknown) => unknown } & Record<string, unknown>,
  dateformat: (d: unknown, fmt?: string) => string,
  dur: (s: unknown) => unknown,
  choice: (condition: unknown, whenTrue: unknown, whenFalse: unknown) => unknown,
  scriptInput: unknown,
  app: ObsidianApp,
): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const blanks = Array<undefined>(DATAVIEW_JS_PARAMS.length - 9).fill(undefined);
  const args = [
    dv, dateformat, dur, dv.date, choice, luxonish, thisNote, scriptInput, app, ...blanks,
  ];
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction(...DATAVIEW_JS_PARAMS, `"use strict";\nreturn (${source});`);
  } catch {
    fn = new AsyncFunction(...DATAVIEW_JS_PARAMS, `"use strict";\n${source}`);
  }
  return fn.call(thisNote, ...args);
}

function makeWikilink(path: string, embed = false, display?: string): string {
  return `${embed ? "!" : ""}[[${path}${display == null ? "" : `|${display}`}]]`;
}

function plainString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value instanceof DvDuration) return value.toHuman();
  if (Array.isArray(value)) return value.map(plainString).join(", ");
  if (typeof value === "object" && "file" in value) return (value as DvPage).file.link;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function markdownTable(headers: string[], rows: unknown[][]): string {
  const clean = (value: unknown) => plainString(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(clean).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(clean).join(" | ")} |`),
  ].join("\n");
}

function bindPreviewLinks(container: HTMLElement, ctx: EngineContext): void {
  container.querySelectorAll<HTMLAnchorElement>("a[data-wikilink]").forEach((link) => {
    if (link.dataset.openLinkBound) return;
    link.dataset.openLinkBound = "1";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = link.dataset.wikilink;
      if (target) ctx.resolveLink(target);
    });
  });
  bindQueryUriLinks(container);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Replace script fences in HTML preview with placeholder divs, then execute.
 * Works on the original markdown to find blocks and inject into a container.
 */

/** Run script fences found under a single preview subtree (e.g. one .md-block). */
export async function executeBlocksInSubtree(
  markdownSlice: string,
  subtree: HTMLElement,
  ctx: EngineContext,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  return executeBlocksInPreview(markdownSlice, subtree, ctx, shouldContinue);
}

export async function executeBlocksInPreview(
  markdownBody: string,
  previewEl: HTMLElement,
  ctx: EngineContext,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const blocks = extractScriptBlocks(markdownBody);
  const inlineScriptFlags = extractInlineScriptFlags(markdownBody);
  // Snapshot before running anything so generated <code> is never executed.
  const codeElements = Array.from(previewEl.querySelectorAll<HTMLElement>("code"));
  queryDiagnostic("executor.enter", {
    blocks: blocks.length,
    codeElements: codeElements.length,
    connected: previewEl.isConnected,
  });
  let bi = 0;
  let ii = 0;
  const runBlock = async (
    lang: string,
    source: string,
    mount: HTMLElement,
    inline = false,
  ) => {
    try {
      if (inline) await runScriptBlock(source, mount, ctx, true);
      else if (lang === "dataview") await runDqlBlock(source, mount, ctx);
      else if (SQL_LANGS.has(lang)) await runSqlBlock(source, mount, ctx);
      else await runScriptBlock(source, mount, ctx);
    } catch (error) {
      queryDiagnostic("executor.block.error", {
        lang: lang || "dataviewjs",
        error: error instanceof Error ? error.message : String(error),
      });
      const failure = document.createElement(inline ? "span" : "pre");
      failure.className = "dv-error";
      failure.textContent = `${inline ? "Inline script" : lang || "DataviewJS"} error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      mount.replaceChildren(failure);
    }
  };
  // Walking the snapshot preserves Markdown order across block and inline scripts.
  for (const codeEl of codeElements) {
    if (!shouldContinue()) return;
    const pre = codeEl.closest("pre");
    if (!pre) {
      const shouldRun = inlineScriptFlags[ii++] ?? false;
      const inlineLang = ((codeEl.className.match(/language-(\S+)/) || [])[1] || "").toLowerCase();
      // Pandoc `{.sqlpostgresql}` (and other language classes) is highlighting, not execution.
      if (inlineLang) continue;
      if (!shouldRun) continue;
      if (!previewEl.contains(codeEl)) continue;
      const mount = document.createElement("span");
      mount.className = "dv-inline";
      codeEl.replaceWith(mount);
      await runBlock("dataviewjs", codeEl.textContent || "", mount, true);
      if (!shouldContinue()) return;
      continue;
    }

    const cls = codeEl.className || "";
    const lang = ((cls.match(/language-(\S+)/) || [])[1] || "").toLowerCase();
    const text = codeEl.textContent || "";
    const always = ALWAYS_ENGINE.has(lang) || (lang === "" && /\bdv\b/.test(text));
    if (!always) continue;
    const mount = document.createElement("div");
    mount.className = "dv-block";
    mount.dataset.lang = lang || "dataviewjs";
    pre.replaceWith(mount);
    const block = blocks[bi++];
    const source = block?.code ?? text;
    queryDiagnostic("executor.block", { index: bi - 1, lang: lang || "dataviewjs" });
    await runBlock(lang || "dataviewjs", source, mount);
  }

  // Intentionally no root-level fallback mounts.
  // Older code appended leftover extractScriptBlocks() entries onto previewEl when
  // the corresponding <pre><code> had already been turned into .dv-block in a
  // *preserved* section. That stacked stale sql-error / result tables under the
  // live query (e.g. ghost "near ID" next to a successful table).
  // Blocks without a live <pre> are already rendered in a preserved .dv-block —
  // leave them alone (surgical). Callers that replace an .md-block must run
  // executeBlocksInPreview on that subtree so its new <pre> nodes execute.
  if (bi < blocks.length) {
    queryDiagnostic("executor.unmounted-blocks", {
      remaining: blocks.length - bi,
      total: blocks.length,
      mounted: bi,
    });
  }
  queryDiagnostic("executor.complete", { blocks: bi });
}
