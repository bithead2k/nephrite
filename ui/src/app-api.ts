/**
 * One capability-checked host API for Nephrite plugins, compatibility scripts,
 * and native automation. Obsidian names are aliases over this object; they do
 * not receive a separate path around permission or path validation.
 *
 * The event system mirrors Obsidian's `Component.on/off/offref` subscriptions
 * so plugins that register listeners via `vault.on(...)`, `metadataCache.on(...)`,
 * or `workspace.on(...)` receive a consistent, permission-enforcing host rather
 * than a parallel in-iframe implementation.
 */

import { shortestWikilinkTarget } from "./wikilinks";

export type AppPermission =
  | "vault.read"
  | "vault.write"
  | "index.query"
  | "editor.read"
  | "editor.write"
  | "workspace.commands"
  | "workspace.views"
  | "network.request"
  | "shell.execute";

export type AppFile = {
  path: string;
  name: string;
  parent_path?: string;
  file_kind?: string;
  extension?: string;
  basename?: string;
};

export type AppEventReference = { name: string; callback: (...args: any[]) => void };

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
  requestUrl?: (request: unknown) => unknown | Promise<unknown>;
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
  "vault.exists": "vault.read",
  "metadata.page": "vault.read",
  "metadata.resolveLink": "vault.read",
  "metadata.resolvedLinks": "vault.read",
  "index.query": "index.query",
  "editor.getState": "editor.read",
  "editor.replaceSelection": "editor.write",
  "workspace.open": "vault.read",
  "workspace.getActiveFile": "editor.read",
  "workspace.executeCommand": "workspace.commands",
  "workspace.registerCommand": "workspace.commands",
  "workspace.registerView": "workspace.views",
  "network.requestUrl": "network.request",
  "plugins.get": "vault.read",
  "plugins.getService": "vault.read",
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
  "vault.exists": [0],
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

/**
 * A permission-checked event emitter shared by the vault, metadata cache, and
 * workspace surfaces. `on` returns a reference that `offref` removes, matching
 * Obsidian's `Component` contract while keeping disposal inside the host.
 */
export class AppEventEmitter {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(name: string, callback: (...args: any[]) => void): AppEventReference {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(callback);
    this.listeners.set(name, listeners);
    return { name, callback };
  }

  off(name: string, callback?: (...args: any[]) => void): void {
    if (!callback) { this.listeners.delete(name); return; }
    this.listeners.get(name)?.delete(callback);
  }

  offref(reference: AppEventReference): void {
    this.listeners.get(reference?.name)?.delete(reference?.callback);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const callback of this.listeners.get(name) ?? []) {
      try { callback(...args); } catch (error) { console.error(`[app event:${name}]`, error); }
    }
  }

  clear(): void { this.listeners.clear(); }
}

export type AppEventApi = {
  on: (name: string, callback: (...args: any[]) => void) => AppEventReference;
  off: (name: string, callback?: (...args: any[]) => void) => void;
  offref: (reference: AppEventReference) => void;
};

export type AppVaultApi = AppEventApi & {
  configDir: string;
  list: () => unknown;
  read: (path: unknown) => unknown;
  write: (path: unknown, content: unknown) => unknown;
  create: (path: unknown, content?: unknown) => unknown;
  rename: (from: unknown, to: unknown) => unknown;
  delete: (path: unknown) => unknown;
  exists: (path: unknown) => unknown;
};

export type AppMetadataApi = AppEventApi & {
  page: (path: unknown) => unknown;
  resolveLink: (link: unknown, sourcePath: unknown) => unknown;
  resolvedLinks: unknown;
};

export type AppWorkspaceApi = AppEventApi & {
  open: (path: unknown) => unknown;
  getActiveFile: () => unknown;
  executeCommand: (id: unknown) => unknown;
  registerCommand: (id: unknown, title: unknown, keywords?: unknown) => unknown;
  registerView: (id: unknown, title: unknown) => unknown;
};

export type AppIndexApi = { query: (sql: unknown) => unknown };
export type AppEditorApi = {
  getState: () => unknown;
  replaceSelection: (content: unknown) => unknown;
};
export type AppPluginsApi = {
  getPlugin: (id?: unknown) => unknown;
  getPlugins: () => unknown;
  getService: (id?: unknown) => unknown;
  loadData: () => unknown;
  saveData: (value: unknown) => unknown;
};
export type AppCommandsApi = { executeCommandById: (id: unknown) => unknown };
export type AppShellApi = { execute: (command: unknown, args?: unknown) => unknown };

