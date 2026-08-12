# Nephrite

## Project Summary

Nephrite is an open-source, local-first knowledge management application intended to be a practical drop-in alternative to Obsidian.

The core design principle is:

> Markdown is storage. Everything else is a disposable interpretation of it.

Nephrite must be able to open an existing Obsidian vault directly, without import, export, migration, or conversion. Users should be able to close Obsidian, open the same directory in Nephrite, and later return to Obsidian without damage or unwanted rewriting of their files.

The application should preserve plain Markdown as the canonical datastore while providing the functionality that years of Obsidian plugin adoption have demonstrated belongs in a mature product.

## Name

**Nephrite**

The name deliberately contrasts with Obsidian.

Obsidian is extremely hard and can hold a sharp edge, but it is brittle.

Nephrite jade is less hard but exceptionally tough. Its interlocking fibrous structure resists fracture.

That metaphor fits the software:

* files remain independent and durable;
* links interconnect them;
* metadata provides structure;
* indexes are disposable;
* functionality should survive the loss or replacement of the application itself.

Possible tagline:

> Nephrite — knowledge that doesn’t fracture.

## Primary Goal

Create an open-source application that can use an existing Obsidian vault as-is while incorporating the most important functionality currently supplied by Obsidian community plugins.

This is not initially an attempt to support every Obsidian plugin.

The first goal is to reproduce the mature functionality represented by the highest-value plugin categories directly in the core product.

## Fundamental Requirements

### 1. Existing Obsidian Vault Compatibility

Nephrite must operate directly on an existing vault.

It must understand and preserve at least:

* Markdown files
* YAML frontmatter / Obsidian properties
* `[[wikilinks]]`
* `[[links|aliases]]`
* heading links
* block links where practical
* Markdown links
* attachments
* images
* Obsidian embeds such as `![[file]]`
* tags
* headings
* checkboxes/tasks
* callout syntax
* existing directory layout
* `.obsidian/`

Unsupported syntax must be preserved verbatim.

Opening a vault must never silently normalize or rewrite files.

A useful compatibility test is:

1. Commit an Obsidian vault to Git.
2. Open and use it in Nephrite.
3. Close Nephrite.
4. Run `git diff`.
5. Only intentional user edits should appear.

## 2. Markdown Is Authoritative

No user data should exist only inside a proprietary or application-specific database.

Nephrite may maintain an index such as:

```
.nephrite/
    index.db
    cache/
    state/
```

but this data must be disposable.

Deleting `.nephrite/index.db` must not cause information loss.

The index should rebuild entirely from Markdown, attachments, and other files in the vault.

## 3. Native Vault Metadata Index

The application should maintain a structured representation of the vault.

Likely indexed entities include:

* files
* paths
* titles
* aliases
* YAML properties
* headings
* blocks
* tags
* links
* backlinks
* embeds
* tasks
* task status
* dates
* attachments
* file creation/modification metadata

Conceptually:

```
Markdown Vault
     |
     v
Filesystem Watcher
     |
     v
Markdown / Metadata Parser
     |
     v
Disposable Vault Index
     |
     +-- Search
     +-- Backlinks
     +-- SQL queries
     +-- Tasks
     +-- Graph
     +-- Templates
     +-- Plugins
```

Do not let individual features independently rescan and reinterpret the vault if they can share the same index.

## 4. PostgreSQL SQL as the Query Language

Dataview demonstrates that users want to treat Markdown metadata as a database.

Do not invent another query language for new functionality.

Use PostgreSQL-compatible SQL.

Prefer using the PostgreSQL parser, likely through `libpg_query`, to parse queries.

The underlying execution engine can be an embedded database such as DuckDB or SQLite, provided PostgreSQL syntax can be translated or supported cleanly.

Initial query blocks should be read-only.

Allow constructs such as:

* `SELECT`
* `WITH`
* `VALUES`
* joins
* subqueries
* aggregates
* grouping
* ordering
* `CASE`
* window functions where supported
* date expressions
* regular expressions
* JSON/property access

