# Nephrite 0.17.0

`PROJECT_VERSION` 0.17 is a compatible minor release from 0.16. Existing indexes
remain usable without a full vault rebuild. New completion indexes are additive;
opening or rendering notes does not rewrite their Markdown.

## Consolidated enhancements

- Indexed, asynchronous wikilink completion searches note names, aliases, and
  paths with bounded suggestions and disambiguates duplicate note names.
- Base views gain grouped layouts, collapsible groups, folder-based kanban moves,
  CSV export, and keyboard table navigation including right-to-left layouts.
- Searchable settings, fuzzy file-name search, colored Markdown highlights, and
  edge auto-scrolling during file-tree and kanban dragging.
- Device-local text size and direction preferences, mobile system text scaling,
  and camera attachments through the normal attachment workflow.
- Quick Capture with an explicit review/save step, `nephrite://` note/daily/capture
  links, and an Android home-screen widget. See [mobile capture](mobile-capture.md).
- External Markdown files can be opened read-only without adding them to a vault.
- Atomic creation prevents captures and attachments from replacing existing files.

## Worktree reconciliation

All pending feature files in the main workspace are consolidated. The detached
large-vault build worktree was compared against both 0.15 and 0.16: its file-tree
batching enhancement is already present in trunk. Its other differences revert
to 0.15 and are not adopted. Shared metadata caching, indexed birthday queries,
cooperative query processing, scoped file refresh, and their regression tests
from 0.16 remain intact. No experimental backup source files are shipped.

## Platform scope

This release is built and tested on Linux. Android widget, camera, and deep-link
source is included; iOS Shortcuts integration uses URL links rather than a native
share extension. Native mobile, Windows, and macOS behavior requires testing on
those platforms; Linux verification does not certify them.

## Verification

- `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` pass.
- `cargo test --workspace`: 138 tests pass (90 application, 48 index).
- `npm test`: 273 test executions pass, including the repeated large-vault suite.
- TypeScript and Vite production build pass; large-chunk warnings remain non-fatal.
- Linux release binary and Debian package built; Debian package installed locally
  as 0.17.0 with all shared-library dependencies resolved.
