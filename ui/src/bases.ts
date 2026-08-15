import { parseSimpleYaml } from "./structured-view";

export type BaseFilter =
  | { kind: "and" | "or" | "not"; items: BaseFilter[] }
  | { kind: "expr"; source: string };

export type BaseSort = {
  property: string;
  direction: "ASC" | "DESC";
};

export type BaseView = {
  type: string;
  name: string;
  limit: number | null;
  order: string[];
  sort: BaseSort[];
  filters: BaseFilter | null;
};

export type BaseFile = {
  filters: BaseFilter | null;
  formulas: Record<string, string>;
  properties: Record<string, { displayName?: string }>;
  views: BaseView[];
};

export type BasePage = {
  path: string;
  name: string;
  folder: string;
  ext: string;
  size: number;
  tags: string[];
  links: string[];
  properties: Record<string, unknown>;
};

export type BaseTable = {
  name: string;
  columns: { id: string; label: string }[];
  rows: { path: string; cells: unknown[] }[];
};

export function isBasePath(path: string): boolean {
  return /\.base$/i.test(path);
}

export function parseBase(source: string): BaseFile {
  const raw = parseSimpleYaml(source);
  const root = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const viewsRaw = Array.isArray(root.views) ? root.views : [];
  const views = viewsRaw
    .filter((view): view is Record<string, unknown> => !!view && typeof view === "object")
    .map((view) => ({
      type: String(view.type ?? "table"),
      name: String(view.name ?? "Table"),
      limit: typeof view.limit === "number" ? view.limit : Number(view.limit) || null,
      order: Array.isArray(view.order) ? view.order.map((item) => String(item)) : [],
      sort: parseSort(view.sort),
      filters: parseFilter(view.filters),
    }));
  const formulas: Record<string, string> = {};
  if (root.formulas && typeof root.formulas === "object" && !Array.isArray(root.formulas)) {
    for (const [key, value] of Object.entries(root.formulas)) {
      formulas[key] = String(value ?? "");
    }
  }
  const properties: Record<string, { displayName?: string }> = {};
  if (root.properties && typeof root.properties === "object" && !Array.isArray(root.properties)) {
    for (const [key, value] of Object.entries(root.properties)) {
      const display = value && typeof value === "object" && !Array.isArray(value)
        ? String((value as { displayName?: unknown }).displayName ?? "")
        : "";
      properties[key] = display ? { displayName: display } : {};
    }
  }
  return {
    filters: parseFilter(root.filters),
    formulas,
    properties,
    views: views.length ? views : [{
      type: "table",
      name: "Table",
      limit: null,
      order: ["file.name", "file.folder", "file.ext"],
      sort: [],
      filters: null,
    }],
  };
}

export function evaluateBase(
  base: BaseFile,
  pages: readonly BasePage[],
  viewIndex = 0,
): BaseTable {
  const view = base.views[viewIndex] ?? base.views[0];
  const computed = pages.map((page) => applyFormulas(page, base.formulas));
  const filtered = computed.filter((page) =>
    matchesFilter(base.filters, page) && matchesFilter(view.filters, page),
  );
  const sorted = sortPages(filtered, view.sort);
  const columns = (view.order.length ? view.order : ["file.name", "file.folder", "file.ext"])
    .map((id) => ({
      id,
      label: base.properties[id]?.displayName || displayName(id),
    }));
  const rows = sorted.map((page) => ({
    path: page.path,
    cells: columns.map((column) => resolveProperty(page, column.id)),
  }));
  const limited = view.limit && view.limit > 0 ? rows.slice(0, view.limit) : rows;
  return { name: view.name, columns, rows: limited };
}

export function pageFromIndexRow(row: {
  path: string;
  name: string;
  folder?: string;
  size_bytes?: number;
  tags?: unknown;
  links?: unknown;
  properties?: Record<string, unknown> | null;
}): BasePage {
  const name = row.name.replace(/\.md$/i, "");
  return {
    path: row.path,
    name,
    folder: row.folder ?? (row.path.includes("/") ? row.path.replace(/\/[^/]+$/, "") : ""),
    ext: (row.path.split(".").pop() || "").toLowerCase(),
    size: Number(row.size_bytes ?? 0),
    tags: stringList(row.tags).map((tag) => tag.replace(/^#/, "")),
    links: linkList(row.links),
    properties: row.properties && typeof row.properties === "object" ? row.properties : {},
  };
}

export function emptyBaseSource(): string {
  return [
    "filters:",
    "  and:",
    '    - file.ext == "md"',
    "formulas: {}",
    "properties:",
    "  file.name:",
    "    displayName: Name",
    "views:",
    "  - type: table",
    "    name: Table",
    "    order:",
    "      - file.name",
    "      - file.folder",
    "      - file.ext",
    "",
  ].join("\n");
}

function parseSort(value: unknown): BaseSort[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ property: item, direction: "ASC" as const }];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const property = String(record.property ?? record.column ?? "");
    if (!property) return [];
    const direction = String(record.direction ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
    return [{ property, direction }];
  });
}

function applyFormulas(page: BasePage, formulas: Record<string, string>): BasePage {
  const keys = Object.keys(formulas);
  if (!keys.length) return page;
  const properties = { ...page.properties };
  const next = { ...page, properties };
  for (const [key, source] of Object.entries(formulas)) {
    properties[key] = evaluateFormula(source, next);
  }
  return next;
}

