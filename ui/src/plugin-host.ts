import type { AppCommand } from "./command-bar";
import type { FileEntry } from "./types";

export const PLUGIN_API_VERSION = 1;

export type PluginPermission =
  | "vault.read"
  | "vault.write"
  | "index.query"
  | "editor.read"
  | "editor.write"
  | "workspace.commands"
  | "workspace.views"
  | "shell.execute";

export type PluginDescriptor = {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: PluginPermission[];
  api_version: number;
  min_app_version: string | null;
  source: string;
};

export type PluginStatus = PluginDescriptor & {
  enabled: boolean;
  loaded: boolean;
  error: string | null;
};

export type PluginHostServices = {
  listFiles: () => readonly FileEntry[];
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  queryIndex: (sql: string) => Promise<unknown>;
  editorState: () => { path: string | null; content: string; selection: string };
  replaceSelection: (content: string) => void;
  openPath: (path: string) => Promise<void>;
  showView: (title: string, result: PluginViewResult) => void;
  executeShell: (command: string, args: string[]) => Promise<unknown>;
};

export type PluginViewResult = { type?: "text" | "markdown"; content?: string } | string | null;

type Contribution = { id: string; title: string; keywords: string; pluginId: string; kind: "command" | "view" };
type RpcRequest = { nephritePlugin: true; pluginId: string; type: "request"; requestId: number; method: string; args: unknown[] };
type PluginMessage = RpcRequest | { nephritePlugin: true; pluginId: string; type: "ready" | "error"; message?: string };

const METHOD_PERMISSIONS: Record<string, PluginPermission> = {
  "vault.list": "vault.read",
  "vault.read": "vault.read",
  "vault.write": "vault.write",
  "index.query": "index.query",
  "editor.getState": "editor.read",
  "editor.replaceSelection": "editor.write",
  "workspace.open": "vault.read",
  "workspace.registerCommand": "workspace.commands",
  "workspace.registerView": "workspace.views",
  "shell.execute": "shell.execute",
};

export function permissionForPluginMethod(method: string): PluginPermission | null {
  return METHOD_PERMISSIONS[method] ?? null;
}

export function validatePluginDescriptor(plugin: PluginDescriptor): string | null {
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(plugin.id)) return "Invalid plugin id";
  if (!plugin.name.trim()) return "Plugin name is required";
  if (!plugin.version.trim()) return "Plugin version is required";
  if (new Set(plugin.permissions).size !== plugin.permissions.length) return "Duplicate plugin permission";
  if (plugin.api_version !== PLUGIN_API_VERSION) return `Requires plugin API ${plugin.api_version}`;
  return null;
}