/**
 * The capability-checked host. Every method routes through `call`, which
 * enforces permissions and normalizes vault-relative paths before reaching a
 * service. Obsidian-facing names are thin aliases; they never bypass this gate.
 */
export class NephriteApp {
  readonly apiVersion = 1;
  vault: AppVaultApi;
  readonly metadata: AppMetadataApi;
  readonly index: AppIndexApi;
  readonly editor: AppEditorApi;
  readonly workspace: AppWorkspaceApi;
  readonly plugins: AppPluginsApi;
  readonly commands: AppCommandsApi;
  readonly shell: AppShellApi;
  readonly events: AppEventEmitter;

  constructor(
    protected readonly services: AppHostServices,
    permissions: Iterable<AppPermission>,
  ) {
    this.permissions = new Set(permissions);
    this.events = new AppEventEmitter();
    const hostCall = this.call.bind(this);
    const handleEvents: AppEventApi = {
      on: (name, callback) => this.events.on(name, callback),
      off: (name, callback) => this.events.off(name, callback),
      offref: (reference) => this.events.offref(reference),
    };
    this.vault = Object.freeze({
      configDir: ".obsidian",
      list: () => this.call("vault.list"),
      read: (path: unknown) => this.call("vault.read", path),
      write: (path: unknown, content: unknown) => this.call("vault.write", path, content),
      create: (path: unknown, content = "") => this.call("vault.create", path, content),
      rename: (from: unknown, to: unknown) => this.call("vault.rename", from, to),
      delete: (path: unknown) => this.call("vault.delete", path),
      exists: (path: unknown) => this.call("vault.exists", path),
      on: handleEvents.on,
      off: handleEvents.off,
      offref: handleEvents.offref,
    });
    this.metadata = Object.freeze({
      page: (path: unknown) => this.call("metadata.page", path),
      resolveLink: (link: unknown, sourcePath: unknown) => this.call("metadata.resolveLink", link, sourcePath),
      get resolvedLinks() { return hostCall("metadata.resolvedLinks"); },
      on: handleEvents.on,
      off: handleEvents.off,
      offref: handleEvents.offref,
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
      on: handleEvents.on,
      off: handleEvents.off,
      offref: handleEvents.offref,
    });
    this.plugins = Object.freeze({
      getPlugin: (id: unknown) => this.call("plugins.get", id),
      getPlugins: () => this.call("plugins.get"),
      getService: (id: unknown) => this.call("plugins.getService", id),
      loadData: () => this.call("plugins.loadData"),
      saveData: (value: unknown) => this.call("plugins.saveData", value),
    });
    this.commands = Object.freeze({
      executeCommandById: (id: unknown) => this.call("workspace.executeCommand", id),
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
      case "vault.exists": return maybeBoolean(this.services.listFiles(), (files) =>
        (files as AppFile[]).some((file) => file.path === String(args[0])));
      case "metadata.page": return required(this.services.pageMetadata, method)(String(args[0]));
      case "metadata.resolveLink": return required(this.services.resolveLink, method)(String(args[0]), String(args[1]));
      case "metadata.resolvedLinks": return resolveLinksMap(this.services.listFiles(), this.services.pageMetadata, this.services.metadataSnapshot);
      case "index.query": return this.services.queryIndex(String(args[0]));
      case "editor.getState": return this.services.editorState();
      case "editor.replaceSelection": return required(this.services.replaceSelection, method)(String(args[0]));
      case "workspace.open": return this.services.openPath(String(args[0]));
      case "workspace.getActiveFile": return fileFromPath(this.services.editorState().path);
      case "workspace.executeCommand": return required(this.services.executeCommand, method)(String(args[0]));
      case "workspace.registerCommand": return required(this.services.registerCommand, method)(String(args[0]), String(args[1]), String(args[2] ?? ""));
      case "workspace.registerView": return required(this.services.registerView, method)(String(args[0]), String(args[1]));
      case "network.requestUrl": return required(this.services.requestUrl, method)(args[0]);
      case "plugins.get":
      case "plugins.getService": return this.services.pluginInfo?.(args[0] == null ? undefined : String(args[0])) ?? null;
      case "plugins.loadData": return this.services.loadPluginData?.() ?? null;
      case "plugins.saveData": return required(this.services.savePluginData, method)(args[0]);
      case "shell.execute": return required(this.services.executeShell, method)(String(args[0]), Array.isArray(args[1]) ? args[1].map(String) : []);
      default: throw new Error(`Unknown app API method: ${method}`);
    }
  }

  protected linkText(file: unknown): string {
    const path = filePath(file);
    const listed = this.services.listFiles();
    const files = Array.isArray(listed) ? listed : [];
    return shortestWikilinkTarget(path, files);
  }
}

/** Extended Obsidian vault surface projected over NephriteApp's permission gate. */
export type ObsidianVaultApi = AppVaultApi & {
  getName: () => string;
  getMarkdownFiles: () => unknown;
  getFiles: () => unknown;
  getAbstractFileByPath: (path: unknown) => unknown;
  cachedRead: (file: unknown) => unknown;
  read: (file: unknown) => unknown;
  modify: (file: unknown, content: unknown) => unknown;
  adapter: {
    read: (path: unknown) => unknown;
    write: (path: unknown, content: unknown) => unknown;
    exists: (path: unknown) => unknown;
    list: (folder: unknown) => unknown;
  };
};

/** Extended Obsidian workspace surface projected over NephriteApp's gate. */
export type ObsidianWorkspaceApi = AppWorkspaceApi & {
  openLinkText: (link: unknown, sourcePath: unknown) => unknown;
  getActiveFile: () => unknown;
  getLeaf: () => { openFile: (file: unknown) => unknown };
  getLeavesOfType: (type: unknown) => never[];
  getActiveViewOfType: (type: unknown) => null;
  onLayoutReady: (callback: () => void) => void;
};

export type ObsidianMetadataCacheApi = AppEventApi & {
  getFileCache: (file: unknown) => unknown;
  getFirstLinkpathDest: (link: unknown, sourcePath: unknown) => unknown;
  resolvedLinks: unknown;
  fileToLinktext: (file: unknown) => string;
};

export type ObsidianFileManagerApi = {
  renameFile: (file: unknown, to: unknown) => unknown;
  generateMarkdownLink: (file: unknown, sourcePath: unknown, subpath?: string, alias?: string) => string;
};

/**
 * Obsidian-compatible names inherit every security decision from NephriteApp.
 * Where Obsidian exposes richer helpers (getMarkdownFiles, resolvedLinks,
 * workspace leaves), this facade projects them over the same underlying
 * services — it does not open a separate, unvalidated path.
 */
export class ObsidianApp extends NephriteApp {
  readonly metadataCache: ObsidianMetadataCacheApi;
  readonly fileManager: ObsidianFileManagerApi;
  /** Narrowed type-only override; the runtime property is assigned in the constructor. */
  declare readonly commands: AppCommandsApi;
  declare readonly workspace: ObsidianWorkspaceApi;

