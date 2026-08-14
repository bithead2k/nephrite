# Compatibility & Product Surface

Obsidian vault compatibility, feature tiers, and product commitments.

Companion docs: `AGENTS.md` (vision), `docs/decisions.md` (engineering choices).

**Acceptance test (always):**

1. Commit an Obsidian vault to Git (or note its hash).
2. Open and use it in Nephrite.
3. Close Nephrite.
4. Inspect the vault (`git diff`, etc.).
5. Only intentional user edits appear—never silent rewrites.

For day-to-day development: **run Nephrite on top of an existing Obsidian vault** and let **Obsidian Sync** move files between devices. Nephrite must not fight Sync (no thrashing rewrites, no proprietary sidecar data that Obsidian would stomp or that must sync to be correct).

---

## Compatibility tiers

Every feature falls into one of three tiers. Unsupported syntax is always at least **Preserve**.

| Tier | Meaning |
|------|---------|
| **Preserve** | Bytes stay on disk. Never damage, normalize, or “fix up” on open. |
| **Render** | Display usefully in the UI when opened or embedded. |
| **Execute** | Interpret and act (query, toggle, template, draw, board, script). |

Markdown remains authoritative. The SQLite index under `.nephrite/` is **disposable** and rebuildable. Prefer putting durable state in Markdown (or standard vault files) so Obsidian Sync carries it.

---

## Organization: no philosophy war

**Folders, links, and tags are all first-class.**

There is no mandated Zettelkasten, PARA, or “links only” religion. Users may organize however they want. The index and query surface treat folder path, link graph, and tags as equal facets of the same vault.

---

## Links

### Required forms

| Form | Behavior |
|------|----------|
| `[[note]]` | Resolve and navigate |
| `[[note\|alias]]` | Display alias, resolve note |
| `[[note#Heading]]` | Jump to heading |
| `[[note#^blockid]]` | Block ref where practical |
| `![[note]]` | Embed note |
| `![[note#Heading]]` | **Embed / show that section** (or jump, depending on context) |
| `![[image.png]]` / attachments | Embed media |
| `[text](path)` Markdown links | Full support—not second-class |
| Heading-only / path variants | As Obsidian does, where documented |

**Section embeds and jumps are baseline**, not a stretch goal: `[[page#header]]` and `![[page#header]]` must work for show and navigate.

Both wikilinks and Markdown links get rename updates, unresolved styling, and backlink participation. Never force conversion between styles.

---

## YAML / properties (hierarchical)

### Problem with the Obsidian-shaped world

Obsidian properties are effectively **flat** for much of the product and plugin ecosystem. Nested structure and **YAML that uses block / bullet-list shapes** are often poorly understood by core UI and by community extensions.

### Nephrite commitment

Do a **better job supporting hierarchical YAML**:

