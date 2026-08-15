import type { GraphData, LinkHealth, LinkHealthNote, LinkPlaceholder } from "./types";

/** Notes with no incoming resolved links. */
export function orphanNotes(data: GraphData): LinkHealthNote[] {
  const incoming = new Set(data.edges.map((edge) => edge.target));
  return data.nodes
    .filter((node) => !incoming.has(node.path))
    .map((node) => ({ path: node.path, title: node.title || noteTitle(node.path) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function groupPlaceholders(
  unresolved: readonly { path: string; target: string }[],
): LinkPlaceholder[] {
  const counts = new Map<string, LinkPlaceholder>();
  for (const row of unresolved) {
    const target = row.target.trim();
    if (!target) continue;
    const key = `${row.path}\0${target}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { source: row.path, target, count: 1 });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.target.localeCompare(right.target) || left.source.localeCompare(right.source),
  );
}

export function buildLinkHealth(
  data: GraphData,
  unresolved: readonly { path: string; target: string }[],
): LinkHealth {
  return {
    orphans: orphanNotes(data),
    placeholders: groupPlaceholders(unresolved),
  };
}

export function filterLinkHealth(health: LinkHealth, query: string): LinkHealth {
  const needle = query.trim().toLowerCase();
  if (!needle) return health;
  const match = (value: string) => value.toLowerCase().includes(needle);
  return {
    orphans: health.orphans.filter((note) => match(note.path) || match(note.title)),
    placeholders: health.placeholders.filter(
      (row) => match(row.target) || match(row.source),
    ),
  };
}

export function renderLinkHealth(
  host: HTMLElement,
  health: LinkHealth,
  handlers: {
    onOpen: (path: string) => void;
    onCreate: (target: string, source: string) => void;
  },
) {
  host.replaceChildren();
  host.classList.add("link-health");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "link-health-search";
  search.placeholder = "Filter orphans and placeholders…";
  search.autocomplete = "off";
  const summary = document.createElement("p");
  summary.className = "feature-help";
  const orphans = document.createElement("section");
  const placeholders = document.createElement("section");
  host.append(search, summary, orphans, placeholders);

  const draw = () => {
    const visible = filterLinkHealth(health, search.value);
    summary.textContent =
      `${visible.orphans.length} orphan${visible.orphans.length === 1 ? "" : "s"} · ` +
      `${visible.placeholders.length} placeholder${visible.placeholders.length === 1 ? "" : "s"}`;
    drawNoteList(orphans, "Orphans", "Notes with no incoming links.", visible.orphans, handlers.onOpen);
    drawPlaceholders(placeholders, visible.placeholders, handlers);
  };
  search.addEventListener("input", draw);
  draw();
}

function drawNoteList(
  host: HTMLElement,
  title: string,
  help: string,
  notes: readonly LinkHealthNote[],
  onOpen: (path: string) => void,
) {
  host.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = `${title} (${notes.length})`;
  const hint = document.createElement("p");
  hint.className = "feature-help";
  hint.textContent = help;
  host.append(heading, hint);
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "None.";
    host.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "link-health-list";
  for (const note of notes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-health-row";
    button.innerHTML = `<strong></strong><code></code>`;
    button.querySelector("strong")!.textContent = note.title;
    button.querySelector("code")!.textContent = note.path;
    button.addEventListener("click", () => onOpen(note.path));
    list.append(button);
  }
  host.append(list);
}

function drawPlaceholders(
  host: HTMLElement,
  rows: readonly LinkPlaceholder[],
  handlers: {
    onOpen: (path: string) => void;
    onCreate: (target: string, source: string) => void;
  },
) {
  host.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = `Placeholders (${rows.length})`;
  const hint = document.createElement("p");
  hint.className = "feature-help";
  hint.textContent = "Unresolved wikilinks. Open the source or create the missing note.";
  host.append(heading, hint);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "None.";
    host.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "link-health-list";
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "link-health-placeholder";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "link-health-row";
    const times = row.count > 1 ? ` ×${row.count}` : "";
    open.innerHTML = `<strong></strong><code></code>`;
    open.querySelector("strong")!.textContent = `[[${row.target}]]${times}`;
    open.querySelector("code")!.textContent = row.source;
    open.title = `Open ${row.source}`;
    open.addEventListener("click", () => handlers.onOpen(row.source));
    const create = document.createElement("button");
    create.type = "button";
    create.className = "link-health-create";
    create.textContent = "Create";
    create.addEventListener("click", () => handlers.onCreate(row.target, row.source));
    item.append(open, create);
    list.append(item);
  }
  host.append(list);
}

function noteTitle(path: string): string {
  return path.replace(/\.md$/i, "").split("/").pop() || path;
}
