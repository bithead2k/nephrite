# Nephrite

**PROJECT_VERSION 0.6** — knowledge that doesn’t fracture.

Open-source, local-first knowledge app. Markdown is storage; the SQLite index is disposable. Opens an existing Obsidian vault without import or conversion.

Nephrite is softer, but more resilient than Obsidian.  It overcomes some of the friction of Obsidian plugins that really should be native by now.

It's also free and open source (FOSS), based on the AGPL-3.0 license.   Do what you like with it.

Please fork my repo, and give me back any additions or bug fixes you'd like to make.

This code was largely created with codex, claude, and grok on the command line. 

Anybody who tells you that AI can create professional level code is an idiot or a liar.   It required several hundred human iterations to create this, and all of the AI models combined still produced garbage sometimes.  Excuse me for saying so, but AI is still a professional code assistant, not a finished product creator.

Still, I find AI to be a great drudge work assistant, and it fairly regularly comes up with a better idea than what I had.  That's enough to make it useful, not enough to stake your business on it.  Productivity is definitely and dramatically higher.

License: [AGPL-3.0](LICENSE)

## Native integrations

These replace the community plugins that should have been core a long time ago.
Markdown on disk is still the store. Indexes and viewers are disposable.

- **Excalidraw:** press **Draw**, use **New Excalidraw drawing** in a folder
  context menu, or open an existing `.excalidraw` / Obsidian `.excalidraw.md`
  file. Drawings autosave to their vault file. Fonts are bundled for offline use.
- **Templater compatibility:** press **Template** in a Markdown note. Recognizes
  template folders and common `tp.file`, `tp.date`, `tp.frontmatter`,
  `tp.system.prompt`, file include, and cursor commands. Arbitrary
  `<%* JavaScript %>` is preserved with a warning, not executed unsandboxed.
- **Tasks:** press **Tasks** for the vault dashboard (today / week / overdue).
  Status changes surgically edit the checkbox. Due, scheduled, start, done, and
  created dates, recurrence, priority, and tags use common Obsidian Tasks
  syntax. Extra statuses `[/] [>] [<] [?] [!] [-]` are indexed and cycled.
- **Kanban:** Markdown boards (`kanban-plugin` frontmatter) as a first-class
  view. Lane moves write the file. No separate board store.
- **Git:** press **Git** for staging, conflict resolution, upstream status,
  branches, commit details, per-file history, and confirmed version restores.
  Full-file merge UI is started, not a `git mergetool` replacement.
- **Dataview:** DQL and DataviewJS over the index (`dv.pages`, tables, lists,
  tasks, calendars, `dv.view`). Scripts that poke undocumented Obsidian
  internals are not a compatibility target.
