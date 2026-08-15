import { invoke } from "@tauri-apps/api/core";
import { uiAlert, uiConfirm, uiPrompt } from "./dialogs";
import type { PluginStatus } from "./plugin-host";

export type PluginCatalogItem = {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
  installed: boolean;
  enabled: boolean;
  native: boolean;
};

export function filterPluginCatalog(
  items: readonly PluginCatalogItem[],
  query: string,
): PluginCatalogItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    `${item.name} ${item.author} ${item.id} ${item.description}`.toLowerCase().includes(needle),
  );
}

export function pluginDataPath(id: string): string {
  return `.obsidian/plugins/${id}/data.json`;
}

type ManagerOptions = {
  installed: () => readonly PluginStatus[];
  reload: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  openSettings?: (id: string) => void | Promise<void>;
};

export function renderPluginManager(host: HTMLElement, options: ManagerOptions): void {
  host.replaceChildren();
  host.classList.add("plugin-manager");
  const tabs = document.createElement("div");
  tabs.className = "plugin-manager-tabs";
  const installedTab = tabButton("Installed", true);
  const catalogTab = tabButton("Community", false);
  tabs.append(installedTab, catalogTab);
  const search = document.createElement("input");
  search.type = "search";
  search.className = "plugin-manager-search";
  search.placeholder = "Search plugins…";
  search.autocomplete = "off";
  const list = document.createElement("div");
  list.className = "plugin-manager-list";
  const note = document.createElement("p");
  note.className = "feature-help";
  note.textContent =
    "Installs to .obsidian/plugins and community-plugins.json — the same files Obsidian uses.";
  host.append(tabs, search, note, list);

  let mode: "installed" | "catalog" = "installed";
  let catalog: PluginCatalogItem[] | null = null;
  let query = "";

  const drawInstalled = () => {
    const items = options.installed().filter((plugin) =>
      `${plugin.name} ${plugin.id} ${plugin.description}`.toLowerCase().includes(query),
    );
    list.replaceChildren();
    if (!items.length) {
      list.innerHTML = `<div class="feature-empty">No plugins installed. Browse the community catalog to add some.</div>`;
      return;
    }
    for (const plugin of items) list.appendChild(installedRow(plugin, options, drawInstalled));
  };

  const drawCatalog = async (refresh = false) => {
    if (!catalog || refresh) {
      list.innerHTML = `<div class="feature-loading">Loading community catalog…</div>`;
      try {
        catalog = await invoke<PluginCatalogItem[]>("plugin_catalog");
      } catch (error) {
        list.innerHTML = `<div class="feature-error">${escapeHtml(String(error))}</div>`;
        return;
      }
    }
    const items = filterPluginCatalog(catalog.filter((item) => !item.native), query);
    list.replaceChildren();
    if (!items.length) {
      list.innerHTML = `<div class="feature-empty">No matching community plugins.</div>`;
      return;
    }
    for (const item of items.slice(0, 200)) {
      list.appendChild(catalogRow(item, async () => {
        await options.reload();
        catalog = null;
        await drawCatalog(true);
      }));
    }
  };

  const draw = () => {
    if (mode === "installed") drawInstalled();
    else void drawCatalog();
  };

  installedTab.addEventListener("click", () => {
    mode = "installed";
    installedTab.classList.add("active");
    catalogTab.classList.remove("active");
    draw();
  });
  catalogTab.addEventListener("click", () => {
    mode = "catalog";
    catalogTab.classList.add("active");
    installedTab.classList.remove("active");
    draw();
  });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    draw();
  });
  draw();
}

