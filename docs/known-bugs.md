# Known bugs

## Main preview: `![[note]]` / `![[note#Heading]]` stays a bare link

**Status:** Resolved per user report (2026-09-09), following extensive embed use
during work on the job-search Kanban. The notes below are historical regression
context, not an outstanding verification request.

**Symptom:** In the main editor preview, note embeds render as ordinary wikilinks.
Opening the same note via **Kanban card hover** (or right pane paths that call
`renderPreview` + hydrate directly) expands the embed correctly.

**What we tried:** Always-on `hydrateNoteEmbeds` in `bindPreviewContent`, uncoupling
from Excalidraw hydrate, re-running after `renderDynamicPreview`, `root.contains`
guard. Still fails on main preview in the field.

**Likely area:** Main preview commit path (`PreviewWorkerClient` →
`patchPreviewHtml` → `bindPreviewContent` / surgical `.md-block` updates) vs
standalone popup paths. Suspect timing (hydrate before final DOM), patch
preservation of pre-hydrate anchors, or selector/`data-wikilink` loss after
worker HTML commit.

**Cleanup findings:** The full-render path did not record `lastPreviewBody` or
`lastPreviewPath`, so the surgical update path could never run. That state is
now recorded after a successful commit. Regression coverage now verifies both
the rendered hydration target and the real DOM hydration path for a heading
embed. The remaining check is reproducing the original vault case in the live
Tauri process.

**Workaround:** View the note via card hover / open the target note directly.

## INFO callout inline Dataview output disappears after a frontmatter edit

**Status:** Fixed (2026-09-09).

The metadata-only preview path removed all Dataview mounts, but rebuilt only
blocks containing executable fences. Inline expressions in INFO navigation and
habit summaries were left empty. Ordinary block edits also only reran fences.

Metadata refresh now rebuilds dynamic blocks individually and executes both
inline expressions and fences on the mounted DOM, including plugin-processed
markup. Ordinary changed blocks also execute inline expressions. Unrelated
terminal/ANSI blocks retain their DOM. A regression test verifies updated inline
and fenced results beside an unchanged colored weather block.
