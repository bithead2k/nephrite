import type { AppCommand } from "./command-bar";
import type { FileEntry } from "./types";
import { uiConfirm } from "./dialogs";
import {
  ObsidianApp,
  permissionForAppMethod,
  type AppHostServices,
  type AppPermission,
} from "./app-api";
import { installObsidianDom } from "./obsidian-dom";

export const PLUGIN_API_VERSION = 1;

export type PluginPermission = AppPermission;

export type PluginDescriptor = {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: PluginPermission[];
  api_version: number;
  min_app_version: string | null;
  source: string;
  compatibility?: "nephrite" | "obsidian";
  style?: string | null;
  assets?: Record<string, string>;
  enabled?: boolean;
};

export type PluginStatus = PluginDescriptor & {
  enabled: boolean;
  loaded: boolean;
  error: string | null;
  hasSettings: boolean;
};

export type PluginHostServices = AppHostServices & {
  listFiles: () => readonly FileEntry[];
  showView: (title: string, result: PluginViewResult) => void;
  readPluginData?: (id: string) => unknown | Promise<unknown>;
  writePluginData?: (id: string, value: unknown) => void | Promise<void>;
  persistPluginEnabled?: (id: string, enabled: boolean) => void | Promise<void>;
};

export type PluginViewResult = { type?: "text" | "markdown"; content?: string } | string | null;

type Contribution = { id: string; title: string; keywords: string; pluginId: string; kind: "command" | "view" | "ribbon" | "status"; icon?: string };
type RpcRequest = { nephritePlugin: true; pluginId: string; type: "request"; requestId: number; method: string; args: unknown[] };
type PluginMessage = RpcRequest | {
  nephritePlugin: true;
  pluginId: string;
  type: "ready" | "error" | "processor-registered" | "settings-tab";
  message?: string;
  kind?: "post" | "code";
  language?: string;
};

export function permissionForPluginMethod(method: string): PluginPermission | null {
  return permissionForAppMethod(method);
}

export function validatePluginDescriptor(plugin: PluginDescriptor): string | null {
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(plugin.id)) return "Invalid plugin id";
  if (!plugin.name.trim()) return "Plugin name is required";
  if (!plugin.version.trim()) return "Plugin version is required";
  if (new Set(plugin.permissions).size !== plugin.permissions.length) return "Duplicate plugin permission";
  if (plugin.api_version !== PLUGIN_API_VERSION) return `Requires plugin API ${plugin.api_version}`;
  return null;
}

export function transformPluginModuleSource(source: string): string {
  // Regex-based ESM lowering must never interpret documentation emitted by a
  // bundler as executable syntax (Svelte bundles commonly contain comments
  // such as `export let metadata`). Protect comments with inert placeholders
  // first, while respecting quoted and template strings.
  const comments: string[] = [];
  let protectedSource = "";
  let quote = "";
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (quote) {
      protectedSource += character;
      if (character === "\\") {
        protectedSource += source[index + 1] || "";
        index += 2;
        continue;
      }
      if (character === quote) quote = "";
      index++;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      protectedSource += character;
      index++;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? source.length : end;
      const id = comments.push(source.slice(index, stop)) - 1;
      protectedSource += `/*__NEPHRITE_MODULE_COMMENT_${id}__*/`;
      if (end >= 0) protectedSource += "\n";
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      const id = comments.push(source.slice(index, stop)) - 1;
      protectedSource += `/*__NEPHRITE_MODULE_COMMENT_${id}__*/`;
      index = stop;
      continue;
    }
    protectedSource += character;
    index++;
  }
  const exportedDeclarations: string[] = [];
  let reexportSequence = 0;
  let importSequence = 0;
  let output = protectedSource
    .replace(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']\s*;?/g, "const $1 = require(\"$2\");")
    .replace(/\bimport\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s+from\s+["']([^"']+)["']\s*;?/g, (_all, defaultName: string, names: string, moduleName: string) => {
      const variable = `__nephriteImport${importSequence++}`;
      const bindings = names.split(",").map((name) => name.trim().replace(/\s+as\s+/, ": ")).join(", ");
      return `const ${variable} = require(${JSON.stringify(moduleName)}); const ${defaultName} = ${variable}?.default ?? ${variable}; const { ${bindings} } = ${variable};`;
    })
    .replace(/\bimport\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']\s*;?/g, (_all, names: string, moduleName: string) => {
      const bindings = names.split(",").map((name) => name.trim().replace(/\s+as\s+/, ": ")).join(", ");
      return `const { ${bindings} } = require(${JSON.stringify(moduleName)});`;
    })
    .replace(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']\s*;?/g, (_all, name: string, moduleName: string) =>
      `const ${name} = (() => { const value = require(${JSON.stringify(moduleName)}); return value?.default ?? value; })();`)
    .replace(/\bimport\s+["']([^"']+)["']\s*;?/g, "require(\"$1\");")
    .replace(/\bexport\s+\*\s+from\s+["']([^"']+)["']\s*;?/g, "Object.assign(module.exports, require(\"$1\"));")
    .replace(/\bexport\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']\s*;?/g, (_all, names: string, moduleName: string) => {
      const variable = `__nephriteReexport${reexportSequence++}`;
      const assignments = names.split(",").map((entry) => {
        const [local, exported = local] = entry.trim().split(/\s+as\s+/);
        return `module.exports[${JSON.stringify(exported)}] = ${variable}[${JSON.stringify(local)}];`;
      }).join("\n");
      return `const ${variable} = require(${JSON.stringify(moduleName)});\n${assignments}`;
    })
    .replace(/\bexport\s+(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g, (_all, kind: string, name: string) => {
      exportedDeclarations.push(name);
      return `${kind} ${name}`;
    })
    .replace(/\bexport\s+\{([^}]+)\}\s*;?/g, (_all, names: string) => names.split(",").map((entry) => {
      const [local, exported = local] = entry.trim().split(/\s+as\s+/);
      return `module.exports[${JSON.stringify(exported)}] = ${local};`;
    }).join("\n"))
    .replace(/\bexport\s+default\s+/g, "module.exports.default = ");
  if (exportedDeclarations.length) {
    output += "\n" + exportedDeclarations.map((name) => `module.exports[${JSON.stringify(name)}] = ${name};`).join("\n");
  }
  output = output.replace(/\/\*__NEPHRITE_MODULE_COMMENT_(\d+)__\*\//g, (_token, id: string) => comments[Number(id)] || "");
  try { new Function("require", "module", "exports", output); }
  catch (error) { throw new Error(`Plugin module contains unsupported or malformed syntax: ${String(error)}`); }
  return output;
}

