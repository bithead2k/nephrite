import { parseSimpleYaml } from "./structured-view";
import { splitFrontmatter } from "./frontmatter";

export function serializeSimpleYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value == null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    return /[:#\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) return `${pad}- {}`;
        const [firstKey, firstValue] = entries[0];
        const first = `${pad}- ${firstKey}: ${inlineOrBlock(firstValue, indent + 2)}`;
        const rest = entries.slice(1).map(([key, child]) =>
          `${"  ".repeat(indent + 1)}${key}: ${inlineOrBlock(child, indent + 2)}`,
        );
        return [first, ...rest].join("\n");
      }
      return `${pad}- ${inlineOrBlock(item, indent + 1)}`;
    }).join("\n");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  return entries.map(([key, child]) => {
    if (child && typeof child === "object") {
      const nested = serializeSimpleYaml(child, indent + 1);
      if (nested === "[]" || nested === "{}") return `${pad}${key}: ${nested}`;
      return `${pad}${key}:\n${nested}`;
    }
    return `${pad}${key}: ${serializeSimpleYaml(child)}`;
  }).join("\n");
}

export function applyYamlFrontmatter(source: string, value: unknown): string {
  const { hasFrontmatter, body } = splitFrontmatter(source);
  const yaml = `${serializeSimpleYaml(value).trim()}\n`;
  if (!hasFrontmatter && !yaml.trim()) return source;
  return `---\n${yaml}---\n${hasFrontmatter ? body : source}`;
}

export function parseFrontmatterTree(source: string): unknown {
  const { yaml, hasFrontmatter } = splitFrontmatter(source);
  if (!hasFrontmatter || !yaml?.trim()) return {};
  return parseSimpleYaml(yaml) ?? {};
}

function inlineOrBlock(value: unknown, indent: number): string {
  if (value && typeof value === "object") {
    const nested = serializeSimpleYaml(value, indent);
    if (nested === "[]" || nested === "{}") return nested;
    return `\n${nested}`;
  }
  return serializeSimpleYaml(value);
}
