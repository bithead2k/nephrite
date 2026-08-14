# Vault Index: Why Plugins Re-Index, and What SQLite Must Provide

Companion: `AGENTS.md`, `docs/decisions.md`, `docs/compatibility.md`.

**Invariant:** Markdown (and other vault files) are authoritative. The SQLite database under `.nephrite/` is **disposable**, rebuildable, and the **only** structured index consumers should use.

**Identity:** Vault-relative path only (case retained). No surrogate file IDs for identity. See `docs/decisions.md` #8.

---

## 1. Why Obsidian plugins re-index the vault

This is not random waste—it is a structural consequence of Obsidian’s architecture.

### 1.0 Clarification: this is usually *not* about a stale core cache

A natural misreading: “the platform index is rarely rebuilt, goes stale, and plugins can’t tolerate that—so they re-index.”

**That is not the main story.**

Obsidian’s `MetadataCache` is generally **kept up to date** as files change. Plugins can and do listen to cache events. Core backlinks/outline/properties work off that live cache. Occasional full reindex pain (cache wipe, corruption, “indexing thousands of files on open”) is real for users, but it is **not** why Dataview, Tasks, and Omnisearch each maintain their own long-lived indexes.

Plugins re-parse / re-index primarily because they need **different data**, a **different access model**, or a **private derived store**—not because core metadata is chronically wrong or frozen.

| If the problem were… | You’d fix it by… |
|----------------------|------------------|
| Stale core cache | Better invalidation of one shared cache |
| **Missing fields + no query DB** (actual) | Richer shared schema + SQL/API (Nephrite’s approach) |

Nephrite’s SQLite index must also stay **fresh** (watcher + per-file incremental updates). Freshness is necessary hygiene. It is not, by itself, what makes a shared index replace plugin re-indexing—**completeness and queryability** are.

### 1.1 Core `MetadataCache` is incomplete for power features

Obsidian maintains a per-file `CachedMetadata` (headings, links, embeds, tags, frontmatter, list/task items, sections, blocks). That is enough for core UI (backlinks, outline, basic properties).

It is **not** a shared analytical database. Gaps that force plugins to parse Markdown themselves (even when the core cache is fresh):

| Need | In core cache? | Who builds their own index / parse |
|------|----------------|-------------------------------------|
| Inline fields `key:: value` | No | Dataview, others |
| Hierarchical / nested YAML as queryable paths | Shallow / property-UI oriented | Dataview, custom plugins |
| Task emoji dates, recurrence, priority signifiers | Partial list items only | Tasks plugin |
| Full-text ranked search, PDF/OCR text | No durable FTS product surface | Omnisearch (+ Text Extractor) |
| Canvas card ↔ note graph | Weak / separate | Canvas-related plugins |
| Excalidraw link extraction | No | Excalidraw plugin |
| Cross-file query engine (SQL/DQL) | No | Dataview, OQL, Bases (own model) |
| Custom domain models (kanban columns, etc.) | No | Each plugin |

Example: Dataview discussions about “use Obsidian’s cache” still hit the wall that **inline fields are not in that cache**—so a second parse layer remains even if you trust core freshness completely.

### 1.2 Cache is process-oriented, not a query API

Plugins can read `app.metadataCache.getFileCache(file)` **per file**. There is no first-class vault-wide:

- `SELECT * FROM tasks WHERE due < today`
- indexed property paths across all notes
- one transactional snapshot for multi-file queries
- “give me every task” without scanning caches or files yourself

So each plugin materializes **its own** structure optimized for its queries: Dataview pages, Tasks’ task list, Omnisearch’s search engine, etc. That materialization looks like “re-indexing” whether or not core metadata was already current.

Tasks’ heavier reload behavior on edits is about **keeping its own task model and signifier parse coherent**, not a claim that `MetadataCache` forgot the file exists.

### 1.3 Many private indexes, no shared derived layer

Even with live core events:

- Plugin A’s derived data is invisible to plugin B unless B depends on A’s private API (e.g. Dataview’s `getAPI()`—a second platform on top of Obsidian).
- Event ordering vs view refresh can be awkward, but that is secondary to “I need my own tables.”
- On large vaults / mobile, **N plugins × parse or index work** multiplies cost even when each index is correctly incremental.

