import { workBudget } from "./work-budget";
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

// One parsed snapshot per open vault, shared by preview/query contexts.
let sharedPages: Promise<PageSnapshot> | null = null;

export function resetEnginePageCache(): void {
  sharedPages = null;
}

export function refreshEnginePageCache(paths: string[]): void {
  if (!sharedPages || !paths.length) return;
  const previous = sharedPages;
  const next = previous.then(async (pages) => {
    const rows = await invoke<PageRow[]>("list_pages", { source: null, paths });
    await pages.update(paths, rows);
    return pages;
  });
  sharedPages = next;
  void next.catch(error => {
    if (sharedPages === next) sharedPages = null;
    console.warn("[page cache refresh]", error);
  });
}

function loadSharedPages(): Promise<PageSnapshot> {
  if (!sharedPages) {
    const pending = invoke<PageRow[]>("list_pages", { source: null })
      .then(async rows => {
        const snapshot = new PageSnapshot();
        await snapshot.update([], rows);
        return snapshot;
      });
    sharedPages = pending;
    void pending.catch(() => { if (sharedPages === pending) sharedPages = null; });
  }
  return sharedPages;
}

export function makeEngineContext(
  currentPath: string,
  currentSource: string,
  resolveLink: (target: string) => void,
): EngineContext {
  const loadPages = (source?: string): Promise<DvPage[]> =>
    loadSharedPages().then((pages) => filterPagesBySource(pages.values(), source, currentPath));

  return {
    currentPath,
    currentSource,
    loadPages,
    birthdayCandidates: (month, day) => invoke<string[]>("birthday_candidates", { month, day }),
    loadPagesByPaths: async (paths) => {
      if (!paths.length) return [];
      // Preserve complete backlink metadata from the existing shared snapshot.
      // The candidate set narrows evaluation, not the semantic page contents.
      return (await loadSharedPages()).pick(paths);
    },
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
      // Parse date-only values as local midnight (matching Obsidian Dataview).
      // `new Date("2026-08-14")` would be UTC midnight, which reads as the
      // previous evening in western timezones and corrupts calendar math.
      const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (parts) {
        const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
        if (!Number.isNaN(date.getTime())) {
          props[key] = Object.assign(date, {
            month: date.getMonth() + 1,
            day: date.getDate(),
            year: date.getFullYear(),
          });
        }
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

// Reverse indexes keep an ordinary note save proportional to its changed links,
// rather than rebuilding backlinks for every page in the vault.
class PageSnapshot {
  private pages = new Map<string, DvPage>();
  private incoming = new Map<string, Set<string>>();
  private targets = new Map<string, Set<string>>();
  private outgoing = new Map<string, Set<string>>();
  private ordered: DvPage[] | null = null;

  pick(paths: string[]): DvPage[] {
    return paths.flatMap(path => { const page = this.pages.get(path); return page ? [page] : []; });
  }

  values(): DvPage[] {
    return this.ordered ??= [...this.pages.values()];
  }

  async update(paths: string[], rows: PageRow[]): Promise<void> {
    const affected = new Set<string>();
    const changed = new Set([...paths, ...rows.map(row => row.path)]);
    const checkpoint = workBudget();
    let count = 0;
    const pause = () => ++count % 256 === 0 ? checkpoint() : undefined;
    for (const path of this.pages.size ? changed : []) {
      const old = this.pages.get(path);
      if (old) {
        for (const key of this.keys(old)) {
          this.targets.get(key)?.delete(path);
          if (!this.targets.get(key)?.size) this.targets.delete(key);
        }
        for (const key of this.outgoing.get(path) ?? []) {
          this.incoming.get(key)?.delete(path);
          if (!this.incoming.get(key)?.size) this.incoming.delete(key);
          affected.add(key);
        }
        this.outgoing.delete(path);
        this.pages.delete(path);
      }
      const pending = pause();
      if (pending) await pending;
    }
    for (const row of rows) {
      const page = rowToDvPage(row);
      this.pages.set(page.path, page);
      for (const key of this.keys(page)) {
        this.add(this.targets, key, page.path);
        affected.add(key);
      }
      const links = new Set((page.file.outlinks ?? []).map(link => normalizeLinkPath(String(link))));
      this.outgoing.set(page.path, links);
      for (const key of links) {
        this.add(this.incoming, key, page.path);
        affected.add(key);
      }
      const pending = pause();
      if (pending) await pending;
    }
    const touched = new Set<string>();
    for (const key of affected) {
      for (const path of this.targets.get(key) ?? []) touched.add(path);
      const pending = pause();
      if (pending) await pending;
    }
    for (const path of touched) {
      const page = this.pages.get(path)!;
      const links = new Set<string>();
      for (const key of this.keys(page)) {
        for (const source of this.incoming.get(key) ?? []) links.add(source.replace(/\.md$/i, ""));
      }
      page.file.inlinks = [...links];
      const pending = pause();
      if (pending) await pending;
    }
    this.ordered = null;
  }

  private keys(page: DvPage): Set<string> {
    return new Set([normalizeLinkPath(page.path), normalizeLinkPath(page.file.name)]);
  }

  private add(index: Map<string, Set<string>>, key: string, path: string): void {
    let paths = index.get(key);
    if (!paths) index.set(key, paths = new Set());
    paths.add(path);
  }
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