function installedRow(
  plugin: PluginStatus,
  options: ManagerOptions,
  redraw: () => void,
): HTMLElement {
  const row = document.createElement("article");
  row.className = "plugin-manager-row";
  const title = document.createElement("strong");
  title.textContent = plugin.name;
  const meta = document.createElement("small");
  meta.textContent = [
    plugin.version,
    plugin.compatibility === "obsidian" ? "Obsidian" : "Nephrite",
    plugin.loaded ? "loaded" : plugin.enabled ? "starting" : "disabled",
    plugin.error,
  ].filter(Boolean).join(" · ");
  const desc = document.createElement("p");
  desc.textContent = plugin.description || "No description.";
  const actions = document.createElement("div");
  actions.className = "plugin-manager-actions";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = plugin.enabled ? "Disable" : "Enable";
  toggle.addEventListener("click", () => void (async () => {
    toggle.disabled = true;
    try {
      await options.setEnabled(plugin.id, !plugin.enabled);
      redraw();
    } catch (error) {
      toggle.disabled = false;
      void uiAlert(String(error));
    }
  })());
  const settings = document.createElement("button");
  settings.type = "button";
  settings.textContent = "Settings";
  settings.disabled = !plugin.hasSettings || !options.openSettings;
  settings.title = plugin.hasSettings
    ? `Open ${plugin.name} settings`
    : "This plugin did not register a settings tab";
  settings.addEventListener("click", () => {
    if (options.openSettings) void options.openSettings(plugin.id);
  });
  const configure = document.createElement("button");
  configure.type = "button";
  configure.textContent = "Data…";
  configure.title = "Edit data.json";
  configure.addEventListener("click", () => void editPluginData(plugin.id, plugin.name));
  const uninstall = document.createElement("button");
  uninstall.type = "button";
  uninstall.textContent = "Uninstall";
  uninstall.disabled = plugin.compatibility !== "obsidian";
  uninstall.title = uninstall.disabled
    ? "Native Nephrite packages are not uninstalled from this list"
    : `Remove .obsidian/plugins/${plugin.id}`;
  uninstall.addEventListener("click", () => void (async () => {
    const ok = await uiConfirm(`Uninstall “${plugin.name}”? This deletes .obsidian/plugins/${plugin.id}.`, {
      title: "Uninstall plugin",
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke("uninstall_community_plugin", { id: plugin.id });
      await options.reload();
      redraw();
    } catch (error) {
      void uiAlert(String(error));
    }
  })());
  actions.append(toggle, settings, configure, uninstall);
  row.append(title, meta, desc, actions);
  return row;
}

function catalogRow(item: PluginCatalogItem, refresh: () => Promise<void>): HTMLElement {
  const row = document.createElement("article");
  row.className = "plugin-manager-row";
  const title = document.createElement("strong");
  title.textContent = item.name;
  const meta = document.createElement("small");
  meta.textContent = `${item.author} · ${item.repo}`;
  const desc = document.createElement("p");
  desc.textContent = item.description;
  const actions = document.createElement("div");
  actions.className = "plugin-manager-actions";
  const action = document.createElement("button");
  action.type = "button";
  if (item.native) {
    action.textContent = "Included in Nephrite";
    action.disabled = true;
  } else if (item.installed) {
    action.textContent = item.enabled ? "Installed" : "Installed (disabled)";
    action.disabled = true;
  } else {
    action.textContent = "Install";
    action.addEventListener("click", () => void (async () => {
      action.disabled = true;
      action.textContent = "Installing…";
      try {
        const version = await invoke<string>("install_community_plugin", {
          id: item.id,
          repo: item.repo,
        });
        await refresh();
        void uiAlert(`Installed ${item.name} ${version} into .obsidian/plugins/${item.id}.`);
      } catch (error) {
        action.disabled = false;
        action.textContent = "Install";
        void uiAlert(String(error));
      }
    })());
  }
  actions.appendChild(action);
  row.append(title, meta, desc, actions);
  return row;
}

async function editPluginData(id: string, name: string): Promise<void> {
  const path = pluginDataPath(id);
  let current = "{}";
  try {
    current = (await invoke<{ content: string }>("read_file", { path })).content;
  } catch {
    current = "{}";
  }
  const next = await uiPrompt(`data.json for ${name}`, { defaultValue: current });
  if (next == null) return;
  try {
    JSON.parse(next);
    await invoke("write_file", { path, content: next.endsWith("\n") ? next : `${next}\n` });
  } catch (error) {
    void uiAlert(String(error));
  }
}

function tabButton(label: string, active: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `plugin-manager-tab${active ? " active" : ""}`;
  button.textContent = label;
  return button;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