### 1.4 Persistence shape (startup cost ≠ stale core)

Core metadata is session/cache oriented. Plugin indexes are often:

- rebuilt or warmed **on plugin load**,
- held in memory,
- or stored in plugin data that **does not travel with Markdown** the way vault notes do under Sync.

So users see stacked “indexing…” on open. That is **each plugin reconstructing its private world**, not proof that Obsidian left everyone on last week’s data.

### 1.5 Root cause (one sentence)

**Obsidian never shipped a complete, queryable, shared vault index as the platform API—so every serious feature reimplemented indexing for coverage and access patterns, not because the core cache was mostly stale.**

Nephrite’s job is to **be** that platform API via SQLite (complete enough + SQL + change bus), keep it **incrementally fresh**, and require core features and plugins to consume it instead of each owning a full-vault parse.

---

## 2. Consumer map → index capabilities

Map every Nephrite product surface (from `docs/compatibility.md`) to index requirements.

| Consumer | Reads from index | Writes / side effects |
|----------|------------------|------------------------|
| Search / FTS | `files_fts`, paths, titles, headings | — |
| Backlinks / outgoing | `links`, `embeds` | — |
| Graph | `links`, `embeds`, optional tag edges | — |
| Wikilink resolve | `files`, `aliases`, `headings`, `blocks` | — |
| Section jump / `![[p#h]]` | `headings` (+ content slice from file at render) | — |
| Properties / hierarchical YAML | `properties` (path-keyed JSON + typed leaves) | Property edit → file write → reindex file |
| Tags | `tags` | — |
| Tasks UI + Ctrl-Enter | `tasks` | Toggle → file write → reindex file |
| SQL query blocks | SQL views over all tables | Read-only |
| Engine scripting (DVJS-class) | Same as SQL + row APIs | Prefer read; writes via vault API only |
| Dataview DQL | Shared indexed page model and compatibility evaluator | Implemented frontend |
| Kanban | `kanban_*` or tasks/notes + board files | Board edit → vault file |
| Canvas | `canvas_nodes`, `canvas_edges` | Canvas edit → `.canvas` file |
| Excalidraw | `files` type + `links` extracted from drawing | Drawing save → file |
| Templates / automation | `files`, `properties`, query API | File create/move via vault API |
| Footnotes | `footnotes` | — |
| Command bar | commands registry (not vault); nav uses `files` | — |
| Plugins | **only** index + vault API | Must not private-scan whole vault for baseline facts |
| Live preview / editor | CM6 parse for current buffer; index for vault-wide | Editor is source for current file until saved |

**Content policy:** Large body text for FTS may live in FTS virtual tables. Random access to body for embed preview may read the file (or a chunk cache). Do not force full body into relational rows for every note unless needed.

---

## 3. Index architecture

```
Vault filesystem
       │
       ▼
  Watcher (create/modify/delete/rename)
       │
       ▼
  File classifier (md, canvas, image, excalidraw, other)
       │
       ▼
  Parsers (CM6/Lezer-driven for MD; JSON for canvas; …)
       │
       ▼
  SQLite (.nephrite/index.db)  ←── single writer / transactional per file
       │
       ├── FTS5
       ├── Relational tables
       └── SQL views (pages, tasks_v, …)
       │
       ▼
  Change bus (path, kinds: links|tasks|properties|…)
       │
       ▼
  Core features + plugins (subscribe; query; never full rescan)
```

### 3.1 Rules for consumers

1. **No full-vault reparse** in a plugin for data the index already has.
2. **Query** via SQL or typed index APIs.
3. **Mutate** via vault file APIs; index updates from the watcher/parser pipeline.
4. **Subscribe** to index change events filtered by path or entity kind.
5. If a plugin needs a new fact type, **extend the shared schema** (or a versioned extension table)—do not start a parallel index of all Markdown files.

### 3.2 Per-file incremental update

On file change (while app is open):

