import { splitFrontmatter } from "./frontmatter";

export type SourceRange = { from: number; to: number };

export type TemplateEdit = SourceRange & { insert: string };

export type TemplateApplication = {
  changes: TemplateEdit[];
  cursor: number;
};

type YamlEntry = SourceRange & { key: string; source: string };

type FrontmatterLocation = {
  yamlFrom: number;
  yamlTo: number;
  yaml: string;
  newline: string;
};

/**
 * Build non-overlapping edits that apply a rendered template to a note.
 *
 * Template top-level YAML keys replace matching keys and append missing keys;
 * unrelated source YAML remains byte-identical. The rendered Markdown body
 * replaces the active selection (or is inserted at the caret).
 */
export function planTemplateApplication(
  source: string,
  selection: SourceRange,
  renderedTemplate: string,
  templateCursor: number | null,
): TemplateApplication {
  if (selection.from < 0 || selection.to < selection.from || selection.to > source.length) {
    throw new Error("The template target selection is outside the current note");
  }

  const template = splitFrontmatter(renderedTemplate);
  const bodyStart = renderedTemplate.length - template.body.length;
  const bodyCursor = templateCursor == null || templateCursor < bodyStart
    ? template.body.length
    : Math.min(template.body.length, templateCursor - bodyStart);
  const changes: TemplateEdit[] = [];

  if (template.hasFrontmatter && template.yaml != null && template.yaml.trim()) {
    const incoming = yamlEntries(template.yaml);
    if (incoming.length === 0) {
      throw new Error("The template frontmatter has no mergeable top-level YAML fields");
    }
    const current = locateFrontmatter(source);
    if (current) {
      if (selection.from < current.yamlTo && selection.to > current.yamlFrom) {
        throw new Error("Move the caret outside YAML frontmatter before applying a template");
      }
      const merged = mergeYaml(current.yaml, incoming, current.newline);
      if (merged !== current.yaml) {
        changes.push({ from: current.yamlFrom, to: current.yamlTo, insert: merged });
      }
    } else {
      const at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
      const newline = source.includes("\r\n") ? "\r\n" : "\n";
      const yaml = template.yaml.replace(/\r\n|\r|\n/g, newline).replace(/(?:\r?\n)+$/, "");
      changes.push({ from: at, to: at, insert: `---${newline}${yaml}${newline}---${newline}` });
    }
  }

  if (template.body) {
    changes.push({ from: selection.from, to: selection.to, insert: template.body });
  }

  changes.sort((left, right) => left.from - right.from || left.to - right.to);
  const combined = combineCoincidentInsertions(changes, selection.from, bodyCursor);
  if (combined) return combined;

  assertNonOverlapping(changes);
  const bodyChange = changes.find((change) =>
    change.from === selection.from && change.to === selection.to && change.insert === template.body
  );
  if (!bodyChange) {
    return {
      changes,
      cursor: mapPosition(selection.from, changes),
    };
  }
  const bodyStartAfterChanges = mapPositionBeforeChange(selection.from, changes, bodyChange);
  return { changes, cursor: bodyStartAfterChanges + bodyCursor };
}

function locateFrontmatter(source: string): FrontmatterLocation | null {
  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const firstEnd = source.indexOf("\n", bom);
  if (firstEnd < 0 || source.slice(bom, firstEnd).replace(/\r$/, "") !== "---") return null;
  const yamlFrom = firstEnd + 1;
  let lineStart = yamlFrom;
  while (lineStart <= source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? source.length : lineEnd;
    const line = source.slice(lineStart, end).replace(/\r$/, "");
    if (line === "---" || line === "...") {
      return {
        yamlFrom,
        yamlTo: lineStart,
        yaml: source.slice(yamlFrom, lineStart),
        newline: source.slice(firstEnd - 1, firstEnd + 1) === "\r\n" ? "\r\n" : "\n",
      };
    }
    if (lineEnd < 0) return null;
    lineStart = lineEnd + 1;
  }
  return null;
}

function yamlEntries(yaml: string): YamlEntry[] {
  const entries: YamlEntry[] = [];
  const lines = lineRanges(yaml);
  for (let index = 0; index < lines.length; index++) {
    const line = yaml.slice(lines[index].from, lines[index].contentTo);
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (!match) continue;
    let to = lines[index].to;
    for (let next = index + 1; next < lines.length; next++) {
      const nextLine = yaml.slice(lines[next].from, lines[next].contentTo);
      if (nextLine && !/^\s/.test(nextLine)) break;
      to = lines[next].to;
    }
    entries.push({ key: match[1], from: lines[index].from, to, source: yaml.slice(lines[index].from, to) });
  }
  return entries;
}

function mergeYaml(existing: string, incomingEntries: YamlEntry[], newline: string): string {
  let merged = existing;
  const replacements = new Map(incomingEntries.map((entry) => [entry.key, normalizeEntry(entry.source, newline)]));
  const existingEntries = yamlEntries(existing);
  const edits: TemplateEdit[] = [];
  for (const entry of existingEntries) {
    const replacement = replacements.get(entry.key);
    if (replacement == null) continue;
    edits.push({ from: entry.from, to: entry.to, insert: replacement });
    replacements.delete(entry.key);
  }
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index];
    merged = merged.slice(0, edit.from) + edit.insert + merged.slice(edit.to);
  }
  if (replacements.size) {
    if (merged && !merged.endsWith("\n") && !merged.endsWith("\r")) merged += newline;
    for (const entry of replacements.values()) merged += entry;
  }
  return merged;
}

function normalizeEntry(source: string, newline: string): string {
  const normalized = source.replace(/\r\n|\r|\n/g, newline);
  return normalized.endsWith(newline) ? normalized : `${normalized}${newline}`;
}

function lineRanges(source: string): Array<SourceRange & { contentTo: number }> {
  const lines: Array<SourceRange & { contentTo: number }> = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf("\n", from);
    const to = newline < 0 ? source.length : newline + 1;
    const contentTo = (newline < 0 ? source.length : newline) -
      (source.charAt((newline < 0 ? source.length : newline) - 1) === "\r" ? 1 : 0);
    lines.push({ from, to, contentTo });
    from = to;
  }
  return lines;
}

function combineCoincidentInsertions(
  changes: TemplateEdit[],
  caret: number,
  bodyCursor: number,
): TemplateApplication | null {
  const coincident = changes.filter((change) => change.from === caret && change.to === caret);
  if (coincident.length !== 2) return null;
  const yaml = coincident.find((change) => change.insert.startsWith("---"));
  const body = coincident.find((change) => change !== yaml);
  if (!yaml || !body) return null;
  const replacement = yaml.insert + body.insert;
  return {
    changes: [{ from: caret, to: caret, insert: replacement }],
    cursor: caret + yaml.insert.length + bodyCursor,
  };
}

function assertNonOverlapping(changes: TemplateEdit[]) {
  for (let index = 1; index < changes.length; index++) {
    if (changes[index].from < changes[index - 1].to) {
      throw new Error("Template YAML and body insertion ranges overlap");
    }
  }
}

function mapPosition(position: number, changes: TemplateEdit[]): number {
  return changes.reduce((mapped, change) =>
    change.to <= position ? mapped + change.insert.length - (change.to - change.from) : mapped,
  position);
}

function mapPositionBeforeChange(position: number, changes: TemplateEdit[], target: TemplateEdit): number {
  let mapped = position;
  for (const change of changes) {
    if (change === target) break;
    if (change.to <= position) mapped += change.insert.length - (change.to - change.from);
  }
  return mapped;
}
