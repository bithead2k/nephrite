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

/** Extract note path and optional heading from a wikilink target. */
export function splitWikilinkTarget(target: string): {
  note: string;
  heading: string | null;
  block: string | null;
} {
  const hash = target.indexOf("#");
  if (hash < 0) {
    return { note: target.trim(), heading: null, block: null };
  }
  const note = target.slice(0, hash).trim();
  const frag = target.slice(hash + 1);
  if (frag.startsWith("^")) {
    return { note, heading: null, block: frag.slice(1) };
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
