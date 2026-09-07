export type EditorChange = { from: number; to: number; insert: string };

export type FootnoteInsertion = { id: number; changes: EditorChange[]; cursor: number };

export type FootnoteDefinition = {
  label: string;
  number: number;
  markdown: string;
  referenceIds: string[];
};

export type FootnoteWarning = {
  kind: "missing" | "duplicate" | "unused";
  label: string;
  message: string;
};

export type FootnoteRenderPlan = {
  markdown: string;
  definitions: FootnoteDefinition[];
  warnings: FootnoteWarning[];
};

export type FootnoteSourceDefinition = {
  kind: "definition";
  label: string;
  from: number;
  to: number;
  markdown: string;
};

export type FootnoteSourceReference = {
  kind: "reference" | "inline";
  label: string;
  from: number;
  to: number;
  markdown?: string;
};

export type FootnoteDocument = {
  definitions: FootnoteSourceDefinition[];
  references: FootnoteSourceReference[];
  warnings: FootnoteWarning[];
};

export type FootnoteEditTarget = {
  kind: "new" | "inline" | "reference" | "definition";
  label?: string;
  markdown: string;
  from: number;
  to: number;
  anchor: number;
  missing?: boolean;
};

export type FootnoteEditPlan = {
  changes: EditorChange[];
  cursor: number;
  description: string;
};

export function nextFootnoteId(markdown: string): number {
  let highest = 0;
  for (const match of markdown.matchAll(/\[\^(\d+)\]/g)) highest = Math.max(highest, Number(match[1]));
  return highest + 1;
}

/** Reference-style insertion plan retained for plugin/API compatibility. */
export function planFootnoteInsertion(markdown: string, cursor: number): FootnoteInsertion {
  const position = clamp(cursor, 0, markdown.length);
  const id = nextFootnoteId(markdown);
  const reference = `[^${id}]`;
  const bodyAfterReference = markdown.slice(0, position) + reference + markdown.slice(position);
  const spacing = bodyAfterReference.endsWith("\n\n") ? "" : bodyAfterReference.endsWith("\n") ? "\n" : "\n\n";
  const definition = `${spacing}[^${id}]: `;
  if (position === markdown.length) {
    const insert = reference + definition;
    return { id, changes: [{ from: position, to: position, insert }], cursor: position + insert.length };
  }
  return {
    id,
    changes: [
      { from: position, to: position, insert: reference },
      { from: markdown.length, to: markdown.length, insert: definition },
    ],
    cursor: bodyAfterReference.length + definition.length,
  };
}

export function hasFootnoteSyntax(markdown: string): boolean {
  return /(^|[^\\])(?:\[\^[^\]\r\n]+\]|\^\[)/m.test(markdown);
}

export function scanFootnotes(markdown: string): FootnoteDocument {
  const definitions: FootnoteSourceDefinition[] = [];
  const protectedRanges: Array<{ from: number; to: number }> = [];
  const lines = sourceLines(markdown);
  let fence: { marker: string; length: number; from: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const boundary = fenceBoundary(line.text);
    if (boundary) {
      if (!fence) fence = { ...boundary, from: line.from };
      else if (boundary.marker === fence.marker && boundary.length >= fence.length) {
        protectedRanges.push({ from: fence.from, to: line.to });
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const match = line.text.match(/^( {0,3})\[\^([^\]\r\n]+)\]:[ \t]*(.*)$/);
    if (!match) {
      addInlineCodeRanges(line.text, line.from, protectedRanges);
      continue;
    }
    const label = match[2].trim();
    const body = [match[3]];
    let to = line.to;
    let next = index + 1;
    while (next < lines.length) {
      const continuation = lines[next].text.match(/^(?: {2,}|\t)(.*)$/);
      if (continuation) {
        body.push(continuation[1]);
        to = lines[next].to;
        next += 1;
        continue;
      }
      if (lines[next].text.trim() === "" && /^(?: {2,}|\t)/.test(lines[next + 1]?.text ?? "")) {
        body.push("");
        to = lines[next].to;
        next += 1;
        continue;
      }
      break;
    }
    definitions.push({ kind: "definition", label, from: line.from, to, markdown: body.join("\n") });
    protectedRanges.push({ from: line.from, to });
    index = next - 1;
  }
  if (fence) protectedRanges.push({ from: fence.from, to: markdown.length });
  protectedRanges.sort((left, right) => left.from - right.from);

  const references: FootnoteSourceReference[] = [];
  let position = 0;
  let inlineNumber = 0;
  let protectedIndex = 0;
  while (position < markdown.length) {
    while (protectedIndex < protectedRanges.length && position >= protectedRanges[protectedIndex].to) protectedIndex += 1;
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && position >= protectedRange.from) {
      position = protectedRange.to;
      continue;
    }
    if (markdown[position] === "\\") { position += 2; continue; }
    if (markdown.startsWith("^[", position)) {
      const close = balancedBracketEnd(markdown, position + 1);
      if (close >= 0) {
        inlineNumber += 1;
        references.push({
          kind: "inline",
          label: `inline-${inlineNumber}`,
          from: position,
          to: close + 1,
          markdown: markdown.slice(position + 2, close),
        });
        position = close + 1;
        continue;
      }
    }
    if (markdown.startsWith("[^", position)) {
      const close = markdown.indexOf("]", position + 2);
      if (close >= 0 && !markdown.slice(position + 2, close).includes("\n")) {
        references.push({ kind: "reference", label: markdown.slice(position + 2, close).trim(), from: position, to: close + 1 });
        position = close + 1;
        continue;
      }
    }
    position += 1;
  }

  const warnings: FootnoteWarning[] = [];
  const definitionCounts = countBy(definitions.map((definition) => definition.label));
  const referenceLabels = new Set(references.filter((reference) => reference.kind === "reference").map((reference) => reference.label));
  for (const [label, count] of definitionCounts) {
    if (count > 1) warnings.push({ kind: "duplicate", label, message: `Footnote “${label}” has ${count} definitions.` });
    if (!referenceLabels.has(label)) warnings.push({ kind: "unused", label, message: `Footnote “${label}” is defined but never referenced.` });
  }
  for (const label of referenceLabels) {
    if (!definitionCounts.has(label)) warnings.push({ kind: "missing", label, message: `Footnote “${label}” has no definition.` });
  }
  return { definitions, references, warnings };
}