1. Begin transaction.
2. `DELETE` dependent rows for `path` (or `path` old on rename).
3. Re-parse that file only; `INSERT` new rows.
4. Update `files` row (`mtime`, `size`, `content_hash`, `parse_version`).
5. Commit; emit change events.

On rename: update `files.path` and all path FKs **or** delete-old + insert-new in one transaction (path is identity—prefer single transactional rewrite of path columns).

### 3.3 Rebuild (full vault reparse into SQLite)

`DELETE` all user tables → walk vault → parse all. Safe anytime. User data loss: **none** (only disposable index).

This is **not** the same as SQLite’s SQL command `REINDEX` (see §3.5).

### 3.4 Refresh on open (product rule)

**On every vault open**, bring the index into agreement with the filesystem before treating search/SQL/backlinks/tasks as authoritative.

Recommended algorithm (robust, not “blind full parse every time unless needed”):

1. Open or create `.nephrite/index.db` (WAL mode).
2. If no stored `project_version`, empty `files` table, or **`PROJECT_VERSION` major** mismatch → **full rebuild**  
   (one version only — see `docs/versioning.md`: **major** = rebuild, **minor** = no rebuild).
3. Else **reconcile** (minor may differ; that does **not** wipe the index):
   - List all vault files (respect ignore rules: `.obsidian` settings later; always skip `.nephrite` internals as content).
   - For each path: compare `mtime_ms` + `size_bytes` (and optionally `content_hash` if cheap).
   - **Unchanged** → leave rows.
   - **New or changed** → per-file reparse (transaction).
   - **In index but gone from disk** → delete dependent rows + `files` row.
4. Write `project_version` and `last_open_reconcile_ms` in `schema_meta`.
5. Start filesystem watcher for ongoing incremental updates.
6. UI may show “Indexing…” only while reconcile/rebuild runs; queries wait or run on last-good snapshot policy (prefer: **block query API until reconcile finishes** for correctness on open).

Optional later: background priority queue so the app shell appears while indexing continues—**only** if UI clearly marks vault facts as not-ready. Default for correctness: **ready after open reconcile**.

This closes the “other client (Obsidian Sync / Unison / external editor) changed files while we were closed” gap without requiring plugins to rescan.

### 3.5 SQLite `REINDEX` vs vault reindex — and `REINDEX CONCURRENTLY`

**PostgreSQL** has `REINDEX CONCURRENTLY`: rebuild a B-tree/GiST/… index with less write-blocking on a live server.

