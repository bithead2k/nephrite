/**
 * Pandoc inline code attributes: `` `SELECT 1;`{.sqlpostgresql} ``
 * and the same with a longer backtick run.
 * Preview-only: the language class is for highlighting, not execution.
 */

export type PandocAttrs = {
  id: string | null;
  classes: string[];
  language: string | null;
};

export function parsePandocAttributeBlock(raw: string): PandocAttrs | null {
  const inner = raw.trim();
  if (!inner || !/^[.#A-Za-z_]/.test(inner)) return null;
  const classes: string[] = [];
  let id: string | null = null;
  const tokens = inner.match(/#[^\s.#]+|\.[^\s.#]+|[^\s]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("#")) id = token.slice(1);
    else if (token.startsWith(".")) classes.push(token.slice(1).toLowerCase());
  }
  if (!id && classes.length === 0) return null;
  return { id, classes, language: classes[0] ?? null };
}

/** Attach `{.lang}` that marked leaves as literal text after `</code>`. */
export function applyPandocInlineCodeAttrs(html: string): string {
  return html.replace(
    /<code(\s[^>]*)?>([\s\S]*?)<\/code>\s*\{([^}]*)\}/gi,
    (whole, rawAttrs: string | undefined, body: string, spec: string) => {
      const parsed = parsePandocAttributeBlock(spec);
      if (!parsed?.language) return whole;
      const attrs = new Map<string, string>();
      for (const match of (rawAttrs ?? "").matchAll(/([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g)) {
        attrs.set(match[1], match[2] ?? match[3] ?? match[4] ?? "");
      }
      const classes = new Set((attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
      classes.add(`language-${parsed.language}`);
      for (const name of parsed.classes.slice(1)) classes.add(name);
      attrs.set("class", [...classes].join(" "));
      if (parsed.id) attrs.set("id", parsed.id);
      const rendered = [...attrs].map(([key, value]) =>
        value === "" ? key : `${key}="${value.replace(/"/g, "&quot;")}"`,
      ).join(" ");
      return `<code${rendered ? ` ${rendered}` : ""}>${body}</code>`;
    },
  );
}
