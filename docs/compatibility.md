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

## Obsidian Bases

`.base` files and ` ```base ` fences parse the Obsidian Bases YAML shape (filters, formulas, properties, views). Nephrite renders table, list, and cards views from the vault index. Command bar: **Create base**. Sync is not part of this surface.

## Plugin settings

Obsidian `Plugin.addSettingTab` / `PluginSettingTab` / `Setting` now open in a host settings panel from **Plugins → Settings** or **Plugin settings**. `data.json` remains available as **Data…**.

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

## Markdown table justification

Table separator cells support `:---` (left), `:---:` (center), `---:` (right),
`---` (default left), and the Nephrite extension `-:---:-` (block justified).
The middle hyphen run may be longer, for example `-:-----------:-`.
Block justification applies to both headers and body cells in preview, including
print rendering; the last line is justified too.

Editing a complete table automatically aligns its Markdown source columns.
Block-justified source cells spread spaces between prose words; spaces inside
code spans, wikilink aliases, link destinations, and HTML tags are preserved.
Single-word cells receive padding. The formatter runs on editing transactions,
including typing, deletion, and paste, rather than polling the vault. Formatting
and the initiating edit share undo/redo, and carets track their cell content.

Opening, reloading, or navigating a note does not format it. Malformed tables,
fenced examples, frontmatter, indented code, and HTML blocks are left alone.
Active IME composition is left undisturbed; subsequent editing formats the table.
The block marker is a Nephrite extension, not standard GFM/Obsidian alignment;
other Markdown applications may display such a table as literal source.

### Source table navigation, commands, and repair

In the source editor, Tab selects the next cell and Shift+Tab selects the previous
cell, skipping the separator. Tab in the final cell adds a body row. Right-click a
source cell for row/column insertion, duplication, movement, deletion, and column
alignment. Column movement includes its alignment marker. Table actions are not
added to live-preview or rendered-preview context menus.

`Inspect / repair table…` opens an editor-attached proposal with Apply and Cancel.
It can propose missing separators, malformed alignment markers, and rectangular
rows without dropping excess cells. Literal unescaped pipes are ambiguous: the
proposal preserves them as cells and explains how to escape them instead. Repair
never writes without Apply, is undoable, and expires when the document changes.
Creation stays in the editor through the existing `/table` completion. Spreadsheet paste, formatting, settings, source sorting, and cell-region selection
are documented in
[table-editing-design.md](table-editing-design.md).


### Formatting, spreadsheet paste, and source sorting

The command palette formats the current table, tables intersecting the selection,
or all valid tables in the current note. Each operation is one undoable edit;
malformed tables are reported and skipped. Formatting preserves alignment and row
order. Preferences → Editor → Tables controls live formatting, padding, Tab
navigation, visual source wrapping, and preview column width. Saving settings
never reformats a document.

Spreadsheet TSV or HTML paste opens a source-editor proposal before modifying the
note. It shows replaced cells and added rows/columns, supports generated headings,
and offers plain paste or Cancel. Multiline values use `<br>`; literal Markdown
characters are escaped. Merged HTML cells expand to blank covered cells.

Select table cells from the source context menu or palette, then extend with
Shift-click or Shift+Arrow. Copy exports TSV; Delete clears content while retaining
pipes and alignment. Paste starts at the rectangle's top-left and explicitly
reports dimension mismatches. Escape exits selection mode.

Source context menus and palette commands sort body rows by a column, preserving
headers and alignment. Numeric columns sort numerically; text uses natural order;
equal values remain stable and blanks go last. Sorting is one undoable edit.

### Sync dependency discovery

Provider installation resolves the home directory through platform APIs, including
the account database fallback on Unix. Executable discovery uses platform PATH
separators and checks user/npm/nvm installation folders and Windows command shims.
Once `ob` is discovered, the Node.js dependency warning clears on the refreshed
sync snapshot, even if the desktop launcher's PATH lacks `node`.


### Automatic sync dependency setup

**Install ob** owns dependency setup on Windows, macOS, and Linux. It first checks
an existing provider by launching it. Otherwise it reuses a compatible Node 22+
runtime with npm, or downloads a private Node 22 runtime from nodejs.org and
verifies the archive against the official SHA-256 manifest before extraction.
This does not require a global npm installation, administrator access, shell
initialization, or a change to the user's system Node installation.

Private dependencies live under the platform's local application data directory
in `Nephrite/sync-runtime`, outside the vault. Provider installation uses a staged
npm prefix, verifies the actual `ob` entry point, then atomically records the
runtime and entry point. Sync invokes Node directly, so npm shell shims and the
desktop launcher's PATH are not required. Failed or interrupted provider setup
can reuse the verified runtime on retry. Existing generations are retained so
running processes are not damaged by a replacement.

Installation runs off the UI thread. The install button blocks duplicate clicks;
errors leave it available for retry, and successful installation refreshes provider
status and enables login immediately. No login or sync is performed by installation.

`cargo run -p nephrite --example sync-runtime-smoke` exercises a clean private
installation, launch, repeated installation, and repair in a temporary directory,
without reading or changing a vault. The same example can be built for Windows.


### Sync authentication confirmation

Login sends the account fields as structured input to a Node preload hook, which
supplies them to the provider inside the child process. The provider runs as a
normal Node script; eval mode would change Commander's argument parsing. Credentials do not appear
in the operating system command line. This avoids the provider's non-interactive
prompt behavior, which consumes the entire stdin stream as a single answer.
A zero exit code alone is insufficient: Nephrite requires the provider's explicit
login confirmation. Missing MFA confirmation is reported as incomplete login.

Authentication is separate from vault availability. A successful remote-vault
query with zero results still means the account is logged in. Confirmed login
enables settings even if listing remote vaults temporarily fails; the list error
is displayed separately. A provider report that no account is logged in clears
that state. The UI never displays login success for an unconfirmed response.

The private-argument smoke test invokes the real provider's version, login help,
and remote-list help commands through the same launcher. A separate fixture
checks password quoting and MFA transport without contacting an account service.
Run against an existing installation with `sync-runtime-smoke --check-provider
<node-path> <cli-path>`; this does not log in or modify provider credentials.


### Sync form continuity

Account email, password, MFA code, encryption password, remote-vault choice,
device name, sync direction, conflicts, exclusions, and checkboxes stay in the
interface across login, setup, failures, retries, and status refreshes. Both forms
remain visible after login, and settings remain editable during reauthentication.
If a remote-vault refresh fails or returns an empty list, the current selection
is retained. Drafts are kept per local vault for the lifetime of the application,
including closing and reopening the Sync panel. Status responses do not replace
what the user has typed with saved defaults.

Sync errors appear at the top of the pane. Failed operations and error status
responses scroll the pane to the top and focus the error message while retaining
all form entries.

Vault setup passes the encryption password explicitly through the private argument
launcher: the provider's JSON mode does not read password prompts from stdin.
Both password fields have independent reveal buttons. Their values and reveal
states survive login, setup, errors, refreshes, and reopening the Sync pane.

### Terminal reports in text fences

Fenced `text`, `plain`, `plaintext`, `ansi`, and `terminal` blocks display ANSI
SGR foreground/background colors (standard, bright, 256-color and RGB), bold,
dim, italic, underline, strikeout, inverse, and resets. Spaces, newlines and
Unicode box drawing remain literal. HTML is escaped; terminal OSC commands and
non-SGR CSI controls are discarded rather than executed. This renders static
terminal reports, not an interactive terminal or cursor-motion emulator.
The source must contain actual escape characters: colors discarded by the
clipboard cannot be recovered. Preview rendering does not modify the note.

Terminal text uses fixed-width HTML cells for non-ASCII graphemes so fallback
fonts cannot widen wind arrows. Common wide CJK characters and emoji occupy two
columns; combining sequences stay together. Common single-line box-drawing
characters render with CSS line segments while retaining their original text
for copying. This is a static display convention, not full terminal emulation.

### Cached vault startup

For an existing index with no required rebuild or feature backfill, startup opens
cached results before scanning file contents. Once the workspace is restored,
“Checking for changes…” appears in the index status while a separate database
connection scans and hashes files without holding the active editor index lock.
Changed candidates are applied using current disk contents, then the existing
vault-change handler refreshes affected views. Switching vaults prevents old
results from being applied to the new vault.

The check still detects same-size edits with preserved modification timestamps.
Until it completes, search and metadata views may reflect the cached state.
Completion reports no changes or updated/removed counts; failures remain visible.
First-time index creation and required migrations still initialize before opening.

The preview follows its pane width rather than imposing a fixed 48rem cap.
Prose wraps to the available space; oversized preformatted reports scroll within
their own block. WebKit layout checks cover both 400px and 1400px viewports.
