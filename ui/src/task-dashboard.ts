import type { TaskRow, TaskScope } from "./types";

export type TaskView = {
  name: string;
  completion: "open" | "completed" | "all";
  status: string;
  due: "all" | "overdue" | "today" | "week" | "none";
  priority: string;
  path: string;
  query: string;
  sort: "due" | "scheduled" | "priority" | "path";
  group: "none" | "agenda" | "due" | "priority" | "path";
  scope: "global" | "all";
};

export const DEFAULT_TASK_VIEW: TaskView = {
  name: "Open tasks",
  completion: "open",
  status: "",
  due: "all",
  priority: "",
  path: "",
  query: "",
  sort: "due",
  group: "none",
  scope: "global",
};

export const DEFAULT_TASK_SCOPE: TaskScope = { folders: [], tags: [], property: "" };

export function normalizeTaskScope(scope: Partial<TaskScope> | null | undefined): TaskScope {
  const clean = (values: unknown) => Array.isArray(values)
    ? [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim().replace(/^#/, "")).filter(Boolean))]
    : [];
  return {
    folders: [...new Set(clean(scope?.folders).map((folder) => folder.replace(/^\/+|\/+$/g, "")).filter(Boolean))],
    tags: clean(scope?.tags),
    property: typeof scope?.property === "string" ? scope.property.trim() : "",
  };
}

export function taskScopeIsActive(scope: TaskScope): boolean {
  return Boolean(scope.folders.length || scope.tags.length || scope.property);
}

function localIsoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const PRIORITY_ORDER: Record<string, number> = {
  highest: 0, high: 1, medium: 2, low: 3, lowest: 4,
};

export function selectTasks(tasks: TaskRow[], view: TaskView, now = new Date()): TaskRow[] {
  const today = localIsoDate(now);
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  const weekEnd = localIsoDate(week);
  const query = view.query.trim().toLowerCase();
  const path = view.path.trim().toLowerCase();
  const selected = tasks.filter((task) => {
    if (view.completion === "open" && task.completed) return false;
    if (view.completion === "completed" && !task.completed) return false;
    if (view.status && task.status_char !== view.status) return false;
    if (view.priority && task.priority !== view.priority) return false;
    if (path && !task.path.toLowerCase().includes(path)) return false;
    if (query && !`${task.text} ${task.path} ${task.tags.join(" ")}`.toLowerCase().includes(query)) return false;
    if (view.due === "overdue" && (!task.due || task.due >= today)) return false;
    if (view.due === "today" && task.due !== today) return false;
    if (view.due === "week" && (!task.due || task.due < today || task.due > weekEnd)) return false;
    if (view.due === "none" && task.due) return false;
    return true;
  });
  const dateKey = (value: string | null) => value || "9999-12-31";
  return selected.sort((left, right) => {
    if (view.sort === "priority") {
      return (PRIORITY_ORDER[left.priority || ""] ?? 9) - (PRIORITY_ORDER[right.priority || ""] ?? 9)
        || dateKey(left.due).localeCompare(dateKey(right.due));
    }
    if (view.sort === "scheduled") {
      return dateKey(left.scheduled).localeCompare(dateKey(right.scheduled))
        || dateKey(left.due).localeCompare(dateKey(right.due));
    }
    if (view.sort === "path") return left.path.localeCompare(right.path) || left.line - right.line;
    return dateKey(left.due).localeCompare(dateKey(right.due))
      || (PRIORITY_ORDER[left.priority || ""] ?? 9) - (PRIORITY_ORDER[right.priority || ""] ?? 9)
      || left.path.localeCompare(right.path);
  });
}

export function groupTasks(
  tasks: TaskRow[],
  group: TaskView["group"],
  now = new Date(),
): Map<string, TaskRow[]> {
  const groups = new Map<string, TaskRow[]>();
  const today = localIsoDate(now);
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = localIsoDate(tomorrowDate);
  const weekDate = new Date(now);
  weekDate.setDate(weekDate.getDate() + 7);
  const week = localIsoDate(weekDate);
  for (const task of tasks) {
    const key = group === "agenda" ? agendaBucket(task.due, today, tomorrow, week)
      : group === "due" ? task.due || "No due date"
      : group === "priority" ? task.priority || "No priority"
      : group === "path" ? task.path.split("/").slice(0, -1).join("/") || "Vault root"
      : "Tasks";
    const rows = groups.get(key) ?? [];
    rows.push(task);
    groups.set(key, rows);
  }
  return groups;
}

function agendaBucket(due: string | null, today: string, tomorrow: string, week: string): string {
  if (!due) return "6 · No due date";
  if (due < today) return "1 · Overdue";
  if (due === today) return "2 · Today";
  if (due === tomorrow) return "3 · Tomorrow";
  if (due <= week) return "4 · Next 7 days";
  return "5 · Later";
}

const PRIORITY_MARKERS: Record<string, string> = {
  highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬",
};

export function updateTaskMetadataLine(
  rawLine: string,
  metadata: { due: string | null; scheduled: string | null; priority: string | null },
): string {
  const block = rawLine.match(/(\s+\^[A-Za-z0-9-]+\s*)$/)?.[1] ?? "";
  let line = block ? rawLine.slice(0, -block.length) : rawLine;
  line = line
    .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\s*⏳\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\s*(?:🔺|⏫|🔼|🔽|⏬)/gu, "")
    .trimEnd();
  const markers = [
    metadata.priority ? PRIORITY_MARKERS[metadata.priority] : "",
    metadata.scheduled ? `⏳ ${metadata.scheduled}` : "",
    metadata.due ? `📅 ${metadata.due}` : "",
  ].filter(Boolean);
  return `${line}${markers.length ? ` ${markers.join(" ")}` : ""}${block}`;
}
