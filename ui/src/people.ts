/**
 * Attendance lists: collect `/people` notes, filter by company and/or tag,
 * sort by last name then first name, and render the markdown block.
 */

export type PersonRow = {
  path: string;
  name: string;
  folder?: string;
  size_bytes?: number;
  tags?: unknown;
  links?: unknown;
  properties?: Record<string, unknown> | null;
};

export type Person = {
  path: string;
  displayName: string;
  firstName: string;
  lastName: string;
  company: string;
  tags: string[];
};

export type AttendanceFilters = { company?: string; tag?: string };

export function isPeoplePath(path: string): boolean {
  return path.split("/")[0].toLocaleLowerCase() === "people";
}

function propertyText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim().replace(/^\[\[|\]\]$/g, "");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(propertyText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return propertyText(record.text ?? record.path ?? record.link ?? record.value ?? "");
  }
  return "";
}

function tagList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") tags.push(item);
    else if (item && typeof item === "object" && "tag" in item) {
      tags.push(String((item as { tag: unknown }).tag));
    }
  }
  return tags.map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);
}

export function personFromRow(row: PersonRow): Person | null {
  if (!isPeoplePath(row.path)) return null;
  const props = row.properties && typeof row.properties === "object" ? row.properties : {};
  const firstName = propertyText(props.first_name ?? props.firstName);
  const lastName = propertyText(props.last_name ?? props.lastName);
  const name = propertyText(props.name);
  const stem = row.name.replace(/\.(?:md|markdown)$/i, "");
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || name || stem;
  return {
    path: row.path,
    displayName,
    firstName,
    lastName,
    company: propertyText(props.company),
    tags: tagList(row.tags),
  };
}

export function collectPeople(rows: readonly PersonRow[]): Person[] {
  const people: Person[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const person = personFromRow(row);
    if (!person || seen.has(person.path)) continue;
    seen.add(person.path);
    people.push(person);
  }
  return people;
}

export function sortPeople(people: readonly Person[]): Person[] {
  return [...people].sort((left, right) => {
    const lastLeft = (left.lastName || left.displayName).toLocaleLowerCase();
    const lastRight = (right.lastName || right.displayName).toLocaleLowerCase();
    const byLast = lastLeft.localeCompare(lastRight, undefined, { sensitivity: "base", numeric: true });
    if (byLast !== 0) return byLast;
    const firstLeft = (left.firstName || left.displayName).toLocaleLowerCase();
    const firstRight = (right.firstName || right.displayName).toLocaleLowerCase();
    return firstLeft.localeCompare(firstRight, undefined, { sensitivity: "base", numeric: true });
  });
}

export function filterPeople(people: readonly Person[], filters: AttendanceFilters): Person[] {
  const company = filters.company?.trim().toLocaleLowerCase();
  const tag = filters.tag?.trim().toLocaleLowerCase();
  return people.filter((person) => {
    if (company && person.company.toLocaleLowerCase() !== company) return false;
    if (tag && !person.tags.some((candidate) => candidate.toLocaleLowerCase() === tag)) return false;
    return true;
  });
}

export function distinctCompanies(people: readonly Person[]): string[] {
  return [...new Set(people.map((person) => person.company).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

export function distinctTags(people: readonly Person[]): string[] {
  return [...new Set(people.flatMap((person) => person.tags))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

export function buildAttendanceList(people: readonly Person[], heading = "Attendance"): string {
  const lines = sortPeople(people).map((person) => `- [ ] [[${person.displayName}]]`);
  if (!lines.length) return "";
  return `## ${heading}\n\n${lines.join("\n")}\n`;
}

function option(value: string, label: string): HTMLOptionElement {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}

export type AttendancePanelOptions = {
  people: readonly Person[];
  onInsert: (text: string) => void;
};

export function renderAttendancePanel(host: HTMLElement, options: AttendancePanelOptions): void {
  host.replaceChildren();
  const people = options.people;
  const companies = distinctCompanies(people);
  const tags = distinctTags(people);

  const help = document.createElement("p");
  help.className = "feature-help";
  help.textContent =
    "Pick a company and/or tag. Matching notes from the /people folder are inserted at the caret, sorted by last name, first name.";

  const form = document.createElement("div");
  form.className = "attendance-form";
  const companySelect = document.createElement("select");
  companySelect.className = "feature-select";
  companySelect.title = "Company";
  companySelect.appendChild(option("", "All companies"));
  for (const company of companies) companySelect.appendChild(option(company, company));
  const tagSelect = document.createElement("select");
  tagSelect.className = "feature-select";
  tagSelect.title = "Tag";
  tagSelect.appendChild(option("", "All tags"));
  for (const tag of tags) tagSelect.appendChild(option(tag, `#${tag}`));
  form.append(companySelect, tagSelect);

  const preview = document.createElement("pre");
  preview.className = "attendance-preview";

  const footer = document.createElement("div");
  footer.className = "attendance-footer";
  const count = document.createElement("span");
  count.className = "attendance-count";
  const insert = document.createElement("button");
  insert.type = "button";
  insert.textContent = "Insert into note";
  footer.append(count, insert);

  host.append(help, form, preview, footer);

  let currentText = "";
  const draw = () => {
    const matched = filterPeople(people, { company: companySelect.value, tag: tagSelect.value });
    currentText = buildAttendanceList(matched);
    preview.textContent = currentText;
    count.textContent = `${matched.length} person${matched.length === 1 ? "" : "s"}`;
    insert.disabled = !matched.length;
  };
  companySelect.addEventListener("change", draw);
  tagSelect.addEventListener("change", draw);
  insert.addEventListener("click", () => {
    if (insert.disabled) return;
    options.onInsert(currentText);
  });

  draw();
}