Reject mutating SQL such as:

* `INSERT`
* `UPDATE`
* `DELETE`
* `DROP`
* `ALTER`
* arbitrary filesystem/network operations

Example:

````
```sql
SELECT
    path,
    company,
    recruiter,
    rate
FROM pages
WHERE status = 'active'
  AND path LIKE 'Job Search/%'
ORDER BY rate DESC;
```
````

The rendered Markdown view should display query results as a dynamic table or other appropriate view.

### Dataview Compatibility

Existing Dataview blocks should eventually be supported through a compatibility frontend.

Conceptually:

```
Dataview DQL -----\
                   > query AST --> vault query engine
PostgreSQL SQL ---/
```

Do not make Dataview the internal architecture.

Implement the richer native query system first, then translate supported Dataview syntax into it.

## 5. Tasks as a Core Facility

Obsidian Tasks plugin usage demonstrates that task management belongs in the platform.

Markdown remains the storage representation:

```
- [ ] Submit application
- [x] Update documentation
```

The vault index should expose tasks as structured records.

For example:

```
SELECT task, path, due
FROM tasks
WHERE completed = false
ORDER BY due;
```

Task functionality should eventually include:

* status
* due dates
* scheduled dates
* recurrence
* tags
* priorities
* filtering
* grouping
* sorting
* backlinks to source location

Where possible, remain compatible with common Obsidian Tasks syntax.

## 6. Native Template and Automation Engine

Templater and QuickAdd demonstrate another mature subsystem: document automation.

Nephrite should have a native automation runtime rather than treating templates as simple static snippets.

Desired capabilities include:

* variables
* date/time calculations
* current file metadata
* YAML/frontmatter access
* user prompts
* file creation
* file naming
* file movement
* insertion
* append/prepend
* commands/macros
* user-defined functions
* lifecycle hooks
* JavaScript execution, if it can be sandboxed appropriately

Existing Templater syntax should eventually receive a compatibility layer.

Example:

```
<% tp.date.now() %>
<% tp.file.title %>
<% tp.frontmatter.status %>
```

Internally, however, expose Nephrite's own vault API rather than reproducing Obsidian internals.

The core abstraction should look roughly like:

```
Template
   |
   v
Parser
   |
   v
Automation Runtime
   |
   +-- File API
   +-- Metadata API
   +-- Query API
   +-- User input
   +-- Commands
   +-- JS runtime
```

QuickAdd is useful as a reference for workflow and capture semantics.

## 7. Excalidraw Integration

Do not reimplement a drawing application.

Use upstream open-source Excalidraw as the drawing engine.

Nephrite should provide the vault integration layer:

* drawings stored in the vault
* Markdown embedding
* links between drawings and notes
* attachments
* exports
* transclusion where practical
* internal wikilinks from drawings if supported
* compatibility with existing Obsidian Excalidraw files where feasible

The existing Obsidian Excalidraw plugin is useful as a behavioral reference and, depending on licensing decisions, possibly as reusable implementation material.

## 8. Plugin Architecture

Nephrite should support plugins, but plugins are intended for the long tail.

Features already demonstrated to be broadly foundational should be implemented in core.

Likely core functionality:

* Markdown editing
* properties
* wikilinks
* backlinks
* graph
* query engine
* dynamic views
* tasks
* templates
* automation
* Excalidraw/canvas support
* search
* basic Git/history integration

Plugins should handle things such as:

* citation managers
* niche publishing workflows
* special renderers
* external integrations
* specialized domain tools
* unusual calendars
* RPG systems
* music notation
* custom views

Design the plugin API around native abstractions such as the vault, metadata index, query engine, editor, workspace, commands, and events.

Do not initially attempt binary compatibility with the entire Obsidian plugin API.

## 9. Git-Friendly by Design

Because the canonical store is plain files, Git integration is a natural fit.

