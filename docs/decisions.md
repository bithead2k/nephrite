# Engineering Decisions

Answers to the Initial Engineering Questions in `AGENTS.md`.

Status: **accepted** (2026-08-08)

---

## Summary

| # | Topic | Decision |
|---|--------|----------|
| 1 | Desktop / app framework | **Tauri 2** (Windows, Linux, macOS, Android, iOS) |
| 2 | Markdown editor | **CodeMirror 6** + **Vim (`@replit/codemirror-vim`) bundled, off until simple switch** |
| 3 | Markdown parser | **CodeMirror 6’s API / Lezer stack** (editor owns parse surface; no separate competing parser product) |
| 4 | Index database | **SQLite** (+ FTS5 when needed) |
| 5 | PostgreSQL parser | **libpg_query** + small **YAML/properties SQL extension** where needed |
| 6 | SQL execution | **PG AST → IR → SQLite**; **SELECT-only** (plus `WITH` / `VALUES` as read-only) |
| 7 | Frontmatter typing | **Typed in the index; raw YAML in the file** |
| 8 | File identity | **Vault-relative path only**; retain case; **no surrogate IDs**; **warn on case-only create collisions** |
| 9 | License | **AGPL-3.0** |
| 10 | Compatibility boundary | **Preserve / Render / Execute** tiers (as agreed) |

---

## 1. Framework: Tauri 2

### Target platforms

| Platform | Tauri 2 support | Nephrite posture |
|----------|-----------------|------------------|
| Windows | Yes (WebView2) | Primary desktop |
| Linux | Yes (WebKitGTK) | Primary desktop |
| macOS | Yes (WKWebView) | Primary desktop |
| Android | Yes (system WebView); mobile is newer than desktop | Shared UI/core later; not Phase 1 ship target |
| iOS / iPadOS | Yes (WKWebView); mobile is newer than desktop | Shared UI/core later; not Phase 1 ship target |

Tauri 2 advertises a single codebase for **Linux, macOS, Windows, Android, and iOS**. The UI is a web frontend; the host uses the OS webview; native/FS logic lives in Rust (plus optional Kotlin/Swift plugins on mobile).

### Cross-platform reality (important)

- **Desktop (Win / Linux / Mac)** is mature enough to be the default product surface for a vault app.
- **Mobile is officially supported** but younger: more platform friction (tooling, plugins, store packaging, WebView quirks). Plan architecture for five platforms; **ship desktop first**.
- **Vault-on-mobile is a product problem, not only a framework problem:**
  - iOS/Android sandboxing, scoped storage, document pickers, and cloud folders differ sharply from “open a directory path.”
  - A local-first Markdown vault still works, but “point at `~/Notes`” becomes “grant access to a folder / Files provider / synced location.”
  - File watching, large vault indexing, and background refresh need mobile-specific design.
- **Build hosts:** iOS builds require macOS + Xcode; Android needs Android SDK; Linux/Windows desktop builds are straightforward on their respective hosts (with usual cross-compile caveats).

### Architecture implication

```
┌─────────────────────────────────────────┐
│  Web UI (CodeMirror 6, views, Excalidraw) │  shared
├─────────────────────────────────────────┤
│  Tauri commands / events                  │  shared API
├─────────────────────────────────────────┤
│  Rust core: vault FS, parse, SQLite index │  shared
│  SQL (libpg_query → IR → SQLite)          │
├─────────────────────────────────────────┤
│  Platform adapters: path access, watch,   │  desktop vs mobile
│  dialogs, permissions                     │
└─────────────────────────────────────────┘
```

Keep vault and index logic in Rust behind a stable command API so mobile can swap only the filesystem/permission adapter later.

**Related non-goal (initial release):** full mobile apps are listed as a non-goal for the first release in `AGENTS.md`. That remains: **desktop MVP**, with mobile kept architecturally possible rather than blocked by Electron.

---

## 2. Markdown editor: CodeMirror 6

Accepted. CM6 is the editing surface for source (and later live-preview decorations).

### Vim keybindings

- **Ship `@replit/codemirror-vim` in the app** as a normal dependency—bundled with Nephrite, not an optional download, plugin, or marketplace install.
- **Available by default** (always present in the build); **not forced on**.
- **Simple switch** in settings (or equivalent) to turn Vim keybindings **on**. One toggle—no massive configuration, no extra install.
- When off: standard CM6 keymap. When on: include `vim()` in the editor extension set.
- Do **not** embed real Neovim/libvim for this path; stay on the CM6 extension.

---

## 3. Markdown parser

**Decision: CodeMirror 6 decides the parse stack.**

CM6 exposes a managed API (document model, Lezer languages, syntax tree, decorations, ranges). That API is the product’s Markdown parse surface—we do not pick a second, competing “markdown parser product” and maintain two grammars in parallel as first-class choices.

Implications:

