import { invoke } from "@tauri-apps/api/core";
import type { DvPage, EngineContext, SqlQueryResult } from "./dv-engine";

type PageRow = {
  path: string;
  name: string;
  folder: string;
  mtime_ms: number;
  size_bytes?: number;
  properties: Record<string, unknown>;
};

export function makeEngineContext(
  currentPath: string,
  currentSource: string,
  resolveLink: (target: string) => void,
): EngineContext {
  const pageCache = new Map<string, Promise<DvPage[]>>();
  const loadPages = (source?: string): Promise<DvPage[]> => {
    const key = source ?? "";
    let pending = pageCache.get(key);
    if (!pending) {
      pending = invoke<PageRow[]>("list_pages", { source: source ?? null })
        .then((rows) => rows.map(rowToDvPage));
      pageCache.set(key, pending);
    }
    return pending;
  };

  return {
    currentPath,
    currentSource,
    loadPages,
    loadPage: async (path) => {
      const pages = await loadPages();
      return pages.find((candidate) => candidate.path === path) ?? null;
    },
    runSql: (sql) => {
      // Defense in depth if callers skip expandSqlNoteRefs.
      const pathLit = currentPath.replace(/'/g, "''");
      let expanded = sql
        .replace(/\bthis\.file\.path\b/gi, `'${pathLit}'`)
        .replace(/\bthis\.path\b/gi, `'${pathLit}'`)
        .replace(/\{\{\s*active\.path\s*\}\}/gi, `'${pathLit}'`);
      return invoke<SqlQueryResult>("query_vault_sql", { sql: expanded });
    },
    resolveLink,
  };
}

export function rowToDvPage(row: PageRow): DvPage {
  const mtime = row.mtime_ms ? new Date(row.mtime_ms) : null;
  const name = row.name.replace(/\.md$/i, "");
  // The page property bag must always remain an object, even for a page with
  // no frontmatter. Only values inside it use Dataview's null semantics.
  const props = normalizePageProperties(row.properties);
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        props[key] = Object.assign(date, {
          month: date.getMonth() + 1,
          day: date.getDate(),
          year: date.getFullYear(),
        });
      }
    }
  }
  const page: DvPage = {
    path: row.path,
    ...props,
    file: {
      path: row.path,
      name,
      folder: row.folder,
      link: `[[${row.path.replace(/\.md$/i, "")}]]`,
      mtime,
      ctime: null,
      day: mtime,
      size: row.size_bytes ?? null,
      bytes: row.size_bytes ?? null,
    },
  };
  return page;
}

export function normalizePageProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, normalizeMetadata(value)]),
  );
}

function normalizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMetadata);
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return null;
    return Object.fromEntries(entries.map(([key, child]) => [key, normalizeMetadata(child)]));
  }
  return value;
}