Git may eventually become a core feature.

Normal users could see:

```
History
Previous versions
Restore
Sync status
```

while advanced users can work directly with the underlying Git repository.

Nephrite itself must produce deterministic, minimal file modifications so diffs remain meaningful.

## 10. Open-Source Licensing

The PostgreSQL parser and other PostgreSQL-derived components use permissive PostgreSQL-style licensing and can generally be incorporated into applications under other licenses.

Potential upstream components span multiple licenses:

* PostgreSQL / `libpg_query`: permissive
* QuickAdd: MIT
* Excalidraw core: permissive/open-source; verify exact package license before incorporation
* Templater: AGPL
* Obsidian Excalidraw integration: AGPL

A major early project decision is therefore whether Nephrite itself should use AGPL.

AGPL would make direct reuse of some existing community code easier and would strongly preserve the project's open-source nature.

A permissive MIT/BSD/Apache/PostgreSQL-style license would maximize reuse by others but may require clean independent implementations of AGPL-derived components.

Do not copy AGPL source into a permissively licensed project.

## Product Philosophy

Obsidian has effectively performed years of product research through its plugin ecosystem.

The plugin ecosystem should be viewed as a proving ground:

```
experimental idea
    |
    v
community extension
    |
    v
widespread adoption
    |
    v
stable semantics
    |
    v
core platform capability
```

The project should learn from that mature ecosystem rather than recreating an intentionally minimal first-generation note editor.

In particular, Dataview, Templater, Tasks, and Excalidraw represent capabilities important enough to consider native product features.

## MVP

The first usable milestone should be deliberately narrow.

### Phase 1 — Safe Vault Reader

Implement:

* open an arbitrary directory as a vault
* recursively discover Markdown files
* parse Markdown
* parse YAML frontmatter
* resolve wikilinks
* index tags
* index links/backlinks
* index headings
* index tasks
* filesystem watching
* search
* basic Markdown editor/viewer

Critical acceptance test:

An existing Obsidian vault can be opened without modification.

### Phase 2 — Vault Database

Implement the disposable structured index.

Define a stable relational schema such as:

```
files
properties
headings
links
tags
tasks
attachments
```

The exact schema should receive significant design attention.

This schema is foundational.

### Phase 3 — SQL

Integrate PostgreSQL parsing.

Expose read-only SQL query blocks.

Example:

````
```sql
SELECT *
FROM tasks
WHERE completed = false;
```
````

Render results dynamically.

### Phase 4 — Dataview Compatibility

Parse common Dataview query blocks and translate them to the internal query model.

Prioritize:

* `LIST`
* `TABLE`
* `FROM`
* `WHERE`
* `SORT`
* `GROUP BY`

DataviewJS can come later.

### Phase 5 — Tasks

Build task views, queries, editing, dates, recurrence, and source navigation.

### Phase 6 — Templates and Automation

Build the native automation runtime.

Then implement Templater compatibility progressively.

### Phase 7 — Excalidraw

Embed upstream Excalidraw and build vault integration.

### Phase 8 — Plugin API

Expose stable public APIs after the underlying core abstractions have matured.

Avoid prematurely freezing APIs around an immature architecture.

## Suggested Repository Layout

```
nephrite/
├── README.md
├── PROJECT.md
├── LICENSE
├── AGENTS.md
├── docs/
│   ├── architecture.md
│   ├── compatibility.md
│   ├── vault-schema.md
│   ├── query-engine.md
│   ├── automation.md
│   └── roadmap.md
├── src/
│   ├── app/
│   ├── editor/
│   ├── vault/
│   ├── markdown/
│   ├── index/
│   ├── query/
│   ├── tasks/
│   ├── automation/
│   ├── drawing/
│   └── plugins/
├── tests/
│   ├── fixtures/
│   │   └── obsidian-vault/
│   ├── compatibility/
│   └── integration/
└── tools/
```

## Initial Engineering Questions