  constructor(services: AppHostServices, permissions: Iterable<AppPermission>) {
    super(services, permissions);
    const hostCall = this.call.bind(this);
    const nativeVault = this.vault;
    const nativeMetadata = this.metadata;
    const nativeWorkspace = this.workspace;
    this.vault = Object.freeze({
      ...nativeVault,
      getName: () => "Nephrite vault",
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
      adapter: Object.freeze({
        read: (path: unknown) => nativeVault.read(normalizeAppVaultPath(path)),
        write: (path: unknown, content: unknown) => nativeVault.write(normalizeAppVaultPath(path), content),
        exists: (path: unknown) => nativeVault.exists(path),
        list: (folder: unknown) => mapMaybe(nativeVault.list(), (files) => {
          const prefix = String(folder ?? "").replace(/\/$/, "");
          const inFolder = (files as AppFile[]).filter((file) => file.path.startsWith(`${prefix}/`));
          return {
            files: inFolder.map((file) => file.path),
            folders: unique(inFolder.map((file) => file.parent_path ?? file.path.split("/").slice(0, -1).join("/")).filter((path) => path && path.startsWith(`${prefix}/`))),
          };
        }),
      }),
    }) as ObsidianVaultApi;
    this.metadataCache = Object.freeze({
      getFileCache: (file: unknown) => this.call("metadata.page", filePath(file)),
      getFirstLinkpathDest: (link: unknown, sourcePath: unknown) =>
        this.call("metadata.resolveLink", link, sourcePath),
      get resolvedLinks() { return hostCall("metadata.resolvedLinks"); },
      fileToLinktext: (file: unknown) => this.linkText(file),
      on: nativeMetadata.on,
      off: nativeMetadata.off,
      offref: nativeMetadata.offref,
    });
    this.fileManager = Object.freeze({
      renameFile: (file: unknown, to: unknown) => this.call("vault.rename", filePath(file), to),
      generateMarkdownLink: (file: unknown, _sourcePath: unknown, subpath = "", alias = "") => {
        const target = this.linkText(file) + String(subpath || "");
        return `[[${target}${alias ? `|${String(alias)}` : ""}]]`;
      },
    });
    this.commands = Object.freeze({
      executeCommandById: (id: unknown) => this.call("workspace.executeCommand", id),
    });
    this.workspace = Object.freeze({
      ...nativeWorkspace,
      openLinkText: (link: unknown, sourcePath: unknown) => {
        const target = this.call("metadata.resolveLink", link, sourcePath) as AppFile | null | Promise<AppFile | null>;
        return mapMaybe(target, (file) => file ? nativeWorkspace.open(file.path) : undefined);
      },
      getActiveFile: () => this.call("workspace.getActiveFile"),
      getLeaf: () => Object.freeze({ openFile: (file: unknown) => nativeWorkspace.open(filePath(file)) }),
      getLeavesOfType: () => [],
      getActiveViewOfType: () => null,
      onLayoutReady: (callback: () => void) => queueMicrotask(callback),
      on: nativeWorkspace.on,
      off: nativeWorkspace.off,
      offref: nativeWorkspace.offref,
    }) as ObsidianWorkspaceApi;
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

function maybeBoolean<T>(value: T | Promise<T>, mapper: (value: T) => boolean): boolean | Promise<boolean> {
  return mapMaybe(value, mapper);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Build an Obsidian-shaped `resolvedLinks` map ({ source -> { target -> count } })
 * from the vault file list and per-page metadata. Only resolved file paths are
 * exposed — never raw file contents — so the shape stays safe to project
 * through the permission gate.
 */
function resolveLinksMap(
  filesOrPromise: readonly AppFile[] | Promise<readonly AppFile[]>,
  pageMetadata?: (path: string) => unknown | Promise<unknown>,
  metadataSnapshot?: () => readonly unknown[] | Promise<readonly unknown[]>,
): Record<string, Record<string, number>> | Promise<Record<string, Record<string, number>>> {
  const build = async (files: readonly AppFile[]): Promise<Record<string, Record<string, number>>> => {
    const resolved: Record<string, Record<string, number>> = {};
    const linksByPath = new Map<string, unknown[]>();
    if (metadataSnapshot) {
      const snapshot = await metadataSnapshot();
      for (const entry of snapshot as Array<Record<string, unknown>>) {
        const path = String(entry.path ?? "");
        const links = Array.isArray(entry.links) ? entry.links : [];
        linksByPath.set(path, links);
      }
    } else if (pageMetadata) {
      for (const file of files) {
        const meta = await pageMetadata(file.path) as Record<string, unknown> | null;
        if (meta && Array.isArray(meta.links)) linksByPath.set(file.path, meta.links);
      }
    }
    for (const file of files) {
      const counts: Record<string, number> = {};
      for (const link of linksByPath.get(file.path) ?? []) {
        const target = typeof link === "string" ? link : (link as { path?: unknown }).path;
        const resolvedPath = resolveTarget(files, String(target ?? ""));
        if (resolvedPath) counts[resolvedPath] = (counts[resolvedPath] ?? 0) + 1;
      }
      resolved[file.path] = counts;
    }
    return resolved;
  };
  return filesOrPromise instanceof Promise ? filesOrPromise.then(build) : build(filesOrPromise);
}

function resolveTarget(files: readonly AppFile[], target: string): string | null {
  const clean = target.split(/[|#^]/)[0].replace(/\.md$/i, "").replace(/\\/g, "/").toLocaleLowerCase();
  if (!clean) return null;
  const match = files.find((file) =>
    file.path.replace(/\.md$/i, "").toLocaleLowerCase() === clean ||
    file.path.replace(/\.md$/i, "").toLocaleLowerCase().endsWith(`/${clean}`) ||
    file.path.replace(/\.md$/i, "").toLocaleLowerCase() === clean.split("/").at(-1),
  );
  return match?.path ?? null;
}
