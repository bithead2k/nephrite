import { applyYamlFrontmatter, parseFrontmatterTree, serializeSimpleYaml } from "./yaml-tree";

type YamlNode = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function renderPropertiesEditor(
  host: HTMLElement,
  source: string,
  onSave: (next: string) => void,
): void {
  host.replaceChildren();
  host.classList.add("properties-editor");
  const help = document.createElement("p");
  help.className = "feature-help";
  help.textContent = "Nested YAML frontmatter. Save rewrites only the --- block; the note body is unchanged.";
  const treeHost = document.createElement("div");
  treeHost.className = "properties-tree";
  const actions = document.createElement("div");
  actions.className = "feature-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save properties";
  const preview = document.createElement("pre");
  preview.className = "properties-preview";
  actions.appendChild(save);
  host.append(help, treeHost, actions, preview);

  let value: unknown = cloneValue(parseFrontmatterTree(source));
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};

  const draw = () => {
    treeHost.replaceChildren(renderNode(value as Record<string, unknown>, (next) => {
      value = next;
      draw();
    }));
    preview.textContent = serializeSimpleYaml(value);
  };
  save.addEventListener("click", () => onSave(applyYamlFrontmatter(source, value)));
  draw();
}

function renderNode(
  value: Record<string, unknown> | unknown[],
  replace: (next: Record<string, unknown> | unknown[]) => void,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "properties-node";
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      root.appendChild(row(`#${index}`, item, (next) => {
        const copy = value.slice();
        copy[index] = next;
        replace(copy);
      }, () => replace(value.filter((_, i) => i !== index))));
    });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add item";
    add.addEventListener("click", () => replace([...value, ""]));
    root.appendChild(add);
    return root;
  }
  for (const [key, child] of Object.entries(value)) {
    root.appendChild(row(key, child, (next) => replace({ ...value, [key]: next }), () => {
      const copy = { ...value };
      delete copy[key];
      replace(copy);
    }, (nextKey) => {
      if (!nextKey || nextKey === key) return;
      const copy: Record<string, unknown> = {};
      for (const [existing, item] of Object.entries(value)) {
        copy[existing === key ? nextKey : existing] = item;
      }
      replace(copy);
    }));
  }
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add property";
  add.addEventListener("click", () => {
    let key = "property";
    let n = 2;
    while (key in value) {
      key = `property${n}`;
      n += 1;
    }
    replace({ ...value, [key]: "" });
  });
  root.appendChild(add);
  return root;
}

function row(
  label: string,
  value: unknown,
  setValue: (next: unknown) => void,
  remove: () => void,
  rename?: (key: string) => void,
): HTMLElement {
  const rowEl = document.createElement("div");
  rowEl.className = "properties-row";
  const name = document.createElement("input");
  name.className = "properties-key";
  name.value = label;
  name.readOnly = !rename;
  if (rename) {
    name.addEventListener("change", () => rename(name.value.trim()));
  }
  const type = document.createElement("select");
  type.className = "properties-type";
  for (const option of ["string", "number", "boolean", "list", "map"] as const) {
    const item = document.createElement("option");
    item.value = option;
    item.textContent = option;
    type.appendChild(item);
  }
  type.value = valueType(value);
  type.addEventListener("change", () => setValue(coerceValue(type.value, value)));
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove";
  removeBtn.addEventListener("click", remove);
  rowEl.append(name, type, removeBtn);

  if (value && typeof value === "object") {
    const nested = renderNode(value as Record<string, unknown> | unknown[], (next) => setValue(next));
    nested.classList.add("properties-nested");
    rowEl.appendChild(nested);
    return rowEl;
  }
  if (typeof value === "boolean") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = value;
    box.addEventListener("change", () => setValue(box.checked));
    rowEl.appendChild(box);
    return rowEl;
  }
  const input = document.createElement("input");
  input.className = "properties-value";
  input.value = value == null ? "" : String(value);
  input.addEventListener("change", () => {
    if (typeof value === "number") {
      const next = Number(input.value);
      setValue(Number.isNaN(next) ? input.value : next);
    } else {
      setValue(input.value);
    }
  });
  rowEl.appendChild(input);
  return rowEl;
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "list";
  if (value && typeof value === "object") return "map";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function coerceValue(type: string, current: unknown): YamlNode {
  if (type === "list") return Array.isArray(current) ? current : current == null || current === "" ? [] : [current];
  if (type === "map") {
    if (current && typeof current === "object" && !Array.isArray(current)) return current as Record<string, unknown>;
    return {};
  }
  if (type === "boolean") return Boolean(current);
  if (type === "number") {
    const n = Number(current);
    return Number.isNaN(n) ? 0 : n;
  }
  if (current && typeof current === "object") return "";
  return current == null ? "" : String(current);
}

function cloneValue<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}
