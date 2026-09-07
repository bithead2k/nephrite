# Nephrite 0.11.0

`PROJECT_VERSION` 0.11 is a minor application release. Existing 0.10 indexes
remain compatible and reconcile in place; this release does not require a full
vault rebuild.

## Usability enhancements

- Empty rendered journal sections collapse and stay out of the table of
  contents, while incrementally added goals and Interstitial entries reappear
  immediately.
- Preview documents can be printed from their context menu with an optional
  frontmatter section and a paper-readable color treatment.
- File-tree and Kanban dragging respond immediately, provide clearer drop
  feedback, and avoid launching linked-note previews during a drag.
- Context menus remain reusable after their host DOM is refreshed.

## Regression protection

- UI coverage exercises empty-section visibility, incremental goal updates,
  printing, and immediate pointer-driven drag interactions.