Before committing deeply to implementation, resolve:

1. Desktop framework:

   * Tauri
   * Electron
   * native application
   * another cross-platform framework

2. Markdown editor:

   * CodeMirror 6 is an obvious candidate.

3. Markdown parser:

   * Must preserve Obsidian syntax and source positions reliably.

4. Index database:

   * SQLite
   * DuckDB
   * custom structures
   * combination

5. PostgreSQL parser:

   * Evaluate `libpg_query`.

6. SQL execution:

   * Decide how PostgreSQL AST is mapped to the chosen embedded engine.

7. Frontmatter typing:

   * strings
   * numbers
   * booleans
   * dates
   * arrays
   * objects
   * links

8. File identity:

   * Paths can change.
   * Determine whether internal index identities need stable ephemeral IDs.

9. Licensing:

   * Decide AGPL versus permissive before incorporating upstream AGPL code.

10. Obsidian compatibility boundary:

    * Define what is guaranteed preserved.
    * Define what is rendered.
    * Define what is executable.

## Non-Goals for the Initial Release

Do not initially attempt:

* full Obsidian plugin API compatibility
* Obsidian Sync compatibility
* every DataviewJS feature
* every Templater API
* mobile applications
* collaborative cloud editing
* a proprietary server backend
* a custom file format
* replacing Markdown with database-owned records

## Definition of Success

Nephrite is successful when a user with a substantial existing Obsidian vault can:

1. clone/install Nephrite;
2. point it at the existing vault;
3. browse and edit notes normally;
4. retain properties, links, attachments, and syntax;
5. execute useful SQL over their notes;
6. use dynamic task and metadata views;
7. close Nephrite;
8. reopen the same vault in Obsidian;
9. find that nothing has been damaged or unnecessarily rewritten.

The long-term objective is not merely to create another Markdown editor.

It is to create the open-source implementation of the mature local-first knowledge system that the Obsidian ecosystem has already demonstrated users want.

## Reloadable Implementation Context (2026-08-09)

This section records the current implementation state and recent design decisions so work can resume after an agent/context reload. Treat the requirements above as authoritative; this section describes what has actually been built and what remains provisional.

### Current Stack and Safety Model

* The desktop application uses Tauri, TypeScript, and CodeMirror 6.
* The disposable vault index uses SQLite under `.nephrite/index.db` with WAL mode.
* Markdown remains authoritative. Preview/index transformations must never rewrite source unless the user edits it.
* Vault opening displays action text and progress while checking or rebuilding the index.
* The project is AGPL-3.0-only.
* `PROJECT_VERSION` is currently `0.2`; Cargo and npm package versions are `0.2.0`.
* Version 0.2 rebuilds indexes from the earlier internal 2.0 development version because the stored major differs.

### Editor and Vim Integration

* CodeMirror 6 provides the Markdown editor.
* Vim mode supports `:write`/`:w` through the Nephrite save bridge.
* Nephrite reads the user's `.vimrc`, follows sourced configuration files such as `.vimspellrc`, audits unsupported commands, and implements selected compatible settings and mappings.
* Vim plugins/configuration are interpreted where practical; Nephrite does not embed a complete Vim runtime.
* Supported compatibility work includes `colorcolumn`, `runtimepath` awareness, mswin-style mappings, and Powerline/Vim status integration without replacing Nephrite's status bar.
* The status bar uses the configured Vim/Powerline presentation, displays dirty state, and prefers the user's configured font with DejaVu Sans Mono in the fallback stack.
* Tabs were widened to fit full journal dates.
* Autosave is enabled after an edit delay; `:w` remains an explicit immediate save.
* YAML booleans render as checkboxes in preview and as editable checkbox decorations in source. The textual `true`/`false` decoration is hidden without changing stored YAML.

### Editor Performance and Scroll Rules

The following regressions were fixed and are protected by `tests/editor-performance.test.ts`:

* A keystroke no longer serializes the complete CodeMirror document.
* Preview work is coalesced by `DeferredDocumentWork` and reads the document only after the quiet period.
* Preview debounce is 350 ms; autosave delay is 800 ms.
* YAML checkbox decoration scans only frontmatter and maps existing decorations for body-only edits.
* Dirty-state chrome is redrawn only when dirty state changes.
* Preview images/transclusions are hydrated once in the settled dynamic pass rather than twice per edit.
* Programmatic preview scroll restoration cannot drive the editor scrollbar.
* Cross-pane synchronization requires genuine user scroll intent; ordinary typing is not scroll intent.
* Vim cursor-line movement drives the preview from CodeMirror's resulting scrollbar position.
* Vim `G` uses the actual final document line, not CodeMirror's virtual scroll maximum, to pin the preview to EOF.
* On arrival at EOF, the preview first follows the editor to the bottom; only then does the "leave me alone" lock prevent preview-to-editor movement.
* Moving away from EOF re-enables editor-driven synchronization.

Run the focused suite with:

```sh
npm run test:performance
```

### Markdown and Obsidian Rendering

Implemented preview behavior includes:

* YAML frontmatter rendered as a foldable property panel; full previews and hover previews default it appropriately and preserve fold state across preview replacement.
* Native `[toc]` rendering.
* Obsidian callouts such as `[!info]`, including fold markers.
* Stronger visible section-break styling for `---` in the edit pane.
* Obsidian wikilinks, heading links, aliases, note embeds, heading transclusion, and image embeds.
* Standard Markdown images and Obsidian image syntax, including paths resolved relative to the containing note.
* Link hover previews with miniature rendered pages and dynamic code/query execution.
* Excalidraw embeds and upstream Excalidraw editing integration.
* Templater, Tasks, Git/history UI, and Kanban hook integration have initial native implementations.
* Kanban movement status clears after ten seconds without removing shortcut help text.

Media resolution added a native `read_media_file` command. Native command changes require restarting the Tauri process; a hot UI refresh alone is insufficient.

### Dataview and Dynamic Rendering

* `dataview`, `dataviewjs`, `js`, `javascript`, `nephrite`, and `nephritejs` fences are dynamically executed where supported.
* Single-backtick inline commands are supported; longer backtick spans remain literal.
* Common Dataview DQL constructs (`TABLE`, `LIST`, `FROM`, `WHERE`, `SORT`, and limits) have a compatibility implementation.
* DataviewJS exposes page collections with array-compatible `.where()`/`.limit()` behavior and current-page context.
* Null/empty query values render as empty text rather than `[object Object]`.
* Query results detect URLs, email addresses, and telephone numbers. Field names such as `work_email`, `home_email`, `website`, `company_url`, `linkedin`, and `phone` guide detection.
* URI results render as clickable anchors with an appropriate MIME `type` attribute.

### YAML Frontmatter URI/MIME Rendering

* URI and MIME classification was extracted from `dv-engine.ts` into the shared `ui/src/query-uri.ts` module.
* `frontmatter.ts` now applies the same classifier to scalar YAML property values and to each item in block-list properties.
* `main.ts` binds those generated URI anchors in full previews, hover previews, and note embeds through the shared preview-binding path.
* Explicit regression tests cover field-name hints, MIME attributes, block-list items, and non-URI values.
* The TypeScript build and focused regression suite pass with this behavior.

### Native PostgreSQL Page SQL

Native fenced query languages are `sql`, `postgresql`, and `pgsql`. Legal Markdown indentation of up to three spaces is recognized.

The query path is:

```text
PostgreSQL text
    -> libpg_query parser/read-only statement gate
    -> Nephrite page-type lowering
    -> read-only SQLite statement
    -> typed/link-aware result table
```

Native execution enforces:

* exactly one PostgreSQL `SELECT` statement;
* SQLite's native read-only statement classification after lowering;
* no unbound parameters;
* a 128 KiB query limit;
* a 1,000-row result limit;
* preservation of SQL `NULL` and scalar numeric/boolean types;
* rejection of mutating SQL.

