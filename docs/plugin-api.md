# Nephrite plugin API v1

Plugins live inside the vault at `.nephrite/plugins/<plugin-id>/`. Nephrite loads
only folders containing a valid `manifest.json` and asks the user to approve the
declared permissions before running the plugin.

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

Plugin JavaScript runs in a sandboxed iframe with no same-origin access, network
access, filesystem access, or direct access to Nephrite's DOM. All host access
goes through the frozen `nephrite` object and is checked against the manifest.
The v1 loader accepts one self-contained classic JavaScript file; module imports
and package dependencies are not yet supported.

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
| `shell.execute` | `shell.execute(executable, args)` |

A registered view supplies an async `onOpen` callback. It may return a string,
or `{ type: "text" | "markdown", content: "..." }`. Markdown is rendered after
raw HTML is escaped, so a plugin cannot use a view to escape its sandbox.

Permission grants are tied to the vault, plugin ID, and exact permission set.
Changing requested permissions requires fresh approval. Plugins can be disabled
or reloaded through **Manage plugins** in the command bar.

## Compatibility

`apiVersion` is mandatory for forward compatibility; omitted manifests default
to v1. Nephrite refuses to load a plugin targeting a different API version.
`minAppVersion` is recorded for package tooling but is not enforced by v1.
