import { splitFrontmatter, yamlToRows } from "./frontmatter";

export type TemplateContext = {
  path: string;
  content: string;
  selection?: string;
  readFile?: (path: string) => Promise<string>;
  prompt?: (message: string, defaultValue?: string) => Promise<string | null>;
};

export type TemplateResult = {
  text: string;
  cursor: number | null;
  warnings: string[];
};

const COMMAND = /<%([_*+-]?)([\s\S]*?)([-_+]?)[%]>/g;

export async function renderTemplater(
  template: string,
  context: TemplateContext,
): Promise<TemplateResult> {
  const warnings: string[] = [];
  let cursor: number | null = null;
  let output = "";
  let last = 0;
  for (const match of template.matchAll(COMMAND)) {
    const index = match.index ?? 0;
    output += template.slice(last, index);
    const prefix = match[1];
    const expression = match[2].trim();
    if (prefix === "*") {
      warnings.push(`Script command was preserved because arbitrary Templater JavaScript is not enabled: ${expression}`);
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

async function evaluateExpression(expression: string, context: TemplateContext): Promise<string> {
  const path = context.path.replace(/\\/g, "/");
  const filename = path.split("/").pop() ?? path;
  const title = filename.replace(/\.(?:md|markdown)$/i, "");
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
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

  const frontmatter = expression.match(/^tp\.frontmatter\.([A-Za-z0-9_.-]+)$/);
  if (frontmatter) {
    const split = splitFrontmatter(context.content);
    const row = split.yaml ? yamlToRows(split.yaml).find((item) => item.key === frontmatter[1]) : null;
    return row?.value ?? "";
  }

  const date = expression.match(/^tp\.date\.(now|tomorrow|yesterday)\((.*)\)$/s);
  if (date) {
    const args = splitArguments(date[2]).map((arg) => resolveArgument(arg, { title, path, folder }));
    const format = String(args[0] ?? "YYYY-MM-DD");
    let value = new Date();
    const defaultOffset = date[1] === "tomorrow" ? 1 : date[1] === "yesterday" ? -1 : 0;
    const offset = typeof args[1] === "number" ? args[1] : defaultOffset;
    if (typeof args[2] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args[2])) {
      value = new Date(`${args[2]}T12:00:00`);
    }
    value.setDate(value.getDate() + offset);
    return formatDate(value, format);
  }

  const prompt = expression.match(/^tp\.system\.prompt\((.*)\)$/s);
  if (prompt) {
    if (!context.prompt) throw new Error("This template needs a prompt, but no prompt host is available");
    const args = splitArguments(prompt[1]).map((arg) => resolveArgument(arg, { title, path, folder }));
    return (await context.prompt(String(args[0] ?? "Value"), String(args[1] ?? ""))) ?? "";
  }

  const include = expression.match(/^tp\.file\.include\((.*)\)$/s);
  if (include) {
    if (!context.readFile) throw new Error("This template needs file inclusion, but no vault reader is available");
    const raw = String(resolveArgument(include[1].trim(), { title, path, folder }));
    const target = raw.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("#")[0];
    return context.readFile(target.endsWith(".md") ? target : `${target}.md`);
  }

  // Common harmless string transformations on tp.file.title.
  const titleTransform = expression.match(/^tp\.file\.title\.(toLowerCase|toUpperCase)\(\)$/);
  if (titleTransform) return titleTransform[1] === "toLowerCase" ? title.toLowerCase() : title.toUpperCase();

  throw new Error(`Unsupported Templater expression: ${expression}`);
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
  if ((source.startsWith('"') && source.endsWith('"')) ||
      (source.startsWith("'") && source.endsWith("'"))) {
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
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatDate(date: Date, format: string): string {
  const day = date.getDate();
  const ordinal = day % 10 === 1 && day % 100 !== 11 ? "st"
    : day % 10 === 2 && day % 100 !== 12 ? "nd"
    : day % 10 === 3 && day % 100 !== 13 ? "rd" : "th";
  const replacements: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MMMM: MONTHS[date.getMonth()],
    dddd: DAYS[date.getDay()],
    MM: String(date.getMonth() + 1).padStart(2, "0"),
    DD: String(day).padStart(2, "0"),
    Do: `${day}${ordinal}`,
    HH: String(date.getHours()).padStart(2, "0"),
    mm: String(date.getMinutes()).padStart(2, "0"),
    ss: String(date.getSeconds()).padStart(2, "0"),
  };
  return format.replace(/YYYY|MMMM|dddd|MM|DD|Do|HH|mm|ss/g, (token) => replacements[token]);
}