The public semantic type namespace is `page`, not `nephrite`. The intended model is:

```text
page.record
├── properties  page.properties
├── tags        page.tag[]
├── aliases     page.alias[]
├── links       page.link[]
├── headers     page.header[]
└── todos       page.todo[]
```

Important semantic distinction:

* `p.properties['tags']` and `p.properties['aliases']` preserve the YAML-declared values.
* `p.tags` is the normalized union of YAML and inline tags.
* `p.aliases` is the normalized alias collection used for link resolution.
* Promoted fields remain present in `properties`; promotion is a semantic projection, not removal.

Supported PostgreSQL-facing expressions currently include:

```sql
p.properties['company']
'recruiter' = ANY(p.tags)
p.tags @> ARRAY['recruiter']
p.tags @> ARRAY['recruiter', 'linkedin']
p.tags && ARRAY['recruiter', 'interviewer']
```

`@>` is containment and therefore requires every listed tag (AND semantics).
`&&` is overlap and therefore requires any listed tag (OR semantics).

The normalized `properties`, `tags`, `aliases`, `links`, `headings`, and `tasks` tables remain disposable index internals/advanced escape hatches. Ordinary page queries should use `pages` and its page-owned values.

Current implementation note: SQLite still serializes complex page values internally. That encoding is private. `libpg_query` validates PostgreSQL syntax, and a lowering layer implements the public `page.*` behavior. Literal property subscripts and literal tag-array operations are implemented; replace the current narrowly scoped textual lowering with AST/IR lowering as the supported surface grows.

### YAML Index Typing

The prototype YAML parser previously confused blank scalars with empty objects and failed to represent block lists in frontmatter JSON. Version 0.2 corrects this:

* `work_email:` indexes as SQL/YAML null, not `{}`.
* YAML block lists index as typed arrays.
* Nested objects retain their hierarchy.
* Raw frontmatter bytes remain unchanged.

### Brady Gunter End-to-End SQL Fixture

The only known page containing a native SQL block is:

```text
/home/kroybal/Documents/notes/people/Brady Gunter.md
```

Its image is:

```text
/home/kroybal/Documents/notes/people/assets/linkedin-brady-gunter.jpg
```

The image link was accidentally changed to `linGkedin-brady-gunter.jpg` during the earlier slow-editor regression and was repaired to `linkedin-brady-gunter.jpg`.

The Brady SQL query now uses semantic page syntax, excludes Brady himself, compares company through `page.properties`, and filters recruiters with:

```sql
AND p.tags @> ARRAY['recruiter']
```

The live v2 backing index returns Josh Flanders alone. His missing `work_email` is SQL `NULL`; links such as LinkedIn render as clickable URI values.

### Verification Baseline

The latest completed validation is:

* 13/13 TypeScript performance/rendering regression tests passing;
* 8/8 `nephrite-index` tests passing;
* 4/4 native PostgreSQL SQL tests passing;
* `cargo fmt --check` passing;
* `cargo check -p nephrite` passing;
* `npm run build` passing;
* live v2 vault index rebuilt and queried successfully.

Expected Vite warnings about third-party `"use client"` directives and large chunks are non-fatal.

### Immediate Resume Checklist

1. Restart Nephrite to load the native SQL command, `libpg_query`, page-type lowering, index v2 behavior, and shared URI renderer.
2. Open `people/Brady Gunter.md` in split/preview mode and verify the SQL table renders Josh Flanders rather than source text or an error.
3. Verify `p.tags @> ARRAY['recruiter']` works unchanged.
4. Visually verify frontmatter email, phone, website, LinkedIn, and file-extension URLs are clickable and carry the expected MIME `type`.
5. Continue replacing textual PostgreSQL lowering with AST-to-IR translation as additional `page.*` operations are introduced.
