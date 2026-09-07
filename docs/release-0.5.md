# Nephrite 0.5.0

`PROJECT_VERSION` 0.5 was a minor application release. Existing 0.4 indexes
remained compatible, and named feature backfills became resumable when an
upgrade was interrupted.

## Native workflows

- Daily notes and the calendar honored Obsidian configuration, with period-note
  navigation and creation from configured templates.
- PDF, audio, video, source-code, CSV, JSON, and YAML files gained native
  viewers; preview added KaTeX, Mermaid, syntax highlighting, and richer note
  embeds.
- Smart paste converted browser HTML, linked selected text, and stored pasted
  or dropped images in the configured attachment folder.
- Slash commands, extended task statuses, surgical property editing, and a
  full-file merge surface reduced common editing friction.

## Navigation and vault integrity

- A shared Obsidian-order link resolver handled aliases, relative links,
  ambiguous names, attachments, and shortest-unique wikilink insertion.
- Backlinks, outgoing links, tags, unlinked mentions, orphans, placeholders,
  and folder/tag graph coloring became first-class navigation surfaces.
- File moves rewrote affected Markdown and wikilinks while preserving source
  syntax, and batch indexing/checkpoint work moved into reusable index paths.

## Plugins

- The plugin manager could browse, install, enable, disable, and remove
  community plugins using the same `.obsidian/plugins/` layout as Obsidian.
- Native and Obsidian-compatible plugins shared a permissioned application
  facade, persistent data, processors, and host-managed UI surfaces.

## Regression protection

- Coverage expanded across real journal Dataview queries, sandboxed globals,
  properties, links, daily notes, navigation panes, plugins, file viewers,
  smart paste, math, Mermaid, and syntax highlighting.

