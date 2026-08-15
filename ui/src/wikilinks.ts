import {
  Decoration,
  DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/** Highlight `[[wikilinks]]` and `![[embeds]]` without hiding source text. */
export function wikilinkPlugin() {
  const decorator = new MatchDecorator({
    regexp: /!?\[\[([^\]]+)\]\]/g,
    decoration: (match) => {
      const isEmbed = match[0].startsWith("!");
      return Decoration.mark({
        class: isEmbed ? "cm-wikilink cm-wikilink-embed" : "cm-wikilink",
        attributes: { title: match[1] },
      });
    },
  });

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(update: ViewUpdate) {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Vault-relative path without a note extension — Obsidian's wikilink key. */
export function wikilinkKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\.(?:md|markdown)$/i, "");
}

/**
 * Shortest unique wikilink, like Obsidian's "shortest path when possible".
 * Unique filename → `Note`. Collision → shortest unique suffix (`folder/Note`).
 * Existing short links are not rewritten when a namesake appears later.
 */
export function shortestWikilinkTarget(
  path: string,
  files: readonly { path: string }[],
): string {
  return shortestWikilinkTargets(files).get(wikilinkKey(path)) ?? wikilinkKey(path);
}

function walkSuffixes(key: string, visit: (suffix: string) => void): void {
  visit(key);
  for (let index = key.length - 1; index >= 0; index--) {
    if (key.charCodeAt(index) === 47) visit(key.slice(index + 1));
  }
}

/** O(n) unique-suffix map. Do not call the single-file helper in a loop. */
export function shortestWikilinkTargets(
  files: readonly { path: string }[],
): Map<string, string> {
  const keys = files.map((file) => wikilinkKey(file.path));
  const suffixCount = new Map<string, number>();
  for (const key of keys) {
    walkSuffixes(key, (suffix) => {
      suffixCount.set(suffix, (suffixCount.get(suffix) ?? 0) + 1);
    });
  }
  const out = new Map<string, string>();
  for (const key of keys) {
    let chosen = key;
    walkSuffixes(key, (suffix) => {
      if ((suffixCount.get(suffix) ?? 0) <= 1 && suffix.length <= chosen.length) {
        chosen = suffix;
      }
    });
    out.set(key, chosen);
  }
  return out;
}

/** Extract note path and optional heading from a wikilink target. */
export function splitWikilinkTarget(target: string): {
  note: string;
  heading: string | null;
  block: string | null;
} {
  const pipe = target.lastIndexOf("|");
  const core = pipe >= 0 ? target.slice(0, pipe) : target;
  const hash = core.indexOf("#");
  if (hash < 0) {
    return { note: core.trim(), heading: null, block: null };
  }
  const note = core.slice(0, hash).trim();
  const frag = core.slice(hash + 1);
  if (frag.startsWith("^")) {
    return { note, heading: null, block: frag.slice(1) };
  }
  // note#heading#^block — split heading (may itself contain #) from a trailing ^block.
  const blockHash = frag.lastIndexOf("#^");
  if (blockHash >= 0) {
    return {
      note,
      heading: frag.slice(0, blockHash),
      block: frag.slice(blockHash + 2),
    };
  }
  return { note, heading: frag, block: null };
}

/** Find wikilink under cursor (if any). */
export function wikilinkAt(doc: string, pos: number): string | null {
  // search outward for [[ ... ]]
  const start = doc.lastIndexOf("[[", pos);
  if (start < 0) return null;
  const bang = start > 0 && doc[start - 1] === "!";
  const end = doc.indexOf("]]", pos);
  if (end < 0 || end < start) return null;
  // cursor must be inside
  const open = bang ? start - 1 : start;
  if (pos < open || pos > end + 2) return null;
  const inner = doc.slice(start + 2, end);
  const pipe = inner.indexOf("|");
  return (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
}
