import { splitFrontmatter, yamlToRows } from "./frontmatter";

export type TemplateContext = {
  path: string;
  content: string;
  selection?: string;
  /** Clock used by {{date}}, {{time}}, and their formatted variants. */
  now?: Date;
  /** Host-provided values for core or vault-specific {{insertion}} tags. */
  insertions?: Record<string, unknown>;
  /** Optional lazy provider for insertion values not present in `insertions`. */
  resolveInsertion?: (name: string) => Promise<unknown> | unknown;
  /** Optional ISO or local mtime string for tp.file.last_modified_date */
  mtime?: string | null;
  readFile?: (path: string) => Promise<string>;
  prompt?: (message: string, defaultValue?: string) => Promise<string | null>;
};

export type TemplateResult = {
  text: string;
  cursor: number | null;
  warnings: string[];
};

const COMMAND = /<%([_*+-]?)([\s\S]*?)([-_+]?)[%]>/g;
const INSERTION = /\{\{\s*([^{}]+?)\s*\}\}/g;

export async function renderTemplater(
  template: string,
  context: TemplateContext,
): Promise<TemplateResult> {
  const warnings: string[] = [];
  let cursor: number | null = null;
  template = await renderInsertionTags(template, context, warnings);
  let output = "";
  let last = 0;
  for (const match of template.matchAll(COMMAND)) {
    const index = match.index ?? 0;
    output += template.slice(last, index);
    const prefix = match[1];
    const expression = match[2].trim();
    if (prefix === "*") {
      warnings.push(
        `Script command was preserved because arbitrary Templater JavaScript is not enabled: ${expression}`,
      );
      output += match[0];
    } else if (/^tp\.file\.cursor(?:\(.*\))?$/.test(expression)) {
      cursor ??= output.length;
    } else {
      try {
        output += await evaluateExpression(expression, context);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
        output += match[0];
      }
    }
    last = index + match[0].length;
  }
  output += template.slice(last);
  return { text: output, cursor, warnings };
}

async function renderInsertionTags(
  template: string,
  context: TemplateContext,
  warnings: string[],
): Promise<string> {
  let output = "";
  let last = 0;
  const warned = new Set<string>();
  for (const match of template.matchAll(INSERTION)) {
    const index = match.index ?? 0;
    output += template.slice(last, index);
    const name = match[1].trim();
    const value = await insertionValue(name, context);
    if (value.found) {
      output += value.value == null ? "" : String(value.value);
    } else {
      output += match[0];
      if (!warned.has(name)) {
        warnings.push(`Unknown template insertion: ${name}`);
        warned.add(name);
      }
    }
    last = index + match[0].length;
  }
  output += template.slice(last);
  return output;
}

