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

## Implementation Status (2026-08-15)

AGPL-3.0-only. Tauri + TypeScript + CodeMirror 6; disposable SQLite index at `.nephrite/index.db` (WAL). Markdown is authoritative — never rewrite source. `PROJECT_VERSION = 0.5` (0.5.0): minor upgrade from 0.4, not a full rebuild.

Implemented and verified (behavior details live in `docs/`): vault reader + metadata index + search + editor/viewer + watcher; native PostgreSQL SQL (`libpg_query` + `page` lowering, read-only); Dataview DQL/DataviewJS; Vim, Markdown/Obsidian rendering, Excalidraw, tasks dashboard, Git, declarative automation + Templater subset; plugin permission host.

Remaining gaps:

* Tasks (Phase 5): full Obsidian Tasks syntax parity, recurrence-series project views, tighter source navigation.
* Automation (Phase 6): sandboxed JS runtime + richer declarative actions (`<%* %>` preserved with warning).
* Plugin API (Phase 8): view/settings adapters; ES module/package support; packaged assets; stability contract.
* Vault compat: block-reference/edge-case link + hierarchical YAML write discipline; reconcile robustness under concurrent external changes.
* Preview/query/kanban hardening ongoing.
* Out of scope: mobile, full Obsidian plugin API, Sync, proprietary formats, unrestricted Node/Electron, undocumented internals.

Verify:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets   # warnings denied
cargo test --workspace                   # 64 app + 17 index
npm run build
npm run test                             # 53 perf + 6 ui + 10 dataview
```

Expected Vite warnings about third-party `"use client"` directives and large chunks are non-fatal. The supported SQL surface is audited against the local PostgreSQL 18.4 catalog at port 5438.
