# Nephrite

**PROJECT_VERSION 0.2** — knowledge that doesn’t fracture.

Open-source, local-first knowledge app. Markdown is storage; the SQLite index is disposable. Opens an existing Obsidian vault without import or conversion.

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
- Node 20+
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
