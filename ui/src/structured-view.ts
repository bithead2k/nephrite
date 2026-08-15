export function renderStructuredView(host: HTMLElement, path: string, source: string): void {
  host.replaceChildren();
  host.classList.add("structured-viewer");
  const header = document.createElement("div");
  header.className = "code-viewer-header";
  header.textContent = path;
  const body = document.createElement("div");
  body.className = "structured-viewer-body";
  const ext = path.replace(/^.*\./, "").toLowerCase();
  try {
    const value = ext === "json"
      ? JSON.parse(source)
      : parseSimpleYaml(source);
    body.appendChild(renderTree(value, path.split("/").pop() || "root"));
  } catch (error) {
    body.classList.add("feature-error");
    body.textContent = `Could not parse ${ext.toUpperCase()}: ${String(error)}`;
  }
  host.append(header, body);
}

export function clearStructuredView(host: HTMLElement): void {
  host.replaceChildren();
}

function renderTree(value: unknown, label: string): HTMLElement {
  const item = document.createElement("div");
  item.className = "struct-node";
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((entry, index) => [String(index), entry] as const)
      : Object.entries(value as Record<string, unknown>);
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `${label} ${Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}`;
    details.appendChild(summary);
    for (const [key, child] of entries) {
      details.appendChild(renderTree(child, key));
    }
    item.appendChild(details);
    return item;
  }
  const key = document.createElement("span");
  key.className = "struct-key";
  key.textContent = label;
  const sep = document.createElement("span");
  sep.textContent = ": ";
  const leaf = document.createElement("span");
  leaf.className = "struct-value";
  leaf.textContent = value === null ? "null" : String(value);
  item.append(key, sep, leaf);
  return item;
}

/** Indent-based YAML subset: maps, lists, scalars. Not a full YAML 1.2 parser. */
export function parseSimpleYaml(source: string): unknown {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  const peek = () => {
    while (index < lines.length && (!lines[index].trim() || lines[index].trim().startsWith("#"))) {
      index += 1;
    }
    return index < lines.length ? lines[index] : null;
  };

  const indentOf = (line: string) => line.match(/^ */)?.[0].length ?? 0;

  const parseValue = (indent: number): unknown => {
    const line = peek();
    if (line == null) return null;
    const current = indentOf(line);
    if (current < indent) return null;
    if (line.trim().startsWith("- ")) {
      const list: unknown[] = [];
      while (true) {
        const next = peek();
        if (next == null || indentOf(next) < current || !next.trim().startsWith("- ")) break;
        const rest = next.trim().slice(2);
        index += 1;
        if (!rest) list.push(parseValue(current + 2));
        else if (rest.includes(": ")) {
          const colon = rest.indexOf(": ");
          const key = rest.slice(0, colon).trim();
          const value = rest.slice(colon + 2).trim();
          const child = parseValue(current + 2);
          const object: Record<string, unknown> = { [unquote(key)]: value ? scalar(value) : child };
          if (child && typeof child === "object" && !Array.isArray(child) && !value) {
            Object.assign(object, child);
            delete object[unquote(key)];
            object[unquote(key)] = child;
          }
          list.push(object);
        } else {
          list.push(scalar(rest));
        }
      }
      return list;
    }
    const object: Record<string, unknown> = {};
    while (true) {
      const next = peek();
      if (next == null || indentOf(next) < current || next.trim().startsWith("- ")) break;
      if (indentOf(next) > current) break;
      const trimmed = next.trim();
      const colon = trimmed.indexOf(":");
      if (colon < 0) {
        index += 1;
        continue;
      }
      const key = unquote(trimmed.slice(0, colon).trim());
      const rest = trimmed.slice(colon + 1).trim();
      index += 1;
      object[key] = rest ? scalar(rest) : parseValue(current + 2);
    }
    return object;
  };

  return parseValue(0);
}

function scalar(value: string): unknown {
  const text = unquote(value);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function unquote(value: string): string {
  const match = value.match(/^(['"])([\s\S]*)\1$/);
  return match ? match[2] : value;
}
