import {
  DEFAULT_ATTACHMENT_FILTERS,
  formatAttachmentBytes,
  selectAttachments,
  type AttachmentFilters,
} from "./attachment-inventory";
import type { AttachmentRow } from "./types";

export function renderAttachmentPanel(
  host: HTMLElement,
  rows: readonly AttachmentRow[],
  onOpen: (path: string) => void,
): void {
  host.replaceChildren();
  host.classList.add("attachment-panel");
  const filters: AttachmentFilters = { ...DEFAULT_ATTACHMENT_FILTERS };
  const toolbar = document.createElement("div");
  toolbar.className = "attachment-toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter attachments…";
  search.autocomplete = "off";
  const kind = document.createElement("select");
  for (const option of ["all", "image", "audio", "video", "document", "other"] as const) {
    const item = document.createElement("option");
    item.value = option;
    item.textContent = option[0].toUpperCase() + option.slice(1);
    kind.appendChild(item);
  }
  const orphans = document.createElement("label");
  const orphanBox = document.createElement("input");
  orphanBox.type = "checkbox";
  orphans.append(orphanBox, " Orphans only");
  const sort = document.createElement("select");
  for (const [value, label] of [["path", "Path"], ["size", "Size"], ["references", "References"]] as const) {
    const item = document.createElement("option");
    item.value = value;
    item.textContent = label;
    sort.appendChild(item);
  }
  const summary = document.createElement("p");
  summary.className = "feature-help";
  const list = document.createElement("div");
  list.className = "attachment-list";
  toolbar.append(search, kind, orphans, sort);
  host.append(toolbar, summary, list);

  const draw = () => {
    filters.query = search.value;
    filters.kind = kind.value as AttachmentFilters["kind"];
    filters.orphanedOnly = orphanBox.checked;
    filters.sort = sort.value as AttachmentFilters["sort"];
    const selected = selectAttachments(rows, filters);
    summary.textContent = `${selected.length} of ${rows.length} attachments`;
    list.replaceChildren();
    if (!selected.length) {
      list.innerHTML = `<div class="feature-empty">No attachments match.</div>`;
      return;
    }
    for (const row of selected) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "attachment-row";
      button.innerHTML = `<strong></strong><span></span><code></code>`;
      button.querySelector("strong")!.textContent = row.name;
      button.querySelector("span")!.textContent =
        `${formatAttachmentBytes(row.size_bytes)} · ${row.reference_count} ref${row.reference_count === 1 ? "" : "s"}${row.orphaned ? " · orphan" : ""}`;
      button.querySelector("code")!.textContent = row.path;
      button.addEventListener("click", () => onOpen(row.path));
      list.appendChild(button);
    }
  };
  search.addEventListener("input", draw);
  kind.addEventListener("change", draw);
  orphanBox.addEventListener("change", draw);
  sort.addEventListener("change", draw);
  draw();
}
