# Layout review — September 9, 2026

Bounded review of `ui/src/styles.css`, editor theme/viewport restoration, the
file-tree renderer, and existing UI/performance regression tests. This is not an
exhaustive application or plugin audit.

## Fixed

- File-tree names used single-line ellipsis. They now wrap, including unbroken
  names, without shrinking the disclosure/icon column. WebKit at 240px tree
  width confirmed multiline rows with no horizontal overflow.
- Plugin settings iframe required 32rem minimum height inside a viewport-limited
  container with hidden overflow. Removing that minimum allows the frame to
  shrink. WebKit at 400px viewport height measured the frame and available
  container both at 331px.

## Reviewed without changing behavior

- Editor theme and viewport restoration: no artificial rightward scrolling
  extent found in these Nephrite settings. Long unwrapped source lines can
  require extensive horizontal scrolling. Infinite scrolling has not been
  reproduced; no source-clipping limit was added.
- Kanban hover previews and command results have bounded dimensions with
  scrolling. Those limits serve their overlay role.
- Existing tests cover dirty-note save echoes, session preservation during
  restore, incremental preview preservation, pane scroll synchronization,
  viewport-height restoration, and Sync form retention.

## Follow-up only if needed

A browser-level exercise combining rapid tab changes, pane resizing, and external
file changes would supplement the existing focused reset tests. No new reset
bug is asserted by this review.

Per user direction, do not expand this into YAML size stress tests, URL-length
limits, or another startup optimization project without a concrete need.
