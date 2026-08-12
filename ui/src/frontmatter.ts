import { formatQueryUri } from "./query-uri";

/** Split Obsidian/Jekyll-style YAML frontmatter from the Markdown body. */

export type SplitDoc = {
  /** Raw YAML between --- fences, without the fences. Null if none. */
  yaml: string | null;
  /** Markdown after closing --- */
  body: string;
  /** True if a well-formed frontmatter block was found at the start. */
  hasFrontmatter: boolean;
};

/**
 * Respect `---` … `---` at the start of the file only.
 * Does not treat horizontal rules later in the body as frontmatter.
 */
export function splitFrontmatter(source: string): SplitDoc {
  // Normalize newlines for parsing; preserve body content as-is after slice.
  if (!source.startsWith("---")) {
    // Allow UTF-8 BOM
    if (source.charCodeAt(0) === 0xfeff && source.slice(1).startsWith("---")) {
      return splitFrontmatter(source.slice(1));
    }
    return { yaml: null, body: source, hasFrontmatter: false };
  }

  // First line must be exactly --- (optional trailing CR)
  const firstNl = source.indexOf("\n");
  if (firstNl < 0) {
    return { yaml: null, body: source, hasFrontmatter: false };
  }
  const firstLine = source.slice(0, firstNl).replace(/\r$/, "");
  if (firstLine !== "---") {
    return { yaml: null, body: source, hasFrontmatter: false };
  }

  const afterOpen = firstNl + 1;
  // Find closing --- on its own line
  let i = afterOpen;
  while (i < source.length) {
    const nl = source.indexOf("\n", i);
    const lineEnd = nl < 0 ? source.length : nl;
    const line = source.slice(i, lineEnd).replace(/\r$/, "");
    if (line === "---" || line === "...") {
      const yaml = source.slice(afterOpen, i);
      // body starts after this line's newline
      const bodyStart = nl < 0 ? source.length : nl + 1;
      return {
        yaml: yaml.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
        body: source.slice(bodyStart),
        hasFrontmatter: true,
      };
    }
    if (nl < 0) break;
    i = nl + 1;
  }

  // No closer — treat whole file as body (do not invent frontmatter)
  return { yaml: null, body: source, hasFrontmatter: false };
}

export type PropertyType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "array"
  | "object"
  | "null"
  | "link";

export type PropRow = {
  key: string;
  value: string;
  type: PropertyType;
  booleanValue?: boolean;
  items?: string[];
};

/** Very small YAML line reader for property display (not a full YAML engine). */
export function yamlToRows(yaml: string): PropRow[] {
  const rows: PropRow[] = [];
  const lines = yaml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    // top-level key: value
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const sourceValue = m[2].trim();
    let val = sourceValue;
    if (val === "" || val === "|" || val === ">") {
      // collect indented block / list
      const block: string[] = [];
      i++;
      while (i < lines.length) {
        const L = lines[i];
        if (/^\s+\S/.test(L) || /^\s*-\s/.test(L)) {
          block.push(L.trim());
          i++;
        } else if (!L.trim()) {
          i++;
          break;
        } else {
          break;
        }
      }
      const isList = block.length > 0 && block.every((entry) => entry.startsWith("- "));
      const value = isList
        ? block.map((entry) => entry.slice(2).trim()).join(", ")
        : block.join(val === ">" ? " " : "\n");
      rows.push({
        key,
        value: value || "—",
        items: isList ? block.map((entry) => entry.slice(2).trim()) : undefined,
        type: isList
          ? "array"
          : val === "" && block.length > 0
            ? "object"
            : val === "" && block.length === 0
              ? "null"
              : "string",
      });
      continue;
    }
    // strip simple quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      rows.push({ key, value: val.slice(1, -1), type: "string" });
      i++;
      continue;
    }
    rows.push({ key, ...classifyYamlValue(val) });
    i++;
  }
  return rows;
}