export function pluginIframeDocument(plugin: PluginDescriptor): string {
  const bootstrap = `
(() => {
  "use strict";
  const __name = (value) => value;
  (${installObsidianDom.toString()})(window);
  window.activeDocument = window.document;
  window.activeWindow = window;
  window.createEl = (tag, options, callback) => { const element = document.createElement(tag); if (typeof options === "string") element.className = options; else { if (options?.cls) element.addClass(...(Array.isArray(options.cls) ? options.cls : [options.cls])); if (options?.text != null) element.setText(options.text); if (options?.attr) element.setAttrs(options.attr); } callback?.(element); return element; };
  window.createDiv = (options, callback) => window.createEl("div", options, callback);
  window.createSpan = (options, callback) => window.createEl("span", options, callback);
  window.createSvg = (tag, attrs) => { const element = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attrs || {})) element.setAttribute(key, String(value)); return element; };
  window.createFragment = (callback) => { const fragment = document.createDocumentFragment(); callback?.(fragment); return fragment; };
  const pluginId = ${JSON.stringify(plugin.id)};
  const pluginAssets = ${JSON.stringify(plugin.assets ?? {})};
  const resourcePath = (path) => {
    const normalized = String(path || "").replace(/\\\\/g, "/").replace(/^\\.\\//, "");
    const prefixes = [".obsidian/plugins/" + pluginId + "/", pluginId + "/"];
    const relative = prefixes.reduce((value, prefix) => value.startsWith(prefix) ? value.slice(prefix.length) : value, normalized);
    return pluginAssets[relative] || pluginAssets[normalized] || "";
  };
  const callbacks = new Map();
  const commandRegistry = Object.create(null);
  const views = new Map();
  const loadHandlers = [];
  const unloadHandlers = [];
  let fileSnapshot = [];
  let abstractFileSnapshot = new Map();
  let metadataSnapshot = new Map();
  let resolvedLinksSnapshot = Object.create(null);
  let activeFileSnapshot = null;
  const eventHandlers = new Map();
  const eventApi = Object.freeze({
    on: (name, callback) => { const handlers = eventHandlers.get(name) || new Set(); handlers.add(callback); eventHandlers.set(name, handlers); return { name, callback }; },
    off: (name, callback) => { const handlers = eventHandlers.get(name); if (!handlers) return; if (callback == null) handlers.clear(); else handlers.delete(callback); },
    offref: (reference) => eventHandlers.get(reference?.name)?.delete(reference?.callback),
    trigger: (name, ...args) => { for (const callback of eventHandlers.get(name) || []) try { callback(...args); } catch (error) { console.error(error); } },
  });
  let sequence = 0;
  let uiSequence = 0;
  const pending = new Map();
  const send = (method, args) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    pending.set(requestId, { resolve, reject });
    parent.postMessage({ nephritePlugin: true, pluginId, type: "request", requestId, method, args }, "*");
  });
  const registerCommand = ({ id, name, title, keywords = "", callback }) => {
    if (typeof callback !== "function") throw new Error("Plugin command callback is required");
    callbacks.set(id, callback);
    commandRegistry[id] = { id, name: name || title || id, callback };
    void send("workspace.registerCommand", [id, name || title || id, keywords]);
    return commandRegistry[id];
  };
  const registerView = async ({ id, name, title, onOpen }) => {
    if (typeof onOpen !== "function") throw new Error("Plugin view onOpen callback is required");
    views.set(id, onOpen);
    return send("workspace.registerView", [id, name || title || id]);
  };
  const nephrite = Object.freeze({
    apiVersion: ${PLUGIN_API_VERSION},
    onLoad: (callback) => loadHandlers.push(callback),
    onUnload: (callback) => unloadHandlers.push(callback),
    vault: Object.freeze({
      configDir: ".obsidian",
      list: () => send("vault.list", []),
      read: (path) => send("vault.read", [path]),
      write: (path, content) => send("vault.write", [path, content]),
      create: (path, content = "") => send("vault.create", [path, content]),
      rename: (from, to) => send("vault.rename", [from, to]),
      delete: (path) => send("vault.delete", [path]),
      exists: (path) => send("vault.exists", [path]),
      on: eventApi.on,
      off: eventApi.off,
      offref: eventApi.offref,
      trigger: eventApi.trigger,
    }),
    index: Object.freeze({ query: (sql) => send("index.query", [sql]) }),
    metadata: Object.freeze({
      page: (path) => send("metadata.page", [path]),
      resolveLink: (link, sourcePath) => send("metadata.resolveLink", [link, sourcePath]),
      get resolvedLinks() { return send("metadata.resolvedLinks", []); },
      on: eventApi.on,
      off: eventApi.off,
      offref: eventApi.offref,
      trigger: eventApi.trigger,
    }),
    editor: Object.freeze({
      getState: () => send("editor.getState", []),
      replaceSelection: (content) => send("editor.replaceSelection", [content]),
      setValue: (content) => send("editor.setValue", [content]),
      setSelection: (from, to = from) => send("editor.setSelection", [from, to]),
    }),
    workspace: Object.freeze({
      open: (path) => send("workspace.open", [path]),
      getActiveFile: () => send("workspace.getActiveFile", []),
      executeCommand: (id) => send("workspace.executeCommand", [id]),
      registerCommand,
      registerView,
      renderMarkdown: (markdown, sourcePath = "") => send("workspace.renderMarkdown", [markdown, sourcePath]),
      on: eventApi.on,
      off: eventApi.off,
      offref: eventApi.offref,
      trigger: eventApi.trigger,
    }),
    plugins: Object.freeze({
      plugins: Object.create(null),
      manifests: Object.create(null),
      getPlugin: (id) => send("plugins.get", [id]),
      getPlugins: () => send("plugins.get", []),
      getService: (id) => send("plugins.getService", [id]),
      loadData: () => send("plugins.loadData", []),
      saveData: (value) => send("plugins.saveData", [value]),
    }),
    commands: Object.freeze({ executeCommandById: (id) => send("workspace.executeCommand", [id]) }),
    events: Object.freeze({ on: eventApi.on, off: eventApi.off, offref: eventApi.offref }),
    shell: Object.freeze({ execute: (command, args = []) => send("shell.execute", [command, args]) }),
    network: Object.freeze({ requestUrl: (request) => send("network.requestUrl", [request]) }),
  });
  window.nephrite = nephrite;
  Object.isEmpty ||= (value) => value == null || Object.keys(value).length === 0;
  Object.each ||= (value, callback, context) => Object.keys(value || {}).forEach((key) => callback.call(context, value[key], key, value));
  Array.combine ||= (arrays) => arrays.flat();
  Array.prototype.first ||= function () { return this[0]; };
  Array.prototype.last ||= function () { return this[this.length - 1]; };
  Array.prototype.contains ||= function (value) { return this.includes(value); };
  Array.prototype.remove ||= function (value) { const index = this.indexOf(value); if (index >= 0) this.splice(index, 1); return index >= 0; };
  Array.prototype.shuffle ||= function () { for (let index = this.length - 1; index > 0; index -= 1) { const other = Math.floor(Math.random() * (index + 1)); [this[index], this[other]] = [this[other], this[index]]; } return this; };
  Array.prototype.unique ||= function () { return [...new Set(this)]; };
  Math.clamp ||= (value, min, max) => Math.min(max, Math.max(min, value));
  Math.square ||= (value) => value * value;
  String.isString ||= (value) => typeof value === "string" || value instanceof String;
  String.prototype.contains ||= function (value) { return this.includes(value); };
  Number.isNumber ||= (value) => typeof value === "number" && !Number.isNaN(value);
  const installElementHelpers = (prototype) => {
    prototype.empty ||= function () { this.replaceChildren(); };
    prototype.addClass ||= function (...classes) { this.classList.add(...classes.flatMap((value) => String(value).split(/\\s+/)).filter(Boolean)); };
    prototype.addClasses ||= function (classes) { this.classList.add(...classes); };
    prototype.removeClass ||= function (...classes) { this.classList.remove(...classes.flatMap((value) => String(value).split(/\\s+/)).filter(Boolean)); };
    prototype.removeClasses ||= function (classes) { this.classList.remove(...classes); };
    prototype.toggleClass ||= function (name, value) { this.classList.toggle(name, value); };
    prototype.hasClass ||= function (name) { return this.classList.contains(name); };
    prototype.setText ||= function (value) { this.textContent = String(value ?? ""); };
    prototype.getText ||= function () { return this.textContent || ""; };
    prototype.setAttr ||= function (name, value) { if (typeof name === "object") Object.entries(name).forEach(([key, item]) => this.setAttribute(key, String(item))); else this.setAttribute(name, String(value)); };
    prototype.setAttrs ||= function (attrs) { this.setAttr(attrs); };
    prototype.getAttr ||= function (name) { return this.getAttribute(name); };
    prototype.createEl ||= function (tag, options = {}, callback) { const child = document.createElement(tag); if (typeof options === "string") options = { text: options }; if (options.text != null) child.textContent = String(options.text); if (options.cls) child.addClass(...(Array.isArray(options.cls) ? options.cls : [options.cls])); if (options.attr) child.setAttr(options.attr); if (options.href) child.setAttribute("href", options.href); if (options.value != null) child.value = options.value; this.append(child); callback?.(child); return child; };
    prototype.createDiv ||= function (options, callback) { return this.createEl("div", options, callback); };
    prototype.createSpan ||= function (options, callback) { return this.createEl("span", options, callback); };
    prototype.createSvg ||= function (tag, attrs) { const child = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attrs || {})) child.setAttribute(key, String(value)); this.append(child); return child; };
    prototype.show ||= function () { this.style.display = ""; };
    prototype.hide ||= function () { this.style.display = "none"; };
    prototype.toggle ||= function (visible) { this.style.display = visible ? "" : "none"; };
    prototype.isShown ||= function () { return this.style.display !== "none"; };
    prototype.detach ||= function () { this.remove(); };
    prototype.insertAfter ||= function (other) { other.parentNode?.insertBefore(this, other.nextSibling); };
    prototype.on ||= function (type, selector, listener, options) { const delegated = selector ? (event) => { const target = event.target?.closest?.(selector); if (target && this.contains(target)) listener.call(target, event, target); } : listener; this.addEventListener(type, delegated, options); return delegated; };
    prototype.off ||= function (type, listener, options) { this.removeEventListener(type, listener, options); };
    prototype.trigger ||= function (type) { this.dispatchEvent(new Event(type, { bubbles: true })); };
  };
  installElementHelpers(Element.prototype);
  installElementHelpers(DocumentFragment.prototype);
  document.documentElement.addClass("app-container");
  const pathOf = (file) => typeof file === "object" && file ? file.path : file;
  const debounceFn = (callback, wait = 0, immediate = false) => { let timer; const wrapped = (...args) => { const callNow = immediate && !timer; clearTimeout(timer); timer = setTimeout(() => { timer = undefined; if (!immediate) callback(...args); }, wait); if (callNow) return callback(...args); }; wrapped.cancel = () => { clearTimeout(timer); timer = undefined; }; return wrapped; };
  let activeWorkspaceLeaf = null;
  const ensureWorkspaceLeaf = () => activeWorkspaceLeaf ||= new WorkspaceLeaf(app);
  const statusBarContainer = document.createElement("div");
  statusBarContainer.className = "status-bar";
  const app = window.app = Object.freeze({
    vault: Object.freeze({
      configDir: nephrite.vault.configDir,
      getName: () => "Nephrite vault",
      getRoot: () => abstractFileSnapshot.get("") || new TFolder(""),
      getMarkdownFiles: () => fileSnapshot.filter((file) => file.file_kind === "markdown" || /\\.md$/i.test(file.path)),
      getFiles: () => fileSnapshot.slice(),
      getAbstractFileByPath: (path) => abstractFileSnapshot.get(String(path).replace(/^\\/+|\\/+$/g, "")) || null,
      getFileByPath: (path) => { const file = abstractFileSnapshot.get(String(path).replace(/^\\/+|\\/+$/g, "")); return file instanceof TFile ? file : null; },
      getFolderByPath: (path) => { const file = abstractFileSnapshot.get(String(path).replace(/^\\/+|\\/+$/g, "")); return file instanceof TFolder ? file : null; },
      read: (file) => nephrite.vault.read(pathOf(file)),
      cachedRead: (file) => nephrite.vault.read(pathOf(file)),
      modify: (file, content) => nephrite.vault.write(pathOf(file), content),
      append: (file, content) => nephrite.vault.read(pathOf(file)).then((current) => nephrite.vault.write(pathOf(file), String(current) + String(content))),
      process: (file, callback) => nephrite.vault.read(pathOf(file)).then(async (current) => { const next = await callback(String(current)); if (typeof next !== "string") throw new Error("Vault.process callback must return a string"); if (next !== current) await nephrite.vault.write(pathOf(file), next); return next; }),
      create: nephrite.vault.create,
      copy: (file, to) => nephrite.vault.read(pathOf(file)).then((content) => nephrite.vault.create(to, content)),
      delete: (file) => nephrite.vault.delete(pathOf(file)),
      rename: (file, to) => nephrite.vault.rename(pathOf(file), to),
      exists: (path) => nephrite.vault.exists(path),
      on: eventApi.on,
      off: eventApi.off,
      offref: eventApi.offref,
      trigger: eventApi.trigger,
      adapter: Object.freeze({
        read: (path) => nephrite.vault.read(path),
        write: (path, content) => nephrite.vault.write(path, content),
        exists: (path) => nephrite.vault.exists(path),
        remove: (path) => nephrite.vault.delete(path),
        rename: (from, to) => nephrite.vault.rename(from, to),
        copy: (from, to) => nephrite.vault.read(from).then((content) => nephrite.vault.create(to, content)),
        mkdir: async () => {},
        rmdir: (path) => nephrite.vault.delete(path),
        list: (folder) => { const prefix = String(folder).replace(/\\/$/, ""); const entries = [...abstractFileSnapshot.values()].filter((file) => file.path.startsWith(prefix ? prefix + "/" : "") && file.path !== prefix); return { files: entries.filter((file) => file instanceof TFile).map((file) => file.path), folders: entries.filter((file) => file instanceof TFolder).map((file) => file.path) }; },
        getResourcePath: resourcePath,
      }),
    }),
    metadataCache: Object.freeze({
      getFileCache: (file) => metadataSnapshot.get(pathOf(file)) || null,
      getFirstLinkpathDest: (link, sourcePath) => {
        const clean = String(link).split(/[|#^]/)[0].replace(/\\.md$/i, "").toLowerCase();
        const sourceFolder = String(sourcePath || "").replace(/\\/[^/]*$/, "");
        return fileSnapshot.find((file) => file.path.replace(/\\.md$/i, "").toLowerCase() === clean)
          || fileSnapshot.find((file) => file.path.replace(/\\.md$/i, "").toLowerCase() === (sourceFolder ? sourceFolder + "/" + clean : clean))
          || fileSnapshot.find((file) => file.path.replace(/^.*\\//, "").replace(/\\.md$/i, "").toLowerCase() === clean.replace(/^.*\\//, ""))
          || null;
      },
      get resolvedLinks() { return resolvedLinksSnapshot; },
      getCache: (path) => metadataSnapshot.get(String(path)) || null,
      fileToLinktext: (file) => String(pathOf(file)).replace(/\.md$/i, ""),
      on: eventApi.on,
      off: eventApi.off,
      offref: eventApi.offref,
      trigger: eventApi.trigger,
    }),
    workspace: Object.freeze({
      openLinkText: (link, sourcePath) => send("metadata.resolveLink", [link, sourcePath]).then((file) => file && nephrite.workspace.open(file.path)),
      getActiveFile: () => activeFileSnapshot,
      getLeaf: () => ensureWorkspaceLeaf(),
      getMostRecentLeaf: () => ensureWorkspaceLeaf(),
      getLeftLeaf: () => ensureWorkspaceLeaf(),
      getRightLeaf: () => ensureWorkspaceLeaf(),
      getLeafById: (id) => ensureWorkspaceLeaf().id === id ? ensureWorkspaceLeaf() : null,
      getLeavesOfType: (type) => ensureWorkspaceLeaf().getViewState().type === type ? [ensureWorkspaceLeaf()] : [],
      getActiveViewOfType: (constructor) => ensureWorkspaceLeaf().view instanceof constructor ? ensureWorkspaceLeaf().view : null,
      getActiveLeaf: () => ensureWorkspaceLeaf(),
      iterateAllLeaves: (callback) => callback(ensureWorkspaceLeaf()),
      setActiveLeaf: (leaf) => { activeWorkspaceLeaf = leaf; eventApi.trigger("active-leaf-change", leaf); },
      revealLeaf: (leaf) => { activeWorkspaceLeaf = leaf; eventApi.trigger("active-leaf-change", leaf); return Promise.resolve(); },
      detachLeavesOfType: (type) => { if (activeWorkspaceLeaf?.getViewState().type === type) activeWorkspaceLeaf.detach(); },
      onLayoutReady: (callback) => queueMicrotask(callback),
      registerHoverLinkSource: () => {},
      unregisterHoverLinkSource: () => {},
      on: eventApi.on,
      off: eventApi.off,
      offref: eventApi.offref,
      trigger: eventApi.trigger,
    }),
    fileManager: Object.freeze({
      renameFile: (file, to) => nephrite.vault.rename(pathOf(file), to),
      generateMarkdownLink: (file, _sourcePath, subpath = "", alias = "") => {
        const target = String(pathOf(file)).replace(/\.md$/i, "") + String(subpath || "");
        return "[[" + target + (alias ? "|" + alias : "") + "]]";
      },
    }),
    embedRegistry: Object.freeze({ embedByExtension: Object.freeze({ md: () => ({ editMode: new EmbeddedEditor(), editable: false, load() {}, unload() {}, showEditor() {} }) }) }),
    commands: Object.freeze({ commands: commandRegistry, executeCommandById: (id) => callbacks.has(id) ? callbacks.get(id)?.() : nephrite.workspace.executeCommand(id), removeCommand: (id) => { callbacks.delete(id); delete commandRegistry[id]; } }),
    statusBar: Object.freeze({ containerEl: statusBarContainer }),
    customCss: (() => { const enabledSnippets = new Set(); return Object.freeze({ enabledSnippets, snippets: [], getSnippetPath: (name) => ".obsidian/snippets/" + String(name).replace(/\\.css$/i, "") + ".css", setCssEnabledStatus: (name, enabled) => { if (enabled) enabledSnippets.add(name); else enabledSnippets.delete(name); }, readSnippets: async () => [...enabledSnippets] }); })(),
    setting: Object.freeze({ activeTab: { containerEl: document.createElement("div") }, open: () => {}, close: () => {}, openTabById: () => {} }),
    internalPlugins: Object.freeze({
      getPluginById: (id) => id === "daily-notes" ? Object.freeze({ enabled: true, instance: Object.freeze({ options: Object.freeze({ folder: "", format: "YYYY-MM-DD", template: "" }) }) }) : null,
      getEnabledPluginById: (id) => id === "daily-notes" ? Object.freeze({ options: Object.freeze({ folder: "", format: "YYYY-MM-DD", template: "" }) }) : null,
    }),
    plugins: Object.freeze({
      plugins: Object.create(null),
      manifests: Object.create(null),
      getPlugin: (id) => send("plugins.get", [id]),
      getPlugins: () => send("plugins.get", []),
      getService: (id) => send("plugins.getService", [id]),
      loadData: () => send("plugins.loadData", []),
      saveData: (value) => send("plugins.saveData", [value]),
    }),
  });
  class Events {
    constructor() { this._events = new Map(); }
    on(name, callback, context) {
      const handlers = this._events.get(name) || new Set();
      const reference = { name, callback, context, emitter: this };
      handlers.add(reference); this._events.set(name, handlers); return reference;
    }
    once(name, callback, context) { const reference = this.on(name, (...args) => { this.offref(reference); callback.apply(context, args); }, context); return reference; }
    off(name, callback) { const handlers = this._events.get(name); if (!handlers) return; for (const reference of handlers) if (!callback || reference.callback === callback) handlers.delete(reference); }
    offref(reference) { reference?.emitter?._events?.get(reference.name)?.delete(reference); }
    trigger(name, ...args) { for (const reference of [...(this._events.get(name) || [])]) reference.callback.apply(reference.context, args); }
  }
  class BaseComponent extends Events {
    then(callback) { callback(this); return this; }
    setDisabled(value) { this.disabled = !!value; return this; }
  }
  class Component extends BaseComponent {
    constructor() { super(); this._disposers = []; this._children = new Set(); this._loaded = false; }
    load() { if (!this._loaded) { this._loaded = true; const result = this.onload?.(); for (const child of this._children) child.load?.(); return result; } }
    addChild(child) { this._children.add(child); if (this._loaded) child.load?.(); return child; }
    removeChild(child) { if (this._children.delete(child)) child.unload?.(); return child; }
    register(callback) { if (typeof callback === "function") this._disposers.push(callback); return callback; }
    registerEvent(reference) { this.register(() => reference?.emitter?.offref?.(reference) ?? eventApi.offref(reference)); return reference; }
    registerDomEvent(target, type, callback, options) {
      target?.addEventListener?.(type, callback, options);
      return this.register(() => target?.removeEventListener?.(type, callback, options));
    }
    registerInterval(id) { return this.register(() => clearInterval(id)); }
    unload() { if (!this._loaded && !this._disposers.length && !this._children.size) return; for (const child of [...this._children].reverse()) child.unload?.(); this._children.clear(); while (this._disposers.length) try { this._disposers.pop()?.(); } catch {} this._loaded = false; return this.onunload?.(); }
  }
  class TAbstractFile { constructor(path = "") { this.path = path; this.name = path.split("/").pop() || path; } }
  class TFile extends TAbstractFile {
    constructor(path = "") { super(path); this.extension = this.name.includes(".") ? this.name.split(".").pop() : ""; this.basename = this.extension ? this.name.slice(0, -(this.extension.length + 1)) : this.name; this.parent = null; this.stat = { ctime: 0, mtime: 0, size: 0 }; }
  }
  class TFolder extends TAbstractFile { constructor(path = "") { super(path); this.children = []; this.parent = null; } }
  const hydrateFiles = (files) => {
    const abstracts = new Map();
    const root = new TFolder(""); root.name = ""; abstracts.set("", root);
    const folderFor = (path) => {
      const normalized = String(path || "").replace(/^\\/+|\\/+$/g, "");
      if (abstracts.has(normalized)) return abstracts.get(normalized);
      const parentPath = normalized.split("/").slice(0, -1).join("/");
      const folder = new TFolder(normalized); folder.parent = folderFor(parentPath); folder.parent.children.push(folder); abstracts.set(normalized, folder); return folder;
    };
    const hydrated = (files || []).map((raw) => {
      const file = Object.assign(new TFile(raw.path), raw);
      const parentPath = file.path.split("/").slice(0, -1).join("/");
      file.parent = folderFor(parentPath); file.parent.children.push(file);
      file.stat = { ctime: Number(raw.ctime ?? raw.created_at ?? 0), mtime: Number(raw.mtime ?? raw.modified_at ?? 0), size: Number(raw.size ?? raw.size_bytes ?? 0) };
      abstracts.set(file.path, file); return file;
    });
    abstractFileSnapshot = abstracts;
    return hydrated;
  };
  class View extends Component {
    constructor(leaf) { super(); this.leaf = leaf; this.app = app; this.containerEl = document.createElement("div"); this.icon = "document"; this.navigation = false; }
    getViewType() { return "empty"; } getDisplayText() { return this.getViewType(); } getIcon() { return this.icon; }
  }
  class FileView extends View {
    constructor(leaf) { super(leaf); this.file = activeFileSnapshot; this.navigation = true; }
    getState() { return { file: this.file?.path || null }; }
    async setState(state) { if (state?.file) await this.leaf.openFile(fileSnapshot.find((file) => file.path === state.file) || { path: state.file }); }
  }
  class TextFileView extends FileView {
    constructor(leaf) { super(leaf); this.data = ""; this.requestSave = debounceFn(() => this.file && nephrite.vault.write(this.file.path, this.data), 250); }
    getViewData() { return this.data; } setViewData(data, _clear) { this.data = String(data ?? ""); } clear() { this.data = ""; }
  }
  class MarkdownView extends TextFileView {
    constructor(leaf) { super(leaf); this.contentEl = this.containerEl; this.editor = null; this.currentMode = { type: "source" }; }
    getViewType() { return "markdown"; }
    getDisplayText() { return this.file?.basename || this.file?.name || "Markdown"; }
    getMode() { return this.currentMode.type; }
    async setMode(mode) { this.currentMode = { type: mode }; }
  }
  class WorkspaceLeaf extends Events {
    constructor(workspace) { super(); this.workspace = workspace; this.id = "nephrite-active-leaf"; this.view = new MarkdownView(this); this.containerEl = this.view.containerEl; }
    async openFile(file, _openState) { this.view.file = file; activeFileSnapshot = file; await nephrite.workspace.open(pathOf(file)); eventApi.trigger("file-open", file); eventApi.trigger("active-leaf-change", this); }
    async open(view) { this.view = view; view.leaf = this; await view.load?.(); }
    async setViewState(state) { this._state = { type: state?.type || "empty", state: state?.state || {}, active: state?.active !== false }; if (this._state.type === "markdown") { if (!(this.view instanceof MarkdownView)) this.view = new MarkdownView(this); await this.view.setState(this._state.state); } else if (views.has(this._state.type)) { const result = await views.get(this._state.type)?.(); this.view = Object.assign(new View(this), { contentEl: this.containerEl, result, getViewType: () => this._state.type }); } return this; }
    getViewState() { return this._state || { type: this.view?.getViewType?.() || "empty", state: this.view?.getState?.() || {}, active: true }; }
    getRoot() { return this; } getContainer() { return this; } setGroup() {} setPinned() {} togglePinned() {}
    detach() { this.view?.unload?.(); if (activeWorkspaceLeaf === this) activeWorkspaceLeaf = null; eventApi.trigger("active-leaf-change", null); }
  }
  class Notice { constructor(message) { console.info("[Obsidian Notice]", message); this.message = String(message); } hide() {} }
  class Modal extends Component {
    constructor(app) {
      super(); this.app = app; this.scope = new Scope();
      this.modalEl = document.createElement("div"); this.modalEl.className = "modal";
      this.titleEl = document.createElement("h2"); this.titleEl.className = "modal-title";
      this.contentEl = document.createElement("div"); this.contentEl.className = "modal-content";
      this.closeButtonEl = document.createElement("button"); this.closeButtonEl.className = "modal-close-button"; this.closeButtonEl.textContent = "×"; this.closeButtonEl.addEventListener("click", () => this.close());
      this.modalEl.append(this.closeButtonEl, this.titleEl, this.contentEl);
    }
    setTitle(value) { this.titleEl.textContent = String(value ?? ""); return this; }
    open() { document.body.className = "plugin-modal-host"; document.body.replaceChildren(this.modalEl); this.load(); parent.postMessage({ nephritePlugin: true, pluginId, type: "modal-open" }, "*"); }
    close() { const result = this.unload(); parent.postMessage({ nephritePlugin: true, pluginId, type: "modal-close" }, "*"); return result; }
    onOpen() {} onClose() {}
    onunload() { this.onClose(); }
  }
  class ItemView extends View { constructor(leaf) { super(leaf); this.contentEl = this.containerEl; } }
  class MarkdownRenderChild extends Component { constructor(containerEl) { super(); this.containerEl = containerEl; } }
  class MenuItem {
    setTitle(value) { this.title = value; return this; }
    setIcon(value) { this.icon = value; return this; }
    setChecked(value) { this.checked = !!value; return this; }
    setDisabled(value) { this.disabled = !!value; return this; }
    setSection(value) { this.section = value; return this; }
    setSubmenu() { this.submenu = new Menu(); return this.submenu; }
    onClick(callback) { this.callback = callback; return this; }
  }
  class MenuSeparator {}
  class Menu {
    constructor() { this.items = []; this.dom = document.createElement("div"); this.dom.className = "menu"; }
    addItem(callback) { const item = new MenuItem(); callback(item); this.items.push(item); return this; }
    addSeparator() { this.items.push(new MenuSeparator()); return this; }
    render() { this.dom.replaceChildren(); for (const item of this.items) { if (item instanceof MenuSeparator) { const separator = document.createElement("div"); separator.className = "menu-separator"; this.dom.append(separator); continue; } const button = document.createElement("button"); button.className = "menu-item"; button.disabled = !!item.disabled; button.textContent = String(item.title ?? ""); if (item.icon) button.dataset.icon = item.icon; if (item.checked != null) button.setAttribute("aria-checked", String(item.checked)); button.addEventListener("click", (event) => { item.callback?.(event); this.hide(); }); this.dom.append(button); } }
    showAtMouseEvent(event) { return this.showAtPosition({ x: event?.clientX || 0, y: event?.clientY || 0 }); }
    showAtPosition(position) { this.render(); this.dom.style.left = Number(position?.x || 0) + "px"; this.dom.style.top = Number(position?.y || 0) + "px"; document.body.className = "plugin-menu-host"; document.body.replaceChildren(this.dom); parent.postMessage({ nephritePlugin: true, pluginId, type: "modal-open", menu: true }, "*"); return this; }
    hide() { this.dom.remove(); parent.postMessage({ nephritePlugin: true, pluginId, type: "modal-close" }, "*"); this.onHide?.(); }
  }
  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.id = plugin?.manifest?.id || "settings";
      this.name = plugin?.manifest?.name || "Settings";
      this.containerEl = document.createElement("div");
    }
    display() {}
    hide() {}
  }
  class ValueComponent extends BaseComponent { registerOptionListener(listeners, key, callback) { (listeners[key] ||= []).push(callback); return this; } }
  class AbstractTextComponent extends ValueComponent {
    constructor(inputEl) { super(); this.inputEl = inputEl; }
    getValue() { return this.inputEl.value; }
    setValue(value) { this.inputEl.value = String(value ?? ""); return this; }
    setPlaceholder(value) { this.inputEl.placeholder = String(value ?? ""); return this; }
    setDisabled(value) { super.setDisabled(value); this.inputEl.disabled = !!value; return this; }
    onChanged() {}
    onChange(callback) { this.inputEl.addEventListener("input", () => { this.onChanged(); callback(this.getValue()); }); return this; }
  }
  class TextComponent extends AbstractTextComponent { constructor(container) { const input = document.createElement("input"); input.type = "text"; container?.append(input); super(input); } }
  class SearchComponent extends TextComponent { constructor(container) { super(container); this.inputEl.type = "search"; } }
  class TextAreaComponent extends AbstractTextComponent { constructor(container) { const input = document.createElement("textarea"); container?.append(input); super(input); } }
  class ToggleComponent extends ValueComponent {
    constructor(container) { super(); this.toggleEl = document.createElement("input"); this.toggleEl.type = "checkbox"; container?.append(this.toggleEl); }
    getValue() { return this.toggleEl.checked; } setValue(value) { this.toggleEl.checked = !!value; return this; }
    setDisabled(value) { super.setDisabled(value); this.toggleEl.disabled = !!value; return this; }
    onChange(callback) { this.toggleEl.addEventListener("change", () => callback(this.getValue())); return this; }
  }
  class DropdownComponent extends ValueComponent {
    constructor(container) { super(); this.selectEl = document.createElement("select"); container?.append(this.selectEl); }
    addOption(value, display) { const option = document.createElement("option"); option.value = String(value); option.textContent = String(display ?? value); this.selectEl.append(option); return this; }
    addOptions(options) { Object.entries(options || {}).forEach(([value, display]) => this.addOption(value, display)); return this; }
    getValue() { return this.selectEl.value; } setValue(value) { this.selectEl.value = String(value); return this; }
    setDisabled(value) { super.setDisabled(value); this.selectEl.disabled = !!value; return this; }
    onChange(callback) { this.selectEl.addEventListener("change", () => callback(this.getValue())); return this; }
  }
  class SliderComponent extends ValueComponent {
    constructor(container) { super(); this.sliderEl = document.createElement("input"); this.sliderEl.type = "range"; container?.append(this.sliderEl); }
    setLimits(min, max, step) { this.sliderEl.min = String(min); this.sliderEl.max = String(max); this.sliderEl.step = String(step); return this; }
    setValue(value) { this.sliderEl.value = String(value); return this; } getValue() { return Number(this.sliderEl.value); }
    setDisabled(value) { super.setDisabled(value); this.sliderEl.disabled = !!value; return this; }
    setDynamicTooltip() { return this; } showTooltip() { return this; }
    onChange(callback) { this.sliderEl.addEventListener("input", () => callback(this.getValue())); return this; }
  }
  class ButtonComponent extends ValueComponent {
    constructor(container) { super(); this.buttonEl = document.createElement("button"); this.buttonEl.type = "button"; container?.append(this.buttonEl); }
    setButtonText(value) { this.buttonEl.textContent = String(value ?? ""); return this; }
    setIcon(value) { this.buttonEl.dataset.icon = String(value); this.buttonEl.textContent ||= String(value); return this; }
    setTooltip(value) { this.buttonEl.title = String(value ?? ""); return this; } setClass(value) { this.buttonEl.classList.add(value); return this; }
    setCta() { return this.setClass("mod-cta"); } setWarning() { return this.setClass("mod-warning"); }
    setDisabled(value) { super.setDisabled(value); this.buttonEl.disabled = !!value; return this; }
    onClick(callback) { this.buttonEl.addEventListener("click", callback); return this; }
  }
  class ExtraButtonComponent extends ButtonComponent { constructor(container) { super(container); this.extraButtonEl = this.buttonEl; this.extraButtonEl.classList.add("clickable-icon"); } }
  class ColorComponent extends ValueComponent {
    constructor(container) { super(); this.colorPickerEl = document.createElement("input"); this.colorPickerEl.type = "color"; container?.append(this.colorPickerEl); }
    getValue() { return this.colorPickerEl.value; } setValue(value) { this.colorPickerEl.value = String(value); return this; }
    setDisabled(value) { super.setDisabled(value); this.colorPickerEl.disabled = !!value; return this; }
    onChange(callback) { this.colorPickerEl.addEventListener("input", () => callback(this.getValue())); return this; }
  }
  class ProgressBarComponent extends ValueComponent { constructor(container) { super(); this.progressBar = document.createElement("progress"); this.progressBar.max = 100; container?.append(this.progressBar); } setValue(value) { this.progressBar.value = Number(value); return this; } }
  class Setting {
    constructor(container) {
      this.settingEl = document.createElement("div");
      this.settingEl.className = "setting-item";
      this.infoEl = document.createElement("div");
      this.infoEl.className = "setting-item-info";
      this.nameEl = document.createElement("div");
      this.nameEl.className = "setting-item-name";
      this.descEl = document.createElement("div");
      this.descEl.className = "setting-item-description";
      this.controlEl = document.createElement("div");
      this.controlEl.className = "setting-item-control";
      this.infoEl.append(this.nameEl, this.descEl);
      this.settingEl.append(this.infoEl, this.controlEl);
      container?.append?.(this.settingEl);
    }
    setName(value) {
      this.name = value;
      this.nameEl.replaceChildren();
      if (value && typeof value === "object" && value.nodeType) this.nameEl.append(value);
      else this.nameEl.textContent = String(value ?? "");
      return this;
    }
    setDesc(value) {
      this.desc = value;
      this.descEl.replaceChildren();
      if (value && typeof value === "object" && value.nodeType) this.descEl.append(value);
      else this.descEl.textContent = String(value ?? "");
      return this;
    }
    setHeading() { this.settingEl.classList.add("setting-item-heading"); this.controlEl.remove(); return this; }
    setClass(value) { this.settingEl.classList.add(value); return this; }
    setDisabled(value) {
      this.settingEl.classList.toggle("is-disabled", !!value);
      for (const input of this.settingEl.querySelectorAll("input, textarea, select, button")) input.disabled = !!value;
      return this;
    }
    addText(callback) { callback(new TextComponent(this.controlEl)); return this; }
    addSearch(callback) { callback(new SearchComponent(this.controlEl)); return this; }
    addToggle(callback) { callback(new ToggleComponent(this.controlEl)); return this; }
    addButton(callback) { callback(new ButtonComponent(this.controlEl)); return this; }
    addTextArea(callback) { callback(new TextAreaComponent(this.controlEl)); return this; }
    addExtraButton(callback) { callback(new ExtraButtonComponent(this.controlEl)); return this; }
    addSlider(callback) { callback(new SliderComponent(this.controlEl)); return this; }
    addDropdown(callback) { callback(new DropdownComponent(this.controlEl)); return this; }
    addColorPicker(callback) { callback(new ColorComponent(this.controlEl)); return this; }
    addProgressBar(callback) { callback(new ProgressBarComponent(this.controlEl)); return this; }
  }
  const editorOffset = (content, position) => {
    if (typeof position === "number") return Math.max(0, Math.min(content.length, position));
    const wantedLine = Math.max(0, Number(position?.line) || 0);
    const wantedCh = Math.max(0, Number(position?.ch ?? position?.character) || 0);
    let offset = 0;
    for (let line = 0; line < wantedLine; line += 1) {
      const next = content.indexOf("\\n", offset);
      if (next < 0) return content.length;
      offset = next + 1;
    }
    const end = content.indexOf("\\n", offset);
    return Math.min(end < 0 ? content.length : end, offset + wantedCh);
  };
  const editorPosition = (content, rawOffset) => {
    const offset = Math.max(0, Math.min(content.length, Number(rawOffset) || 0));
    const before = content.slice(0, offset);
    const line = (before.match(/\\n/g) || []).length;
    const last = before.lastIndexOf("\\n");
    return { line, ch: offset - last - 1 };
  };
  const createEditorAdapter = (initial) => {
    let content = String(initial?.content || "");
    let anchor = Number.isFinite(initial?.from) ? initial.from : editorOffset(content, initial?.anchor || initial?.cursor || { line: 0, ch: 0 });
    let head = Number.isFinite(initial?.to) ? initial.to : editorOffset(content, initial?.cursor || initial?.anchor || { line: 0, ch: 0 });
    const ordered = () => ({ from: Math.min(anchor, head), to: Math.max(anchor, head) });
    const publishSelection = () => { void nephrite.editor.setSelection(anchor, head); };
    const publishContent = () => { void nephrite.editor.setValue(content); };
    const adapter = {
      getValue: () => content,
      setValue: (value) => { content = String(value ?? ""); anchor = head = Math.min(head, content.length); publishContent(); publishSelection(); },
      getSelection: () => { const range = ordered(); return content.slice(range.from, range.to); },
      somethingSelected: () => anchor !== head,
      replaceSelection: (value) => {
        const range = ordered(); const replacement = String(value ?? "");
        content = content.slice(0, range.from) + replacement + content.slice(range.to);
        anchor = head = range.from + replacement.length;
        publishContent(); publishSelection();
      },
      getCursor: (which) => editorPosition(content, which === "anchor" || which === "from" ? anchor : head),
      setCursor: (position) => { anchor = head = editorOffset(content, position); publishSelection(); },
      listSelections: () => [{ anchor: editorPosition(content, anchor), head: editorPosition(content, head) }],
      setSelection: (from, to = from) => { anchor = editorOffset(content, from); head = editorOffset(content, to); publishSelection(); },
      setSelections: (ranges) => { const range = ranges?.[0]; if (range) adapter.setSelection(range.anchor, range.head); },
      getLine: (line) => content.split("\\n")[Math.max(0, Number(line) || 0)] || "",
      lineCount: () => content.split("\\n").length,
      lastLine: () => Math.max(0, content.split("\\n").length - 1),
      getRange: (from, to) => content.slice(editorOffset(content, from), editorOffset(content, to)),
      replaceRange: (value, from, to = from) => {
        const start = editorOffset(content, from); const end = editorOffset(content, to); const replacement = String(value ?? "");
        content = content.slice(0, Math.min(start, end)) + replacement + content.slice(Math.max(start, end));
        anchor = head = Math.min(start, end) + replacement.length;
        publishContent(); publishSelection();
      },
      posToOffset: (position) => editorOffset(content, position),
      offsetToPos: (offset) => editorPosition(content, offset),
      focus: () => publishSelection(),
      blur: () => {},
      hasFocus: () => true,
      exec: () => false,
      transaction: (spec) => {
        for (const change of spec?.changes || []) adapter.replaceRange(change.text || "", change.from, change.to);
        if (spec?.selection) adapter.setSelection(spec.selection.anchor, spec.selection.head);
      },
    };
    return adapter;
  };
  const bytesToBase64 = (buffer) => { let binary = ""; for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte); return btoa(binary); };
  const base64ToBytes = (value) => Uint8Array.from(atob(String(value)), (character) => character.charCodeAt(0)).buffer;
  const bytesToHex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const hexToBytes = (value) => { const clean = String(value).replace(/[^0-9a-f]/gi, ""); const bytes = new Uint8Array(Math.ceil(clean.length / 2)); for (let index = 0; index < clean.length; index += 2) bytes[index / 2] = parseInt(clean.slice(index, index + 2), 16); return bytes.buffer; };
  const getLinkpath = (linktext) => String(linktext ?? "").split("|")[0].split("#")[0];
  const parseLinktext = (linktext) => { const text = String(linktext ?? ""); const target = text.split("|")[0]; const hash = target.search(/[#^]/); return { path: hash < 0 ? target : target.slice(0, hash), subpath: hash < 0 ? "" : target.slice(hash) }; };
  const parseFrontMatterEntry = (frontmatter, key) => { if (!frontmatter || typeof frontmatter !== "object") return null; if (key instanceof RegExp) { const found = Object.keys(frontmatter).find((name) => key.test(name)); return found == null ? null : frontmatter[found]; } return frontmatter[key] ?? null; };
  const stringArrayValue = (value, allowEmpty = false) => {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : value == null ? [] : [value];
    return values.map((item) => String(item).trim()).filter((item) => allowEmpty || item.length > 0);
  };
  const parseFrontMatterStringArray = (frontmatter, key) => { const value = parseFrontMatterEntry(frontmatter, key); return value == null ? null : stringArrayValue(value); };
  const parseFrontMatterTags = (frontmatter) => stringArrayValue(frontmatter?.tags ?? frontmatter?.tag).map((tag) => tag.startsWith("#") ? tag : "#" + tag);
  const parseFrontMatterAliases = (frontmatter) => stringArrayValue(frontmatter?.aliases ?? frontmatter?.alias);
  const getFrontMatterInfo = (content) => {
    const text = String(content ?? ""); if (!text.startsWith("---")) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
    const match = /^---\\s*\\r?\\n([\\s\\S]*?)\\r?\\n---\\s*(?:\\r?\\n|$)/.exec(text);
    return match ? { exists: true, frontmatter: match[1], from: 0, to: match[0].length, contentStart: match[0].length } : { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  };
  const prepareSimpleSearch = (query) => { const needle = String(query).toLowerCase(); return (text) => { const start = String(text).toLowerCase().indexOf(needle); return start < 0 ? null : { score: -start, matches: [[start, start + needle.length]] }; }; };
  const prepareFuzzySearch = (query) => { const chars = [...String(query).toLowerCase()]; return (text) => { const value = String(text); const lower = value.toLowerCase(); let cursor = 0; const matches = []; for (const char of chars) { const found = lower.indexOf(char, cursor); if (found < 0) return null; matches.push([found, found + 1]); cursor = found + 1; } return { score: -(cursor - chars.length), matches }; }; };
  const renderMatches = (element, text, matches, offset = 0) => { const value = String(text); let cursor = 0; for (const [rawFrom, rawTo] of matches || []) { const from = Math.max(0, rawFrom - offset), to = Math.max(from, rawTo - offset); if (from > cursor) element.append(document.createTextNode(value.slice(cursor, from))); const mark = document.createElement("span"); mark.className = "suggestion-highlight"; mark.textContent = value.slice(from, to); element.append(mark); cursor = to; } if (cursor < value.length) element.append(document.createTextNode(value.slice(cursor))); };
  const iconRegistry = new Map();
  const addIcon = (iconId, svgContent) => { iconRegistry.set(String(iconId), String(svgContent)); };
  const removeIcon = (iconId) => iconRegistry.delete(String(iconId));
  const getIcon = (iconId) => { const wrapper = document.createElement("div"); wrapper.innerHTML = iconRegistry.get(String(iconId)) || '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"/></svg>'; return wrapper.firstElementChild; };
  const setIcon = (element, iconId) => { element.replaceChildren(getIcon(iconId)); element.dataset.icon = String(iconId); };
  class Scope { constructor(parent) { this.parent = parent; this.keys = []; } register(modifiers, key, callback) { const binding = { modifiers, key, callback }; this.keys.push(binding); return () => this.unregister(binding); } unregister(binding) { this.keys.remove(binding); } }
  class Keymap { static isModEvent(event) { return !!(event?.metaKey || event?.ctrlKey); } }
  class SuggestModal extends Modal {
    constructor(app) { super(app); this.inputEl = document.createElement("input"); this.resultContainerEl = document.createElement("div"); this.contentEl.append(this.inputEl, this.resultContainerEl); this.limit = 100; }
    setPlaceholder(value) { this.inputEl.placeholder = String(value); return this; } setInstructions(value) { this.instructions = value; return this; }
  }
  class FuzzySuggestModal extends SuggestModal { getItemText(item) { return String(item); } }
  class AbstractInputSuggest extends Component { constructor(app, inputEl) { super(); this.app = app; this.inputEl = inputEl; this.scope = new Scope(); } close() { this.unload(); } setValue(value) { this.inputEl.value = String(value); } }
  class EditorSuggest extends Component { constructor(app) { super(); this.app = app; this.scope = new Scope(); this.context = null; this.limit = 100; this.suggestEl = document.createElement("div"); this.containerEl = this.suggestEl; } setInstructions(instructions) { this.instructions = instructions; } open() { this.suggestEl.show(); } close() { this.suggestEl.hide(); } }
  class Plugin extends Component {
    constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this._data = {}; }
    addCommand(command) {
      const callback = async () => {
        const state = await nephrite.editor.getState().catch(() => ({ path: null, content: "", selection: "" }));
        const editor = createEditorAdapter(state);
        if (typeof command.editorCallback === "function") return command.editorCallback(editor, null);
        if (typeof command.checkCallback === "function") return command.checkCallback(false);
        return command.callback?.();
      };
      return registerCommand({ ...command, name: command.name || command.id, callback });
    }
    registerView(type, creator) { return registerView({ id: type, name: type, onOpen: async () => {
      const view = creator({ type, openFile: (file) => app.workspace.getLeaf().openFile(file) });
      await view?.onOpen?.();
      const content = view?.contentEl?.innerHTML || view?.containerEl?.innerHTML || "";
      return { type: "markdown", content };
    } }); }
    removeCommand(id) { callbacks.delete(id); delete commandRegistry[id]; }
    registerExtensions(extensions, viewType) { this._extensions ||= new Map(); for (const extension of extensions || []) this._extensions.set(extension, viewType); }
    registerBasesView(viewId, registration) { this._basesViews ||= new Map(); this._basesViews.set(viewId, registration); return true; }
    registerEditorExtension(extension) { this._editorExtensions ||= []; this._editorExtensions.push(...(Array.isArray(extension) ? extension : [extension])); return extension; }
    registerEditorSuggest(suggest) { this._editorSuggests ||= []; this._editorSuggests.push(suggest); return this.register(() => { this._editorSuggests.remove(suggest); suggest.close?.(); }); }
    registerCliHandler(command, description, flags, handler) { this._cliHandlers ||= new Map(); this._cliHandlers.set(command, { description, flags, handler }); return this.register(() => this._cliHandlers.delete(command)); }
    registerHoverLinkSource(id, info) { this._hoverLinkSources ||= new Map(); this._hoverLinkSources.set(id, info); return this.register(() => this._hoverLinkSources.delete(id)); }
    registerObsidianProtocolHandler(action, handler) { this._protocolHandlers ||= new Map(); this._protocolHandlers.set(action, handler); return this.register(() => this._protocolHandlers.delete(action)); }
    addRibbonIcon(icon, title, callback) { const id = "ribbon-" + (++uiSequence); callbacks.set(id, callback); parent.postMessage({ nephritePlugin: true, pluginId, type: "ribbon-registered", id, name: String(title || id), icon: String(icon || "") }, "*"); const el = document.createElement("button"); el.dataset.icon = String(icon || ""); el.title = String(title || ""); el.addEventListener("click", callback); const remove = el.remove.bind(el); el.remove = () => { callbacks.delete(id); parent.postMessage({ nephritePlugin: true, pluginId, type: "ribbon-removed", id }, "*"); remove(); }; return el; }
    addStatusBarItem() { const id = "status-" + (++uiSequence); const el = document.createElement("span"); el.className = "status-bar-item plugin-" + pluginId; statusBarContainer.append(el); callbacks.set(id, () => el.click()); const publish = () => parent.postMessage({ nephritePlugin: true, pluginId, type: "status-updated", id, text: el.textContent || "", title: el.title || "" }, "*"); const observer = new MutationObserver(publish); observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true }); queueMicrotask(publish); const remove = el.remove.bind(el); el.remove = () => { observer.disconnect(); callbacks.delete(id); parent.postMessage({ nephritePlugin: true, pluginId, type: "status-removed", id }, "*"); remove(); }; return el; }
    addSettingTab(tab) {
      this._settingTabs = this._settingTabs || [];
      this._settingTabs.push(tab);
      parent.postMessage({
        nephritePlugin: true,
        pluginId,
        type: "settings-tab",
        id: tab.id || pluginId,
        name: tab.name || this.manifest?.name || pluginId,
      }, "*");
      return tab;
    }
    registerMarkdownPostProcessor(processor) {
      this._postProcessors ||= [];
      this._postProcessors.push(processor);
      this._postProcessors.sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0));
      parent.postMessage({ nephritePlugin: true, pluginId, type: "processor-registered", kind: "post" }, "*");
      return this.register(() => this._postProcessors.remove(processor));
    }
    registerMarkdownCodeBlockProcessor(language, processor) {
      this._codeProcessors ||= new Map();
      this._codeProcessors.set(language, processor);
      parent.postMessage({ nephritePlugin: true, pluginId, type: "processor-registered", kind: "code", language }, "*");
      return processor;
    }
    async loadData() { return (await send("plugins.loadData", [])) ?? {}; }
    async saveData(value) { return send("plugins.saveData", [value ?? {}]); }
  }
  class SettingTab extends Component { constructor(app) { super(); this.app = app; this.containerEl = document.createElement("div"); } display() {} hide() {} }
  class SettingGroup { constructor(container) { this.settingEl = document.createElement("div"); this.settingEl.className = "setting-group"; container?.append(this.settingEl); } setHeading(value) { this.settingEl.createEl("h3", { text: value }); return this; } addSetting(callback) { const setting = new Setting(this.settingEl); callback?.(setting); return this; } }
  class HoverPopover extends Component { constructor(parent, targetEl, waitTime = 0) { super(); this.parent = parent; this.targetEl = targetEl; this.waitTime = waitTime; this.hoverEl = document.createElement("div"); } }
  class ConfirmationModal extends Modal { constructor(app, title, text, cta) { super(app); this.setTitle(title); this.contentEl.createEl("p", { text }); this.cta = cta; } }
  class ConfirmationButton extends ButtonComponent {}
  class DisplayValueComponent extends ValueComponent { constructor(container) { super(); this.valueEl = container.createSpan(); } setValue(value) { this.valueEl.textContent = String(value ?? ""); return this; } }
  class MomentFormatComponent extends TextComponent {}
  class SecretComponent extends TextComponent { constructor(container) { super(container); this.inputEl.type = "password"; } }
  class SecretStorage { async getSecret(id) { return (await send("plugins.loadData", []))?.secrets?.[id] ?? null; } async setSecret(id, value) { const data = await send("plugins.loadData", []) || {}; data.secrets ||= {}; data.secrets[id] = value; return send("plugins.saveData", [data]); } async deleteSecret(id) { const data = await send("plugins.loadData", []) || {}; delete data.secrets?.[id]; return send("plugins.saveData", [data]); } }
  class GenericObsidianClass extends Component { constructor(...args) { super(); this.args = args; this.app = args[0] || app; } }
  class App { static [Symbol.hasInstance](value) { return !!value?.vault && !!value?.workspace && !!value?.metadataCache; } }
  class Vault extends Events { static [Symbol.hasInstance](value) { return !!value?.adapter && typeof value?.read === "function" && typeof value?.getFiles === "function"; } static recurseChildren(root, callback) { for (const child of root?.children || []) { callback(child); if (child instanceof TFolder) this.recurseChildren(child, callback); } } }
  class Workspace extends Events { static [Symbol.hasInstance](value) { return typeof value?.getLeaf === "function" && typeof value?.getActiveFile === "function"; } }
  class MetadataCache extends Events { static [Symbol.hasInstance](value) { return typeof value?.getFileCache === "function" && typeof value?.getFirstLinkpathDest === "function"; } }
  class FileManager { static [Symbol.hasInstance](value) { return typeof value?.renameFile === "function" && typeof value?.generateMarkdownLink === "function"; } }
  class Editor { static [Symbol.hasInstance](value) { return typeof value?.getValue === "function" && typeof value?.replaceRange === "function" && typeof value?.getCursor === "function"; } }
  class EmbeddedEditor extends Editor {}
  class FileSystemAdapter { static [Symbol.hasInstance](value) { return typeof value?.read === "function" && typeof value?.write === "function" && typeof value?.exists === "function"; } }
  class CapacitorAdapter extends FileSystemAdapter {}
  class EditableFileView extends FileView {}
  class MarkdownEditView {
    constructor(view) { this.view = view; this.app = view?.app || app; this.hoverPopover = null; }
    clear() { return this.set("", true); }
    get() { return this.view?.data || ""; }
    set(data) { if (this.view) this.view.data = String(data); }
    get file() { return this.view?.file || null; }
    getSelection() { return this.view?.editor?.getSelection?.() || ""; }
    getScroll() { return this.scroll || 0; }
    applyScroll(scroll) { this.scroll = Number(scroll) || 0; }
  }
  class MarkdownPreviewRenderer {
    static processors = new Set();
    static registerPostProcessor(processor, sortOrder = 0) { processor.sortOrder = sortOrder; this.processors.add(processor); }
    static unregisterPostProcessor(processor) { this.processors.delete(processor); }
    static createCodeBlockPostProcessor(language, handler) { return (element, context) => { for (const code of element.querySelectorAll("pre > code.language-" + String(language))) handler(code.textContent || "", code.parentElement, context); }; }
  }
  class MarkdownPreviewView extends Component { constructor(view) { super(); this.view = view; this.containerEl = document.createElement("div"); this.data = ""; } get file() { return this.view?.file || null; } get() { return this.data; } set(data) { this.data = String(data); } clear() { this.data = ""; this.containerEl.empty(); } }
  class PopoverState { constructor() { this.hoverPopover = null; } }
  class PopoverSuggest { constructor(appValue, scope = new Scope()) { this.app = appValue; this.scope = scope; this.isOpen = false; this.suggestEl = document.createElement("div"); } open() { this.isOpen = true; this.suggestEl.show(); } close() { this.isOpen = false; this.suggestEl.hide(); } }
  class SettingPage { constructor() { this.rootEl = document.createElement("div"); this.rootEl.addClass("setting-page"); this.titlebarEl = this.rootEl.createDiv({ cls: "setting-page-title" }); this.containerEl = this.rootEl.createDiv({ cls: "setting-page-content" }); this.title = ""; } display() { this.containerEl.empty(); } }
  class WorkspaceItem extends Events { constructor(parent = null) { super(); this.parent = parent; } getRoot() { let item = this; while (item.parent) item = item.parent; return item; } getContainer() { let item = this; while (item && !(item instanceof WorkspaceContainer)) item = item.parent; return item || null; } }
  class WorkspaceParent extends WorkspaceItem {}
  class WorkspaceSplit extends WorkspaceParent {}
  class WorkspaceContainer extends WorkspaceSplit { constructor(parent = null) { super(parent); this.win = window; this.doc = document; } }
  class WorkspaceRoot extends WorkspaceContainer {}
  class WorkspaceWindow extends WorkspaceContainer {}
  class WorkspaceFloating extends WorkspaceParent {}
  class WorkspaceTabs extends WorkspaceParent {}
  class WorkspaceMobileDrawer extends WorkspaceParent { constructor(parent = null) { super(parent); this.collapsed = false; } expand() { this.collapsed = false; } collapse() { this.collapsed = true; } toggle() { this.collapsed = !this.collapsed; } }
  class WorkspaceSidedock extends WorkspaceSplit { constructor(parent = null) { super(parent); this.collapsed = false; } expand() { this.collapsed = false; } collapse() { this.collapsed = true; } toggle() { this.collapsed = !this.collapsed; } }
  class WorkspaceRibbon { constructor() { this.containerEl = document.createElement("div"); } }
  class Value {
    static type = "unknown";
    static equals(left, right) { return left === right || (!!left && !!right && left.constructor === right.constructor && left.equals(right)); }
    static looseEquals(left, right) { return left === right || (!!left && !!right && left.looseEquals(right)); }
    equals(other) { return this === other || this.toString() === other?.toString(); }
    looseEquals(other) { return this.equals(other) || this.toString() === other?.toString(); }
    renderTo(element) { element.textContent = this.toString(); }
  }
  class NotNullValue extends Value {}
  class NullValue extends Value { static type = "null"; toString() { return ""; } isTruthy() { return false; } }
  NullValue.value = new NullValue();
  class PrimitiveValue extends NotNullValue { constructor(value) { super(); this.value = value; } toString() { return String(this.value ?? ""); } isTruthy() { return !!this.value; } equals(other) { return other?.constructor === this.constructor && Object.is(this.value, other.value); } looseEquals(other) { return this.value == other?.value; } }
  class StringValue extends PrimitiveValue { static type = "string"; }
  class NumberValue extends PrimitiveValue { static type = "number"; }
  class BooleanValue extends PrimitiveValue { static type = "boolean"; }
  class TagValue extends StringValue { static type = "tag"; constructor(value) { super(String(value || "").replace(/^#/, "")); } toString() { return this.value ? "#" + this.value : ""; } }
  class UrlValue extends StringValue { static type = "url"; }
  class HTMLValue extends StringValue { static type = "html"; renderTo(element) { element.append(sanitizeHTMLToDom(this.value)); } }
  class IconValue extends StringValue { static type = "icon"; renderTo(element) { setIcon(element, this.value); } }
  class ImageValue extends StringValue { static type = "image"; renderTo(element) { const image = element.createEl("img"); image.src = this.value; image.alt = this.value; } }
  class LinkValue extends StringValue {
    static type = "link";
    constructor(value, display, sourcePath = "") { super(value); this.path = value; this.display = display || value; this.sourcePath = sourcePath; }
    static parseFromString(_app, input, sourcePath = "") { const text = String(input).trim(); if (!text.startsWith("[[") || !text.endsWith("]]")) return null; const [path, display] = text.slice(2, -2).split("|", 2); return path ? new LinkValue(path, display, sourcePath) : null; }
    toString() { return "[[" + this.path + (this.display !== this.path ? "|" + this.display : "") + "]]"; }
    renderTo(element) { const link = element.createEl("a", { text: this.display, attr: { href: this.path } }); link.addClass("internal-link"); }
  }
  class FileValue extends NotNullValue { static type = "file"; constructor(file) { super(); this.value = file; } toString() { return this.value?.path || ""; } isTruthy() { return !!this.value; } }
  class DateValue extends NotNullValue {
    static type = "date";
    constructor(value) { super(); this.value = value instanceof Date ? new Date(value) : new Date(value); }
    toString() { return Number.isNaN(this.value.getTime()) ? "" : this.value.toISOString(); }
    isTruthy() { return !Number.isNaN(this.value.getTime()); }
    dateOnly() { const copy = new Date(this.value); copy.setHours(0, 0, 0, 0); return new DateValue(copy); }
    relative() { const delta = this.value.getTime() - Date.now(); const days = Math.round(Math.abs(delta) / 86400000); return days === 0 ? "today" : days + " day" + (days === 1 ? "" : "s") + (delta < 0 ? " ago" : " from now"); }
  }
  class RelativeDateValue extends DateValue { static type = "relative-date"; toString() { return this.relative(); } }
  class DurationValue extends NotNullValue {
    static type = "duration";
    constructor(value) { super(); this.value = typeof value === "number" ? value : Number(value?.milliseconds ?? value ?? 0); }
    toString() { return String(this.value) + "ms"; }
    isTruthy() { return this.value !== 0; }
    getMilliseconds() { return this.value; }
    addToDate(value, subtract = false) { return new DateValue(value.value.getTime() + this.value * (subtract ? -1 : 1)); }
  }
  class RegExpValue extends NotNullValue { static type = "regexp"; constructor(value, flags) { super(); this.value = value instanceof RegExp ? value : new RegExp(value, flags); } toString() { return this.value.toString(); } isTruthy() { return true; } }
  const wrapValue = (value) => value instanceof Value ? value : value == null ? NullValue.value : Array.isArray(value) ? new ListValue(value) : value instanceof Date ? new DateValue(value) : typeof value === "string" ? new StringValue(value) : typeof value === "number" ? new NumberValue(value) : typeof value === "boolean" ? new BooleanValue(value) : new ObjectValue(value);
  class ListValue extends NotNullValue {
    static type = "list";
    constructor(value = []) { super(); this.value = value.map(wrapValue); }
    toString() { return this.value.map(String).join(", "); }
    isTruthy() { return this.value.length > 0; }
    includes(value) { return this.value.some((item) => Value.looseEquals(item, wrapValue(value))); }
    length() { return this.value.length; }
    get(index) { return this.value[index] || NullValue.value; }
    concat(other) { return new ListValue([...this.value, ...other.value]); }
  }
  class ObjectValue extends NotNullValue { static type = "object"; constructor(value = {}) { super(); this.value = value; } toString() { return JSON.stringify(this.value); } isTruthy() { return Object.keys(this.value).length > 0; } isEmpty() { return !this.isTruthy(); } get(key) { return Object.prototype.hasOwnProperty.call(this.value, key) ? wrapValue(this.value[key]) : NullValue.value; } }
  class Tasks { constructor() { this.tasks = []; } add(callback) { this.tasks.push(Promise.resolve().then(callback)); } addPromise(promise) { this.tasks.push(Promise.resolve(promise)); } isEmpty() { return this.tasks.length === 0; } promise() { return Promise.all(this.tasks); } }
  class BasesEntry { constructor(file, values = {}) { this.file = file; this.values = values; } getValue(propertyId) { return Object.prototype.hasOwnProperty.call(this.values, propertyId) ? wrapValue(this.values[propertyId]) : null; } }
  class BasesEntryGroup { constructor(key, entries = []) { this.key = key == null ? undefined : wrapValue(key); this.entries = entries; } hasKey() { return !!this.key && !(this.key instanceof NullValue); } }
  class BasesViewConfig {
    constructor(config = {}) { this.values = { ...config }; this.name = String(config.name || ""); }
    get(key) { return this.values[key]; }
    getAsPropertyId(key) { const value = this.get(key); return typeof value === "string" && value.length ? value : null; }
    getEvaluatedFormula(_view, key) { return wrapValue(this.get(key)); }
    set(key, value) { if (value == null) delete this.values[key]; else this.values[key] = value; }
    getOrder() { return Array.isArray(this.values.order) ? [...this.values.order] : []; }
    getSort() { return Array.isArray(this.values.sort) ? this.values.sort.filter((item) => item && typeof item.property === "string" && ["ASC", "DESC"].includes(item.direction)) : []; }
    getDisplayName(propertyId) { return this.values.displayNames?.[propertyId] || String(propertyId).replace(/^(note|file|formula)\./, ""); }
  }
  class BasesQueryResult { constructor(data = [], properties = [], groups = null) { this.data = data; this._properties = properties; this._groups = groups; } get groupedData() { return this._groups || [new BasesEntryGroup(undefined, this.data)]; } get properties() { return [...this._properties]; } getSummaryValue(_controller, entries, property, summaryKey) { const values = entries.map((entry) => entry.getValue(property)).filter((value) => value && !(value instanceof NullValue)); if (summaryKey === "count") return new NumberValue(values.length); if (summaryKey === "sum") return new NumberValue(values.reduce((sum, value) => sum + Number(value.value || 0), 0)); return NullValue.value; } }
  class QueryController extends Component {}
  class RenderContext { constructor() { this.hoverPopover = null; } }
  class BasesView extends Component { constructor(controller) { super(); this.controller = controller; this.app = app; this.config = new BasesViewConfig(); this.allProperties = []; this.data = new BasesQueryResult(); } async createFileForView() {} }
  const moment = (input) => {
    const dateParts = typeof input === "string" ? input.split("-").map(Number) : [];
    const date = dateParts.length === 3 && dateParts.every(Number.isFinite)
      ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2])
      : input?.toDate ? input.toDate() : input == null ? new Date() : input instanceof Date ? new Date(input) : new Date(input);
    const api = {
      _isAMomentObject: true, _d: date,
      clone: () => moment(date), isValid: () => !Number.isNaN(date.getTime()), valueOf: () => date.getTime(), unix: () => Math.floor(date.getTime() / 1000),
      toDate: () => new Date(date), toISOString: () => date.toISOString(), toJSON: () => date.toJSON(),
      year: (value) => value == null ? date.getFullYear() : (date.setFullYear(value), api),
      month: (value) => value == null ? date.getMonth() : (date.setMonth(value), api),
      date: (value) => value == null ? date.getDate() : (date.setDate(value), api),
      day: (value) => value == null ? date.getDay() : (date.setDate(date.getDate() + Number(value) - date.getDay()), api),
      weekday: (value) => value == null ? date.getDay() : (date.setDate(date.getDate() + Number(value) - date.getDay()), api),
      isoWeekday: (value) => { const current = date.getDay() || 7; return value == null ? current : (date.setDate(date.getDate() + Number(value) - current), api); },
      week: (value) => { const first = new Date(date.getFullYear(), 0, 1); const current = Math.ceil((((date - first) / 86400000) + first.getDay() + 1) / 7); return value == null ? current : api.add(Number(value) - current, "week"); },
      hour: (value) => value == null ? date.getHours() : (date.setHours(value), api),
      minute: (value) => value == null ? date.getMinutes() : (date.setMinutes(value), api),
      second: (value) => value == null ? date.getSeconds() : (date.setSeconds(value), api),
      add: (amount, unit) => { const table = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }; const key = String(unit).replace(/s$/, ""); if (key === "month") date.setMonth(date.getMonth() + Number(amount)); else if (key === "year") date.setFullYear(date.getFullYear() + Number(amount)); else date.setTime(date.getTime() + Number(amount) * (table[key] || 1)); return api; },
      subtract: (amount, unit) => api.add(-Number(amount), unit),
      locale: () => api,
      localeData: () => moment.localeData(),
      isSame: (other, unit) => { const right = moment(other); if (!unit) return date.getTime() === right.valueOf(); return moment(date).startOf(unit).valueOf() === right.startOf(unit).valueOf(); },
      diff: (other, unit = "millisecond", precise = false) => { const divisor = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[String(unit).replace(/s$/, "")] || 1; const value = (date - moment(other).toDate()) / divisor; return precise ? value : Math.trunc(value); },
      startOf: (unit) => { const key = String(unit); if (key === "year") date.setMonth(0); if (key === "year" || key === "month") date.setDate(1); if (["year","month","day","date"].includes(key)) date.setHours(0); if (["year","month","day","date","hour"].includes(key)) date.setMinutes(0); if (["year","month","day","date","hour","minute"].includes(key)) date.setSeconds(0); date.setMilliseconds(0); return api; },
      endOf: (unit) => api.startOf(unit).add(1, unit).subtract(1, "millisecond"),
      format: (pattern = "YYYY-MM-DDTHH:mm:ssZ") => { const values = { YYYY: String(date.getFullYear()), MM: String(date.getMonth()+1).padStart(2,"0"), DD: String(date.getDate()).padStart(2,"0"), HH: String(date.getHours()).padStart(2,"0"), mm: String(date.getMinutes()).padStart(2,"0"), ss: String(date.getSeconds()).padStart(2,"0") }; return String(pattern).replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => values[token]); },
    };
    return api;
  };
  const momentLocaleData = { _week: { dow: 0, doy: 6 } };
  moment.now = () => Date.now(); moment.unix = (value) => moment(Number(value) * 1000); moment.isMoment = (value) => !!value?._isAMomentObject;
  moment.locale = () => "en"; moment.locales = () => ["en"]; moment.localeData = () => momentLocaleData;
  moment.updateLocale = (_locale, config) => { if (config?.week) Object.assign(momentLocaleData._week, config.week); return momentLocaleData; };
  moment.weekdays = () => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  moment.weekdaysShort = () => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  window.moment = moment;
  const parseYaml = (source) => { const result = {}; for (const line of String(source ?? "").split("\\n")) { const match = /^([^:#][^:]*):\\s*(.*)$/.exec(line); if (!match) continue; const value = match[2].trim(); result[match[1].trim()] = value === "true" ? true : value === "false" ? false : value === "null" ? null : /^-?\\d+(?:\\.\\d+)?$/.test(value) ? Number(value) : /^\\[.*\\]$/.test(value) ? value.slice(1,-1).split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")) : value.replace(/^['\"]|['\"]$/g, ""); } return result; };
  const stringifyYaml = (value) => Object.entries(value || {}).map(([key, item]) => key + ": " + (Array.isArray(item) ? "[" + item.map((entry) => JSON.stringify(entry)).join(", ") + "]" : typeof item === "string" ? JSON.stringify(item) : String(item))).join("\\n");
  const stripHeading = (heading) => String(heading ?? "").replace(/^#+\\s*/, "");
  const stripHeadingForLink = (heading) => stripHeading(heading).replace(/[\\[\\]#|^]/g, "");
  const htmlToMarkdown = (html) => { const element = document.createElement("div"); element.innerHTML = String(html ?? ""); return element.innerText || element.textContent || ""; };
  const sanitizeHTMLToDom = (html) => { const template = document.createElement("template"); template.innerHTML = String(html ?? ""); for (const unsafe of template.content.querySelectorAll("script,iframe,object,embed")) unsafe.remove(); for (const element of template.content.querySelectorAll("*")) for (const attr of [...element.attributes]) if (/^on/i.test(attr.name)) element.removeAttribute(attr.name); return template.content; };
  const iterateRefs = (refs, callback) => { for (const ref of refs || []) if (callback(ref) === true) return true; return false; };
  const iterateCacheRefs = (cache, callback) => iterateRefs([...(cache?.links || []), ...(cache?.embeds || [])], callback);
  const resolveSubpath = (cache, subpath) => {
    const value = String(subpath || "");
    if (value.startsWith("#^")) { const block = cache?.blocks?.[value.slice(2)]; return block ? { type: "block", block } : null; }
    if (value.startsWith("^")) { const block = cache?.blocks?.[value.slice(1)]; return block ? { type: "block", block } : null; }
    const heading = value.replace(/^#/, "").toLowerCase();
    const match = (cache?.headings || []).find((item) => String(item.heading).toLowerCase() === heading);
    return match ? { type: "heading", current: match, next: null } : null;
  };
  const renderMath = (source, display) => { const element = document.createElement(display ? "div" : "span"); element.className = "math math-" + (display ? "block" : "inline"); element.textContent = String(source); return element; };
  const renderResults = (element, text, result, offset = 0) => renderMatches(element, text, result?.matches || [], offset);
  const sortSearchResults = (results) => results.sort((left, right) => (right.match?.score ?? right.score ?? 0) - (left.match?.score ?? left.score ?? 0));
  const parsePropertyId = (propertyId) => { const text = String(propertyId); const dot = text.indexOf("."); return dot < 0 ? { type: "note", name: text } : { type: text.slice(0, dot), name: text.slice(dot + 1) }; };
  const getLanguage = () => navigator.language || "en";
  const editorEditorField = Object.freeze({ name: "editorEditorField" });
  const editorInfoField = Object.freeze({ name: "editorInfoField" });
  const editorLivePreviewField = Object.freeze({ name: "editorLivePreviewField" });
  const editorViewField = Object.freeze({ name: "editorViewField" });
  const livePreviewState = Object.freeze({ name: "livePreviewState" });
  const genericNames = new Set([]);
  const obsidianApi = {
    App, Vault, Workspace, MetadataCache, FileManager, Editor, FileSystemAdapter, CapacitorAdapter,
    EditableFileView, MarkdownEditView, MarkdownPreviewRenderer, MarkdownPreviewView, PopoverState, PopoverSuggest, SettingPage,
    WorkspaceItem, WorkspaceParent, WorkspaceSplit, WorkspaceContainer, WorkspaceRoot, WorkspaceWindow, WorkspaceFloating,
    WorkspaceTabs, WorkspaceMobileDrawer, WorkspaceSidedock, WorkspaceRibbon,
    Plugin, Events, BaseComponent, Component, TAbstractFile, TFile, TFolder, Notice, Modal, ConfirmationModal, ConfirmationButton,
    Value, NotNullValue, NullValue, PrimitiveValue, StringValue, NumberValue, BooleanValue, TagValue, UrlValue, HTMLValue, IconValue, ImageValue,
    LinkValue, FileValue, DateValue, RelativeDateValue, DurationValue, RegExpValue, ListValue, ObjectValue, Tasks,
    BasesEntry, BasesEntryGroup, BasesViewConfig, BasesQueryResult, BasesView, QueryController, RenderContext,
    View, FileView, TextFileView, ItemView, MarkdownView, WorkspaceLeaf, MarkdownRenderChild, HoverPopover,
    Menu, MenuItem, MenuSeparator, PluginSettingTab, SettingTab, SettingGroup, Setting,
    ValueComponent, AbstractTextComponent, TextComponent, SearchComponent, TextAreaComponent, ToggleComponent, DropdownComponent,
    SliderComponent, ButtonComponent, ExtraButtonComponent, ColorComponent, ProgressBarComponent, DisplayValueComponent, MomentFormatComponent, SecretComponent, SecretStorage,
    Scope, Keymap, SuggestModal, FuzzySuggestModal, AbstractInputSuggest, EditorSuggest,
    Platform: Object.freeze({ isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false }),
    normalizePath: (path) => String(path).replace(/\\\\/g, "/").replace(/^\\.\\//, ""),
    debounce: debounceFn, apiVersion: "1.13.1", requireApiVersion: (version) => String(version).localeCompare("1.13.1", undefined, { numeric: true }) <= 0,
    moment, parseYaml, stringifyYaml, htmlToMarkdown, sanitizeHTMLToDom,
    arrayBufferToBase64: bytesToBase64, base64ToArrayBuffer: base64ToBytes, arrayBufferToHex: bytesToHex, hexToArrayBuffer: hexToBytes,
    getBlobArrayBuffer: (blob) => blob.arrayBuffer(), getLinkpath, parseLinktext, stripHeading, stripHeadingForLink,
    parseFrontMatterEntry, parseFrontMatterStringArray, parseFrontMatterTags, parseFrontMatterAliases, getFrontMatterInfo,
    prepareSimpleSearch, prepareFuzzySearch, renderMatches, addIcon, removeIcon, getIcon, getIconIds: () => [...iconRegistry.keys()], setIcon,
    editorEditorField, editorInfoField, editorLivePreviewField, editorViewField, livePreviewState,
    finishRenderMath: async () => {}, getLanguage, iterateCacheRefs, iterateRefs,
    loadMathJax: async () => window.MathJax || null, loadMermaid: async () => window.mermaid || null,
    loadPdfJs: async () => window.pdfjsLib || null, loadPrism: async () => window.Prism || null,
    parsePropertyId, renderMath, renderResults, resolveSubpath, sortSearchResults,
    setTooltip: (element, tooltip) => { element.title = String(tooltip ?? ""); }, displayTooltip: (element, tooltip) => { element.title = String(tooltip ?? ""); },
    getAllTags: (cache) => [...new Set([...(cache?.tags || []).map((tag) => tag.tag), ...parseFrontMatterTags(cache?.frontmatter)])],
    MarkdownRenderer: Object.freeze({ render: async (_app, markdown, element, sourcePath = "") => {
      element.innerHTML = await nephrite.workspace.renderMarkdown(String(markdown), String(sourcePath || ""));
      return element;
    } }),
    requestUrl: (request) => nephrite.network.requestUrl(typeof request === "string" ? { url: request } : request).then((response) => {
      const binary = atob(response.arrayBufferBase64 || "");
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return Object.freeze({ ...response, arrayBuffer: bytes.buffer });
    }),
    request: (request) => nephrite.network.requestUrl(typeof request === "string" ? { url: request } : request).then((response) => response.text),
    createFragment: (callback) => {
      const fragment = document.createDocumentFragment();
      callback?.(fragment);
      return fragment;
    },
  };
  for (const name of genericNames) obsidianApi[name] ||= GenericObsidianClass;
  const warnedExports = new Set();
  const obsidian = Object.freeze(new Proxy(obsidianApi, { get(target, property) { if (property in target) return target[property]; if (typeof property === "string" && !warnedExports.has(property)) { warnedExports.add(property); console.warn("[Nephrite] Obsidian API export uses a compatibility shim:", property); } return GenericObsidianClass; } }));
  const extensionFacet = (name) => Object.freeze({ of: (value) => Object.freeze({ facet: name, value }) });
  const codemirrorState = Object.freeze({
    Prec: Object.freeze({ highest: (value) => value, high: (value) => value, default: (value) => value, low: (value) => value, lowest: (value) => value }),
    EditorSelection: Object.freeze({ cursor: (anchor, assoc = 0) => ({ anchor, head: anchor, assoc }), range: (anchor, head) => ({ anchor, head }), create: (ranges, mainIndex = 0) => ({ ranges, mainIndex, main: ranges[mainIndex] }) }),
    SelectionRange: class { constructor(anchor, head = anchor) { this.anchor = anchor; this.head = head; } },
    StateEffect: Object.freeze({ define: () => { const type = { of: (value) => ({ value, is: (candidate) => candidate === type }), is: (effect) => effect?.is?.(type) === true }; return type; } }),
    StateField: Object.freeze({ define: (spec) => Object.freeze({ spec }) }),
    Facet: Object.freeze({ define: () => extensionFacet("facet") }),
    Compartment: class { of(extension) { return extension; } reconfigure(extension) { return extension; } },
  });
  class CodeMirrorWidgetType { toDOM() { return document.createElement("span"); } eq(other) { return this === other; } ignoreEvent() { return false; } }
  const decorationFactory = (kind) => (spec = {}) => Object.freeze({ kind, spec, range: (from, to = from) => ({ from, to, value: spec }) });
  const codemirrorView = Object.freeze({
    keymap: extensionFacet("keymap"),
    ViewPlugin: Object.freeze({ fromClass: (constructor, spec = {}) => ({ constructor, spec }), define: (factory, spec = {}) => ({ factory, spec }) }),
    Decoration: Object.freeze({ mark: decorationFactory("mark"), line: decorationFactory("line"), widget: decorationFactory("widget"), replace: decorationFactory("replace"), set: (ranges) => ranges }),
    WidgetType: CodeMirrorWidgetType,
    placeholder: (text) => ({ facet: "placeholder", value: String(text) }),
    EditorView: Object.freeze({ decorations: extensionFacet("decorations"), atomicRanges: extensionFacet("atomicRanges"), updateListener: extensionFacet("updateListener"), domEventHandlers: (handlers) => ({ facet: "domEventHandlers", value: handlers }), theme: (spec) => ({ facet: "theme", value: spec }), baseTheme: (spec) => ({ facet: "baseTheme", value: spec }) }),
  });
  const codemirrorCommands = Object.freeze({ insertBlankLine: () => false });
  const externalModules = Object.freeze({ "@codemirror/state": codemirrorState, "@codemirror/view": codemirrorView, "@codemirror/commands": codemirrorCommands });
  const commonModule = { exports: {} };
  const transformPluginModuleSource = (${transformPluginModuleSource.toString()});
  const moduleCache = new Map();
  const decodePluginText = (url) => {
    const match = /^data:([^,]*?)(;base64)?,(.*)$/.exec(String(url || ""));
    if (!match) return null;
    const decoded = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };
  const normalizeModulePath = (request, parent = "") => {
    const pieces = (request.startsWith(".") ? parent.split("/").slice(0, -1).concat(request.split("/")) : request.split("/"));
    const output = [];
    for (const piece of pieces) { if (!piece || piece === ".") continue; if (piece === "..") output.pop(); else output.push(piece); }
    return output.join("/");
  };
  const resolvePluginModule = (request, parent) => {
    const path = normalizeModulePath(request, parent);
    return [path, path + ".js", path + ".cjs", path + ".mjs", path + "/index.js", path + "/index.cjs"].find((candidate) => pluginAssets[candidate]) || null;
  };
  const loadPluginModule = (request, parent = "") => {
    const resolved = resolvePluginModule(request, parent);
    if (!resolved) throw new Error("Unsupported external module: " + request);
    if (moduleCache.has(resolved)) return moduleCache.get(resolved).exports;
    const encodedSource = decodePluginText(pluginAssets[resolved]);
    if (encodedSource == null) throw new Error("Plugin module is not text: " + resolved);
    const source = transformPluginModuleSource(encodedSource);
    const loaded = { exports: {} };
    moduleCache.set(resolved, loaded);
    const scopedRequire = (name) => name === "obsidian" ? obsidian : name.startsWith(".") ? loadPluginModule(name, resolved) : window.require(name);
    new Function("require", "module", "exports", source + "\\n//# sourceURL=nephrite-plugin://" + pluginId + "/" + resolved)(scopedRequire, loaded, loaded.exports);
    return loaded.exports;
  };
  window.module = commonModule;
  window.exports = commonModule.exports;
  window.require = (name) => {
    if (name === "obsidian") return obsidian;
    if (externalModules[name]) return externalModules[name];
    if (String(name).startsWith(".")) return loadPluginModule(String(name));
    throw new Error("Unsupported external module: " + name);
  };
  window.__startObsidianPlugin = () => {
    const exported = commonModule.exports?.default || commonModule.exports;
    if (typeof exported !== "function") return;
    const instance = new exported(window.app, ${JSON.stringify({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      minAppVersion: plugin.min_app_version,
      dir: `.obsidian/plugins/${plugin.id}`,
    })});
    window.__obsidianPluginInstance = instance;
    loadHandlers.push(() => instance.load?.());
    unloadHandlers.push(() => instance.unload?.());
  };
  addEventListener("message", async (event) => {
    const message = event.data;
    if (!message || message.nephriteHost !== true || message.pluginId !== pluginId) return;
    if (message.type === "response") {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
      return;
    }
    try {
      let result;
      if (message.type === "load") {
        fileSnapshot = hydrateFiles(Array.isArray(message.files) ? message.files : []);
        metadataSnapshot = new Map((Array.isArray(message.metadata) ? message.metadata : []).map((entry) => [entry.path, entry]));
        resolvedLinksSnapshot = Object.create(null);
        for (const entry of metadataSnapshot.values()) {
          const counts = resolvedLinksSnapshot[entry.path] = Object.create(null);
          for (const link of Array.isArray(entry.links) ? entry.links : []) {
            const target = typeof link === "string" ? link : link?.path || link?.target || link?.link;
            if (target) counts[target] = (counts[target] || 0) + 1;
          }
        }
        activeFileSnapshot = message.activeFile ? abstractFileSnapshot.get(message.activeFile.path) || Object.assign(new TFile(message.activeFile.path), message.activeFile) : null;
        for (const handler of loadHandlers) result = await handler();
        eventApi.trigger("layout-ready");
        eventApi.trigger("active-leaf-change", activeFileSnapshot);
      }
      else if (message.type === "unload") for (const handler of unloadHandlers) result = await handler();
      else if (message.type === "vault-change") {
        const previous = abstractFileSnapshot;
        fileSnapshot = hydrateFiles(Array.isArray(message.files) ? message.files : fileSnapshot);
        metadataSnapshot = new Map((Array.isArray(message.metadata) ? message.metadata : []).map((entry) => [entry.path, entry]));
        for (const path of message.paths || []) {
          const file = abstractFileSnapshot.get(path) || previous.get(path) || new TFile(path);
          const removed = !abstractFileSnapshot.has(path);
          eventApi.trigger(removed ? "delete" : previous.has(path) ? "modify" : "create", file);
          eventApi.trigger("changed", file, removed ? "deleted" : "changed");
        }
      }
      else if (message.type === "command") result = await callbacks.get(message.id)?.();
      else if (message.type === "ui-action") result = await callbacks.get(message.id)?.();
      else if (message.type === "view") result = await views.get(message.id)?.();
      else if (message.type === "display-settings") {
        document.body.className = "plugin-settings-host";
        document.body.replaceChildren();
        const tabs = window.__obsidianPluginInstance?._settingTabs || [];
        if (!tabs.length) {
          const empty = document.createElement("p");
          empty.textContent = "This plugin did not register a settings tab.";
          document.body.append(empty);
        }
        for (const tab of tabs) {
          const mount = document.createElement("div");
          mount.className = "plugin-settings-tab";
          document.body.append(mount);
          tab.containerEl = mount;
          try { tab.display?.(); }
          catch (error) {
            const failed = document.createElement("p");
            failed.className = "plugin-settings-error";
            failed.textContent = String(error);
            mount.append(failed);
          }
        }
        result = true;
      }
      else if (message.type === "process-post") {
        const host = document.createElement("div");
        host.innerHTML = String(message.html || "");
        const processors = window.__obsidianPluginInstance?._postProcessors || [];
        const children = [];
        const ctx = Object.freeze({ sourcePath: message.path || null, containerEl: host, el: host, addChild: (child) => { children.push(child); child.load?.(); }, getSectionInfo: () => null, frontmatter: null });
        for (const processor of processors) if (typeof processor === "function") await processor(host, ctx);
        result = host.innerHTML;
      }
      else if (message.type === "process-code") {
        const host = document.createElement("div");
        const processor = window.__obsidianPluginInstance?._codeProcessors?.get(String(message.language || ""));
        if (typeof processor === "function") {
          const children = [];
          const ctx = Object.freeze({ sourcePath: message.path || null, containerEl: host, el: host, addChild: (child) => { children.push(child); child.load?.(); }, getSectionInfo: () => null, frontmatter: null });
          await processor(String(message.source || ""), host, ctx);
          result = host.innerHTML;
        }
      }
      parent.postMessage({ nephritePlugin: true, pluginId, type: "callback", requestId: message.requestId, result }, "*");
    } catch (error) {
      parent.postMessage({ nephritePlugin: true, pluginId, type: "callback", requestId: message.requestId, error: String(error?.stack || error) }, "*");
    }
  });
})();`;
  const source = preparePluginModuleSource(plugin.source).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  const style = rewritePluginAssetUrls(plugin.style ?? "", plugin).replace(/<\/style/gi, "<\\/style");
  const startCompatibility = plugin.compatibility === "obsidian" ? "window.__startObsidianPlugin();" : "";
  const settingsCss = `html,body{height:100%;box-sizing:border-box}body.plugin-settings-host{margin:0;padding:18px 22px 28px;font:16px/1.5 system-ui,sans-serif;color:#e7eef7;background:#101820}body.plugin-settings-host p{color:#9aacbf;font-size:14px}.plugin-settings-error{color:#ff9c9c}.setting-item{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:12px 0;border-bottom:1px solid #243041}.setting-item-heading{display:block;border-bottom:1px solid #3a4d63;margin-top:12px;padding-top:4px}.setting-item-info{min-width:0;flex:1}.setting-item-name{font-size:16px;font-weight:650}.setting-item-description{color:#9aacbf;font-size:13px;margin-top:3px}.setting-item-control{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.setting-item-control input[type=text],.setting-item-control textarea,.setting-item-control select{background:#0b1119;color:#e7eef7;border:1px solid #53677e;border-radius:6px;padding:7px 10px;font-size:15px;min-width:18rem}.setting-item-control textarea{min-width:min(36rem,100%);min-height:5rem}.setting-item-control input[type=checkbox]{width:1.05rem;height:1.05rem}.setting-item-control button{background:#1e4b3b;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:14px}.setting-item-control button.mod-cta{background:#2f7d5b}.kroki-header-row{display:grid;gap:6px;margin-top:8px;width:100%}.kroki-header-label{color:#9aacbf;font-size:13px}.kroki-header-textarea{width:100%;min-height:5rem;background:#0b1119;color:#e7eef7;border:1px solid #53677e;border-radius:6px;padding:8px 10px;font:14px ui-monospace,monospace}`;
  const overlayCss = `body.plugin-modal-host,body.plugin-menu-host{margin:0;width:100vw;height:100vh;background:rgba(0,0,0,.45);display:grid;place-items:center;font:15px/1.45 system-ui,sans-serif;color:#e7eef7}.modal{position:relative;min-width:min(34rem,calc(100vw - 3rem));max-width:calc(100vw - 3rem);max-height:calc(100vh - 3rem);overflow:auto;background:#101820;border:1px solid #53677e;border-radius:10px;box-shadow:0 18px 70px #000;padding:20px}.modal-title{margin:0 2rem 14px 0}.modal-close-button{position:absolute;right:10px;top:8px;background:transparent;color:#e7eef7;border:0;font-size:26px}.menu{position:absolute;min-width:12rem;background:#101820;border:1px solid #53677e;border-radius:7px;padding:5px;box-shadow:0 12px 40px #000}.menu-item{display:block;width:100%;text-align:left;background:transparent;color:#e7eef7;border:0;border-radius:4px;padding:7px 10px}.menu-item:hover{background:#244536}.menu-separator{height:1px;background:#53677e;margin:4px}`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:"><style>${settingsCss}${overlayCss}${style}</style>
<script>${bootstrap}\ntry {\n${source}\n${startCompatibility}\nparent.postMessage({nephritePlugin:true,pluginId:${JSON.stringify(plugin.id)},type:"ready"},"*");\n} catch(error) { parent.postMessage({nephritePlugin:true,pluginId:${JSON.stringify(plugin.id)},type:"error",message:String(error?.stack || error)},"*"); }<\/script>`;
}

/** Accept the ESM wrapper emitted by modern plugin builds while retaining the
 * CommonJS contract used by the Obsidian community registry. Relative imports
 * are expected to have been bundled into main.js, as they are for Obsidian. */
export function preparePluginModuleSource(source: string): string {
  return transformPluginModuleSource(source);
}

export function rewritePluginAssetUrls(style: string, plugin: Pick<PluginDescriptor, "id" | "assets">): string {
  const assets = plugin.assets ?? {};
  return style.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, _quote: string, raw: string) => {
    const value = raw.trim();
    if (/^(?:data:|blob:|https?:|#)/i.test(value)) return whole;
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
    const prefix = `.obsidian/plugins/${plugin.id}/`;
    const relative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    const url = assets[relative] ?? assets[normalized];
    return url ? `url("${url}")` : whole;
  });
}

export class IsolatedPlugin {
  readonly contributions = new Map<string, Contribution>();
  readonly iframe: HTMLIFrameElement;
  error: string | null = null;
  ready = false;
  loadFinished = false;
  hasSettings = false;
  settingTabs: Array<{ id: string; name: string }> = [];
  private callbackSequence = 0;
  private callbacks = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private readyWaiters: Array<() => void> = [];
  private loadWaiters: Array<() => void> = [];
  private generation = 0;
  private app: ObsidianApp;
  private overlayWasSettings = false;

  constructor(readonly descriptor: PluginDescriptor, private services: PluginHostServices, private changed: () => void) {
    this.app = new ObsidianApp({
      ...services,
      registerCommand: (id, title, keywords) => this.register(id, title, keywords, "command"),
      registerView: (id, title) => this.register(id, title, "", "view"),
    }, descriptor.permissions);
    this.iframe = document.createElement("iframe");
    this.iframe.hidden = true;
    this.iframe.sandbox.add("allow-scripts");
    this.iframe.title = `Nephrite plugin: ${descriptor.name}`;
    this.iframe.addEventListener("load", () => {
      this.generation += 1;
      if (this.generation > 1) this.resetAfterReload();
    });
    this.iframe.srcdoc = pluginIframeDocument(descriptor);
    (document.getElementById("plugin-host") ?? document.body).appendChild(this.iframe);
  }

  markReady(): void {
    this.ready = true;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter();
  }

  markLoadFinished(): void {
    this.loadFinished = true;
    const waiters = this.loadWaiters;
    this.loadWaiters = [];
    for (const waiter of waiters) waiter();
  }

  waitUntilReady(timeoutMs = 4000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  waitUntilLoadFinished(timeoutMs = 6000): Promise<void> {
    if (this.loadFinished) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.loadWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private resetAfterReload(): void {
    this.ready = false;
    this.loadFinished = false;
    this.error = null;
    for (const callback of this.callbacks.values()) callback.reject(new Error("Plugin frame reloaded"));
    this.callbacks.clear();
  }

  private styleSettingsFrame(): void {
    this.iframe.hidden = false;
    this.iframe.classList.add("plugin-settings-frame");
    this.iframe.setAttribute("aria-hidden", "false");
    this.iframe.removeAttribute("width");
    this.iframe.removeAttribute("height");
    this.iframe.style.cssText = [
      "display:block",
      "width:100%",
      "height:100%",
      "min-height:32rem",
      "flex:1 1 auto",
      "border:0",
      "background:#101820",
    ].join(";");
  }

  showOverlay(): void {
    this.overlayWasSettings = this.iframe.classList.contains("plugin-settings-frame");
    this.iframe.hidden = false;
    this.iframe.classList.add("plugin-overlay-frame");
    this.iframe.setAttribute("aria-hidden", "false");
    this.iframe.style.cssText = "display:block;position:fixed;inset:0;width:100vw;height:100vh;border:0;background:transparent;z-index:2147483000";
  }

  hideOverlay(): void {
    this.iframe.classList.remove("plugin-overlay-frame");
    if (this.overlayWasSettings) this.styleSettingsFrame();
    else {
      this.iframe.hidden = true;
      this.iframe.setAttribute("aria-hidden", "true");
      this.iframe.style.cssText = "";
    }
    this.overlayWasSettings = false;
  }

  async attachSettings(host: HTMLElement): Promise<void> {
    this.styleSettingsFrame();
    if (this.iframe.parentElement === host) {
      await this.waitUntilLoadFinished();
      return;
    }
    const generation = this.generation;
    const sawLoad = new Promise<void>((resolve) => {
      const onLoad = () => resolve();
      this.iframe.addEventListener("load", onLoad, { once: true });
      window.setTimeout(() => {
        this.iframe.removeEventListener("load", onLoad);
        resolve();
      }, 120);
    });
    host.appendChild(this.iframe);
    await sawLoad;
    if (this.generation !== generation || !this.loadFinished) await this.waitUntilLoadFinished();
  }

  accepts(event: MessageEvent, message: PluginMessage): boolean {
    return event.source === this.iframe.contentWindow && message.pluginId === this.descriptor.id;
  }

  async request(message: RpcRequest): Promise<void> {
    const reply = (result?: unknown, error?: string) => this.iframe.contentWindow?.postMessage({
      nephriteHost: true, pluginId: this.descriptor.id, type: "response", requestId: message.requestId, result, error,
    }, "*");
    try {
      const result = await this.app.call(message.method, ...message.args);
      reply(result);
    } catch (error) {
      reply(undefined, String(error));
    }
  }

  register(id: string, title: string, keywords: string, kind: "command" | "view" | "ribbon" | "status", icon?: string) {
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(id)) throw new Error(`Invalid ${kind} id`);
    this.contributions.set(`${kind}:${id}`, { id, title: title || id, keywords, pluginId: this.descriptor.id, kind, icon });
    this.changed();
  }

  invoke(type: "load" | "unload" | "command" | "view" | "ui-action" | "display-settings", id?: string): Promise<unknown> {
    const requestId = ++this.callbackSequence;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!this.callbacks.has(requestId)) return;
        this.callbacks.delete(requestId);
        reject(new Error(`Plugin ${type} timed out`));
      }, type === "display-settings" ? 8000 : 15000);
      this.callbacks.set(requestId, {
        resolve: (value) => { window.clearTimeout(timer); resolve(value); },
        reject: (reason) => { window.clearTimeout(timer); reject(reason); },
      });
      const dispatch = async () => {
        const canRead = this.descriptor.permissions.includes("vault.read");
        const canReadEditor = this.descriptor.permissions.includes("editor.read");
        const [files, metadata] = type === "load" && canRead
          ? await Promise.all([
              this.services.listFiles(),
              this.services.metadataSnapshot?.() ?? [],
            ])
          : [[], []];
        if (type === "display-settings") this.styleSettingsFrame();
        this.iframe.contentWindow?.postMessage({
          nephriteHost: true,
          pluginId: this.descriptor.id,
          type,
          id,
          requestId,
          files,
          metadata,
          activeFile: type === "load" && canReadEditor
            ? fileFromEditorState(this.services.editorState().path)
            : null,
        }, "*");
      };
      void dispatch().catch((error) => {
        this.callbacks.delete(requestId);
        reject(error);
      });
    });
  }

  resolveCallback(message: { requestId: number; result?: unknown; error?: string }) {
    const callback = this.callbacks.get(message.requestId);
    if (!callback) return;
    this.callbacks.delete(message.requestId);
    message.error ? callback.reject(new Error(message.error)) : callback.resolve(message.result);
  }

  notifyVaultChange(paths: string[], files: readonly unknown[], metadata: readonly unknown[]): void {
    this.iframe.contentWindow?.postMessage({ nephriteHost: true, pluginId: this.descriptor.id, type: "vault-change", paths, files, metadata }, "*");
  }

  /**
   * Ask the sandbox to run a registered markdown processor over provided HTML.
   * Post-processors receive (el, ctx) and mutate el; code-block processors
   * receive (source, el, ctx). The sandbox returns the modified element's HTML.
   */
  process(kind: "post" | "code", payload: { html?: string; source?: string; language?: string; path?: string | null }): Promise<string | null> {
    const requestId = ++this.callbackSequence;
    return new Promise((resolve, reject) => {
      this.callbacks.set(requestId, {
        resolve: (value) => resolve(typeof value === "string" ? value : null),
        reject,
      });
      this.iframe.contentWindow?.postMessage({
        nephriteHost: true,
        pluginId: this.descriptor.id,
        type: kind === "post" ? "process-post" : "process-code",
        requestId,
        ...payload,
      }, "*");
    });
  }

  hideSettings(): void {
    this.iframe.hidden = true;
    this.iframe.classList.remove("plugin-settings-frame");
    this.iframe.setAttribute("aria-hidden", "true");
    const host = document.getElementById("plugin-host") ?? document.body;
    if (this.iframe.parentElement !== host) host.appendChild(this.iframe);
  }

  async dispose() {
    if (this.ready) await Promise.race([this.invoke("unload"), new Promise((resolve) => setTimeout(resolve, 750))]).catch(() => {});
    this.iframe.remove();
    this.contributions.clear();
    this.callbacks.clear();
  }
}

function fileFromEditorState(path: string | null) {
  return path ? { path, name: path.replace(/^.*\//, "") } : null;
}

export class PluginManager {
  private plugins = new Map<string, IsolatedPlugin>();
  private descriptors: PluginDescriptor[] = [];
  private vaultKey = "";
  private listener = (event: MessageEvent) => this.onMessage(event);
  private metadataSnapshot: readonly unknown[] | Promise<readonly unknown[]> | null = null;
  private postProcessors = new Set<string>();
  private codeBlockProcessors = new Map<string, string>();

  constructor(private services: PluginHostServices, private changed: () => void = () => {}) {
    window.addEventListener("message", this.listener);
  }

  async load(descriptors: PluginDescriptor[], vaultKey: string) {
    await this.unload();
    this.descriptors = descriptors;
    this.vaultKey = vaultKey;
    this.metadataSnapshot = this.services.metadataSnapshot?.() ?? [];
    for (const descriptor of descriptors) {
      const validation = validatePluginDescriptor(descriptor);
      if (validation) continue;
      if (descriptor.compatibility === "obsidian" && descriptor.enabled === false) continue;
      if (descriptor.compatibility !== "obsidian" && localStorage.getItem(this.enabledKey(descriptor.id)) === "0") continue;
      if (!(await this.permissionsGranted(descriptor))) continue;
      this.plugins.set(descriptor.id, new IsolatedPlugin(descriptor, this.pluginServices(descriptor), this.changed));
    }
    this.changed();
  }

  private async permissionsGranted(descriptor: PluginDescriptor): Promise<boolean> {
    const signature = [...descriptor.permissions].sort().join(",");
    if (localStorage.getItem(this.grantKey(descriptor.id)) === signature) return true;
    const permissions = descriptor.permissions.length ? descriptor.permissions.join("\n• ") : "No host permissions";
    const granted = await uiConfirm(
      `Enable plugin “${descriptor.name}” (${descriptor.version})?\n\nRequested permissions:\n• ${permissions}`,
      { title: "Plugin permissions" },
    );
    if (granted) localStorage.setItem(this.grantKey(descriptor.id), signature);
    else {
      localStorage.setItem(this.enabledKey(descriptor.id), "0");
      await this.services.persistPluginEnabled?.(descriptor.id, false);
    }
    return granted;
  }

  async setEnabled(id: string, enabled: boolean) {
    localStorage.setItem(this.enabledKey(id), enabled ? "1" : "0");
    const descriptor = this.descriptors.find((item) => item.id === id);
    if (descriptor) descriptor.enabled = enabled;
    await this.services.persistPluginEnabled?.(id, enabled);
    if (!enabled) {
      const plugin = this.plugins.get(id);
      if (plugin) await plugin.dispose();
      this.plugins.delete(id);
      this.postProcessors.delete(id);
      for (const [language, pluginId] of [...this.codeBlockProcessors]) {
        if (pluginId === id) this.codeBlockProcessors.delete(language);
      }
    } else {
      const descriptor = this.descriptors.find((item) => item.id === id);
      if (descriptor && (await this.permissionsGranted(descriptor))) {
        this.plugins.set(id, new IsolatedPlugin(descriptor, this.pluginServices(descriptor), this.changed));
      }
    }
    this.changed();
  }

  statuses(): PluginStatus[] {
    return this.descriptors.map((descriptor) => {
      const plugin = this.plugins.get(descriptor.id);
      return {
        ...descriptor,
        enabled: descriptor.compatibility === "obsidian"
          ? descriptor.enabled !== false && localStorage.getItem(this.enabledKey(descriptor.id)) !== "0"
          : localStorage.getItem(this.enabledKey(descriptor.id)) !== "0",
        loaded: plugin?.ready ?? false,
        error: plugin?.error ?? validatePluginDescriptor(descriptor),
        hasSettings: plugin?.hasSettings ?? false,
      };
    });
  }

  get(id: string): IsolatedPlugin | undefined {
    return this.plugins.get(id);
  }

  pluginsWithSettings(): IsolatedPlugin[] {
    return [...this.plugins.values()].filter((plugin) => plugin.hasSettings);
  }

  hideAllSettings(exceptId?: string): void {
    for (const plugin of this.plugins.values()) {
      if (plugin.descriptor.id !== exceptId) plugin.hideSettings();
    }
  }

  async showSettings(id: string, host: HTMLElement): Promise<HTMLIFrameElement | null> {
    const plugin = this.plugins.get(id);
    if (!plugin) return null;
    this.hideAllSettings(id);
    try {
      await plugin.attachSettings(host);
      await plugin.invoke("display-settings");
    } catch (error) {
      plugin.error = String(error);
    }
    return plugin.iframe;
  }

  commands(): AppCommand[] {
    return [...this.plugins.values()].flatMap((plugin) => [...plugin.contributions.values()].filter((item) => item.kind === "command" || item.kind === "view").map((item): AppCommand => ({
      id: `plugin:${item.pluginId}:${item.kind}:${item.id}`,
      title: item.title,
      keywords: `${item.keywords} plugin ${plugin.descriptor.name}`,
      run: async () => {
        const result = await plugin.invoke(item.kind === "view" ? "view" : "command", item.id);
        if (item.kind === "view") this.services.showView(item.title, result as PluginViewResult);
      },
    })));
  }

  ribbonActions(): Array<{ id: string; title: string; icon?: string; run: () => Promise<unknown> }> {
    return [...this.plugins.values()].flatMap((plugin) => [...plugin.contributions.values()].filter((item) => item.kind === "ribbon").map((item) => ({
      id: `plugin:${item.pluginId}:ribbon:${item.id}`,
      title: item.title,
      icon: item.icon,
      run: () => plugin.invoke("ui-action", item.id),
    })));
  }

  statusItems(): Array<{ id: string; text: string; title: string; run: () => Promise<unknown> }> {
    return [...this.plugins.values()].flatMap((plugin) => [...plugin.contributions.values()].filter((item) => item.kind === "status").map((item) => ({
      id: `plugin:${item.pluginId}:status:${item.id}`,
      text: item.keywords,
      title: item.title,
      run: () => plugin.invoke("ui-action", item.id),
    })));
  }

  async notifyVaultChange(paths: string[]): Promise<void> {
    const [files, metadata] = await Promise.all([this.services.listFiles(), this.services.metadataSnapshot?.() ?? []]);
    for (const plugin of this.plugins.values()) {
      if (!plugin.descriptor.permissions.includes("vault.read")) continue;
      plugin.notifyVaultChange(paths, files, metadata);
    }
    this.metadataSnapshot = metadata;
  }

  hasPostProcessors(): boolean {
    return this.postProcessors.size > 0;
  }

  hasCodeBlockProcessors(): boolean {
    return this.codeBlockProcessors.size > 0;
  }

  hasCodeBlockProcessor(language: string): boolean {
    return this.codeBlockProcessors.has(language);
  }

  /** Run every registered post-processor over a rendered block, in registration order. */
  async runPostProcessors(html: string, path: string): Promise<string> {
    let current = html;
    for (const pluginId of this.postProcessors) {
      const plugin = this.plugins.get(pluginId);
      if (!plugin?.ready) continue;
      try {
        const result = await plugin.process("post", { html: current, path });
        if (typeof result === "string") current = result;
      } catch (error) {
        console.warn(`[plugin ${pluginId}] markdown post-processor failed`, error);
      }
    }
    return current;
  }

  /** Render a code block through the plugin that registered its language. */
  async runCodeBlockProcessor(language: string, source: string, path: string): Promise<string | null> {
    const pluginId = this.codeBlockProcessors.get(language);
    if (!pluginId) return null;
    const plugin = this.plugins.get(pluginId);
    if (!plugin?.ready) return null;
    try {
      const result = await plugin.process("code", { language, source, path });
      return typeof result === "string" ? result : null;
    } catch (error) {
      console.warn(`[plugin ${pluginId}] code-block processor failed`, error);
      return null;
    }
  }

  private async onMessage(event: MessageEvent) {
    const message = event.data as {
      nephritePlugin?: boolean;
      pluginId?: string;
      type?: string;
      requestId?: number;
      result?: unknown;
      error?: string;
      message?: string;
      method?: string;
      args?: unknown[];
      kind?: "post" | "code";
      language?: string;
    };
    if (!message?.nephritePlugin || !message.pluginId) return;
    const plugin = this.plugins.get(message.pluginId);
    if (!plugin || event.source !== plugin.iframe.contentWindow) return;
    if (message.type === "request") await plugin.request(message as RpcRequest);
    else if (message.type === "ready") {
      plugin.markReady();
      await plugin.invoke("load").catch((error) => { plugin.error = String(error); });
      plugin.markLoadFinished();
      this.changed();
    } else if (message.type === "error") {
      plugin.error = message.message || "Plugin failed to load";
      this.changed();
    } else if (message.type === "callback" && message.requestId != null) plugin.resolveCallback({ requestId: message.requestId, result: message.result, error: message.error });
    else if (message.type === "settings-tab") {
      plugin.hasSettings = true;
      const tabId = String((message as { id?: string }).id || message.pluginId);
      const tabName = String((message as { name?: string }).name || plugin.descriptor.name);
      plugin.settingTabs = plugin.settingTabs.filter((tab) => tab.id !== tabId);
      plugin.settingTabs.push({ id: tabId, name: tabName });
      this.changed();
    } else if (message.type === "processor-registered") {
      if (message.kind === "post") this.postProcessors.add(message.pluginId);
      else if (message.kind === "code" && message.language) {
        const language = message.language.toLowerCase();
        // Native preview owns mermaid fences; ignore Obsidian mermaid processors.
        if (language === "mermaid" || language === "mmd") return;
        this.codeBlockProcessors.set(language, message.pluginId);
      }
    } else if (message.type === "modal-open") plugin.showOverlay();
    else if (message.type === "modal-close") plugin.hideOverlay();
    else if (message.type === "ribbon-registered") plugin.register(String((message as { id?: string }).id || "ribbon"), String((message as { name?: string }).name || plugin.descriptor.name), "", "ribbon", String((message as { icon?: string }).icon || ""));
    else if (message.type === "ribbon-removed") { plugin.contributions.delete(`ribbon:${String((message as { id?: string }).id || "")}`); this.changed(); }
    else if (message.type === "status-updated") plugin.register(String((message as { id?: string }).id || "status"), String((message as { title?: string }).title || plugin.descriptor.name), String((message as { text?: string }).text || ""), "status");
    else if (message.type === "status-removed") { plugin.contributions.delete(`status:${String((message as { id?: string }).id || "")}`); this.changed(); }
  }

  async unload() {
    await Promise.all([...this.plugins.values()].map((plugin) => plugin.dispose()));
    this.plugins.clear();
    this.postProcessors.clear();
    this.codeBlockProcessors.clear();
    this.changed();
  }

  destroy() {
    void this.unload();
    window.removeEventListener("message", this.listener);
  }

  private pluginServices(descriptor: PluginDescriptor): PluginHostServices {
    const dataKey = `nephrite.plugin.data:${this.vaultKey}:${descriptor.id}`;
    return {
      ...this.services,
      metadataSnapshot: () => this.metadataSnapshot ?? [],
      loadPluginData: async () => {
        if (this.services.readPluginData) return this.services.readPluginData(descriptor.id);
        try { return JSON.parse(localStorage.getItem(dataKey) ?? "null"); }
        catch { return null; }
      },
      savePluginData: async (value) => {
        if (this.services.writePluginData) {
          await this.services.writePluginData(descriptor.id, value);
          return;
        }
        localStorage.setItem(dataKey, JSON.stringify(value ?? null));
      },
    };
  }

  private enabledKey(id: string) { return `nephrite.plugin.enabled:${this.vaultKey}:${id}`; }
  private grantKey(id: string) { return `nephrite.plugin.grant:${this.vaultKey}:${id}`; }
}
