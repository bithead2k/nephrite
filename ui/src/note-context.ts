import type {
  NoteContext,
  NoteHeading,
  NoteLinkRef,
  UnlinkedMention,
  VaultTag,
} from "./types";

export function linkRefLabel(ref: NoteLinkRef): string {
  const dest = ref.display || ref.title || ref.target.replace(/\.md$/i, "");
  const extra = [
    ref.heading ? `#${ref.heading}` : "",
    ref.block ? `#^${ref.block}` : "",
    ref.embed ? " embed" : "",
    ref.resolved ? "" : " unresolved",
  ].join("");
  return `${dest}${extra}`;
}

export function groupBacklinks(refs: readonly NoteLinkRef[]): Map<string, NoteLinkRef[]> {
  const groups = new Map<string, NoteLinkRef[]>();
  for (const ref of refs) {
    const list = groups.get(ref.path) ?? [];
    list.push(ref);
    groups.set(ref.path, list);
  }
  return groups;
}

export function filterVaultTags(tags: readonly VaultTag[], query: string): VaultTag[] {
  const needle = query.trim().replace(/^#/, "").toLowerCase();
  if (!needle) return [...tags];
  return tags.filter((tag) => tag.tag.toLowerCase().includes(needle));
}

export function renderNoteContext(
  host: HTMLElement,
  context: NoteContext,
  handlers: {
    onOpen: (path: string, line?: number | null) => void;
    onHeading: (line: number) => void;
    onTag?: (tag: string) => void;
  },
) {
  host.replaceChildren();
  host.classList.add("note-context");
  const intro = document.createElement("p");
  intro.className = "feature-help";
  intro.textContent = context.title
    ? `Linked mentions and outline for ${context.title}.`
    : "Open a note to see its outline and links.";
  host.append(intro);
  host.append(renderOutline(context.headings, handlers.onHeading));
  host.append(
    renderLinkGroups(
      "Backlinks",
      "Notes that link here.",
      context.backlinks,
      (ref) => handlers.onOpen(ref.path),
    ),
  );
  host.append(
    renderLinkGroups(
      "Outgoing",
      "Links leaving this note.",
      context.outgoing,
      (ref) => handlers.onOpen(ref.resolved ? ref.target : ref.target),
    ),
  );
  host.append(renderUnlinked(context.unlinked, handlers.onOpen));
  if (context.tags.length) {
    const tags = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = `Tags (${context.tags.length})`;
    const list = document.createElement("div");
    list.className = "note-context-tags";
    for (const tag of context.tags) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = tag.startsWith("#") ? tag : `#${tag}`;
      button.addEventListener("click", () => handlers.onTag?.(tag.replace(/^#/, "")));
      list.append(button);
    }
    tags.append(heading, list);
    host.append(tags);
  }
}

export function renderTagBrowser(
  host: HTMLElement,
  tags: readonly VaultTag[],
  onOpenTag: (tag: string) => void,
) {
  host.replaceChildren();
  host.classList.add("tag-browser");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "link-health-search";
  search.placeholder = "Filter tags…";
  search.autocomplete = "off";
  const summary = document.createElement("p");
  summary.className = "feature-help";
  const list = document.createElement("div");
  list.className = "tag-browser-list";
  host.append(search, summary, list);
  const draw = () => {
    const visible = filterVaultTags(tags, search.value);
    summary.textContent = `${visible.length} tag${visible.length === 1 ? "" : "s"}`;
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No tags in the index.";
      list.append(empty);
      return;
    }
    for (const tag of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tag-browser-row";
      button.innerHTML = `<strong></strong><span></span>`;
      button.querySelector("strong")!.textContent = `#${tag.tag}`;
      button.querySelector("span")!.textContent = String(tag.count);
      button.addEventListener("click", () => onOpenTag(tag.tag));
      list.append(button);
    }
  };
  search.addEventListener("input", draw);
  draw();
}

function renderOutline(headings: readonly NoteHeading[], onHeading: (line: number) => void): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = `Outline (${headings.length})`;
  section.append(heading);
  if (!headings.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No headings in this note.";
    section.append(empty);
    return section;
  }
  const list = document.createElement("div");
  list.className = "note-outline";
  for (const item of headings) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-outline-item";
    button.style.paddingLeft = `${0.35 + Math.max(0, item.level - 1) * 0.75}rem`;
    button.textContent = item.text;
    button.title = `Line ${item.line}`;
    button.addEventListener("click", () => onHeading(item.line));
    list.append(button);
  }
  section.append(list);
  return section;
}

function renderLinkGroups(
  title: string,
  help: string,
  refs: readonly NoteLinkRef[],
  onOpen: (ref: NoteLinkRef) => void,
): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = `${title} (${refs.length})`;
  const hint = document.createElement("p");
  hint.className = "feature-help";
  hint.textContent = help;
  section.append(heading, hint);
  if (!refs.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "None.";
    section.append(empty);
    return section;
  }
  const list = document.createElement("div");
  list.className = "note-context-list";
  for (const [path, group] of groupBacklinks(refs)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-health-row";
    const label = group[0]?.title || path;
    const detail = group.map(linkRefLabel).join(" · ");
    button.innerHTML = `<strong></strong><code></code>`;
    button.querySelector("strong")!.textContent = label;
    button.querySelector("code")!.textContent = detail;
    button.addEventListener("click", () => onOpen(group[0]));
    list.append(button);
  }
  section.append(list);
  return section;
}

function renderUnlinked(
  mentions: readonly UnlinkedMention[],
  onOpen: (path: string, line?: number | null) => void,
): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = `Unlinked mentions (${mentions.length})`;
  const hint = document.createElement("p");
  hint.className = "feature-help";
  hint.textContent = "Other notes that mention this title or alias without a wikilink.";
  section.append(heading, hint);
  if (!mentions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "None.";
    section.append(empty);
    return section;
  }
  const list = document.createElement("div");
  list.className = "note-context-list";
  for (const mention of mentions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-health-row";
    button.innerHTML = `<strong></strong><code></code>`;
    button.querySelector("strong")!.textContent = mention.title;
    button.querySelector("code")!.textContent =
      `${mention.path}${mention.line ? `:${mention.line}` : ""} · ${mention.term}`;
    button.addEventListener("click", () => onOpen(mention.path, mention.line));
    list.append(button);
  }
  section.append(list);
  return section;
}
