# Nephrite plugin API v1

Native plugins live inside the vault at `.nephrite/plugins/<plugin-id>/`.
Nephrite also discovers enabled packages already installed under
`.obsidian/plugins/<plugin-id>/`. Both forms run in the same isolated host and
require explicit permission approval.

```json
{
  "id": "example.word-count",
  "name": "Word Count",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.js",
  "description": "Adds a word-count command.",
  "permissions": ["editor.read", "workspace.commands"]
}
```

Plugin JavaScript runs in a sandboxed iframe with no same-origin access,
filesystem access, or direct access to Nephrite's DOM. All host access
goes through the frozen `nephrite` object and is checked against the manifest.
The v1 loader accepts the bundled `main.js` format used by Obsidian packages,
including CommonJS and bundled ESM wrappers. `require("obsidian")` and ESM
imports from `obsidian` are aliases over the host facade. Unbundled relative or
external/Node modules are rejected. Package assets are exposed as capped data
URLs and CSS `url(...)` references are resolved inside the sandbox.

```js
nephrite.onLoad(async () => {
  await nephrite.workspace.registerCommand({
    id: "count-current-note",
    name: "Count words in current note",
    keywords: "statistics words",
    callback: async () => {
      const state = await nephrite.editor.getState();
      const count = state.content.trim() ? state.content.trim().split(/\s+/).length : 0;
      await nephrite.editor.replaceSelection(`Words: ${count}`);
    },
  });
});

nephrite.onUnload(() => {
  // Release plugin-owned resources here.
});
```

## Permissions and APIs

| Permission | API |
| --- | --- |
| `vault.read` | `vault.list()`, `vault.read(path)`, `workspace.open(path)` |
| `vault.write` | `vault.write(path, content)` |
| `index.query` | `index.query(sql)`; the core read-only SQL guard still applies |
| `editor.read` | `editor.getState()` |
| `editor.write` | `editor.replaceSelection(content)` |
| `workspace.commands` | `workspace.registerCommand(...)` |
| `workspace.views` | `workspace.registerView(...)` |
| `network.request` | `network.requestUrl(...)`; HTTP(S), response-size and header checks apply |
| `shell.execute` | `shell.execute(executable, args)` |

The same host is also exposed through an Obsidian-shaped `app` facade. For
example, `app.vault.read(file)` delegates to `nephrite.vault.read(file.path)`,
and both calls pass through the identical `vault.read` permission and
vault-relative path checks. See [`obsidian-plugin-compatibility.md`](obsidian-plugin-compatibility.md).

A registered view supplies an async `onOpen` callback. It may return a string,
or `{ type: "text" | "markdown", content: "..." }`. Markdown is rendered after
raw HTML is escaped, so a plugin cannot use a view to escape its sandbox.

Permission grants are tied to the vault, plugin ID, and exact permission set.
Changing requested permissions requires fresh approval. Browse, install, enable,
and remove plugins through **Manage plugins**. Community packages install into
`.obsidian/plugins/<id>/` and are toggled in `.obsidian/community-plugins.json`,
the same files Obsidian uses. Plugin `data.json` lives in that folder.

## Compatibility

`apiVersion` is mandatory for forward compatibility; omitted manifests default
to v1. Nephrite refuses to load a plugin targeting a different API version.
`minAppVersion` is recorded for package tooling but is not enforced by v1.