export function footnoteEditTarget(markdown: string, cursor: number): FootnoteEditTarget {
  const doc = scanFootnotes(markdown);
  const position = clamp(cursor, 0, markdown.length);
  const reference = doc.references.find((item) => position >= item.from && position <= item.to);
  if (reference?.kind === "inline") {
    return { kind: "inline", label: reference.label, markdown: reference.markdown ?? "", from: reference.from, to: reference.to, anchor: reference.from };
  }
  if (reference) {
    const definition = doc.definitions.find((item) => item.label === reference.label);
    return {
      kind: "reference", label: reference.label, markdown: definition?.markdown ?? "",
      from: reference.from, to: reference.to, anchor: reference.from, missing: !definition,
    };
  }
  const definition = doc.definitions.find((item) => position >= item.from && position <= item.to);
  if (definition) {
    return { kind: "definition", label: definition.label, markdown: definition.markdown, from: definition.from, to: definition.to, anchor: definition.from };
  }
  return { kind: "new", markdown: "", from: position, to: position, anchor: position };
}

export function planFootnoteEdit(
  markdown: string,
  target: FootnoteEditTarget,
  content: string,
  style: "inline" | "reference" = "inline",
): FootnoteEditPlan {
  const value = content.trim();
  if (target.kind === "inline") {
    const insert = `^[${value}]`;
    return { changes: [{ from: target.from, to: target.to, insert }], cursor: target.from + insert.length, description: "Updated inline footnote" };
  }
  if (target.kind === "definition") {
    const insert = formatDefinition(target.label ?? "1", value);
    return { changes: [{ from: target.from, to: target.to, insert }], cursor: target.from + insert.length, description: `Updated footnote [^${target.label}]` };
  }
  if (target.kind === "reference") {
    const definition = scanFootnotes(markdown).definitions.find((item) => item.label === target.label);
    if (definition) {
      const insert = formatDefinition(definition.label, value);
      return { changes: [{ from: definition.from, to: definition.to, insert }], cursor: target.to, description: `Updated footnote [^${definition.label}]` };
    }
    const suffix = endSpacing(markdown);
    return {
      changes: [{ from: markdown.length, to: markdown.length, insert: `${suffix}${formatDefinition(target.label ?? "1", value)}` }],
      cursor: target.to,
      description: `Defined footnote [^${target.label}]`,
    };
  }
  if (style === "inline") {
    const insert = `^[${value}]`;
    return { changes: [{ from: target.from, to: target.to, insert }], cursor: target.from + insert.length, description: "Inserted inline footnote" };
  }
  const id = nextFootnoteId(markdown);
  const marker = `[^${id}]`;
  return {
    changes: [
      { from: target.from, to: target.to, insert: marker },
      { from: markdown.length, to: markdown.length, insert: `${endSpacing(markdown)}${formatDefinition(String(id), value)}` },
    ],
    cursor: target.from + marker.length,
    description: `Inserted footnote [^${id}]`,
  };
}

