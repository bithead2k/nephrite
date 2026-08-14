/**
 * One capability-checked host API for Nephrite plugins, compatibility scripts,
 * and native automation. Obsidian names are aliases over this object; they do
 * not receive a separate path around permission or path validation.
 */

export type AppPermission =
  | "vault.read"
  | "vault.write"
  | "index.query"
  | "editor.read"
  | "editor.write"
  | "workspace.commands"
  | "workspace.views"
  | "shell.execute";

export type AppFile = {
  path: string;
  name: string;
  parent_path?: string;
  file_kind?: string;
  extension?: string;
  basename?: string;
};

export type AppHostServices = {
  listFiles: () => readonly AppFile[] | Promise<readonly AppFile[]>;
  readFile: (path: string) => string | Promise<string>;
  writeFile?: (path: string, content: string) => unknown | Promise<unknown>;
  createFile?: (path: string, content: string) => unknown | Promise<unknown>;
  renamePath?: (from: string, to: string) => unknown | Promise<unknown>;
  deletePath?: (path: string) => unknown | Promise<unknown>;
  queryIndex: (sql: string) => unknown | Promise<unknown>;
  pageMetadata?: (path: string) => unknown | Promise<unknown>;
  metadataSnapshot?: () => readonly unknown[] | Promise<readonly unknown[]>;
  resolveLink?: (link: string, sourcePath: string) => AppFile | null | Promise<AppFile | null>;
  editorState: () => { path: string | null; content: string; selection: string };
  replaceSelection?: (content: string) => unknown;
  openPath: (path: string) => unknown | Promise<unknown>;
  executeCommand?: (id: string) => unknown | Promise<unknown>;
  registerCommand?: (id: string, title: string, keywords: string) => unknown;
  registerView?: (id: string, title: string) => unknown;
  executeShell?: (command: string, args: string[]) => unknown | Promise<unknown>;
  pluginInfo?: (id?: string) => unknown;
  loadPluginData?: () => unknown;
  savePluginData?: (value: unknown) => unknown;
};

export const APP_METHOD_PERMISSIONS: Record<string, AppPermission> = {
  "vault.list": "vault.read",
  "vault.read": "vault.read",
  "vault.write": "vault.write",
  "vault.create": "vault.write",
  "vault.rename": "vault.write",
  "vault.delete": "vault.write",
  "metadata.page": "vault.read",
  "metadata.resolveLink": "vault.read",
  "index.query": "index.query",
  "editor.getState": "editor.read",
  "editor.replaceSelection": "editor.write",
  "workspace.open": "vault.read",
  "workspace.getActiveFile": "editor.read",
  "workspace.executeCommand": "workspace.commands",
  "workspace.registerCommand": "workspace.commands",
  "workspace.registerView": "workspace.views",
  "plugins.get": "vault.read",
  "plugins.loadData": "vault.read",
  "plugins.saveData": "vault.write",
  "shell.execute": "shell.execute",
};

const PATH_ARGUMENTS: Record<string, number[]> = {
  "vault.read": [0],
  "vault.write": [0],
  "vault.create": [0],
  "vault.rename": [0, 1],
  "vault.delete": [0],
  "metadata.page": [0],
  "metadata.resolveLink": [1],
  "workspace.open": [0],
};

export function permissionForAppMethod(method: string): AppPermission | null {
  return APP_METHOD_PERMISSIONS[method] ?? null;
}

export function normalizeAppVaultPath(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("Vault paths must be non-empty and vault-relative");
  }
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("Vault paths cannot escape the vault");
    parts.push(part);
  }
  const path = parts.join("/");
  if (path === ".nephrite" || path.startsWith(".nephrite/")) {
    throw new Error("Nephrite's disposable index and state are not plugin data");
  }
  return path;
}