function sortPages(pages: BasePage[], sort: BaseSort[]): BasePage[] {
  if (!sort.length) return pages;
  return [...pages].sort((left, right) => {
    for (const rule of sort) {
      const cmp = compareValues(resolveProperty(left, rule.property), resolveProperty(right, rule.property));
      if (cmp !== 0) return rule.direction === "DESC" ? -cmp : cmp;
    }
    return 0;
  });
}

function compareValues(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  const ln = Number(left);
  const rn = Number(right);
  if (!Number.isNaN(ln) && !Number.isNaN(rn) && (typeof left === "number" || typeof right === "number" || /^-?\d/.test(String(left)))) {
    return ln - rn;
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

export function evaluateFormula(source: string, page: BasePage): unknown {
  const text = source.trim();
  if (!text) return "";
  const binary = text.match(/^(.+?)\s*([+\-*/])\s+(.+)$/);
  if (binary) {
    const left = Number(evaluateFormula(binary[1], page));
    const right = Number(evaluateFormula(binary[3], page));
    if (!Number.isNaN(left) && !Number.isNaN(right)) {
      if (binary[2] === "+") return left + right;
      if (binary[2] === "-") return left - right;
      if (binary[2] === "*") return left * right;
      return right === 0 ? null : left / right;
    }
    if (binary[2] === "+") return `${evaluateFormula(binary[1], page) ?? ""}${evaluateFormula(binary[3], page) ?? ""}`;
  }
  if ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
    || text === "true" || text === "false" || text === "null"
    || /^-?\d+(?:\.\d+)?$/.test(text)) {
    return literal(text);
  }
  return resolveProperty(page, text);
}

function parseFilter(value: unknown): BaseFilter | null {
  if (value == null || value === "") return null;
  if (typeof value === "string") return { kind: "expr", source: value };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const kind of ["and", "or", "not"] as const) {
    if (kind in record) {
      const items = Array.isArray(record[kind]) ? record[kind] : [record[kind]];
      return {
        kind,
        items: items.map((item) => parseFilter(item)).filter((item): item is BaseFilter => item != null),
      };
    }
  }
  return null;
}

function matchesFilter(filter: BaseFilter | null, page: BasePage): boolean {
  if (!filter) return true;
  if (filter.kind === "and") return filter.items.every((item) => matchesFilter(item, page));
  if (filter.kind === "or") return filter.items.some((item) => matchesFilter(item, page));
  if (filter.kind === "not") return !filter.items.some((item) => matchesFilter(item, page));
  return evaluateExpression(filter.kind === "expr" ? filter.source : "", page);
}

export function evaluateExpression(source: string, page: BasePage): boolean {
  const text = source.trim();
  const hasTag = text.match(/^file\.hasTag\(\s*["']([^"']+)["']\s*\)$/i);
  if (hasTag) {
    const wanted = hasTag[1].replace(/^#/, "").toLocaleLowerCase();
    return page.tags.some((tag) => tag.toLocaleLowerCase() === wanted || tag.toLocaleLowerCase().startsWith(`${wanted}/`));
  }
  const inFolder = text.match(/^file\.inFolder\(\s*["']([^"']+)["']\s*\)$/i);
  if (inFolder) {
    const folder = inFolder[1].replace(/^\/+|\/+$/g, "").toLocaleLowerCase();
    return page.folder.toLocaleLowerCase() === folder || page.folder.toLocaleLowerCase().startsWith(`${folder}/`);
  }
  const hasLink = text.match(/^file\.hasLink\(\s*["']([^"']+)["']\s*\)$/i);
  if (hasLink) {
    const target = hasLink[1].replace(/\.md$/i, "").toLocaleLowerCase();
    return page.links.some((link) => {
      const value = link.replace(/\.md$/i, "").toLocaleLowerCase();
      return value === target || value.endsWith(`/${target}`) || value.split("/").pop() === target;
    });
  }
  const compare = text.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!compare) return Boolean(resolveProperty(page, text));
  const left = resolveProperty(page, compare[1]);
  const right = literal(compare[3]);
  const op = compare[2];
  if (op === "==") return String(left ?? "") === String(right ?? "");
  if (op === "!=") return String(left ?? "") !== String(right ?? "");
  const ln = Number(left);
  const rn = Number(right);
  if (Number.isNaN(ln) || Number.isNaN(rn)) {
    const cmp = String(left ?? "").localeCompare(String(right ?? ""));
    if (op === ">") return cmp > 0;
    if (op === "<") return cmp < 0;
    if (op === ">=") return cmp >= 0;
    return cmp <= 0;
  }
  if (op === ">") return ln > rn;
  if (op === "<") return ln < rn;
  if (op === ">=") return ln >= rn;
  return ln <= rn;
}

function resolveProperty(page: BasePage, id: string): unknown {
  const key = id.trim();
  if (key === "file.name" || key === "name") return page.name;
  if (key === "file.path" || key === "path") return page.path;
  if (key === "file.folder" || key === "folder") return page.folder;
  if (key === "file.ext" || key === "ext") return page.ext;
  if (key === "file.size") return page.size;
  if (key === "file.tags") return page.tags;
  if (key.startsWith("note.")) return page.properties[key.slice(5)];
  if (key.startsWith("file.")) return undefined;
  if (key.startsWith("formula.")) return page.properties[key.slice(8)];
  return page.properties[key];
}

function literal(raw: string): unknown {
  const text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function displayName(id: string): string {
  return id.replace(/^(file|note|formula)\./, "");
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && "tag" in item) return [String((item as { tag: unknown }).tag)];
    return [];
  });
}

function linkList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return String(record.path ?? record.target ?? record.link ?? "");
    }
    return "";
  }).filter(Boolean);
}
