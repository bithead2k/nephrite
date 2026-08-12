# Native automation and capture

Nephrite reads optional automation configuration from
`.nephrite/automations.json`. Each entry becomes a named command in the command
bar and can receive a configurable shortcut in Preferences.

The runtime is declarative: it performs a small set of audited vault operations
instead of evaluating arbitrary `<%* JavaScript %>`. Existing Templater script
blocks remain preserved as source.

## Quick capture example

```json
{
  "version": 1,
  "functions": {
    "captureLine": "- {{date:YYYY-MM-DD}} {{time}} {{value}}"
  },
  "commands": [
    {
      "id": "quick-capture",
      "name": "Quick capture to inbox",
      "description": "Prompt for text and append it to Inbox.md",
      "shortcut": "Mod+Shift+C",
      "prompts": [
        { "name": "value", "label": "Capture" }
      ],
      "actions": [
        {
          "type": "append",
          "path": "Inbox.md",
          "content": "{{function:captureLine}}\n"
        },
        { "type": "open", "path": "Inbox.md" }
      ]
    }
  ],
  "lifecycle": {}
}
```

Preferences can create this example automatically.

## Variables and reusable functions

Text and paths support:

- `{{active.path}}`, `{{active.title}}`, and `{{active.folder}}`
- `{{selection}}`
- prompt names such as `{{value}}`
- `{{date}}`, `{{time}}`, and custom forms such as
  `{{date:YYYY/MM/DD}}`
- `{{function:name}}` for reusable text functions defined in the top-level
  `functions` object

Functions may call other functions. Recursive expansion is rejected.

## Actions

| Type | Fields | Behavior |
| --- | --- | --- |
| `create` | `path`, `content` or `template`, `open` | Create a new file without overwriting an existing one. |
| `append` | `path`, `content` or `template` | Append to a file, creating it if absent. |
| `prepend` | `path`, `content` or `template` | Prepend to a file, creating it if absent. |
| `move` / `rename` | optional `from`, required `to` | Rename a vault file; omitted `from` uses the active file. |
| `apply-template` | `template` | Merge template YAML and insert its body in the active note. |
| `open` | `path` | Open a note/canvas or use the default app for an attachment. |
| `notice` | `message` | Show a status message. |

For `content`, automation variables are expanded directly. For `template`, the
referenced Markdown file is rendered through Nephrite's safe Templater subset,
including dates, prompts, includes, frontmatter, selection, and cursor support.

## Lifecycle hooks

The optional lifecycle object contains command IDs:

```json
{
  "lifecycle": {
    "onVaultOpen": ["initialize-daily-log"],
    "onNoteOpen": ["record-recent-note"],
    "onNoteSave": ["append-save-audit"]
  }
}
```

Lifecycle commands cannot prompt. Recursive invocation of the same command is
rejected. These hooks have the same constrained action surface as commands and
do not gain shell or general JavaScript access.
