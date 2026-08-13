import { marked } from "marked";
import { bindQueryUriLinks, formatQueryUri } from "./query-uri";
import { queryDiagnostic } from "./query-diagnostics";

/**
 * Nephrite JS view engine — DataviewJS-compatible surface for fenced blocks
 * and inline backtick commands.
 *
 * Recognized fence languages (see extractScriptBlocks):
 *   dataviewjs | dataview | js | javascript | sql | postgresql | pgsql | (empty)
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
  };
  [key: string]: unknown;
};

export type DvApi = {
  current: () => DvPage;
  pages: (source?: string) => DvPageList;
  page: (path: string) => DvPage | null;
  date: (input?: unknown) => Date | null;
  duration?: (s: string) => unknown;
  paragraph: (html: unknown) => void;
  list: (items: unknown) => void;
  table: (headers: string[], rows: unknown[][]) => void;
  el: (tag: string, text?: string) => HTMLElement;
  span: (text: string) => HTMLElement;
  header: (level: number, text: string) => void;
  view?: unknown;
};

export type DvPageList = Array<DvPage> & {
  file: { link: string[] };
  where: (predicate: (page: DvPage, index: number) => unknown) => DvPageList;
  limit: (n: number) => DvPageList;
};

export type EngineContext = {
  currentPath: string;
  currentSource: string;
  loadPages: (source?: string) => Promise<DvPage[]>;
  loadPage: (path: string) => Promise<DvPage | null>;
  runSql: (sql: string) => Promise<SqlQueryResult>;
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

const SQL_LANGS = new Set(["sql", "postgresql", "pgsql"]);

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

function wrapList(pages: DvPage[]): DvPageList {
  const arr = pages.slice() as DvPageList;
  Object.defineProperty(arr, "file", {
    get() {
      return { link: arr.map((p) => p.file.link) };
    },
  });
  // Patch filter/sort to keep .file / .limit helpers
  const nativeFilter = Array.prototype.filter;
  const nativeSort = Array.prototype.sort;
  arr.filter = function (this: DvPage[], predicate: (value: DvPage, index: number, array: DvPage[]) => unknown) {
    return wrapList(nativeFilter.call(this, predicate) as DvPage[]);
  } as typeof arr.filter;
  arr.where = (predicate) => wrapList(nativeFilter.call(arr, predicate) as DvPage[]);
  arr.sort = function (
    this: DvPage[],
    compareOrKey?: ((a: DvPage, b?: DvPage) => unknown),
    direction?: string,
  ) {
    if (compareOrKey && direction) {
      const sign = direction.toLowerCase() === "desc" ? -1 : 1;
      nativeSort.call(this, (a: DvPage, b: DvPage) => {
        const av = compareOrKey(a);
        const bv = compareOrKey(b);
        return compareValues(av, bv) * sign;
      });
    } else {
      nativeSort.call(
        this,
        compareOrKey as ((a: DvPage, b: DvPage) => number) | undefined,
      );
    }
    return this as DvPageList;
  } as typeof arr.sort;
  arr.limit = (n) => wrapList(arr.slice(0, n));
  return arr;
}

class DvDate extends Date {
  get year() { return this.getFullYear(); }
  get month() { return this.getMonth() + 1; }
  get day() { return this.getDate(); }

  toString(): string {
    return `${this.year}-${String(this.month).padStart(2, "0")}-${String(this.day).padStart(2, "0")}`;
  }

  plus(parts: { days?: number; weeks?: number; months?: number; years?: number } | DvDuration): DvDate {
    const next = new DvDate(this.getTime());
    if (parts instanceof DvDuration) {
      next.setTime(next.getTime() + parts.milliseconds);
      return next;
    }
    if (parts.years) next.setFullYear(next.getFullYear() + parts.years);
    if (parts.months) next.setMonth(next.getMonth() + parts.months);
    if (parts.weeks) next.setDate(next.getDate() + parts.weeks * 7);
    if (parts.days) next.setDate(next.getDate() + parts.days);
    return next;
  }

}

class DvDuration {
  constructor(readonly milliseconds: number) {}
  get days() { return this.milliseconds / 86_400_000; }
  valueOf() { return this.milliseconds; }
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

function toDvDate(input: unknown): DvDate | null {
  if (input instanceof DvDate) return input;
  if (input instanceof Date) return new DvDate(input.getTime());
  if (typeof input === "string") {
    const plain = input.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
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

  const dv: DvApi = {
    current: () => thisNote,
    pages: (_source?: string) => {
      // sync facade — populated before AsyncFunction runs via preloaded
      return wrapList((dv as unknown as { _pages: DvPage[] })._pages || []);
    },
    page: (path: string) => {
      const pages = (dv as unknown as { _pages: DvPage[] })._pages || [];
      return pages.find((p) => p.path === path || p.path === path + ".md") ?? null;
    },
    date: (input?: unknown) => {
      if (input == null || input === "") return new DvDate();
      if (input instanceof Date || typeof input === "string" || typeof input === "number") {
        return toDvDate(input);
      }
      if (typeof input === "object" && input && "toJSDate" in (input as object)) {
        try {
          return toDvDate((input as { toJSDate: () => Date }).toJSDate());
        } catch {
          return null;
        }
      }
      return null;
    },
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

  // Preload pages for source used in code — heuristic: parse dv.pages("...")
  const sources = [...code.matchAll(/dv\.pages\s*\(\s*(['"`])(.*?)\1\s*\)/g)].map(
    (m) => m[2],
  );
  if (sources.length === 0) sources.push("");
  const all: DvPage[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const batch = await ctx.loadPages(s || undefined);
    for (const p of batch) {
      if (!seen.has(p.path)) {
        seen.add(p.path);
        all.push(normalizePage(p));
      }
    }
  }
  (dv as unknown as { _pages: DvPage[] })._pages = all;

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

  const dur = (s: unknown) => {
    if (s instanceof DvDuration) return s;
    if (typeof s === "number") return new DvDuration(s);
    const match = String(s).trim().match(
      /^(-?\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?|hours?|minutes?)$/i,
    );
    if (!match) return new DvDuration(0);
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const days = unit.startsWith("year")
      ? amount * 365.2425
      : unit.startsWith("month")
        ? amount * 30.436875
        : unit.startsWith("week")
          ? amount * 7
          : unit.startsWith("day")
            ? amount
            : unit.startsWith("hour")
              ? amount / 24
              : amount / 1_440;
    return new DvDuration(days * 86_400_000);
  };

  const choice = (condition: unknown, whenTrue: unknown, whenFalse: unknown) =>
    condition ? whenTrue : whenFalse;

  try {
    // AsyncFunction so scripts can await if they want
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    let fn: (...args: unknown[]) => Promise<unknown>;
    if (inline) {
      const expression = code
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
      try {
        fn = new AsyncFunction(
          "dv",
          "dateformat",
          "dur",
          "date",
          "choice",
          "luxonish",
          "note",
          `"use strict";\nreturn (${expression});`,
        );
      } catch {
        // Multi-statement inline commands still run; an explicit return renders.
        fn = new AsyncFunction(
          "dv",
          "dateformat",
          "dur",
          "date",
          "choice",
          "luxonish",
          "note",
          `"use strict";\n${expression}`,
        );
      }
    } else {
      fn = new AsyncFunction(
        "dv",
        "dateformat",
        "dur",
        "date",
        "choice",
        "luxonish",
        "note",
        `"use strict";\n${code}`,
      );
    }
    const result = await fn.call(
      thisNote,
      dv,
      dateformat,
      dur,
      dv.date,
      choice,
      luxonish,
      thisNote,
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
    let pages = (await ctx.loadPages(query.source || undefined)).map(normalizePage);
    if (query.where) {
      pages = pages.filter((page) => Boolean(evaluateDql(query.where!, page, current)));
    }
    if (query.sort.length > 0) {
      pages.sort((left, right) => {
        for (const sort of query.sort) {
          const comparison = compareValues(
            evaluateDql(sort.expression, left, current),
            evaluateDql(sort.expression, right, current),
          );
          if (comparison !== 0) return sort.descending ? -comparison : comparison;
        }
        return 0;
      });
    }
    if (query.limit != null) pages = pages.slice(0, query.limit);

    if (query.kind === "LIST") {
      const items = pages.map((page) => query.listExpression
        ? evaluateDql(query.listExpression, page, current)
        : page);
      container.innerHTML = `<ul class="dv-list">${items.map((item) =>
        `<li>${stringify(item)}</li>`).join("")}</ul>`;
    } else {
      const columns = query.columns;
      const includeId = !query.withoutId;
      const headers = [
        ...(includeId ? ["File"] : []),
        ...columns.map((column) => column.label),
      ];
      const rows = pages.map((page) => [
        ...(includeId ? [page] : []),
        ...columns.map((column) => evaluateDql(column.expression, page, current)),
      ]);
      const hints = [
        ...(includeId ? ["file"] : []),
        ...columns.map((column) => `${column.expression} ${column.label}`),
      ];
      container.innerHTML = `<table class="dv-table"><thead><tr>${headers.map((header) =>
        `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) =>
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

function parseDql(code: string): {
  kind: "TABLE" | "LIST";
  withoutId: boolean;
  columns: DqlColumn[];
  listExpression: string | null;
  source: string | null;
  where: string | null;
  sort: { expression: string; descending: boolean }[];
  limit: number | null;
} {
  const lines = code.replace(/\r/g, "").split("\n");
  const clauses = new Map<string, string>();
  let active = "";
  for (const original of lines) {
    const line = original.trim();
    if (!line || line.startsWith("//")) continue;
    const marker = line.match(/^(TABLE|LIST|FROM|WHERE|SORT|LIMIT)\b(.*)$/i);
    if (marker) {
      active = marker[1].toUpperCase();
      clauses.set(active, marker[2].trim());
    } else if (active) {
      clauses.set(active, `${clauses.get(active) || ""} ${line}`.trim());
    }
  }
  const table = clauses.get("TABLE");
  const list = clauses.get("LIST");
  if (table == null && list == null) throw new Error("Expected TABLE or LIST");
  let tableText = table ?? "";
  const withoutId = /^WITHOUT\s+ID\b/i.test(tableText);
  tableText = tableText.replace(/^WITHOUT\s+ID\b/i, "").trim();
  const columns = tableText ? splitDqlList(tableText).map(parseDqlColumn) : [];
  const sourceMatch = clauses.get("FROM")?.match(/^["']([^"']+)["']/);
  const sort = clauses.has("SORT")
    ? splitDqlList(clauses.get("SORT")!).map((part) => {
        const match = part.trim().match(/^(.*?)(?:\s+(ASC|DESC))?$/i)!;
        return { expression: match[1].trim(), descending: match[2]?.toUpperCase() === "DESC" };
      })
    : [];
  const parsedLimit = Number.parseInt(clauses.get("LIMIT") || "", 10);
  return {
    kind: table != null ? "TABLE" : "LIST",
    withoutId,
    columns,
    listExpression: list?.trim() || null,
    source: sourceMatch?.[1] ?? null,
    where: clauses.get("WHERE") || null,
    sort,
    limit: Number.isFinite(parsedLimit) ? Math.max(0, parsedLimit) : null,
  };
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
      output += identifier.toLowerCase() === "default" && expression[next] === "("
        ? "coalesce"
        : identifier;
      index = end;
      continue;
    }
    output += char;
    index++;
  }
  return output;
}

/** Evaluate one DQL expression after lowering compatibility aliases to the IR vocabulary. */
export function evaluateDql(expression: string, row: DvPage, current: DvPage): unknown {
  const javascript = lowerDqlFunctionAliases(expression)
    .replace(/\bthis\./gi, "current.")
    .replace(/\bAND\b/gi, "&&")
    .replace(/\bOR\b/gi, "||")
    .replace(/\bNOT\b/gi, "!")
    .replace(/(?<![<>=!])=(?!=)/g, "==");
  const helpers = {
    current,
    contains: (haystack: unknown, needle: unknown) => Array.isArray(haystack)
      ? haystack.includes(needle)
      : String(haystack ?? "").includes(String(needle ?? "")),
    string: (value: unknown) => String(value ?? ""),
    length: (value: unknown) => value == null ? 0 : String(value).length,
    choice: (condition: unknown, yes: unknown, no: unknown) => condition ? yes : no,
    coalesce: (...values: unknown[]) => values.find((value) => value != null),
    regexmatch: (pattern: string, value: unknown) => new RegExp(pattern).test(String(value ?? "")),
    list: (...values: unknown[]) => values,
    join: (values: unknown[], separator = ", ") => values.filter((value) => value != null).join(separator),
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
    `with (helpers) { with (row) { return (${javascript}); } }`,
  ) as (row: DvPage, helpers: Record<string, unknown>) => unknown;
  return evaluator(row, helpers);
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
