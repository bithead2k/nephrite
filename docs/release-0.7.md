# Nephrite 0.7.0

Nephrite 0.7 was the feature milestone between the 0.6 and 0.8 releases. The
repository manifests were not published with a 0.7 version bump; they advanced
from 0.6.0 to 0.8.0 when the next release was cut. The changes were additive
and did not introduce a full index rebuild.

## Bases and structured data

- Obsidian `.base` files and `base` fences gained table, list, and card views
  backed by the shared vault index.
- Base filters, formulas, property selection, sorting, and view tabs were
  parsed and evaluated without creating a separate data store.
- Nested YAML properties gained structured display and surgical editing.

## Workspace tools

- An attachment inventory exposed orphan filtering, and a SQL console ran
  index queries with source-note links.
- Kanban cards could use frontmatter images as covers, with improved hover and
  scrolling behavior.
- Focused-pane refresh, richer command-bar context, and properties editing
  reduced routine navigation friction.

## Plugin compatibility

- Obsidian-style settings tabs and `Setting` controls opened in a host-managed
  panel.
- Common Obsidian DOM helpers such as `empty`, `createEl`, `createDiv`, and
  `addClass` became available to compatible plugins with lifecycle cleanup.

## Regression protection

- Tests covered Bases parsing/evaluation/rendering, nested YAML, the SQL and
  attachment tools, Kanban covers, focused refresh, and plugin settings/DOM
  compatibility.

