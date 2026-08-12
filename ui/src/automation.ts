import { formatDate } from "./templater";

export type AutomationPrompt = {
  name: string;
  label: string;
  default?: string;
  multiline?: boolean;
};

export type AutomationAction =
  | { type: "create"; path: string; content?: string; template?: string; open?: boolean }
  | { type: "append" | "prepend"; path: string; content?: string; template?: string }
  | { type: "move"; from?: string; to: string }
  | { type: "rename"; from?: string; to: string }
  | { type: "apply-template"; template: string }
  | { type: "open"; path: string }
  | { type: "notice"; message: string };

export type AutomationCommand = {
  id: string;
  name: string;
  description?: string;
  shortcut?: string;
  prompts?: AutomationPrompt[];
  actions: AutomationAction[];
};

export type AutomationConfig = {
  version: 1;
  functions?: Record<string, string>;
  commands: AutomationCommand[];
  lifecycle?: {
    onVaultOpen?: string[];
    onNoteOpen?: string[];
    onNoteSave?: string[];
  };
};

export type AutomationVariables = Record<string, string> & {
  "active.path": string;
  "active.title": string;
  "active.folder": string;
  selection: string;
};

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function validateAutomationConfig(value: unknown): AutomationConfig {
  if (!value || typeof value !== "object") throw new Error("Automation configuration must be an object");
  const config = value as Partial<AutomationConfig>;
  if (config.version !== 1) throw new Error(`Unsupported automation configuration version: ${String(config.version)}`);
  if (!Array.isArray(config.commands)) throw new Error("Automation commands must be an array");
  const ids = new Set<string>();
  for (const command of config.commands) {
    if (!command || !/^[A-Za-z0-9._-]{1,96}$/.test(command.id)) throw new Error("Automation command has an invalid id");
    if (ids.has(command.id)) throw new Error(`Duplicate automation command id: ${command.id}`);
    ids.add(command.id);
    if (!command.name?.trim()) throw new Error(`Automation ${command.id} needs a name`);
    if (!Array.isArray(command.actions) || !command.actions.length) throw new Error(`Automation ${command.id} has no actions`);
    for (const prompt of command.prompts ?? []) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(prompt.name) || !prompt.label?.trim()) {
        throw new Error(`Automation ${command.id} has an invalid prompt`);
      }
    }
    for (const action of command.actions) validateAction(command.id, action);
  }
  for (const [event, commands] of Object.entries(config.lifecycle ?? {})) {
    if (!Array.isArray(commands) || commands.some((id) => !ids.has(id))) {
      throw new Error(`Automation lifecycle ${event} references an unknown command`);
    }
  }
  return config as AutomationConfig;
}

function validateAction(commandId: string, action: AutomationAction) {
  const valid = ["create", "append", "prepend", "move", "rename", "apply-template", "open", "notice"];
  if (!action || !valid.includes(action.type)) throw new Error(`Automation ${commandId} has an unknown action`);
  if ((action.type === "create" || action.type === "append" || action.type === "prepend") && !action.path) {
    throw new Error(`Automation ${commandId} action ${action.type} needs a path`);
  }
  if ((action.type === "move" || action.type === "rename") && (!action.to)) {
    throw new Error(`Automation ${commandId} action ${action.type} needs a destination`);
  }
  if (action.type === "apply-template" && !action.template) throw new Error(`Automation ${commandId} needs a template path`);
  if (action.type === "open" && !action.path) throw new Error(`Automation ${commandId} open action needs a path`);
}

export function automationVariables(path: string | null, selection = ""): AutomationVariables {
  const normalized = path?.replace(/\\/g, "/") ?? "";
  const filename = normalized.split("/").pop() ?? "";
  return {
    "active.path": normalized,
    "active.title": filename.replace(/\.(?:md|markdown)$/i, ""),
    "active.folder": normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "",
    selection,
  };
}

export function expandAutomationText(
  source: string,
  variables: Record<string, string>,
  functions: Record<string, string> = {},
  now = new Date(),
): string {
  const expand = (text: string, depth: number): string => {
    if (depth > 8) throw new Error("Automation function expansion is recursive");
    return text.replace(TOKEN, (_whole, raw: string) => {
      const token = raw.trim();
      if (token === "date") return formatDate(now, "YYYY-MM-DD");
      if (token === "time") return formatDate(now, "HH:mm");
      if (token.startsWith("date:")) return formatDate(now, token.slice(5));
      if (token.startsWith("function:")) {
        const name = token.slice(9).trim();
        if (!(name in functions)) throw new Error(`Unknown automation function: ${name}`);
        return expand(functions[name], depth + 1);
      }
      if (token in variables) return variables[token];
      throw new Error(`Unknown automation variable: ${token}`);
    });
  };
  return expand(source, 0);
}
