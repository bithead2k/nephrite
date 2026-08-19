/** Extract an ATX heading section into a new vault note. */

export type HeadingSection = {
  heading: string;
  level: number;
  start: number;
  end: number;
  headingEnd: number;
  text: string;
};

export type NewFileSettings = {
  newFileLocation?: "root" | "current" | "folder" | string;
  newFileFolderPath?: string;
};

export type HeadingExtractPlan = {
  path: string;
  content: string;
  from: number;
  to: number;
  insert: string;
};

const ATX = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

export function normalizeExtractHeading(value: string): string {
  return value.replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** All ATX sections in source order. End is the start of the next peer/ancestor heading, or EOF. */
export function findHeadingSections(markdown: string): HeadingSection[] {
  const lines = markdown.split(/(?<=\n)/);
  type Mark = { heading: string; level: number; start: number; headingEnd: number };
  const marks: Mark[] = [];
  let offset = 0;
  let inFence: "`" | "~" | null = null;

  for (const line of lines) {
    const plain = line.replace(/\r?\n$/, "");
    const fence = plain.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (inFence === marker) inFence = null;
      else if (!inFence) inFence = marker;
      offset += line.length;
      continue;
    }
    if (!inFence) {
      const match = plain.match(ATX);
      if (match) {
        marks.push({
          heading: match[2].trim(),
          level: match[1].length,
          start: offset,
          headingEnd: offset + line.length,
        });
      }
    }
    offset += line.length;
  }

  return marks.map((mark, index) => {
    const next = marks.slice(index + 1).find((other) => other.level <= mark.level);
    const end = next ? next.start : markdown.length;
    return {
      heading: mark.heading,
      level: mark.level,
      start: mark.start,
      end,
      headingEnd: mark.headingEnd,
      text: markdown.slice(mark.start, end).trimEnd(),
    };
  });
}

/** Only when `offset` sits on the heading line itself, not the body under it. */
export function headingSectionAt(markdown: string, offset: number): HeadingSection | null {
  const pos = Math.max(0, Math.min(offset, markdown.length));
  return findHeadingSections(markdown).find((section) => (
    pos >= section.start && pos < section.headingEnd
  )) ?? null;
}

export function headingSectionByOccurrence(
  markdown: string,
  heading: string,
  occurrence: number,
): HeadingSection | null {
  const wanted = normalizeExtractHeading(heading);
  if (!wanted || occurrence < 0) return null;
  const matches = findHeadingSections(markdown).filter((section) => (
    normalizeExtractHeading(section.heading) === wanted
  ));
  return matches[occurrence] ?? null;
}

export function sanitizeNoteFileName(heading: string): string {
  const cleaned = heading
    .replace(/[/\\:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Untitled";
}

export function newNoteDirectory(settings: NewFileSettings, currentPath: string): string {
  const location = settings.newFileLocation ?? "current";
  if (location === "root") return "";
  if (location === "folder") {
    return (settings.newFileFolderPath ?? "").replace(/^\/+|\/+$/g, "");
  }
  const slash = currentPath.lastIndexOf("/");
  return slash >= 0 ? currentPath.slice(0, slash) : "";
}

/** Vault-relative creation path for an unresolved Obsidian wikilink. */
export function newWikilinkPath(
  note: string,
  currentPath: string,
  settings: NewFileSettings,
): string {
  let key = note.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!key) key = "Untitled";
  if (!/\.md$/i.test(key)) key = `${key}.md`;
  // An explicit wikilink path overrides the configured default note folder.
  if (key.includes("/")) return key;
  const folder = newNoteDirectory(settings, currentPath);
  return folder ? `${folder}/${key}` : key;
}

export function uniqueNotePath(
  folder: string,
  stem: string,
  existing: Iterable<string>,
): string {
  const known = new Set(existing);
  const join = (name: string) => (folder ? `${folder}/${name}` : name);
  const first = join(`${stem}.md`);
  if (!known.has(first)) return first;
  let n = 2;
  while (known.has(join(`${stem} ${n}.md`))) n += 1;
  return join(`${stem} ${n}.md`);
}

export function planHeadingExtract(input: {
  markdown: string;
  section: HeadingSection;
  currentPath: string;
  settings: NewFileSettings;
  existingPaths: Iterable<string>;
  linkFor: (path: string) => string;
}): HeadingExtractPlan | { error: string } {
  const stem = sanitizeNoteFileName(input.section.heading);
  const folder = newNoteDirectory(input.settings, input.currentPath);
  const path = uniqueNotePath(folder, stem, input.existingPaths);
  if (path === input.currentPath) {
    return { error: "Cannot extract a heading into the note that already holds it" };
  }
  const content = `${input.section.text}\n`;
  const follows = input.section.end < input.markdown.length;
  return {
    path,
    content,
    from: input.section.start,
    to: input.section.end,
    insert: follows ? `[[${input.linkFor(path)}]]\n\n` : `[[${input.linkFor(path)}]]\n`,
  };
}