export class NephriteApp {
  readonly apiVersion = 1;
  vault: Record<string, (...args: unknown[]) => unknown>;
  readonly index: Record<string, (...args: unknown[]) => unknown>;
  readonly editor: Record<string, (...args: unknown[]) => unknown>;
  readonly workspace: Record<string, (...args: unknown[]) => unknown>;
  readonly shell: Record<string, (...args: unknown[]) => unknown>;

  constructor(
    protected readonly services: AppHostServices,
    permissions: Iterable<AppPermission>,
  ) {
    this.permissions = new Set(permissions);
    this.vault = Object.freeze({
      list: () => this.call("vault.list"),
      read: (path: unknown) => this.call("vault.read", path),
      write: (path: unknown, content: unknown) => this.call("vault.write", path, content),
      create: (path: unknown, content = "") => this.call("vault.create", path, content),
      rename: (from: unknown, to: unknown) => this.call("vault.rename", from, to),
      delete: (path: unknown) => this.call("vault.delete", path),
    });
    this.index = Object.freeze({ query: (sql: unknown) => this.call("index.query", sql) });
    this.editor = Object.freeze({
      getState: () => this.call("editor.getState"),
      replaceSelection: (content: unknown) => this.call("editor.replaceSelection", content),
    });
    this.workspace = Object.freeze({
      open: (path: unknown) => this.call("workspace.open", path),
      getActiveFile: () => this.call("workspace.getActiveFile"),
      executeCommand: (id: unknown) => this.call("workspace.executeCommand", id),
      registerCommand: (id: unknown, title: unknown, keywords = "") =>
        this.call("workspace.registerCommand", id, title, keywords),
      registerView: (id: unknown, title: unknown) => this.call("workspace.registerView", id, title),
    });
    this.shell = Object.freeze({
      execute: (command: unknown, args?: unknown) => this.call("shell.execute", command, Array.isArray(args) ? args : []),
    });
  }

  private readonly permissions: Set<AppPermission>;

  call(method: string, ...rawArgs: unknown[]): unknown {
    const permission = permissionForAppMethod(method);
    if (!permission) throw new Error(`Unknown app API method: ${method}`);
    if (!this.permissions.has(permission)) throw new Error(`Permission denied: ${permission}`);
    const args = rawArgs.slice();
    for (const index of PATH_ARGUMENTS[method] ?? []) args[index] = normalizeAppVaultPath(args[index]);
    switch (method) {
      case "vault.list": return this.services.listFiles();
      case "vault.read": return this.services.readFile(String(args[0]));
      case "vault.write": return required(this.services.writeFile, method)(String(args[0]), String(args[1] ?? ""));
      case "vault.create": return required(this.services.createFile, method)(String(args[0]), String(args[1] ?? ""));
      case "vault.rename": return required(this.services.renamePath, method)(String(args[0]), String(args[1]));
      case "vault.delete": return required(this.services.deletePath, method)(String(args[0]));
      case "metadata.page": return required(this.services.pageMetadata, method)(String(args[0]));
      case "metadata.resolveLink": return required(this.services.resolveLink, method)(String(args[0]), String(args[1]));
      case "index.query": return this.services.queryIndex(String(args[0]));
      case "editor.getState": return this.services.editorState();
      case "editor.replaceSelection": return required(this.services.replaceSelection, method)(String(args[0]));
      case "workspace.open": return this.services.openPath(String(args[0]));
      case "workspace.getActiveFile": return fileFromPath(this.services.editorState().path);
      case "workspace.executeCommand": return required(this.services.executeCommand, method)(String(args[0]));
      case "workspace.registerCommand": return required(this.services.registerCommand, method)(String(args[0]), String(args[1]), String(args[2] ?? ""));
      case "workspace.registerView": return required(this.services.registerView, method)(String(args[0]), String(args[1]));
      case "plugins.get": return this.services.pluginInfo?.(args[0] == null ? undefined : String(args[0])) ?? null;
      case "plugins.loadData": return this.services.loadPluginData?.() ?? null;
      case "plugins.saveData": return required(this.services.savePluginData, method)(args[0]);
      case "shell.execute": return required(this.services.executeShell, method)(String(args[0]), Array.isArray(args[1]) ? args[1].map(String) : []);
      default: throw new Error(`Unknown app API method: ${method}`);
    }
  }
}

