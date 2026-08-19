# Nephrite 0.8.0

`PROJECT_VERSION` 0.8 is a minor, additive index upgrade. Existing 0.x vault
indexes reconcile in place; the added Tasks columns do not require a full
rebuild. A named, resumable Markdown backfill populates the new task metadata.

## Plugin compatibility

- Obsidian and native bundles share one permissioned `app` superclass.
- CommonJS and bundled ESM `obsidian` entrypoints load without source edits.
- Settings tabs, ItemViews, Markdown post-processors, and code-block processors
  project into Nephrite UI and preview surfaces.
- Package images, fonts, media, WASM/data files, and CSS asset references are
  available inside the sandbox with per-file and package size limits.
- `request` and `requestUrl` use an explicit network permission, HTTP(S)-only
  transport, header validation, credential rejection, and a 16 MiB response cap.

## Tasks

- Indexes Tasks dates, priorities, recurrence, tags, arbitrary status markers,
  task IDs, dependencies, cancelled dates, and on-completion policy.
- Completion writes done/cancelled dates surgically; `🏁 delete` is honored.
- Recurrence covers weekdays, named weekdays, intervals, ordinal/last weekdays
  of a month, month days, annual dates, and `when done`.
- Native `tasks` fences support completion, recurrence, due-date, path/folder,
  description, tag, priority and status filtering plus sorting, grouping, limits,
  source navigation, and live source-backed checkboxes.
- Dashboard views retain agenda/project/recurrence grouping and precise source
  navigation.

## Vault safety

- Text and media replacement uses same-directory atomic files with fsync and
  permission preservation.
- Editor saves use an expected-content check and refuse to overwrite an
  externally changed or deleted note.
- Reconcile verifies stored content hashes, catching same-size changes whose
  timestamp was preserved by a sync tool.
- Rename rewriting understands Markdown destination/title boundaries, nested
  parentheses and angle destinations, and does not rewrite inline or fenced
  code.
- Create, copy, rename, and delete operations reject symlink escapes.
- YAML edits remain surgical: unsupported nested/block writes are refused
  instead of serializing or normalizing the frontmatter.

The remaining compatibility boundary is intentional: Nephrite does not expose
ambient Node/Electron modules, CodeMirror 5 internals, Obsidian Sync, or private
undocumented Obsidian objects.
