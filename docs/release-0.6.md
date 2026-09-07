# Nephrite 0.6.0

`PROJECT_VERSION` 0.6 was a minor application release. Existing 0.5 indexes
remained compatible and pending named backfills continued in place.

## Editor responsiveness

- Dirty editor state was isolated behind a lightweight reactor so typing no
  longer performed preview, indexing, or document-serialization work directly.
- Save echoes and filesystem watcher events stopped reloading the active dirty
  note, while autosave and deferred preview refreshes could complete
  independently.
- Closing a pane cancelled its in-flight preview work and quiet-period preview
  rendering avoided obsolete updates.

## Index and link performance

- Reconciliation planned changed, removed, background, and visible files before
  indexing, avoiding repeated work for clean on-screen notes.
- Fast per-path touches, passive WAL checkpoints, and cached link resolution
  reduced watcher and navigation overhead on large vaults.
- Wikilink resolution and highlighting were bounded for large notes and
  multi-thousand-file vaults.

## Embeds and links

- Wikilink parsing consistently stripped aliases and image-width suffixes.
- Note-embed hydration resolved embedded images through the same vault-aware
  link path as other preview content.

## Regression protection

- Performance tests guarded the keystroke path, large-vault resolution,
  highlight scans, save-echo locking, preview cancellation, and incremental
  index touches.