- **SQL:** real PostgreSQL-shaped `SELECT` over vault pages via `libpg_query`.
  Only fenced ` ```pgsql ` blocks execute. `sql` / `sqlpostgresql` highlight
  only. Read-only; no server admin, no mutation.
- **Plugins:** browse and install into `.obsidian/plugins/` (same directories
  Obsidian uses). Native permissioned host plus an Obsidian compatibility
  facade. Plugins Nephrite already implements in core (Dataview, Tasks,
  Kanban, Excalidraw, Templater, Git, Mermaid, Calendar, TOC, Vim add-ons)
  are hidden from the community catalog and not loaded twice.
- **Callouts and TOC:** Obsidian callouts in preview; table-of-contents
  hydration for notes that ask for one.

## Core features

- Open a vault folder (same tree as Obsidian); remembers last vault. No import.
- Disposable SQLite index at `.nephrite/index.db` (WAL). Named, resumable
  backfills; `PROJECT_VERSION` major ⇒ full rebuild, minor ⇒ reconcile.
- Browse / **filter** indexed Markdown, canvases, Excalidraw, and attachments.
- **CodeMirror 6** editor (raw text I/O — no silent rewrite on open/save).
- View modes: **Source · Preview · Split**.
- **Wikilinks:** `[[Note]]`, aliases, heading and block targets. Insertion uses
  the shortest unique path. Resolution follows Obsidian search order; existing
  shorts are not rewritten when a namesake appears. **Ctrl/Cmd+click** (or
  click in preview) opens the target. Hover preview on links.
- **Properties:** YAML frontmatter parsed and indexed; Properties table in
  preview. Hierarchical YAML is read; write-back stays surgical.
- **Ctrl/Cmd+Enter** task cycle through the extended status set.
- Slash commands in the editor (`/task`, `/table`, `/mermaid`, `/callout`, …).
- **Daily notes / calendar:** reads `.obsidian/daily-notes.json` when present.
  Today, previous/next day, overmorrow and ereyesterday. Month pane marks
  existing notes and creates from the configured template. Period notes are
  flat vault-root files: `2026-W02.md`, `2026-08.md`, `2026-Q03.md`.
- **Search:** ranked full-vault content + YAML property search.
- **Graph:** local and global, index-backed. Filters; color by folder or first
  tag. Not 3D.
- **Canvas:** open and edit Obsidian `.canvas` files. Unknown JSON is
  preserved. File cards are indexed as links (graph + backlinks).
- **Outline / links / tags:** activity-rail panes for headings, backlinks,
  outgoing links, unlinked mentions, and a vault tag browser.
- **Orphans and placeholders:** notes with no incoming links, and unresolved
  wikilinks with create-from-source.
- **Session:** restore tabs, active file, right pane, pinned tabs, cursor
  position. Reopen closed tab (`Mod+Shift+T`).
- **Smart paste:** HTML from a browser becomes Markdown; a URL over a
  selection becomes a link; already-Markdown text is left alone. Image
  drag/drop and paste write into the vault (`attachmentFolderPath` when set)
  and insert `![[…]]`.
- **Preview viewers** (never rewrite source):
  - PDF in-app; `![[file.pdf]]` embeds the same viewer
  - Audio / video in-app; `![[clip.mp3]]` / `![[clip.mp4]]` embed
  - KaTeX for `$…$`, `$$…$$`, and ` ```math ` / ` ```tex `
  - Mermaid / `mmd` fences → SVG (vault mermaid plugins are not loaded)
  - highlight.js on fenced code; opening `.rs` / `.ts` / `.py` / … uses a
    read-only highlighted code viewer
  - CSV as a table; JSON / YAML as a structured tree
  - Note embeds `![[note]]` / `![[note#Heading]]` / block embeds
- Optional **Vim** bindings and a practical vimrc/Vimscript subset (common
  `set`s; `syntax` / `filetype` / `autocmd` / `colorscheme` are no-ops).
- 800 ms autosave plus **Ctrl/Cmd+S**; re-indexes that path only.
- File-tree drag to a folder uses in-app rename so dependent wikilinks update.

Not in core, on purpose: mobile, official sync, a WYSIWYG/block editor, Notion
Bases, persisting GFM table column widths, and unsandboxed Node/Electron
plugin APIs. Use the files (or Unison) for sync. Point databases at `pgsql` +
Dataview, not another query language.

## Requirements

- Rust 1.77+
- Node 20.19+
- Linux: WebKitGTK 4.1 dev packages (see Tauri prereqs)
- macOS: Xcode CLT; Windows: WebView2

## Develop

```bash
npm install
cargo test -p nephrite-index
npm run tauri dev
```

Build release:

```bash
npm run tauri build
```

Index-only CLI:

```bash
cargo run -p nephrite-index-cli -- /path/to/vault
```

## Versioning

Single version: **`PROJECT_VERSION`** (`MAJOR.MINOR`). See [docs/versioning.md](docs/versioning.md).

- **Major** — full index rebuild  
- **Minor** — no rebuild  

## Docs

- [AGENTS.md](AGENTS.md) — project vision  
- [docs/decisions.md](docs/decisions.md) — engineering decisions  
- [docs/compatibility.md](docs/compatibility.md) — Obsidian compatibility surface  
- [docs/vault-schema.md](docs/vault-schema.md) — index design  
- [docs/release-0.2.md](docs/release-0.2.md) — 0.2 feature details

## Safety test

1. Commit an Obsidian vault (or note its hash).  
2. Open it in Nephrite, browse/edit intentionally.  
3. Close Nephrite.  
4. Only intentional edits should appear in `git diff`.