- Syntax highlighting, structural editing, wikilink/task decorations, and position ranges come from **CM6 + Lezer** (and extensions we write on that API).
- Indexing and SQL still need structured facts (links, headings, tasks, tags, frontmatter) with positions; extract those **from the same CM6/Lezer pipeline** (or thin adapters over it), not from an independently chosen AST library with its own rewrite semantics.
- **Disk I/O remains raw text.** The editor/index may interpret Markdown; they must **not** round-trip the whole vault through a serializer on open. Unsupported syntax stays preserved as bytes in the file.

---

## 4. Index database: SQLite

Accepted. Disposable DB under something like `.nephrite/index.db`. Rebuild entirely from vault files. Use FTS5 for full-text search when needed.

---

## 5. PostgreSQL parser: libpg_query + YAML/properties extension

Accepted.

- Parse user SQL with **libpg_query** (PostgreSQL-compatible syntax).
- **YAML / properties extension:** a small, documented language surface for vault properties (frontmatter / YAML-shaped fields) where plain Postgres is awkward. Prefer mapping onto indexed columns and JSON operators first; extend the dialect only where the product needs it.
- Stay “Postgres SQL + small Nephrite surface,” not a second full query language (not Dataview-as-architecture).

---

## 6. SQL execution: SELECT-only

Accepted in spirit: **read-only queries**.

- Allow: `SELECT`, and read-only uses of `WITH`, `VALUES`, joins, subqueries, aggregates, `GROUP BY`, `ORDER BY`, `CASE`, and supported functions.
- Reject: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, and any path that mutates the DB, vault, or network.

Pipeline:

```
SQL text → libpg_query → read-only gate → Nephrite IR → SQLite → UI table/view
```

---

## 7. Frontmatter typing

Accepted.

- **File:** exact YAML bytes/text preserved; no silent reformat on open.
- **Index:** coerce for query (string, number, bool, date/datetime, array, object, link-like strings).
- **Writes:** only when the user edits properties; deterministic emission for touched data only.

---

## 8. File identity: path only (retain case)

Accepted with these rules:

- **Identity key:** vault-relative path (using `/` separators in the index).
- **Retain case** as stored on disk and as the user typed it. Paths are not lowercased or “normalized” for identity.
- **No surrogate IDs:** do not allocate or persist a second file id (UUID, inode row, etc.) for identity. Logical identity and all user-facing references are paths.
- **Case-only pairs are user error.** Relying on `Note.md` vs `note.md` as two different notes is not a supported design goal; it breaks platform independence (Windows and many macOS volumes are case-insensitive).
- **On create / rename:** if the new path differs from an existing vault path **only by case**, **warn** that this harms cross-platform use (and on case-insensitive filesystems the create/rename may fail or collide at the OS). Do not invent a clever second identity to make case-only pairs “work.”
- **If both already exist** in a vault (e.g. copied from a case-sensitive volume): preserve both as-is when possible; do not silently merge or rewrite. Surface the mess; do not paper over it with surrogate IDs.

Renames = path changes in the index via the watcher; no separate id remap table.

---

## 9. License: AGPL-3.0

Accepted.

- Project license: **GNU Affero General Public License v3.0**.
- Enables easier alignment with AGPL community projects (e.g. Templater, Obsidian Excalidraw integration) **when** reuse is desired and license-compatible.
- Still verify each dependency’s license before incorporation.
- Add a root `LICENSE` file when the repository is formalized.

---

## 10. Obsidian compatibility boundary

Accepted.

| Tier | Rule |
|------|------|
| **Preserve** | Never damage or silently rewrite. Unknown syntax, `.obsidian/`, plugin-specific Markdown stay on disk. |
| **Render** | Display when supported (wikilinks, images, embeds, tasks, properties, headings, callouts, …). |
| **Execute** | Only features we deliberately implement (SQL blocks, later Dataview subset, tasks, templates, Excalidraw, …). |

**Acceptance test:** git-clean Obsidian vault → use Nephrite → `git diff` shows only intentional user edits.

---

## Follow-ons (not reopened decisions)

1. Scaffold Tauri 2 monorepo (Rust core + TS UI + CM6).
2. Define vault-relative path normalization (Unicode, separators, rejection of `..`).
3. Draft SQLite schema with **path** as the stable key (see Phase 2).
4. Spike libpg_query → read-only gate → SQLite for a tiny `SELECT` subset.
5. Add `LICENSE` (AGPL-3.0) and short README pointing at these decisions.
6. Mobile: keep adapters abstract; no mobile ship requirement for Phase 1.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-08-08 | Initial decisions from engineering Q&A |
| 2026-08-08 | #3: CM6 API owns parse; #5: YAML SQL extension confirmed; #8: retain case, warn on case-only create |
| 2026-08-08 | #2: Vim via `@replit/codemirror-vim` bundled; off until simple on-switch |
| 2026-08-08 | Versioning: single PROJECT_VERSION (MAJOR.MINOR); major ⇒ index rebuild, minor ⇒ no rebuild |
