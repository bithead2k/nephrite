# Nephrite 0.3.0

`PROJECT_VERSION` 0.3 was a minor application release. Existing 0.2 indexes
remained compatible and did not require a full rebuild.

## Preview and embeds

- Obsidian note transclusions gained support for whole notes, heading sections,
  and block IDs without exposing block markers in rendered output.
- Preview updates became block-aware so ordinary edits could update
  incrementally while fenced blocks and frontmatter changes still triggered the
  broader invalidation they require.
- Kanban card and link previews shared the same note-embed hydration behavior as
  the main preview.

## Queries and source context

- Native SQL and Dataview rendering retained the owning note as their current
  page, including when preview blocks were patched incrementally.
- PostgreSQL query handling became more robust around comments and nested type
  casts.

## Diagnostics

- Regression coverage was added for transclusion boundaries, incremental
  preview planning, query page ownership, and live heading-embed hydration.
- A known-bugs document recorded remaining live-preview behavior and its
  workarounds while the rendering path was being hardened.

