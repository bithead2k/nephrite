# Nephrite 0.2

Nephrite 0.2 turns several existing foundations into usable product surfaces.

## Git

- Shows the configured upstream, remote URL, and ahead/behind counts.
- Fetches remote-tracking state without changing working files.
- Detects merge, rebase, cherry-pick, and revert operations.
- Opens conflicted notes, stages a hand-resolved file, or explicitly selects
  the ours/theirs version before continuing.
- Shows commit metadata and patches.
- Shows per-file history and restores a selected historical version into the
  working tree after confirmation.

## Vault navigation

- Searches indexed note, heading, tag, filename, and canvas content with FTS5.
- Ranks results, renders matched snippets, and jumps to the first matching line.
- Displays the resolved wikilink/backlink network as a filterable graph.

## Canvas

- Opens existing Obsidian `.canvas` JSON directly.
- Preserves unknown document, node, and edge fields.
- Renders text, file, link, and group nodes plus edges.
- Supports moving nodes, editing text nodes, adding text/file nodes, connecting
  and deleting nodes, and autosaving back to the same open format.
- Indexes canvas nodes, edges, labels, file references, and text.

## Vim configuration

Nephrite still does not embed a full Vim process. Its compatible vimrc subset
now includes nested `if`/`elseif`/`else`/`endif`, `has()`, `exists()`, scalar
variables, `unlet`, string-building `execute`, `silent` prefixes, mappings,
abbreviations, editor options, and simple zero-argument user commands.