export function footnoteNavigationTarget(
  markdown: string,
  cursor: number,
  action: "next" | "previous" | "definition" | "marker",
): number | null {
  const doc = scanFootnotes(markdown);
  if (!doc.references.length) return null;
  if (action === "next") return doc.references.find((reference) => reference.from > cursor)?.from ?? doc.references[0].from;
  if (action === "previous") return [...doc.references].reverse().find((reference) => reference.from < cursor)?.from ?? doc.references.at(-1)!.from;
  const currentReference = doc.references.find((reference) => cursor >= reference.from && cursor <= reference.to)
    ?? [...doc.references].reverse().find((reference) => reference.from <= cursor)
    ?? doc.references[0];
  if (action === "definition") {
    if (currentReference.kind === "inline") return currentReference.from + 2;
    return doc.definitions.find((definition) => definition.label === currentReference.label)?.from ?? null;
  }
  const currentDefinition = doc.definitions.find((definition) => cursor >= definition.from && cursor <= definition.to);
  if (currentDefinition) return doc.references.find((reference) => reference.label === currentDefinition.label)?.from ?? null;
  return currentReference.from;
}

export function prepareFootnoteRender(markdown: string): FootnoteRenderPlan {
  const doc = scanFootnotes(markdown);
  const firstDefinitions = new Map<string, FootnoteSourceDefinition>();
  for (const definition of doc.definitions) if (!firstDefinitions.has(definition.label)) firstDefinitions.set(definition.label, definition);
  const renderedDefinitions = new Map<string, FootnoteDefinition>();
  const replacements: EditorChange[] = doc.definitions.map((definition) => ({ from: definition.from, to: definition.to, insert: "" }));
  let nextNumber = 1;
  for (const reference of doc.references) {
    const key = reference.kind === "inline" ? reference.label : `reference-${reference.label}`;
    let definition = renderedDefinitions.get(key);
    if (!definition) {
      definition = {
        label: reference.label,
        number: nextNumber++,
        markdown: reference.kind === "inline"
          ? reference.markdown ?? ""
          : firstDefinitions.get(reference.label)?.markdown ?? `Missing definition for [^${reference.label}]`,
        referenceIds: [],
      };
      renderedDefinitions.set(key, definition);
    }
    const occurrence = definition.referenceIds.length + 1;
    const referenceId = `fnref-${definition.number}${occurrence === 1 ? "" : `-${occurrence}`}`;
    definition.referenceIds.push(referenceId);
    const missing = reference.kind === "reference" && !firstDefinitions.has(reference.label);
    replacements.push({
      from: reference.from,
      to: reference.to,
      insert: `<sup class="footnote-ref${missing ? " footnote-missing" : ""}" id="${referenceId}" tabindex="-1">` +
        `<a href="#fn-${definition.number}" data-footnote-target="fn-${definition.number}" ` +
        `aria-label="Footnote ${definition.number}${missing ? ", missing definition" : ""}">${definition.number}</a></sup>`,
    });
  }
  replacements.sort((left, right) => right.from - left.from || right.to - left.to);
  let transformed = markdown;
  for (const replacement of replacements) transformed = transformed.slice(0, replacement.from) + replacement.insert + transformed.slice(replacement.to);
  return { markdown: transformed, definitions: [...renderedDefinitions.values()], warnings: doc.warnings };
}

function sourceLines(markdown: string): Array<{ text: string; from: number; to: number }> {
  const result: Array<{ text: string; from: number; to: number }> = [];
  let from = 0;
  for (const text of markdown.split("\n")) {
    const end = from + text.length;
    result.push({ text, from, to: Math.min(markdown.length, end + 1) });
    from = end + 1;
  }
  return result;
}

function addInlineCodeRanges(text: string, offset: number, ranges: Array<{ from: number; to: number }>): void {
  let position = 0;
  while (position < text.length) {
    if (text[position] !== "`") { position += 1; continue; }
    let end = position + 1;
    while (text[end] === "`") end += 1;
    const delimiter = text.slice(position, end);
    const close = text.indexOf(delimiter, end);
    if (close < 0) return;
    ranges.push({ from: offset + position, to: offset + close + delimiter.length });
    position = close + delimiter.length;
  }
}

function balancedBracketEnd(markdown: string, open: number): number {
  let depth = 0;
  for (let position = open; position < markdown.length; position++) {
    if (markdown[position] === "\\") { position += 1; continue; }
    if (markdown[position] === "[") depth += 1;
    else if (markdown[position] === "]") {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  return -1;
}

function formatDefinition(label: string, markdown: string): string {
  const lines = markdown.split("\n");
  return `[^${label}]: ${lines[0] ?? ""}${lines.slice(1).map((line) => `\n  ${line}`).join("")}`;
}

function endSpacing(markdown: string): string {
  return markdown.endsWith("\n\n") ? "" : markdown.endsWith("\n") ? "\n" : "\n\n";
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function fenceBoundary(line: string): { marker: string; length: number } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  return match ? { marker: match[1][0], length: match[1].length } : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
