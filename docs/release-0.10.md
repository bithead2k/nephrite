# Nephrite 0.10.0

`PROJECT_VERSION` 0.10 is a minor application release. Existing 0.9 indexes
remain compatible and reconcile in place; this release does not require a full
vault rebuild.

## Pane switching and rendering

- Pane navigation now uses latest-request-wins coalescing so obsolete render
  work cannot delay the note the user actually selected.
- Editor state and hydrated preview DOM are retained in bounded LRU caches,
  preserving cursor, selection, folds, scroll position, and rendered content
  while preventing unbounded memory growth.
- Heavy preview hydration is deferred until after the selected pane paints,
  making the active note visible before secondary rendering work begins.
- File-tree, pane-tab, and right-pane chrome update incrementally instead of
  rebuilding their full DOM on each selection.
- Watcher and plugin invalidation evict affected cache entries so external
  changes and extension output remain authoritative.

## Regression protection

- Pane-switch tests cover request coalescing, stale-work rejection, cache
  invalidation, bounded eviction, and preservation of editor state.
- Editor performance guards continue to reject blocking work on the direct
  keystroke path.