| Requirement | Detail |
|-------------|--------|
| **Preserve** | Exact frontmatter text; no silent flatten/reorder on open |
| **Parse deeply** | Nested maps, sequences, and list-shaped YAML that real notes already use |
| **Index for query** | Nested paths addressable from SQL / property access (and any YAML-aware SQL extension—see `docs/decisions.md` #5) |
| **Bullet lists in YAML** | First-class: do not drop or mis-type sequence items the way flat property UIs do |
| **Write discipline** | Only rewrite YAML when the user edits properties; prefer minimal, deterministic emission for touched regions |

Typed coercion (string, number, bool, date, array, object, link-like) still applies in the index; the file remains the source of truth.

---

## Tasks

### Storage

Markdown checkboxes remain storage:

```markdown
- [ ] Not started
- [/] Half done   <!-- or vault’s chosen intermediate mark -->
- [x] Done
```

(Exact intermediate glyphs should stay compatible with common Obsidian Tasks / community conventions where practical; map them clearly in the index.)

### Logseq-style single-key cycle (product requirement)

**Ctrl-Enter** (or platform equivalent) on a line cycles through a fixed sequence—same binding, no mode hunting:

1. Plain line → make it a task (unchecked)
2. Task unchecked → half done
3. Half done → done
4. Done → not a task (plain line again)

This is a **baseline editing behavior**, not a plugin. Implement in the CM6 keymap (compatible with optional Vim mode: define sensible behavior when Vim is on).

### Index & query

Tasks are structured records: status, text, path, position, due/scheduled/priority/recurrence when present. Queryable via SQL. Edits write back to the source line.

---

## Footnotes

Support standard Markdown footnote references and definitions:

```markdown
Some claim.[^1]

[^1]: The supporting note.
```

| Tier | Expectation |
|------|-------------|
| Preserve | Always |
| Render | Clickable refs, footnote section rendering |
| Index | Optional early; full back-references as the index matures |

---

## Live preview

**Live preview is a first-class editing mode**, not an afterthought.

It can be slightly clunky; that is acceptable. The alternative—editing pure source and discovering a mess only in reading view—is worse. Ship:

- Source mode (always)
- **Live preview** (default or easily defaultable for daily use)
- Reading / render view

Live preview must not become a write-back pipeline that rewrites the file on open. What you type is what is stored; preview is interpretation.

---

## Graph view

**Product honesty:** With thousands of notes, the global graph is often pretty and rarely informative for real navigation. Some users will never open it.

**Still ship a graph** (local + global, index-backed). Content creators and many users expect it; absence reads as “not a real PKM app.” Keep it honest: performance on large vaults, filters, and local graph matter more than pure spectacle.

Do not block Phase 1 on a beautiful graph. Do not omit it forever.

---

## Canvas

The author of these notes may not use Canvases; **YouTube and the community clearly do.** Nephrite should aim for an **equivalent implementation**, not a token stub.

| Phase | Expectation |
|-------|-------------|
| Early | **Preserve** `.canvas` JSON and related assets untouched |
| Product | Open, edit, link cards to notes, embed where practical—behavior competitive with Obsidian Canvas |
| Integration | Cards/links participate in the vault index (outgoing links, backlinks) where it makes sense |

Canvas is spatial arrangement of notes and media—not a replacement for freehand drawing (see Excalidraw).

---

## Kanban

**Kanban out of the box**—core product, not a community plugin dependency.

| Expectation | Detail |
|-------------|--------|
| Board UI | Columns + cards |
| Storage | Prefer plain Markdown (or another vault-native, sync-friendly format)—not a proprietary DB only Nephrite can read |
| Data | Cards may map to notes, tasks, or list items; exact mapping is a design task, but **queryable via the index** |
| Sync | Boards must survive Obsidian Sync / Unison as normal vault files |

Avoid formats that force users to keep a plugin forever to open their boards.

---

## Query & scripting

### SQL (native)

Read-only PostgreSQL-compatible SQL over the vault index (`docs/decisions.md`). Render results as tables/views in notes.

### Dataview compatibility

Dataview DQL and DataviewJS compatibility are implemented over the shared disposable index, not as the internal architecture. The supported query types, clauses, source selectors, page fields, and scripting API are documented in [`dataview.md`](dataview.md).

### DataviewJS-class power without insane blocks

Users want **programmatic views** (what DataviewJS provides) without:

- fragile fenced-block mini-languages,
- copy-pasted query soup,
- or a second half-documented runtime bolted on sideways.

**Direction:** retain the compatible fenced and inline entry points while moving long-lived automation toward a deliberate, permissioned scripting surface. DataviewJS reads the shared index and vault API rather than maintaining a second private cache.

Details (language host, sandbox, how scripts are stored in the vault) are implementation design; the compatibility commitment is: **engine-native scripting, not insane block parsing as the primary API.**

---

## Drawing (Excalidraw)

Upstream open-source Excalidraw + vault integration (see `AGENTS.md`). Distinct from Canvas. Compatibility with existing Obsidian Excalidraw files where feasible (license: AGPL-3.0 project—reuse decisions remain per-dependency).

---

## Index: one SQLite brain

See **`docs/vault-schema.md`** for why Obsidian plugins re-index, and the SQLite schema that must cover every consumer so Nephrite does not repeat that pathology.

### Rule

**All features and plugins use the shared SQLite vault index.**

Do not let search, backlinks, graph, tasks, kanban, SQL, templates, or third-party plugins each rescan and reinterpret the whole vault independently.

```
Vault files
    → watcher / parse
    → SQLite index (.nephrite/)
    → search, backlinks, SQL, tasks, graph, kanban, plugins, …
```

### Plugin contract (when plugins exist)

- Read structured vault facts from the index API / SQL.
- Subscribe to index change events.
- Rebuilds of `.nephrite/index.db` must not lose user data (only disposable cache).
- Plugins must not require a private parallel index for baseline operation.

---

## Command bar (readline + powerline)

Ship a **command dialog** that feels like a power-user shell, not only a flat fuzzy list:

| Piece | Intent |
|-------|--------|
| **Readline-style input** | Editing, history, completion behaviors familiar from a terminal command line |
| **Powerline-style prompt** | Contextual segments (vault, current file, mode, git/sync hint, etc.) in the command bar |
| **Commands** | Palette actions, navigation, and later automation hooks exposed uniformly |

This is core UX chrome, not a plugin.

---

## Sync & multi-device

| Phase | Approach |
|-------|----------|
| **Now (dev / early use)** | Run Nephrite **on an Obsidian vault**; **Obsidian Sync** does multi-device lifting |
| **Phase 1 sync direction** | **Unison** (or equivalent) in the background at short intervals—file-level sync of the vault directory |
| **Non-goals (initial)** | Obsidian Sync protocol reimplementation; proprietary cloud backend |

Implications:

- Never put irreplaceable state only in `.nephrite/` if the other machine needs it to open the note correctly.
- Minimize write churn so Sync/Unison do not thrash.
- Assume another client (Obsidian) may touch the same files.

---

## Feature matrix (summary)

Legend: **P** = Preserve, **R** = Render, **E** = Execute / full product. Priority is product intent, not a frozen schedule.

| Feature | P | R | E | Notes |
|---------|---|---|---|-------|
| Markdown body | ✓ | ✓ | ✓ | CM6; Vim optional switch |
| Frontmatter flat | ✓ | ✓ | ✓ | |
| Frontmatter hierarchical / lists | ✓ | ✓ | ✓ | **Better than Obsidian-flat** |
| Wikilinks + aliases | ✓ | ✓ | ✓ | |
| Heading links / embeds `![[p#h]]` | ✓ | ✓ | ✓ | **Baseline** |
| Block refs | ✓ | ✓ | best-effort | |
| Markdown links | ✓ | ✓ | ✓ | Equal class |
| Tags (incl. nested) | ✓ | ✓ | ✓ | First-class with folders/links |
| Folders / paths | ✓ | ✓ | ✓ | First-class |
| Search / FTS | | | ✓ | Via index |
| Backlinks | | ✓ | ✓ | Index |
| Tasks + Ctrl-Enter cycle | ✓ | ✓ | ✓ | Logseq-style binding |
| Callouts | ✓ | ✓ | | |
| Footnotes `[^1]` | ✓ | ✓ | | |
| Live preview | | ✓ | ✓ | Daily-driver mode |
| Source / reading modes | | ✓ | ✓ | |
| Graph | | ✓ | ✓ | Expected; not primary nav |
| Canvas | ✓ | → | → | Equivalent implementation goal |
| Kanban | | | ✓ | **Out of the box** |
| SQL queries | | ✓ | ✓ | SELECT-only |
| Dataview DQL compat | | ✓ | implemented | Frontend over the shared index |
| Engine scripting (DVJS-class) | | ✓ | ✓ | No insane primary block parser |
| Templates / automation | | | ✓ | Native runtime |
| Excalidraw | ✓ | ✓ | ✓ | Upstream engine |
| `.obsidian/` | ✓ | | | Do not trash |
| Attachments / images | ✓ | ✓ | | |
| Command bar (readline + powerline) | | | ✓ | Core chrome |
| Plugins | | | ✓ | **Must use SQLite index** |
| Sync | | | external | Obsidian Sync now; Unison Phase 1 direction |

---

## Explicit non-goals (initial release)

From `AGENTS.md`, still held unless revised:

- Full Obsidian plugin API binary compatibility
- Obsidian Sync protocol compatibility
- Every DataviewJS footgun reimplemented as folklore blocks
- Every Templater API on day one
- Mobile as Phase 1 ship target (architecture stays multi-platform)
- Collaborative cloud editing / proprietary server as the datastore
- Custom file format replacing Markdown
- Surrogate file IDs beyond vault-relative paths

---

## Product rules (children of these decisions)

1. **Markdown is storage; indexes are disposable.**
2. **Open the vault; don’t convert it.**
3. **Folders, links, tags—all first-class.**
4. **Section links and section embeds are real features.**
5. **Hierarchical YAML is a first-class property model.**
6. **Tasks are one key-cycle away (Ctrl-Enter).**
7. **Live preview is for daily work.**
8. **Graph is shipped; not the hero UX.**
9. **Canvas and Kanban are product, not afterthoughts.**
10. **SQL + engine scripting beat plugin query soup.**
11. **One SQLite index; teach everything to use it.**
12. **Command bar is readline + powerline, not a toy palette only.**
13. **Coexist with Obsidian Sync; Phase 1 sync leans Unison.**
14. **Footnotes count.**
15. **It’s all about the children**—document choices so future maintainers inherit intent, not archaeology.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-08-08 | Initial compatibility & product surface from Q&A and author preferences |
