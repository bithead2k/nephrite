# Nephrite

**PROJECT_VERSION 0.4** — knowledge that doesn’t fracture.

Open-source, local-first knowledge app. Markdown is storage; the SQLite index is disposable. Opens an existing Obsidian vault without import or conversion.

Nephrite is softer, but more resilient than Obsidian.  It overcomes some of the friction of Obsidian plugins that really should be native by now.

It's also free and open source (FOSS), based on the AGPL-3.0 license.   Do what you like with it.

Please fork my repo, and give me back any additions or bug fixes you'd like to make.

This code was largely created with codex, claude, and grok on the command line. 

Anybody who tells you that AI can create professional level code is an idiot or a liar.   It required several hundred human iterations to create this, and all of the AI models combined still produced garbage sometimes.  Excuse me for saying so, but AI is still a professional code assistant, not a finished product creator.

Still, I find AI to be a great drudge work assistant, and it fairly regularly comes up with a better idea than what I had.  That's enough to make it useful, not enough to stake your business on it.  Productivity is definitely and dramatically higher.

License: [AGPL-3.0](LICENSE)

## Native integrations

- **Excalidraw:** press **Draw**, use **New Excalidraw drawing** in a folder's
  context menu, or open an existing `.excalidraw` / Obsidian
  `.excalidraw.md` file. Drawings autosave to their vault file. Fonts are
  bundled for offline use.
- **Templater compatibility:** press **Template** in a Markdown note. Nephrite
  recognizes template folders and supports common `tp.file`, `tp.date`,
  `tp.frontmatter`, `tp.system.prompt`, file include, and cursor commands.
  Arbitrary `<%* JavaScript %>` is preserved with a warning, not executed
  unsandboxed.
- **Tasks:** press **Tasks** for the vault dashboard. Status changes surgically
  edit the Markdown checkbox. Due, scheduled, start, done, and created dates,
  recurrence, priority, and tags use common Obsidian Tasks syntax in the shared
  index.
- **Git:** press **Git** for staging, conflict resolution, upstream sync status,
  branches, commit details, per-file history, and confirmed version restores.
- **Search and graph:** ranked full-vault content search plus a filterable view
  of indexed wikilinks and backlinks.
- **Canvas:** open and edit Obsidian `.canvas` files directly; unknown JSON
  fields are preserved while nodes and edges remain indexed and searchable.
- **Dataview** SQL-ish query language
- **SQL** Actual SQL language largely based on PostgreSQL syntax.
- **Plugins:** native permissioned plugins plus an Obsidian compatibility host
  for enabled bundled plugins already installed in `.obsidian/plugins/`.

## Core features

- Open a vault folder (same tree as Obsidian); remembers last vault
- Build / reconcile `.nephrite/index.db` on open (`PROJECT_VERSION` major ⇒ full rebuild)
- Browse / **filter** indexed Markdown, canvases, and Excalidraw drawings
- **CodeMirror 6** editor (raw text I/O — no silent rewrite on open)
- View modes: **Source · Preview · Split** (live preview via `marked`)
- **Ctrl/Cmd+Enter** task cycle (plain → todo → half → done → plain)
- Wikilink highlighting; **Ctrl/Cmd+click** (or click in preview) to open target
- Optional **Vim** bindings and a practical vimrc/Vimscript compatibility subset
- 800 ms autosave plus **Ctrl/Cmd+S**; re-indexes that path only

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
