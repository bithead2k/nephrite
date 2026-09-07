# Nephrite 0.12.0

`PROJECT_VERSION` 0.12 is a minor application release. Existing 0.11 indexes
remain compatible and reconcile in place; this release does not require a full
vault rebuild.

## Dramatically improved footnote support

- Markdown footnotes render as linked superscript markers with return links,
  sequential display numbering, named references, repeated references, and
  multiline definitions.
- Pandoc- and Obsidian-compatible inline footnotes (`^[…]`) render alongside
  reference-style footnotes.
- **Insert footnote** opens a marker-side composer without leaving the current
  paragraph. It creates inline notes by default, can create reference-style
  notes, and edits existing markers, definitions, and missing definitions.
- Footnote markers provide hover and keyboard-focus previews of their rendered
  contents.
- Preview warnings identify missing, duplicate, and unused definitions without
  rewriting the source Markdown.
- Keyboard commands move to the next or previous marker, jump to a definition,
  and return to its marker. All shortcuts remain configurable in Preferences.
- Footnote insertion keeps the destination visible and returns Vim users to
  insert mode.

## Note-preview navigation

- Linked-note and Kanban-card preview popups include an upper-right expand
  action that opens the underlying note in the full editor.

## Regression protection

- Parser and UI coverage exercises inline and reference footnotes, editing,
  diagnostics, hover previews, bidirectional navigation, code-fence safety,
  popup actions, and incremental preview invalidation.
