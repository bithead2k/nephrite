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

type Contribution = { id: string; title: string; keywords: string; pluginId: string; kind: "command" | "view" };
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

export function pluginIframeDocument(plugin: PluginDescriptor): string {
  const bootstrap = `
(() => {
  "use strict";
  (${installObsidianDom.toString()})(window);
  window.activeDocument = window.document;
  window.activeWindow = window;
  const pluginId = ${JSON.stringify(plugin.id)};
  const callbacks = new Map();
  const views = new Map();
  const loadHandlers = [];
  const unloadHandlers = [];
  let fileSnapshot = [];
  let metadataSnapshot = new Map();
  let resolvedLinksSnapshot = Object.create(null);
  let activeFileSnapshot = null;
  const eventHandlers = new Map();
  const eventApi = Object.freeze({
    on: (name, callback) => { const handlers = eventHandlers.get(name) || new Set(); handlers.add(callback); eventHandlers.set(name, handlers); return { name, callback }; },
    offref: (reference) => eventHandlers.get(reference?.name)?.delete(reference?.callback),
    trigger: (name, ...args) => { for (const callback of eventHandlers.get(name) || []) try { callback(...args); } catch (error) { console.error(error); } },
  });
  let sequence = 0;
  const pending = new Map();
  const send = (method, args) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    pending.set(requestId, { resolve, reject });
    parent.postMessage({ nephritePlugin: true, pluginId, type: "request", requestId, method, args }, "*");
  });
  const registerCommand = async ({ id, name, title, keywords = "", callback }) => {
    if (typeof callback !== "function") throw new Error("Plugin command callback is required");
    callbacks.set(id, callback);
    return send("workspace.registerCommand", [id, name || title || id, keywords]);
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
      off: eventApi.offref,
      offref: eventApi.offref,
    }),
    index: Object.freeze({ query: (sql) => send("index.query", [sql]) }),
    metadata: Object.freeze({
      page: (path) => send("metadata.page", [path]),
      resolveLink: (link, sourcePath) => send("metadata.resolveLink", [link, sourcePath]),
      get resolvedLinks() { return send("metadata.resolvedLinks", []); },
      on: eventApi.on,
      off: eventApi.offref,
      offref: eventApi.offref,
    }),
    editor: Object.freeze({ getState: () => send("editor.getState", []), replaceSelection: (content) => send("editor.replaceSelection", [content]) }),
    workspace: Object.freeze({
      open: (path) => send("workspace.open", [path]),
      getActiveFile: () => send("workspace.getActiveFile", []),
      executeCommand: (id) => send("workspace.executeCommand", [id]),
      registerCommand,
      registerView,
      on: eventApi.on,
      off: eventApi.offref,
      offref: eventApi.offref,
    }),
    plugins: Object.freeze({
      getPlugin: (id) => send("plugins.get", [id]),
      getPlugins: () => send("plugins.get", []),
      getService: (id) => send("plugins.getService", [id]),
      loadData: () => send("plugins.loadData", []),
      saveData: (value) => send("plugins.saveData", [value]),
    }),
    commands: Object.freeze({ executeCommandById: (id) => send("workspace.executeCommand", [id]) }),
    events: Object.freeze({ on: eventApi.on, off: eventApi.offref, offref: eventApi.offref }),
    shell: Object.freeze({ execute: (command, args = []) => send("shell.execute", [command, args]) }),
  });
  window.nephrite = nephrite;
  const pathOf = (file) => typeof file === "object" && file ? file.path : file;
  const app = window.app = Object.freeze({
    vault: Object.freeze({
      configDir: nephrite.vault.configDir,
      getName: () => "Nephrite vault",
      getMarkdownFiles: () => fileSnapshot.filter((file) => file.file_kind === "markdown" || /\\.md$/i.test(file.path)),
      getFiles: () => fileSnapshot.slice(),
      getAbstractFileByPath: (path) => fileSnapshot.find((file) => file.path === path) || null,
      read: (file) => nephrite.vault.read(pathOf(file)),
      cachedRead: (file) => nephrite.vault.read(pathOf(file)),
      modify: (file, content) => nephrite.vault.write(pathOf(file), content),
      create: nephrite.vault.create,
      delete: (file) => nephrite.vault.delete(pathOf(file)),
      rename: (file, to) => nephrite.vault.rename(pathOf(file), to),
      exists: (path) => nephrite.vault.exists(path),
      on: eventApi.on,
      off: eventApi.offref,
      offref: eventApi.offref,
      adapter: Object.freeze({
        read: (path) => nephrite.vault.read(path),
        write: (path, content) => nephrite.vault.write(path, content),
        exists: (path) => nephrite.vault.exists(path),
        list: (folder) => ({
          files: fileSnapshot.filter((file) => file.path.startsWith(String(folder).replace(/\\/$/, "") + "/")).map((file) => file.path),
          folders: [],
        }),
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
      fileToLinktext: (file) => String(pathOf(file)).replace(/\.md$/i, ""),
      on: eventApi.on,
      off: eventApi.offref,
      offref: eventApi.offref,
    }),
    workspace: Object.freeze({
      openLinkText: (link, sourcePath) => send("metadata.resolveLink", [link, sourcePath]).then((file) => file && nephrite.workspace.open(file.path)),
      getActiveFile: () => activeFileSnapshot,
      getLeaf: () => Object.freeze({ openFile: (file) => nephrite.workspace.open(pathOf(file)) }),
      getLeavesOfType: () => [],
      getActiveViewOfType: () => null,
      onLayoutReady: (callback) => queueMicrotask(callback),
      on: eventApi.on,
      off: eventApi.offref,
      offref: eventApi.offref,
    }),
    fileManager: Object.freeze({
      renameFile: (file, to) => nephrite.vault.rename(pathOf(file), to),
      generateMarkdownLink: (file, _sourcePath, subpath = "", alias = "") => {
        const target = String(pathOf(file)).replace(/\.md$/i, "") + String(subpath || "");
        return "[[" + target + (alias ? "|" + alias : "") + "]]";
      },
    }),
    commands: Object.freeze({ executeCommandById: (id) => nephrite.workspace.executeCommand(id) }),
    plugins: Object.freeze({
      getPlugin: (id) => send("plugins.get", [id]),
      getPlugins: () => send("plugins.get", []),
      getService: (id) => send("plugins.getService", [id]),
      loadData: () => send("plugins.loadData", []),
      saveData: (value) => send("plugins.saveData", [value]),
    }),
  });
  const disposers = [];
  class Component {
    register(callback) { if (typeof callback === "function") disposers.push(callback); return callback; }
    registerEvent(reference) { this.register(() => eventApi.offref(reference)); return reference; }
    registerDomEvent(target, type, callback, options) {
      target?.addEventListener?.(type, callback, options);
      return this.register(() => target?.removeEventListener?.(type, callback, options));
    }
    registerInterval(id) { return this.register(() => clearInterval(id)); }
    unload() { while (disposers.length) try { disposers.pop()?.(); } catch {} }
  }
  class TAbstractFile { constructor(path = "") { this.path = path; this.name = path.split("/").pop() || path; } }
  class TFile extends TAbstractFile {
    constructor(path = "") { super(path); this.extension = this.name.includes(".") ? this.name.split(".").pop() : ""; this.basename = this.extension ? this.name.slice(0, -(this.extension.length + 1)) : this.name; }
  }
  class TFolder extends TAbstractFile { constructor(path = "") { super(path); this.children = []; } }
  class Notice { constructor(message) { console.info("[Obsidian Notice]", message); this.message = String(message); } hide() {} }
  class Modal extends Component { constructor(app) { super(); this.app = app; this.contentEl = document.createElement("div"); } open() { this.onOpen?.(); } close() { this.onClose?.(); this.unload(); } }
  class ItemView extends Component { constructor(leaf) { super(); this.leaf = leaf; this.containerEl = document.createElement("div"); this.contentEl = this.containerEl; } }
  class MarkdownRenderChild extends Component { constructor(containerEl) { super(); this.containerEl = containerEl; } }
  class MenuItem {
    setTitle(value) { this.title = value; return this; }
    setIcon(value) { this.icon = value; return this; }
    setChecked(value) { this.checked = !!value; return this; }
    setDisabled(value) { this.disabled = !!value; return this; }
    onClick(callback) { this.callback = callback; return this; }
  }
  class Menu {
    constructor() { this.items = []; }
    addItem(callback) { const item = new MenuItem(); callback(item); this.items.push(item); return this; }
    addSeparator() { return this; }
    showAtMouseEvent() { return this; }
    showAtPosition() { return this; }
    hide() {}
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
    addText(callback) {
      const inputEl = document.createElement("input");
      inputEl.type = "text";
      this.controlEl.append(inputEl);
      const control = { inputEl, setValue: (v) => (inputEl.value = v, control), setPlaceholder: (v) => (inputEl.placeholder = v, control), onChange: (fn) => (inputEl.addEventListener("input", () => fn(inputEl.value)), control) };
      callback(control);
      return this;
    }
    addToggle(callback) {
      const toggleEl = document.createElement("input");
      toggleEl.type = "checkbox";
      this.controlEl.append(toggleEl);
      const control = { toggleEl, setValue: (v) => (toggleEl.checked = !!v, control), onChange: (fn) => (toggleEl.addEventListener("change", () => fn(toggleEl.checked)), control) };
      callback(control);
      return this;
    }
    addButton(callback) {
      const buttonEl = document.createElement("button");
      this.controlEl.append(buttonEl);
      const control = { buttonEl, setButtonText: (v) => (buttonEl.textContent = v, control), setCta: () => (buttonEl.classList.add("mod-cta"), control), onClick: (fn) => (buttonEl.addEventListener("click", fn), control) };
      callback(control);
      return this;
    }
    addTextArea(callback) {
      const inputEl = document.createElement("textarea");
      this.controlEl.append(inputEl);
      const control = { inputEl, setValue: (v) => (inputEl.value = v, control), setPlaceholder: (v) => (inputEl.placeholder = v, control), setDisabled: (v) => (inputEl.disabled = !!v, control), onChange: (fn) => (inputEl.addEventListener("input", () => fn(inputEl.value)), control) };
      callback(control);
      return this;
    }
    addExtraButton(callback) {
      const extraButtonEl = document.createElement("button");
      extraButtonEl.type = "button";
      this.controlEl.append(extraButtonEl);
      const control = { extraButtonEl, setIcon: (v) => (extraButtonEl.textContent = v, control), setTooltip: (v) => (extraButtonEl.title = v, control), onClick: (fn) => (extraButtonEl.addEventListener("click", fn), control) };
      callback(control);
      return this;
    }
    addSlider(callback) {
      const sliderEl = document.createElement("input");
      sliderEl.type = "range";
      this.controlEl.append(sliderEl);
      const control = { sliderEl, setLimits: (min, max, step) => (sliderEl.min = min, sliderEl.max = max, sliderEl.step = step, control), setValue: (v) => (sliderEl.value = v, control), setDynamicTooltip: () => control, onChange: (fn) => (sliderEl.addEventListener("input", () => fn(Number(sliderEl.value))), control) };
      callback(control);
      return this;
    }
    addDropdown(callback) {
      const selectEl = document.createElement("select");
      this.controlEl.append(selectEl);
      const control = {
        selectEl,
        addOption: (value, display) => { const option = document.createElement("option"); option.value = value; option.textContent = display ?? value; selectEl.append(option); return control; },
        setValue: (v) => (selectEl.value = v, control),
        onChange: (fn) => (selectEl.addEventListener("change", () => fn(selectEl.value)), control),
      };
      callback(control);
      return this;
    }
  }
  class Plugin extends Component {
    constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this._data = {}; }
    addCommand(command) {
      const callback = async () => {
        const state = await nephrite.editor.getState().catch(() => ({ path: null, content: "", selection: "" }));
        const editor = {
          getValue: () => state.content,
          getSelection: () => state.selection,
          replaceSelection: (value) => nephrite.editor.replaceSelection(value),
          getCursor: () => ({ line: 0, ch: 0 }),
          setCursor: () => {},
        };
        if (typeof command.editorCallback === "function") return command.editorCallback(editor, null);
        if (typeof command.checkCallback === "function") return command.checkCallback(false);
        return command.callback?.();
      };
      return registerCommand({ ...command, name: command.name || command.id, callback });
    }
    registerView(type, creator) { return registerView({ id: type, name: type, onOpen: () => creator({ type, openFile: (file) => app.workspace.getLeaf().openFile(file) }) }); }
    addRibbonIcon(_icon, _title, callback) { const el = document.createElement("button"); el.addEventListener("click", callback); return el; }
    addStatusBarItem() { return document.createElement("span"); }
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
      this._postProcessor = processor;
      parent.postMessage({ nephritePlugin: true, pluginId, type: "processor-registered", kind: "post" }, "*");
      return processor;
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
  const obsidian = Object.freeze({
    Plugin, Component, TAbstractFile, TFile, TFolder, Notice, Modal, ItemView,
    MarkdownView: ItemView, MarkdownRenderChild, Menu, MenuItem, PluginSettingTab, Setting,
    Platform: Object.freeze({ isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false }),
    normalizePath: (path) => String(path).replace(/\\\\/g, "/").replace(/^\\.\\//, ""),
    debounce: (callback, wait = 0) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), wait); }; },
    MarkdownRenderer: Object.freeze({ render: async (_app, markdown, element) => { element.textContent = String(markdown); } }),
    requestUrl: async () => { throw new Error("Network access is not granted by the app host"); },
    request: async () => { throw new Error("Network access is not granted by the app host"); },
    createFragment: (callback) => {
      const fragment = document.createDocumentFragment();
      callback?.(fragment);
      return fragment;
    },
  });
  const commonModule = { exports: {} };
  window.module = commonModule;
  window.exports = commonModule.exports;
  window.require = (name) => {
    if (name === "obsidian") return obsidian;
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
    })});
    window.__obsidianPluginInstance = instance;
    if (typeof instance.onload === "function") loadHandlers.push(() => instance.onload());
    unloadHandlers.push(async () => { if (typeof instance.onunload === "function") await instance.onunload(); instance.unload?.(); });
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
        fileSnapshot = Array.isArray(message.files) ? message.files : [];
        metadataSnapshot = new Map((Array.isArray(message.metadata) ? message.metadata : []).map((entry) => [entry.path, entry]));
        resolvedLinksSnapshot = Object.create(null);
        for (const entry of metadataSnapshot.values()) {
          const counts = resolvedLinksSnapshot[entry.path] = Object.create(null);
          for (const link of Array.isArray(entry.links) ? entry.links : []) {
            const target = typeof link === "string" ? link : link?.path || link?.target || link?.link;
            if (target) counts[target] = (counts[target] || 0) + 1;
          }
        }
        activeFileSnapshot = message.activeFile || null;
        for (const handler of loadHandlers) result = await handler();
        eventApi.trigger("layout-ready");
        eventApi.trigger("active-leaf-change", activeFileSnapshot);
      }
      else if (message.type === "unload") for (const handler of unloadHandlers) result = await handler();
      else if (message.type === "command") result = await callbacks.get(message.id)?.();
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
        const processor = window.__obsidianPluginInstance?._postProcessor;
        if (typeof processor === "function") {
          const ctx = Object.freeze({ sourcePath: message.path || null, containerEl: host, el: host });
          await processor(host, ctx);
        }
        result = host.innerHTML;
      }
      else if (message.type === "process-code") {
        const host = document.createElement("div");
        const processor = window.__obsidianPluginInstance?._codeProcessors?.get(String(message.language || ""));
        if (typeof processor === "function") {
          const ctx = Object.freeze({ sourcePath: message.path || null, containerEl: host, el: host });
          await processor(String(message.source || ""), host, ctx);
          result = host.innerHTML;
        }
      }
      parent.postMessage({ nephritePlugin: true, pluginId, type: "callback", requestId: message.requestId, result }, "*");
    } catch (error) {
      parent.postMessage({ nephritePlugin: true, pluginId, type: "callback", requestId: message.requestId, error: String(error) }, "*");
    }
  });
})();`;
  const source = plugin.source.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  const style = (plugin.style ?? "").replace(/<\/style/gi, "<\\/style");
  const startCompatibility = plugin.compatibility === "obsidian" ? "window.__startObsidianPlugin();" : "";
  const settingsCss = `html,body{height:100%;box-sizing:border-box}body.plugin-settings-host{margin:0;padding:18px 22px 28px;font:16px/1.5 system-ui,sans-serif;color:#e7eef7;background:#101820}body.plugin-settings-host p{color:#9aacbf;font-size:14px}.plugin-settings-error{color:#ff9c9c}.setting-item{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:12px 0;border-bottom:1px solid #243041}.setting-item-heading{display:block;border-bottom:1px solid #3a4d63;margin-top:12px;padding-top:4px}.setting-item-info{min-width:0;flex:1}.setting-item-name{font-size:16px;font-weight:650}.setting-item-description{color:#9aacbf;font-size:13px;margin-top:3px}.setting-item-control{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.setting-item-control input[type=text],.setting-item-control textarea,.setting-item-control select{background:#0b1119;color:#e7eef7;border:1px solid #53677e;border-radius:6px;padding:7px 10px;font-size:15px;min-width:18rem}.setting-item-control textarea{min-width:min(36rem,100%);min-height:5rem}.setting-item-control input[type=checkbox]{width:1.05rem;height:1.05rem}.setting-item-control button{background:#1e4b3b;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:14px}.setting-item-control button.mod-cta{background:#2f7d5b}.kroki-header-row{display:grid;gap:6px;margin-top:8px;width:100%}.kroki-header-label{color:#9aacbf;font-size:13px}.kroki-header-textarea{width:100%;min-height:5rem;background:#0b1119;color:#e7eef7;border:1px solid #53677e;border-radius:6px;padding:8px 10px;font:14px ui-monospace,monospace}`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>${settingsCss}${style}</style>
<script>${bootstrap}\ntry {\n${source}\n${startCompatibility}\nparent.postMessage({nephritePlugin:true,pluginId:${JSON.stringify(plugin.id)},type:"ready"},"*");\n} catch(error) { parent.postMessage({nephritePlugin:true,pluginId:${JSON.stringify(plugin.id)},type:"error",message:String(error)},"*"); }<\/script>`;
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

  private register(id: string, title: string, keywords: string, kind: "command" | "view") {
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(id)) throw new Error(`Invalid ${kind} id`);
    this.contributions.set(`${kind}:${id}`, { id, title: title || id, keywords, pluginId: this.descriptor.id, kind });
    this.changed();
  }

  invoke(type: "load" | "unload" | "command" | "view" | "display-settings", id?: string): Promise<unknown> {
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
    return [...this.plugins.values()].flatMap((plugin) => [...plugin.contributions.values()].map((item): AppCommand => ({
      id: `plugin:${item.pluginId}:${item.kind}:${item.id}`,
      title: item.title,
      keywords: `${item.keywords} plugin ${plugin.descriptor.name}`,
      run: async () => {
        const result = await plugin.invoke(item.kind, item.id);
        if (item.kind === "view") this.services.showView(item.title, result as PluginViewResult);
      },
    })));
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
    }
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
