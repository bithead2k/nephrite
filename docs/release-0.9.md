# Nephrite 0.9.0

`PROJECT_VERSION` 0.9 is a minor application release. Existing 0.8 indexes
remain compatible and reconcile in place; this release does not require a full
vault rebuild.

## Editor latency

- The CodeMirror transaction path now performs only incremental editor work
  plus constant-time dirty/revision bookkeeping.
- Live-preview syntax-tree decoration walks are coalesced and wait until the
  exact saved revision clears the dirty flag.
- Filesystem watcher bursts are merged while editing. File-tree, preview,
  right-pane, and aggregate-stat refreshes resume after the editor is clean.
- Chrome updates, fold persistence, cursor/EOF scroll sympathy, preview reads,
  and autosave remain outside the edit transaction.
- Repeated characters on the same line no longer enqueue redundant cursor
  reactions.
- Ctrl/Cmd-click resolves wikilinks from the containing line without
  serializing the complete document.
- Whole-document Kanban and properties edits now use normal dirty/revision
  semantics instead of bypassing the editor reactor.

## Regression protection

- A 20,000-edit stress test proves dirty-gated work does not execute or churn
  timers on the keystroke path.
- Structural guards reject document serialization, rendering, DOM queries,
  storage, IPC, or asynchronous work inside the editor update listener.
- Watcher bursts, cursor/fold reactions, autosave, live preview, and scroll
  synchronization have explicit coalescing and starvation regressions.
