# Obsidian plugin compatibility

Nephrite treats Obsidian compatibility as a facade over its native plugin host,
not as a second privileged runtime.

The compatibility target is that the vast majority of public-API Obsidian
plugins can be imported without source changes. Compatibility is behavioral:
aliases stay thin, while missing behavior is implemented once in Nephrite's
native objects instead of accumulating a second application architecture.

```text
Obsidian app / obsidian module aliases
                  ↓
            NephriteApp
       permissions + path policy
                  ↓
 vault · index · editor · workspace · commands · plugins · shell
```

Enabled packages from `.obsidian/community-plugins.json` are discovered under
`.obsidian/plugins/`. A native `.nephrite/plugins/` package with the same ID
takes precedence. Obsidian packages without a Nephrite permission manifest are
offered the ordinary vault, index, editor, command, and view permissions for
explicit approval; shell access is never inferred.

## Implemented compatibility surface

- CommonJS bundle startup through `require("obsidian")` and `module.exports`.
- Bundled ESM wrappers that import from `obsidian`, plus packaged images,
  fonts, media, WASM/data files, and sandbox-local CSS asset URLs.
- `Plugin` lifecycle (`onload`, `onunload`, registrations and cleanup).
- `app.vault`: file snapshots, lookup, read/cachedRead, create, modify, rename,
  and delete.
- `app.metadataCache`: synchronous indexed file cache, resolved-link counts,
  file-to-link text, and common link lookup.
- `app.workspace`: active file, leaf/open-file and open-link behavior.
- `app.fileManager.renameFile`/`generateMarkdownLink` and
  `app.commands.executeCommandById`.
- `app.plugins` discovery without exposing another plugin's private object.
- `Component`, `TFile`, `TFolder`, `Notice`, `Modal`, `ItemView`,
  `PluginSettingTab`, `Setting`, `Menu`, `MenuItem`, `MarkdownRenderChild`,
  `Platform`, `normalizePath`, and `debounce`.
- Plugin commands, simple views, settings tabs (`addSettingTab` / `Setting`),
  Obsidian HTMLElement helpers (`empty`, `createEl`, `createDiv`, `addClass`),
  DOM/event cleanup, and persistent `loadData`/`saveData` storage.
  Settings open from the plugin manager instead of only editing `data.json`.
  A settings tab that throws is shown as an error in that plugin's panel;
  it does not replace the host UI.
- Main-preview Markdown post-processors and code-block processors.
- Permission-gated Obsidian `request` / `requestUrl` over the native HTTP host.

The `app` object available to DataviewJS inherits the same superclass. It is
read-only by default and therefore cannot gain write or shell authority merely
by using an Obsidian alias.

## Compatibility tiers and remaining work

Plugins made from public Obsidian APIs, bundled JavaScript, commands, vault
operations, metadata, settings, processors, and ItemViews can load directly.
Plugins may load in a degraded state when they depend on Obsidian's exact
main-window layout or editor internals.

The following still require explicit adapters:

- Electron and Node modules such as `fs`, `child_process`, or `electron`;
- undocumented Obsidian DOM structure or private `app.*` properties;
- CodeMirror 5/Obsidian editor internals;
- CSS selectors or custom views that require Obsidian's exact main-window DOM;
- inter-plugin private-object access.

Unsupported imports fail with a visible plugin error. They are never silently
given ambient filesystem, network, process, WebView, or Tauri access.