**SQLite does not support `REINDEX CONCURRENTLY`.**  
SQLite’s [`REINDEX`](https://sqlite.org/lang_reindex.html) rebuilds SQLite’s own secondary indexes (or all of them) from table data. It takes the normal database locks; there is no concurrent variant.

| Concept | What it does | Nephrite use |
|---------|----------------|--------------|
| **Vault reindex / reconcile** | Re-parse Markdown (etc.) → rewrite *our* tables | On open + on file change; this is the product feature |
| **SQLite `REINDEX`** | Rebuild SQLite B-tree indexes on existing table rows | Rare maintenance (corruption, collation change); **not** how we refresh vault facts |
| **`REINDEX CONCURRENTLY`** | Postgres-only online index rebuild | **N/A** in SQLite |

How Nephrite stays usable while work runs:

| Technique | Role |
|-----------|------|
| **WAL mode** | Readers can proceed while a writer commits; good for UI queries during *incremental* updates |
| **Short per-file transactions** | Prefer many small writes over one multi-minute lock |
| **Full rebuild strategy** | Prefer rebuild into a **temp DB file** then atomic replace/`ATTACH` swap, or rebuild in-place when vault is quiet—avoid holding a single huge exclusive lock longer than needed |
| **Do not rely on SQL `REINDEX`** for open refresh | Wrong tool; does not re-read the vault |

So: **close compatibility gaps with reconcile-on-open + incremental watcher**, not with Postgres-style concurrent reindex.

---

## 4. Schema design (SQLite)

Paths use `/` separators, vault-relative, case-preserved.  
Timestamps: ISO-8601 text or integer unix ms—pick one project-wide (recommend **integer unix ms** for sort + **text ISO** only when displaying). Below: `mtime_ms INTEGER`.

JSON columns use SQLite `TEXT` with JSON1 functions (or `JSONB` if available in target SQLite).

### 4.1 `schema_meta`

| Column | Type | Notes |
|--------|------|-------|
| key | TEXT PK | e.g. `project_version` (`MAJOR.MINOR`), `last_open_reconcile_ms` |
| value | TEXT | |

### 4.2 `files`

One row per vault file (not only Markdown).

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT PK | Identity |
| parent_path | TEXT | Folder path; `''` for root |
| name | TEXT | Final segment |
| stem | TEXT | Name without extension |
| extension | TEXT | `md`, `canvas`, `png`, … |
| file_kind | TEXT | `markdown`, `canvas`, `image`, `attachment`, `excalidraw`, `other` |
| mtime_ms | INTEGER | |
| size_bytes | INTEGER | |
| content_hash | TEXT | Optional; detect same-content moves |
| parse_version | INTEGER | `PROJECT_VERSION.major` that produced dependent rows |
| frontmatter_raw | TEXT | NULL if none; exact YAML body without `---` |
| indexed_at_ms | INTEGER | |

Indexes: `(parent_path)`, `(file_kind)`, `(stem)`, `(extension)`, `(mtime_ms)`.

### 4.3 `aliases`

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | FK → files.path |
| alias | TEXT | |
| PRIMARY KEY (path, alias) | | |

Index: `(alias)` for wikilink resolve by name.

### 4.4 `properties` (hierarchical YAML + flat leaves)

Support nested YAML and sequences better than flat Obsidian properties.

**Approach:** store both a document blob and exploded leaf paths for query.

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | File path |
| prop_path | TEXT | JSON-path-like: `status`, `author.name`, `tags[0]`, `projects[2].id` |
| prop_key | TEXT | Final key segment (for simple filters) |
| value_type | TEXT | `null`, `string`, `number`, `boolean`, `date`, `datetime`, `link`, `array`, `object` |
| value_text | TEXT | Canonical text form |
| value_num | REAL | If number |
| value_bool | INTEGER | 0/1 if boolean |
| value_json | TEXT | Full JSON for complex nodes; for leaves may equal scalar JSON |
| is_leaf | INTEGER | 1 if queryable scalar/link leaf |
| PRIMARY KEY (path, prop_path) | | |

Also optional:

| Table | Purpose |
|-------|---------|
| `file_frontmatter` | `(path PK, json TEXT)` full typed tree for scripting |

Indexes: `(prop_key)`, `(prop_path)`, `(value_text)`, `(value_type)`, `(path, prop_key)`.

**Bullet lists in YAML:** each sequence element gets `prop_path` with indices; object elements nest further. Do not collapse sequences to a single comma-joined string as the only representation.

### 4.5 `headings`

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | |
| heading_id | INTEGER | Stable within file parse (ordinal) |
| level | INTEGER | 1–6 |
| text | TEXT | Plain heading text |
| slug | TEXT | Normalized for `#Heading` match (Obsidian rules) |
| start_offset | INTEGER | Byte or UTF-16—**document one** project-wide |
| end_offset | INTEGER | Section end (until next heading ≤ level) if known |
| start_line | INTEGER | 1-based convenience |
| PRIMARY KEY (path, heading_id) | | |

Indexes: `(path, slug)`, `(text)`.

Enables `[[note#Heading]]` and `![[note#Heading]]` (section bounds for embed).

### 4.6 `blocks`

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | |
| block_id | TEXT | `^blockid` |
| start_offset | INTEGER | |
| end_offset | INTEGER | |
| start_line | INTEGER | |
| PRIMARY KEY (path, block_id) | | |

### 4.7 `links`

Outgoing links from a file (wikilink or markdown).

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | Source file |
| link_id | INTEGER | Ordinal in file |
| target_raw | TEXT | As written |
| target_path | TEXT | Resolved path or NULL if unresolved |
| target_heading | TEXT | `#Heading` if present |
| target_block | TEXT | `^id` if present |
| display_text | TEXT | Alias or md link text |
| link_kind | TEXT | `wikilink`, `markdown`, `autolink`, … |
| is_embed | INTEGER | 0 link / 1 embed (`![[…]]` or image) |
| start_offset | INTEGER | |
| end_offset | INTEGER | |
| PRIMARY KEY (path, link_id) | | |

Indexes: `(target_path)`, `(target_raw)`, `(is_embed)`, `(path, target_path)`.

**Backlinks** = `SELECT * FROM links WHERE target_path = ?`.

### 4.8 `embeds`

Optional view or table filtering `links WHERE is_embed = 1`. Prefer view:

```sql
CREATE VIEW embeds AS
SELECT * FROM links WHERE is_embed = 1;
```

### 4.9 `tags`

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | |
| tag | TEXT | Full tag including parents: `work/project` |
| tag_head | TEXT | First segment |
| source | TEXT | `body`, `frontmatter` |
| start_offset | INTEGER | NULL if frontmatter-only |
| line | INTEGER | |
| PRIMARY KEY (path, tag, source, line, start_offset) | | simplify if needed |

Index: `(tag)`, `(tag_head)`, `(path)`.

### 4.10 `tasks`

Rich enough for Tasks-plugin semantics + simple checkboxes + Logseq-style status cycle.

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | |
| task_id | INTEGER | Ordinal in file |
| status | TEXT | Canonical: `todo`, `half`, `done`, `cancelled`, … |
| status_char | TEXT | Raw checkbox char: ` `, `/`, `x`, `-`, … |
| text | TEXT | Task text without signifiers (or raw—pick one + keep raw_line) |
| raw_line | TEXT | Full line for rewrite safety |
| line | INTEGER | 1-based |
| start_offset | INTEGER | |
| end_offset | INTEGER | |
| due | TEXT | ISO date if present |
| scheduled | TEXT | |
| start_date | TEXT | |
| done_date | TEXT | |
| created_date | TEXT | |
| priority | TEXT | `highest`…`lowest` or empty |
| recurrence | TEXT | Raw recurrence rule string |
| is_recurring | INTEGER | |
| completed | INTEGER | 1 if done/cancelled-done policy |
| list_indent | INTEGER | Nesting depth |
| parent_task_id | INTEGER | NULL or ordinal parent |
| section_heading_id | INTEGER | Heading context |
| tags_json | TEXT | Tags on the task line |
| PRIMARY KEY (path, task_id) | | |

Indexes: `(completed, due)`, `(due)`, `(scheduled)`, `(status)`, `(path)`.

**Ctrl-Enter** uses offsets/line to rewrite the single line, then reindexes that file.

### 4.11 `list_items` (non-task lists, optional but useful)

Dataview-style list field support and outlines.

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | |
| item_id | INTEGER | |
| text | TEXT | |
| line | INTEGER | |
| start_offset | INTEGER | |
| indent | INTEGER | |
| parent_id | INTEGER | |
| is_task | INTEGER | |
| PRIMARY KEY (path, item_id) | | |

### 4.12 `inline_fields` (Dataview `key:: value`)

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | |
| field_id | INTEGER | |
| key | TEXT | |
| value_text | TEXT | |
| value_type | TEXT | |
| value_json | TEXT | |
| line | INTEGER | |
| start_offset | INTEGER | |
| PRIMARY KEY (path, field_id) | | |

Index: `(key)`, `(path, key)`.

This is a primary reason Dataview cannot rely on Obsidian’s cache alone—**Nephrite indexes them once for everyone.**

### 4.13 `footnotes`

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | |
| footnote_id | TEXT | `1` or label |
| kind | TEXT | `ref` or `def` |
| text | TEXT | Definition body if def |
| start_offset | INTEGER | |
| line | INTEGER | |
| PRIMARY KEY (path, footnote_id, kind, start_offset) | | |

### 4.14 `canvas_nodes` / `canvas_edges`

From `.canvas` JSON (Obsidian format).

**canvas_nodes**

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | `.canvas` file path |
| node_id | TEXT | |
| node_type | TEXT | `file`, `text`, `link`, `group`, … |
| file_path | TEXT | If file card |
| text | TEXT | If text card |
| x | REAL | |
| y | REAL | |
| width | REAL | |
| height | REAL | |
| PRIMARY KEY (path, node_id) | | |

**canvas_edges**

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | |
| edge_id | TEXT | |
| from_node | TEXT | |
| to_node | TEXT | |
| label | TEXT | |
| PRIMARY KEY (path, edge_id) | | |

Also emit synthetic `links` rows from file cards → note paths so graph/backlinks see Canvas relationships.

### 4.15 Kanban

Prefer vault-native board files (format TBD: Markdown sections, or JSON in vault). Index:

**kanban_boards**

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT PK | Board file |
| title | TEXT | |

**kanban_columns**

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | Board path |
| column_id | TEXT | |
| name | TEXT | |
| position | INTEGER | |
| PRIMARY KEY (path, column_id) | | |

**kanban_cards**

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT | Board |
| card_id | TEXT | |
| column_id | TEXT | |
| position | INTEGER | |
| title | TEXT | |
| note_path | TEXT | Optional linked note |
| task_path | TEXT | Optional |
| task_id | INTEGER | Optional |
| meta_json | TEXT | |
| PRIMARY KEY (path, card_id) | | |

### 4.16 `attachments` / media

Covered by `files` with `file_kind`. Optional:

| Column | Type | Notes |
|--------|------|-------|
| path | TEXT PK | |
| width | INTEGER | |
| height | INTEGER | |
| mime | TEXT | |

### 4.17 Full-text search

```sql
CREATE VIRTUAL TABLE files_fts USING fts5(
  path UNINDEXED,
  title,
  headings,
  body,
  tags,
  tokenize = 'unicode61'
);
```

The FTS `title` column is search text, not identity. Populate it from the
filename stem (and optionally YAML title), plus heading texts, body text, and
tag strings. Omnisearch-class features (typo tolerance, PDF) can extend later
via extra tables—**not** a second full Markdown metadata index.

### 4.18 SQL-facing views (product names)

Stable names for query blocks and scripting:

```sql
CREATE VIEW pages AS
SELECT
  f.path,
  f.parent_path AS folder,
  f.stem AS name,
  CASE
    WHEN json_valid(fm.json)
    THEN CAST(json_extract(fm.json, '$.title') AS TEXT)
    ELSE NULL
  END AS title,
  f.mtime_ms,
  f.extension,
  f.file_kind,
  CASE WHEN json_valid(fm.json) THEN fm.json ELSE '{}' END AS properties,
  /* JSON arrays assembled from their normalized index tables: */
  (...) AS tags,
  (...) AS aliases,
  (...) AS links,
  (...) AS headers,
  (...) AS todos
FROM files f
LEFT JOIN file_frontmatter fm ON fm.path = f.path
WHERE f.file_kind = 'markdown';

-- `path` is the sole page identity. `name`/`file.name` is the filename stem.
-- `title` is optional YAML metadata and is never an identity fallback.

-- `properties`, `tags`, `aliases`, and `links` are page-owned values on the
-- stable query surface. Their normalized tables are index internals and an
-- advanced-query escape hatch, not the ordinary page-query interface.

CREATE VIEW tasks_v AS
SELECT * FROM tasks;

CREATE VIEW backlinks AS
SELECT
  l.target_path AS path,
  l.path AS source_path,
  l.display_text,
  l.target_heading,
  l.is_embed
FROM links l
WHERE l.target_path IS NOT NULL;
```

The public PostgreSQL type catalog is semantic rather than storage-shaped:

```sql
page.record
page.properties
page.property_value
page.tag[]
page.link[]
page.header[]
page.todo[]
```

Backing serialization in the disposable SQLite index is private to the query
translator. Page SQL uses PostgreSQL subscripting and arrays:

```sql
SELECT
  name,
  properties['title'] AS title,
  properties['work_email'] AS work_email
FROM pages
WHERE properties['company'] = 'CDW'
  AND 'recruiter' = ANY(tags);
```

PostgreSQL array operators retain their native meanings:

```sql
tags @> ARRAY['recruiter', 'interviewer'] -- contains both (AND)
tags && ARRAY['recruiter', 'interviewer'] -- overlaps either (OR)
```

```sql
SELECT path,
       json_extract(json, '$.status') AS status
FROM file_frontmatter
WHERE json_extract(json, '$.company') = 'Acme';
```

Plus the planned small YAML/properties SQL extension (`docs/decisions.md` #5) for nicer path syntax if needed.

---

## 5. Coverage checklist vs compatibility commitments

| Commitment | Schema support |
|------------|----------------|
| Section links / `![[p#h]]` | `headings` offsets + `links.target_heading` |
| Hierarchical YAML + bullet lists | `properties` prop_path + `file_frontmatter` |
| Tasks + Ctrl-Enter | `tasks` with offsets + status_char |
| Footnotes | `footnotes` |
| Live preview | Editor-local; vault facts from index |
| Graph | `links` (+ canvas synthetic links) |
| Canvas equivalent | `canvas_*` + link projection |
| Kanban OOTB | `kanban_*` |
| SQL SELECT | Views + tables |
| DVJS-class engine scripting | Same tables via API |
| Folders/links/tags first-class | `files.parent_path`, `links`, `tags` |
| Plugins use one index | API rules §3.1 |
| FTS search | `files_fts` |
| Inline fields | `inline_fields` |
| Embeds | `links.is_embed` |
| Aliases | `aliases` |
| Block refs | `blocks` |
| No surrogate file IDs | `path` PK everywhere |

---

## 6. What must *not* happen

| Anti-pattern | Why |
|--------------|-----|
| Plugin walks all `.md` files to find tags | Use `tags` table |
| Feature keeps private copy of all tasks | Use `tasks` + change bus |
| SQL engine reparses vault per query | Query SQLite only |
| Index stores only “flat” properties | Breaks hierarchical YAML goal |
| Dropping offsets | Breaks Ctrl-Enter, embeds, precise rewrite |
| Writing identity UUIDs into notes | Violates decisions #8 |
| Durable user data only in SQLite | Breaks Sync / disposable index |

---

## 7. Plugin API sketch (index-facing)

Normative intent (not frozen code):

```text
index.getFile(path) -> FileRow | null
index.query(sql, params) -> ResultSet          // read-only gate
index.tasks(filter) -> TaskRow[]               // optional sugar
index.resolveLink(raw, fromPath) -> path | null
index.onChange(cb: (ev: { paths, kinds }) => void)
vault.read(path) / vault.write(path, content)  // only write path
```

Plugins that need new extracted facts propose schema extensions; core parser version bumps; full rebuild.

---

## 8. Implementation phases (index)

| Phase | Deliver |
|-------|---------|
| **I** | `files`, `aliases`, `headings`, `links`, `tags`, `tasks` (basic), FTS, watcher, rebuild |
| **II** | `properties` hierarchical, `file_frontmatter`, `blocks`, `inline_fields`, `footnotes` |
| **III** | SQL views + read-only query gate |
| **IV** | `canvas_*`, kanban tables, synthetic canvas links |
| **V** | Plugin API + change bus; ban private full-vault scans in first-party features |

---

## 9. Summary

**Why plugins re-index:** Not primarily because core metadata is stale. Because core cache is a **per-file editor aid**, missing fields power tools need (inline fields, task signifiers, FTS, canvas, …), and there is **no shared vault-wide query database**—so each plugin materializes its own world.

**What Nephrite does:** One SQLite index that is **incrementally fresh**, **complete enough** for those consumers, **queryable** (SQL + APIs), path-keyed and offset-rich—and a hard rule that **features and plugins query that index** instead of each rescanning the vault.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-08-08 | Initial analysis + schema coverage for compatibility surface |
| 2026-08-08 | Corrected §1: primary cause is incompleteness/query model, not stale core cache |
| 2026-08-08 | §3.4 reconcile-on-open; §3.5 SQLite has no REINDEX CONCURRENTLY; crate `nephrite-index` |