/** Obsidian-compatible names inherit every security decision from NephriteApp. */
export class ObsidianApp extends NephriteApp {
  readonly metadataCache: Record<string, (...args: unknown[]) => unknown>;
  readonly fileManager: Record<string, (...args: unknown[]) => unknown>;
  readonly commands: Record<string, (...args: unknown[]) => unknown>;
  readonly plugins: Record<string, (...args: unknown[]) => unknown>;

  constructor(services: AppHostServices, permissions: Iterable<AppPermission>) {
    super(services, permissions);
    const nativeVault = this.vault;
    this.vault = Object.freeze({
      ...nativeVault,
      getMarkdownFiles: () => mapMaybe(nativeVault.list(), (files) => (files as AppFile[]).filter(isMarkdown)),
      getFiles: () => nativeVault.list(),
      getAbstractFileByPath: (path: unknown) => mapMaybe(nativeVault.list(), (files) =>
        (files as AppFile[]).find((file) => file.path === normalizeAppVaultPath(path)) ?? null),
      cachedRead: (file: unknown) => nativeVault.read(filePath(file)),
      read: (file: unknown) => nativeVault.read(filePath(file)),
      modify: (file: unknown, content: unknown) => nativeVault.write(filePath(file), content),
      create: (path: unknown, content = "") => nativeVault.create(path, content),
      delete: (file: unknown) => nativeVault.delete(filePath(file)),
      rename: (file: unknown, to: unknown) => nativeVault.rename(filePath(file), to),
    });
    this.metadataCache = Object.freeze({
      getFileCache: (file: unknown) => this.call("metadata.page", filePath(file)),
      getFirstLinkpathDest: (link: unknown, sourcePath: unknown) =>
        this.call("metadata.resolveLink", link, sourcePath),
      fileToLinktext: (file: unknown) => filePath(file).replace(/\.md$/i, ""),
    });
    this.fileManager = Object.freeze({
      renameFile: (file: unknown, to: unknown) => this.call("vault.rename", filePath(file), to),
      generateMarkdownLink: (file: unknown, _sourcePath: unknown, subpath = "", alias = "") => {
        const target = filePath(file).replace(/\.md$/i, "") + String(subpath || "");
        return `[[${target}${alias ? `|${String(alias)}` : ""}]]`;
      },
    });
    this.commands = Object.freeze({
      executeCommandById: (id: unknown) => this.call("workspace.executeCommand", id),
    });
    this.plugins = Object.freeze({
      getPlugin: (id: unknown) => this.call("plugins.get", id),
      getPlugins: () => this.call("plugins.get"),
    });
  }
}

function required<T extends (...args: never[]) => unknown>(service: T | undefined, method: string): T {
  if (!service) throw new Error(`${method} is unavailable in this host`);
  return service;
}

function filePath(value: unknown): string {
  return normalizeAppVaultPath(typeof value === "object" && value && "path" in value
    ? (value as { path: unknown }).path
    : value);
}

function fileFromPath(path: string | null): AppFile | null {
  if (!path) return null;
  const name = path.replace(/^.*\//, "");
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return { path, name, extension, basename: extension ? name.slice(0, -(extension.length + 1)) : name };
}

function isMarkdown(file: AppFile): boolean {
  return file.file_kind === "markdown" || file.path.toLocaleLowerCase().endsWith(".md");
}

function mapMaybe<T, U>(value: T | Promise<T>, mapper: (value: T) => U): U | Promise<U> {
  return value instanceof Promise ? value.then(mapper) : mapper(value);
}