export function renderPropertiesHtml(yaml: string): string {
  const rows = yamlToRows(yaml);
  if (rows.length === 0) {
    return `<details class="props-block props-empty">` +
      `<summary class="props-summary">Properties</summary>` +
      `<pre class="props-raw">${escape(yaml.trim())}</pre></details>`;
  }
  const cells = rows
    .map((row) => renderPropertyRow(row))
    .join("");
  return `<details class="props-block" title="YAML frontmatter">` +
    `<summary class="props-summary"><span>Properties</span>` +
    `<span class="props-count">${rows.length}</span></summary>` +
    `<div class="props-rows">${cells}</div></details>`;
}

function classifyYamlValue(value: string): Omit<PropRow, "key"> {
  const boolean = value.match(/^(?:!!bool\s+)?(true|false)(?:\s+#.*)?$/i);
  if (boolean) {
    const booleanValue = boolean[1].toLowerCase() === "true";
    return { value: String(booleanValue), type: "boolean", booleanValue };
  }
  if (/^(?:null|~)(?:\s+#.*)?$/i.test(value)) return { value: "—", type: "null" };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:\s+#.*)?$/i.test(value)) {
    return { value: value.replace(/\s+#.*$/, ""), type: "number" };
  }
  const scalar = value.replace(/\s+#.*$/, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(scalar)) return { value: scalar, type: "date" };
  if (/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/.test(scalar)) {
    return { value: scalar, type: "datetime" };
  }
  if (/^\[\[[\s\S]+\]\]$/.test(scalar)) return { value: scalar, type: "link" };
  if (/^\[[\s\S]*\]$/.test(scalar)) return { value: scalar, type: "array" };
  if (/^\{[\s\S]*\}$/.test(scalar)) return { value: scalar, type: "object" };
  return { value: scalar, type: "string" };
}

function renderPropertyRow(row: PropRow): string {
  let value: string;
  if (row.type === "boolean") {
    value = `<label class="prop-bool-label" aria-label="${escape(row.key)}">` +
      `<input class="prop-bool" type="checkbox" data-property-key="${escape(row.key)}"` +
      `${row.booleanValue ? " checked" : ""} disabled></label>`;
  } else if (row.type === "date" || row.type === "datetime") {
    value = `<time datetime="${escape(row.value)}">${escape(row.value)}</time>`;
  } else if (row.type === "number") {
    value = `<data value="${escape(row.value)}">${escape(row.value)}</data>`;
  } else if (row.items) {
    value = row.items.map((item) =>
      formatQueryUri(item, row.key) ?? escape(item),
    ).join(", ");
  } else {
    value = formatQueryUri(row.value, row.key) ?? escape(row.value).replace(/\n/g, "<br>");
  }
  return `<div class="prop-row" data-property-type="${row.type}">` +
    `<span class="prop-key">${escape(row.key)}</span>` +
    `<span class="prop-val" title="${row.type}">${value}</span></div>`;
}

/** Locate only a plain, top-level YAML boolean scalar for surgical editing. */
export function findBooleanPropertyEdit(
  source: string,
  key: string,
  value: boolean,
): { from: number; to: number; insert: string } | null {
  const property = findBooleanProperties(source).find((candidate) => candidate.key === key);
  return property
    ? { from: property.from, to: property.to, insert: value ? "true" : "false" }
    : null;
}

export type BooleanPropertyRange = {
  key: string;
  value: boolean;
  from: number;
  to: number;
};

/** Plain top-level booleans only; quoted booleans deliberately do not match. */
export function findBooleanProperties(source: string): BooleanPropertyRange[] {
  const properties: BooleanPropertyRange[] = [];
  const bomOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const firstNewline = source.indexOf("\n", bomOffset);
  if (firstNewline < 0 || source.slice(bomOffset, firstNewline).replace(/\r$/, "") !== "---") {
    return properties;
  }
  let offset = firstNewline + 1;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(offset, lineEnd).replace(/\r$/, "");
    if (line === "---" || line === "...") return properties;
    const match = line.match(/^([A-Za-z0-9_.-]+)(\s*:\s*)(true|false)(\s*(?:#.*)?)$/i);
    if (match) {
      const from = offset + match[1].length + match[2].length;
      properties.push({
        key: match[1],
        value: match[3].toLowerCase() === "true",
        from,
        to: from + match[3].length,
      });
    }
    if (newline < 0) return properties;
    offset = newline + 1;
  }
  return properties;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
