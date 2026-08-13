# Known bugs

## Main preview: `![[note]]` / `![[note#Heading]]` stays a bare link

**Status:** Needs live Tauri verification (2026-08-13)

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
