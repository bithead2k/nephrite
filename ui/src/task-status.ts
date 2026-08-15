/** Obsidian Tasks / Minimal-style checkbox markers. Markdown stays the store. */

export type TaskStatus = {
  char: string;
  id: string;
  label: string;
  completed: boolean;
};

export const TASK_STATUSES: readonly TaskStatus[] = [
  { char: " ", id: "todo", label: "Todo", completed: false },
  { char: "/", id: "half", label: "In progress", completed: false },
  { char: "-", id: "cancelled", label: "Cancelled", completed: false },
  { char: ">", id: "forwarded", label: "Forwarded", completed: false },
  { char: "<", id: "scheduled", label: "Scheduled", completed: false },
  { char: "?", id: "question", label: "Question", completed: false },
  { char: "!", id: "important", label: "Important", completed: false },
  { char: "x", id: "done", label: "Done", completed: true },
];

/** Ctrl-Enter / preview cycle. Ends on done then cancelled, then wraps to todo. */
export const TASK_STATUS_CYCLE = [" ", "/", ">", "<", "?", "!", "x", "-"] as const;

const BY_CHAR = new Map<string, TaskStatus>(
  TASK_STATUSES.flatMap((status) =>
    status.char === "x"
      ? [[status.char, status], ["X", status]] as Array<[string, TaskStatus]>
      : [[status.char, status]],
  ),
);

export function classifyTaskStatus(char: string): TaskStatus {
  return BY_CHAR.get(char) ?? {
    char,
    id: "todo",
    label: `Custom [${char}]`,
    completed: false,
  };
}

export function nextTaskStatusChar(char: string): string {
  const index = TASK_STATUS_CYCLE.indexOf(char as (typeof TASK_STATUS_CYCLE)[number]);
  if (index < 0) return " ";
  return TASK_STATUS_CYCLE[(index + 1) % TASK_STATUS_CYCLE.length];
}

export function isTaskStatusChar(char: string): boolean {
  return char.length === 1 && (BY_CHAR.has(char) || /[^\s\]]/.test(char));
}
