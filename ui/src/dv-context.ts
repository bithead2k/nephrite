import { invoke } from "@tauri-apps/api/core";
import {
  filterPagesBySource,
  type DvPage,
  type EngineContext,
  type SqlQueryResult,
} from "./dv-engine";

type PageRow = {
  path: string;
  name: string;
  folder: string;
  mtime_ms: number;
  size_bytes?: number;
  properties: Record<string, unknown>;
  tags?: unknown[];
  aliases?: unknown[];
  links?: unknown[];
  tasks?: unknown[];
  inline_fields?: unknown[];
};

export function makeEngineContext(
  currentPath: string,
  currentSource: string,
  resolveLink: (target: string) => void,
): EngineContext {
  let allPages: Promise<DvPage[]> | null = null;
  const loadPages = (source?: string): Promise<DvPage[]> => {
    allPages ??= invoke<PageRow[]>("list_pages", { source: null })
      .then((rows) => enrichPageLinks(rows.map(rowToDvPage)));
    return allPages.then((pages) => filterPagesBySource(pages, source, currentPath));
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
    readFile: (path) => invoke<{ content: string }>("read_file", { path }).then((file) => file.content),
    setTaskCompleted: (path, taskId, completed) =>
      invoke("set_task_completed", { path, taskId, completed }),
    resolveLink,
  };
}

export function rowToDvPage(row: PageRow): DvPage {
  const mtime = row.mtime_ms ? new Date(row.mtime_ms) : null;
  const name = row.name.replace(/\.md$/i, "");
  // The page property bag must always remain an object, even for a page with
  // no frontmatter. Only values inside it use Dataview's null semantics.
  const props = normalizePageProperties(row.properties);
  for (const field of row.inline_fields ?? []) {
    if (!field || typeof field !== "object") continue;
    const record = field as Record<string, unknown>;
    const key = String(record.key ?? "").trim();
    if (!key) continue;
    const value = normalizeMetadata(record.value);
    if (!(key in props)) props[key] = value;
    else if (Array.isArray(props[key])) (props[key] as unknown[]).push(value);
    else props[key] = [props[key], value];
  }
  const rawTags = [...new Set([
    ...stringArray(props.tags),
    ...stringArray(row.tags).map((tag) => tag.replace(/^#/, "")),
  ])];
  const fileTags = rawTags.map((tag) => tag.startsWith("#") ? tag : `#${tag}`);
  const aliases = [...new Set([...stringArray(props.aliases), ...stringArray(row.aliases)])];
  const outlinks = (row.links ?? []).map((link) => {
    if (!link || typeof link !== "object") return String(link ?? "");
    const value = link as Record<string, unknown>;
    return String(value.path ?? value.target ?? "").replace(/\.md$/i, "");
  }).filter(Boolean);
  const tasks = (row.tasks ?? []).map((task) => {
    const value = task && typeof task === "object" ? task as Record<string, unknown> : {};
    return {
      ...value,
      path: row.path,
      task_id: Number(value.id ?? value.task_id ?? 0),
      id: Number(value.id ?? value.task_id ?? 0),
      completed: Boolean(value.completed),
      tags: stringArray(value.tags),
      link: `[[${row.path.replace(/\.md$/i, "")}]]`,
    };
  });
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
    tags: props.tags ?? rawTags,
    aliases: props.aliases ?? aliases,
    tasks,
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
      tags: fileTags,
      etags: fileTags,
      aliases,
      tasks,
      frontmatter: props,
      outlinks,
      inlinks: [],
    },
  };
  return page;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function enrichPageLinks(pages: DvPage[]): DvPage[] {
  const byTarget = new Map<string, string[]>();
  for (const page of pages) {
    for (const target of page.file.outlinks ?? []) {
      const key = normalizeLinkPath(String(target));
      const incoming = byTarget.get(key) ?? [];
      incoming.push(page.path.replace(/\.md$/i, ""));
      byTarget.set(key, incoming);
    }
  }
  for (const page of pages) {
    const full = normalizeLinkPath(page.path);
    const name = normalizeLinkPath(page.file.name);
    page.file.inlinks = [...new Set([...(byTarget.get(full) ?? []), ...(byTarget.get(name) ?? [])])];
  }
  return pages;
}

function normalizeLinkPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\.md$/i, "").toLocaleLowerCase();
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
