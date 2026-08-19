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
                 app
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
- CommonJS and static ESM package graphs, including relative sibling modules,
  re-exports, packaged images, fonts, media, WASM/data files, and
  sandbox-local CSS asset URLs. The installer also preserves safe extra assets
  published with a GitHub release.
- Common Obsidian-provided CodeMirror 6 externals (`state`, `view`, and
  `commands`) are exposed as capability-safe extension/keymap adapters. Plugin
  bundles cannot obtain Nephrite's editor internals through those modules.
- `Plugin` lifecycle (`onload`, `onunload`, registrations and cleanup).
- `app.vault`: live `TFile`/`TFolder` trees, lookup, read/cachedRead, create,
  modify, append, process, copy, rename, delete, adapter operations, and
  create/modify/delete change events.
- `app.metadataCache`: synchronous indexed file cache, resolved-link counts,
  file-to-link text, and common link lookup.
- `app.workspace`: active file/view, persistent leaf/open-file and open-link
  behavior, leaf enumeration, layout events, and event triggering.
- `app.fileManager.renameFile`/`generateMarkdownLink` and
  `app.commands.executeCommandById`.
- `app.plugins` discovery without exposing another plugin's private object.
- The complete public runtime export list from the pinned official
  `obsidian` 1.13.1 typings is import-audited. Core classes include isolated
  `Events`/`Component` lifecycles, `TFile`/`TFolder`, views/leaves, editor
  adapters, `Notice`, host-visible `Modal`/`Menu`, setting/input components,
  suggestions, icons, search helpers, frontmatter/link helpers, `moment`,
  `Platform`, `normalizePath`, and `debounce`.
- Obsidian 1.13 Bases runtime values (`Value` and primitive, collection, date,
  duration, link, file, tag, URL, image, HTML, icon, object and null variants),
  equality/truthiness/rendering, `Tasks`, query result/entry/group objects, and
  view configuration. Current official exports have concrete adapters rather
  than a shared empty-constructor fallback.
- Plugin commands, simple views, settings tabs (`addSettingTab` / `Setting`),
  Obsidian HTMLElement helpers (`empty`, `createEl`, `createDiv`, `addClass`),
  DOM/event cleanup, and persistent `loadData`/`saveData` storage.
  Settings open from the plugin manager instead of only editing `data.json`.
  A settings tab that throws is shown as an error in that plugin's panel;
  it does not replace the host UI.
- Main-preview Markdown post-processors and code-block processors.
- Host-visible ribbon actions and plugin status items. Status items live in the
  top toolbar and do not repurpose or mutate Nephrite's Powerline command bar.
- Permission-gated Obsidian `request` / `requestUrl` over the native HTTP host.

The `app` object available to DataviewJS inherits the same superclass. It is
read-only by default and therefore cannot gain write or shell authority merely
by using an Obsidian alias.

## Verification

`npm run test:plugin-compat` executes the generated sandbox and audits every
public runtime export from `node_modules/obsidian/obsidian.d.ts`. It also
exercises lifecycle isolation, workspace leaves, live editor mutation,
CommonJS/static-ESM submodules, settings, overlays, ribbon actions, and status
items. It also exercises the public Bases value, collection, date, task, entry,
group, and configuration semantics.

`npm run test:plugin-real` downloads checksum-pinned upstream releases and
runs their unmodified `main.js` bundles. The current real-world matrix covers:

- Style Settings 1.0.9 (settings/DOM/internal-plugin discovery);
- Commander 0.5.8 (commands, status bar, workspace and setting integration);
- Admonition 12.0.5 (Markdown processors, editor suggestions, snippets and
  custom CSS integration);
- Calendar 2.0.0-beta.2 (workspace views, daily-note aliases, global Moment,
  vault tree traversal, and Svelte UI mounting);
- Advanced Tables 0.23.2 (CodeMirror keymap extensions and editor commands);
- Kanban 2.0.51 (large bundled UI, custom views, editor suggestions, hover
  sources, and CodeMirror externals);
- Recent Files 1.7.10 (workspace/vault events, item views, commands, and
  settings).

The real-plugin command requires network access; the deterministic synthetic
suite remains part of the default offline test run.

## Deliberate security boundary

Plugins made from public Obsidian APIs, bundled JavaScript, commands, vault
operations, metadata, settings, processors, and ItemViews can load directly.
The following cannot be made compatible without either emulating Obsidian's
entire private Electron application or bypassing Nephrite's capability model:

- Electron and Node modules such as `fs`, `child_process`, or `electron`;
- undocumented Obsidian DOM structure or private application objects for which
  no safe native analogue exists;
- CodeMirror 5/Obsidian editor internals;
- CSS selectors or custom views that require Obsidian's exact main-window DOM;
- direct inter-plugin object identity/private-object access across sandbox
  boundaries.

Unsupported imports fail with a visible plugin error. They are never silently
given ambient filesystem, network, process, WebView, or Tauri access.