function iframeDocument(plugin: PluginDescriptor): string {
  const bootstrap = `
(() => {
  "use strict";
  const pluginId = ${JSON.stringify(plugin.id)};
  const callbacks = new Map();
  const views = new Map();
  const loadHandlers = [];
  const unloadHandlers = [];
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
  window.nephrite = Object.freeze({
    apiVersion: ${PLUGIN_API_VERSION},
    onLoad: (callback) => loadHandlers.push(callback),
    onUnload: (callback) => unloadHandlers.push(callback),
    vault: Object.freeze({ list: () => send("vault.list", []), read: (path) => send("vault.read", [path]), write: (path, content) => send("vault.write", [path, content]) }),
    index: Object.freeze({ query: (sql) => send("index.query", [sql]) }),
    editor: Object.freeze({ getState: () => send("editor.getState", []), replaceSelection: (content) => send("editor.replaceSelection", [content]) }),
    workspace: Object.freeze({ open: (path) => send("workspace.open", [path]), registerCommand, registerView }),
    shell: Object.freeze({ execute: (command, args = []) => send("shell.execute", [command, args]) }),
  });
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
      if (message.type === "load") for (const handler of loadHandlers) result = await handler();
      else if (message.type === "unload") for (const handler of unloadHandlers) result = await handler();
      else if (message.type === "command") result = await callbacks.get(message.id)?.();
      else if (message.type === "view") result = await views.get(message.id)?.();
      parent.postMessage({ nephritePlugin: true, pluginId, type: "callback", requestId: message.requestId, result }, "*");
    } catch (error) {
      parent.postMessage({ nephritePlugin: true, pluginId, type: "callback", requestId: message.requestId, error: String(error) }, "*");
    }
  });
})();`;
  const source = plugin.source.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
<script>${bootstrap}\ntry {\n${source}\nparent.postMessage({nephritePlugin:true,pluginId:${JSON.stringify(plugin.id)},type:"ready"},"*");\n} catch(error) { parent.postMessage({nephritePlugin:true,pluginId:${JSON.stringify(plugin.id)},type:"error",message:String(error)},"*"); }<\/script>`;
}

class IsolatedPlugin {
  readonly contributions = new Map<string, Contribution>();
  readonly iframe: HTMLIFrameElement;
  error: string | null = null;
  ready = false;
  private callbackSequence = 0;
  private callbacks = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

  constructor(readonly descriptor: PluginDescriptor, private services: PluginHostServices, private changed: () => void) {
    this.iframe = document.createElement("iframe");
    this.iframe.hidden = true;
    this.iframe.sandbox.add("allow-scripts");
    this.iframe.title = `Nephrite plugin: ${descriptor.name}`;
    this.iframe.srcdoc = iframeDocument(descriptor);
    document.body.appendChild(this.iframe);
  }

  accepts(event: MessageEvent, message: PluginMessage): boolean {
    return event.source === this.iframe.contentWindow && message.pluginId === this.descriptor.id;
  }

  async request(message: RpcRequest): Promise<void> {
    const reply = (result?: unknown, error?: string) => this.iframe.contentWindow?.postMessage({
      nephriteHost: true, pluginId: this.descriptor.id, type: "response", requestId: message.requestId, result, error,
    }, "*");
    try {
      const permission = permissionForPluginMethod(message.method);
      if (!permission) throw new Error(`Unknown plugin API method: ${message.method}`);
      if (!this.descriptor.permissions.includes(permission)) throw new Error(`Permission denied: ${permission}`);
      const [first, second] = message.args;
      let result: unknown;
      switch (message.method) {
        case "vault.list": result = this.services.listFiles(); break;
        case "vault.read": result = await this.services.readFile(String(first)); break;
        case "vault.write": result = await this.services.writeFile(String(first), String(second)); break;
        case "index.query": result = await this.services.queryIndex(String(first)); break;
        case "editor.getState": result = this.services.editorState(); break;
        case "editor.replaceSelection": result = this.services.replaceSelection(String(first)); break;
        case "workspace.open": result = await this.services.openPath(String(first)); break;
        case "workspace.registerCommand": this.register(String(first), String(second), String(message.args[2] ?? ""), "command"); break;
        case "workspace.registerView": this.register(String(first), String(second), "", "view"); break;
        case "shell.execute": result = await this.services.executeShell(String(first), Array.isArray(second) ? second.map(String) : []); break;
      }
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

  invoke(type: "load" | "unload" | "command" | "view", id?: string): Promise<unknown> {
    const requestId = ++this.callbackSequence;
    return new Promise((resolve, reject) => {
      this.callbacks.set(requestId, { resolve, reject });
      this.iframe.contentWindow?.postMessage({ nephriteHost: true, pluginId: this.descriptor.id, type, id, requestId }, "*");
    });
  }

  resolveCallback(message: { requestId: number; result?: unknown; error?: string }) {
    const callback = this.callbacks.get(message.requestId);
    if (!callback) return;
    this.callbacks.delete(message.requestId);
    message.error ? callback.reject(new Error(message.error)) : callback.resolve(message.result);
  }

  async dispose() {
    if (this.ready) await Promise.race([this.invoke("unload"), new Promise((resolve) => setTimeout(resolve, 750))]).catch(() => {});
    this.iframe.remove();
    this.contributions.clear();
    this.callbacks.clear();
  }
}

export class PluginManager {
  private plugins = new Map<string, IsolatedPlugin>();
  private descriptors: PluginDescriptor[] = [];
  private vaultKey = "";
  private listener = (event: MessageEvent) => this.onMessage(event);

  constructor(private services: PluginHostServices, private changed: () => void = () => {}) {
    window.addEventListener("message", this.listener);
  }

  async load(descriptors: PluginDescriptor[], vaultKey: string) {
    await this.unload();
    this.descriptors = descriptors;
    this.vaultKey = vaultKey;
    for (const descriptor of descriptors) {
      const validation = validatePluginDescriptor(descriptor);
      if (validation) continue;
      if (localStorage.getItem(this.enabledKey(descriptor.id)) === "0") continue;
      if (!this.permissionsGranted(descriptor)) continue;
      this.plugins.set(descriptor.id, new IsolatedPlugin(descriptor, this.services, this.changed));
    }
    this.changed();
  }

  private permissionsGranted(descriptor: PluginDescriptor): boolean {
    const signature = [...descriptor.permissions].sort().join(",");
    if (localStorage.getItem(this.grantKey(descriptor.id)) === signature) return true;
    const permissions = descriptor.permissions.length ? descriptor.permissions.join("\n• ") : "No host permissions";
    const granted = confirm(`Enable plugin “${descriptor.name}” (${descriptor.version})?\n\nRequested permissions:\n• ${permissions}`);
    if (granted) localStorage.setItem(this.grantKey(descriptor.id), signature);
    else localStorage.setItem(this.enabledKey(descriptor.id), "0");
    return granted;
  }

  async setEnabled(id: string, enabled: boolean) {
    localStorage.setItem(this.enabledKey(id), enabled ? "1" : "0");
    if (!enabled) {
      const plugin = this.plugins.get(id);
      if (plugin) await plugin.dispose();
      this.plugins.delete(id);
    } else {
      const descriptor = this.descriptors.find((item) => item.id === id);
      if (descriptor && this.permissionsGranted(descriptor)) {
        this.plugins.set(id, new IsolatedPlugin(descriptor, this.services, this.changed));
      }
    }
    this.changed();
  }

  statuses(): PluginStatus[] {
    return this.descriptors.map((descriptor) => {
      const plugin = this.plugins.get(descriptor.id);
      return {
        ...descriptor,
        enabled: localStorage.getItem(this.enabledKey(descriptor.id)) !== "0",
        loaded: plugin?.ready ?? false,
        error: plugin?.error ?? validatePluginDescriptor(descriptor),
      };
    });
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
    };
    if (!message?.nephritePlugin || !message.pluginId) return;
    const plugin = this.plugins.get(message.pluginId);
    if (!plugin || event.source !== plugin.iframe.contentWindow) return;
    if (message.type === "request") await plugin.request(message as RpcRequest);
    else if (message.type === "ready") {
      plugin.ready = true;
      await plugin.invoke("load").catch((error) => { plugin.error = String(error); });
      this.changed();
    } else if (message.type === "error") {
      plugin.error = message.message || "Plugin failed to load";
      this.changed();
    } else if (message.type === "callback" && message.requestId != null) plugin.resolveCallback({ requestId: message.requestId, result: message.result, error: message.error });
  }

  async unload() {
    await Promise.all([...this.plugins.values()].map((plugin) => plugin.dispose()));
    this.plugins.clear();
    this.changed();
  }

  destroy() {
    void this.unload();
    window.removeEventListener("message", this.listener);
  }

  private enabledKey(id: string) { return `nephrite.plugin.enabled:${this.vaultKey}:${id}`; }
  private grantKey(id: string) { return `nephrite.plugin.grant:${this.vaultKey}:${id}`; }
}