async function insertionValue(
  name: string,
  context: TemplateContext,
): Promise<{ found: boolean; value?: unknown }> {
  if (context.insertions && Object.prototype.hasOwnProperty.call(context.insertions, name)) {
    return { found: true, value: context.insertions[name] };
  }

  const now = context.now ?? new Date();
  if (name === "date") return { found: true, value: formatDate(now, "YYYY-MM-DD") };
  if (name === "time") return { found: true, value: formatDate(now, "HH:mm") };
  if (name.startsWith("date:")) return { found: true, value: formatDate(now, name.slice(5)) };
  if (name.startsWith("time:")) return { found: true, value: formatDate(now, name.slice(5)) };

  const path = context.path.replace(/\\/g, "/");
  const filename = path.split("/").pop() ?? path;
  if (name === "title") {
    return { found: true, value: filename.replace(/\.(?:md|markdown)$/i, "") };
  }
  if (name === "path") return { found: true, value: path };
  if (name === "folder") {
    return { found: true, value: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
  }
  if (name === "selection") return { found: true, value: context.selection ?? "" };

  if (context.resolveInsertion) {
    const value = await context.resolveInsertion(name);
    if (value !== undefined) return { found: true, value };
  }
  return { found: false };
}

async function evaluateExpression(expression: string, context: TemplateContext): Promise<string> {
  const path = context.path.replace(/\\/g, "/");
  const filename = path.split("/").pop() ?? path;
  const title = filename.replace(/\.(?:md|markdown)$/i, "");
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const file = { title, path, folder };

  const direct: Record<string, string> = {
    "tp.file.title": title,
    "tp.file.content": context.content,
    "tp.file.selection()": context.selection ?? "",
    "tp.file.path(true)": path,
    "tp.file.path()": path,
    "tp.file.folder(true)": folder,
    "tp.file.folder()": folder.split("/").pop() ?? "",
  };
  if (expression in direct) return direct[expression];

  // Nested or flat frontmatter: tp.frontmatter.key or tp.frontmatter.a.b
  const frontmatter = expression.match(/^tp\.frontmatter\.([A-Za-z0-9_.-]+)$/);
  if (frontmatter) {
    const split = splitFrontmatter(context.content);
    if (!split.yaml) return "";
    // Prefer exact top-level key match first (existing behaviour).
    const rows = yamlToRows(split.yaml);
    const exact = rows.find((item) => item.key === frontmatter[1]);
    if (exact) return exact.value ?? "";
    // Fall back to dotted path through a shallow JSON parse of the YAML object.
    try {
      // Minimal: only handle simple key.subkey when the value is an object-looking line.
      // Full nested YAML is already preserved; this is a best-effort read.
      const pathParts = frontmatter[1].split(".");
      if (pathParts.length > 1) {
        const root = rows.find((item) => item.key === pathParts[0]);
        if (root?.value) {
          // If the stored value looks like JSON, walk it.
          const parsed = JSON.parse(root.value);
          let cur: unknown = parsed;
          for (const part of pathParts.slice(1)) {
            if (cur && typeof cur === "object" && part in (cur as object)) {
              cur = (cur as Record<string, unknown>)[part];
            } else {
              return "";
            }
          }
          return cur == null ? "" : String(cur);
        }
      }
    } catch {
      /* ignore non-JSON nested values */
    }
    return "";
  }

  // tp.date.now / tomorrow / yesterday  — with or without parentheses
  const dateBare = expression.match(/^tp\.date\.(now|tomorrow|yesterday)$/);
  if (dateBare) {
    return formatRelativeDate(dateBare[1], "YYYY-MM-DD");
  }
  const date = expression.match(/^tp\.date\.(now|tomorrow|yesterday)\((.*)\)$/s);
  if (date) {
    const args = splitArguments(date[2]).map((arg) => resolveArgument(arg, file));
    const format = String(args[0] ?? "YYYY-MM-DD");
    const defaultOffset = date[1] === "tomorrow" ? 1 : date[1] === "yesterday" ? -1 : 0;
    const offset = typeof args[1] === "number" ? args[1] : defaultOffset;
    let value = new Date();
    if (typeof args[2] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args[2])) {
      value = new Date(`${args[2]}T12:00:00`);
    }
    value.setDate(value.getDate() + offset);
    return formatDate(value, format);
  }

  // tp.file.last_modified_date(format?) when mtime is supplied by the host
  const lastMod = expression.match(/^tp\.file\.last_modified_date(?:\((.*)\))?$/s);
  if (lastMod) {
    if (!context.mtime) return "";
    const args = lastMod[1] != null
      ? splitArguments(lastMod[1]).map((arg) => resolveArgument(arg, file))
      : [];
    const format = String(args[0] ?? "YYYY-MM-DD");
    const value = new Date(context.mtime);
    if (Number.isNaN(value.getTime())) return "";
    return formatDate(value, format);
  }

  const prompt = expression.match(/^tp\.system\.prompt\((.*)\)$/s);
  if (prompt) {
    if (!context.prompt) throw new Error("This template needs a prompt, but no prompt host is available");
    const args = splitArguments(prompt[1]).map((arg) => resolveArgument(arg, file));
    return (await context.prompt(String(args[0] ?? "Value"), String(args[1] ?? ""))) ?? "";
  }

  const include = expression.match(/^tp\.file\.include\((.*)\)$/s);
  if (include) {
    if (!context.readFile) throw new Error("This template needs file inclusion, but no vault reader is available");
    const raw = String(resolveArgument(include[1].trim(), file));
    const target = raw.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("#")[0];
    return context.readFile(target.endsWith(".md") ? target : `${target}.md`);
  }

  // Common harmless string transformations on tp.file.title.
  const titleTransform = expression.match(/^tp\.file\.title\.(toLowerCase|toUpperCase)\(\)$/);
  if (titleTransform) {
    return titleTransform[1] === "toLowerCase" ? title.toLowerCase() : title.toUpperCase();
  }

  throw new Error(`Unsupported Templater expression: ${expression}`);
}

function formatRelativeDate(kind: string, format: string): string {
  const value = new Date();
  const offset = kind === "tomorrow" ? 1 : kind === "yesterday" ? -1 : 0;
  value.setDate(value.getDate() + offset);
  return formatDate(value, format);
}

function splitArguments(source: string): string[] {
  const args: string[] = [];
  let quote = "";
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ",") {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail || source.trim()) args.push(tail);
  return args;
}

function resolveArgument(
  source: string,
  file: { title: string; path: string; folder: string },
): string | number | boolean {
  if (
    (source.startsWith('"') && source.endsWith('"')) ||
    (source.startsWith("'") && source.endsWith("'"))
  ) {
    return source.slice(1, -1).replace(/\\([\\"'])/g, "$1");
  }
  if (/^-?\d+$/.test(source)) return Number(source);
  if (source === "true" || source === "false") return source === "true";
  if (source === "tp.file.title") return file.title;
  if (source === "tp.file.path(true)") return file.path;
  if (source === "tp.file.folder(true)") return file.folder;
  return source;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDate(date: Date, format: string): string {
  const day = date.getDate();
  const month = date.getMonth();
  const year = date.getFullYear();
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 || 12;
  const ordinal =
    day % 10 === 1 && day % 100 !== 11
      ? "st"
      : day % 10 === 2 && day % 100 !== 12
        ? "nd"
        : day % 10 === 3 && day % 100 !== 13
          ? "rd"
          : "th";
  const replacements: Record<string, string> = {
    YYYY: String(year),
    YY: String(year).slice(-2),
    MMMM: MONTHS[month],
    MMM: MONTHS_SHORT[month],
    MM: String(month + 1).padStart(2, "0"),
    M: String(month + 1),
    dddd: DAYS[date.getDay()],
    ddd: DAYS_SHORT[date.getDay()],
    DD: String(day).padStart(2, "0"),
    D: String(day),
    Do: `${day}${ordinal}`,
    HH: String(hours24).padStart(2, "0"),
    H: String(hours24),
    hh: String(hours12).padStart(2, "0"),
    h: String(hours12),
    mm: String(date.getMinutes()).padStart(2, "0"),
    ss: String(date.getSeconds()).padStart(2, "0"),
    A: hours24 < 12 ? "AM" : "PM",
    a: hours24 < 12 ? "am" : "pm",
  };
  // Longer tokens first so YYYY wins over YY, MMMM over MM, etc.
  return format.replace(
    /YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|Do|HH|H|hh|h|mm|ss|A|a/g,
    (token) => replacements[token],
  );
}
