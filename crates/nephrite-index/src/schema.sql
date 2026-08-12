-- Nephrite vault index schema (disposable).
-- Identity: vault-relative path only (case retained). No surrogate file IDs.
-- See docs/vault-schema.md

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    path          TEXT PRIMARY KEY NOT NULL,
    parent_path   TEXT NOT NULL DEFAULT '',
    name          TEXT NOT NULL,
    stem          TEXT NOT NULL,
    extension     TEXT NOT NULL DEFAULT '',
    file_kind     TEXT NOT NULL,
    mtime_ms      INTEGER NOT NULL,
    size_bytes    INTEGER NOT NULL,
    content_hash  TEXT,
    parse_version INTEGER NOT NULL DEFAULT 0,
    frontmatter_raw TEXT,
    indexed_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_path);
CREATE INDEX IF NOT EXISTS idx_files_kind ON files(file_kind);
CREATE INDEX IF NOT EXISTS idx_files_stem ON files(stem);
CREATE INDEX IF NOT EXISTS idx_files_ext ON files(extension);
CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime_ms);

CREATE TABLE IF NOT EXISTS aliases (
    path  TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    PRIMARY KEY (path, alias)
);

CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);

CREATE TABLE IF NOT EXISTS headings (
    path        TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    heading_id  INTEGER NOT NULL,
    level       INTEGER NOT NULL,
    text        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset   INTEGER,
    start_line   INTEGER NOT NULL,
    PRIMARY KEY (path, heading_id)
);

CREATE INDEX IF NOT EXISTS idx_headings_slug ON headings(path, slug);

CREATE TABLE IF NOT EXISTS blocks (
    path         TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    block_id     TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset   INTEGER,
    start_line   INTEGER NOT NULL,
    PRIMARY KEY (path, block_id)
);

CREATE TABLE IF NOT EXISTS links (
    path            TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    link_id         INTEGER NOT NULL,
    target_raw      TEXT NOT NULL,
    target_path     TEXT,
    target_heading  TEXT,
    target_block    TEXT,
    display_text    TEXT,
    link_kind       TEXT NOT NULL,
    is_embed        INTEGER NOT NULL DEFAULT 0,
    start_offset    INTEGER NOT NULL,
    end_offset      INTEGER NOT NULL,
    PRIMARY KEY (path, link_id)
);

CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_raw ON links(target_raw);
CREATE INDEX IF NOT EXISTS idx_links_embed ON links(is_embed);

CREATE TABLE IF NOT EXISTS tags (
    path         TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    tag          TEXT NOT NULL,
    tag_head     TEXT NOT NULL,
    source       TEXT NOT NULL,
    start_offset INTEGER,
    line         INTEGER,
    PRIMARY KEY (path, tag, source, line, start_offset)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_head ON tags(tag_head);

CREATE TABLE IF NOT EXISTS tasks (
    path              TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    task_id           INTEGER NOT NULL,
    status            TEXT NOT NULL,
    status_char       TEXT NOT NULL,
    text              TEXT NOT NULL,
    raw_line          TEXT NOT NULL,
    line              INTEGER NOT NULL,
    start_offset      INTEGER NOT NULL,
    end_offset        INTEGER NOT NULL,
    due               TEXT,
    scheduled         TEXT,
    start_date        TEXT,
    done_date         TEXT,
    created_date      TEXT,
    priority          TEXT,
    recurrence        TEXT,
    is_recurring      INTEGER NOT NULL DEFAULT 0,
    completed         INTEGER NOT NULL DEFAULT 0,
    list_indent       INTEGER NOT NULL DEFAULT 0,
    parent_task_id    INTEGER,
    section_heading_id INTEGER,
    tags_json         TEXT,
    PRIMARY KEY (path, task_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(completed, due);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS properties (
    path       TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    prop_path  TEXT NOT NULL,
    prop_key   TEXT NOT NULL,
    value_type TEXT NOT NULL,
    value_text TEXT,
    value_num  REAL,
    value_bool INTEGER,
    value_json TEXT,
    is_leaf    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (path, prop_path)
);

CREATE INDEX IF NOT EXISTS idx_properties_key ON properties(prop_key);
CREATE INDEX IF NOT EXISTS idx_properties_path_key ON properties(path, prop_key);

CREATE TABLE IF NOT EXISTS file_frontmatter (
    path TEXT PRIMARY KEY NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inline_fields (
    path         TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    field_id     INTEGER NOT NULL,
    key          TEXT NOT NULL,
    value_text   TEXT,
    value_type   TEXT NOT NULL,
    value_json   TEXT,
    line         INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    PRIMARY KEY (path, field_id)
);

CREATE INDEX IF NOT EXISTS idx_inline_fields_key ON inline_fields(key);

CREATE TABLE IF NOT EXISTS footnotes (
    path         TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    footnote_id  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    text         TEXT,
    start_offset INTEGER NOT NULL,
    line         INTEGER NOT NULL,
    PRIMARY KEY (path, footnote_id, kind, start_offset)
);

CREATE TABLE IF NOT EXISTS canvas_nodes (
    path      TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    node_id   TEXT NOT NULL,
    node_type TEXT NOT NULL,
    file_path TEXT,
    text      TEXT,
    x         REAL,
    y         REAL,
    width     REAL,
    height    REAL,
    PRIMARY KEY (path, node_id)
);

CREATE TABLE IF NOT EXISTS canvas_edges (
    path      TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    edge_id   TEXT NOT NULL,
    from_node TEXT NOT NULL,
    to_node   TEXT NOT NULL,
    label     TEXT,
    PRIMARY KEY (path, edge_id)
);

CREATE TABLE IF NOT EXISTS kanban_boards (
    path  TEXT PRIMARY KEY NOT NULL REFERENCES files(path) ON DELETE CASCADE,
    title TEXT
);

CREATE TABLE IF NOT EXISTS kanban_columns (
    path      TEXT NOT NULL REFERENCES kanban_boards(path) ON DELETE CASCADE,
    column_id TEXT NOT NULL,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (path, column_id)
);

CREATE TABLE IF NOT EXISTS kanban_cards (
    path      TEXT NOT NULL REFERENCES kanban_boards(path) ON DELETE CASCADE,
    card_id   TEXT NOT NULL,
    column_id TEXT NOT NULL,
    position  INTEGER NOT NULL,
    title     TEXT NOT NULL,
    note_path TEXT,
    task_path TEXT,
    task_id   INTEGER,
    meta_json TEXT,
    PRIMARY KEY (path, card_id)
);

CREATE VIEW IF NOT EXISTS embeds AS
SELECT * FROM links WHERE is_embed = 1;

-- `pages` is the stable semantic query surface. Storage-normalized child
-- tables remain available for advanced queries, but ordinary page queries
-- should not need to join them back onto their owner.
DROP VIEW IF EXISTS pages;
CREATE VIEW pages AS
SELECT
    f.path,
    f.parent_path AS folder,
    f.stem AS name,
    CASE
        WHEN json_valid(fm.json) THEN CAST(json_extract(fm.json, '$.title') AS TEXT)
        ELSE NULL
    END AS title,
    f.mtime_ms,
    f.extension,
    f.file_kind,
    CASE WHEN json_valid(fm.json) THEN fm.json ELSE '{}' END AS properties,
    COALESCE((
        SELECT json_group_array(tag)
        FROM (
            SELECT DISTINCT t.tag AS tag
            FROM tags t
            WHERE t.path = f.path
            ORDER BY t.tag COLLATE NOCASE
        )
    ), '[]') AS tags,
    COALESCE((
        SELECT json_group_array(alias)
        FROM (
            SELECT a.alias AS alias
            FROM aliases a
            WHERE a.path = f.path
            ORDER BY a.alias COLLATE NOCASE
        )
    ), '[]') AS aliases,
    COALESCE((
        SELECT json_group_array(json_object(
            'target', l.target_raw,
            'path', l.target_path,
            'heading', l.target_heading,
            'block', l.target_block,
            'label', l.display_text,
            'kind', l.link_kind,
            'embed', json(CASE WHEN l.is_embed = 1 THEN 'true' ELSE 'false' END)
        ))
        FROM links l
        WHERE l.path = f.path
    ), '[]') AS links,
    COALESCE((
        SELECT json_group_array(json_object(
            'id', h.heading_id,
            'level', h.level,
            'text', h.text,
            'slug', h.slug,
            'line', h.start_line,
            'start', h.start_offset,
            'end', h.end_offset
        ))
        FROM headings h
        WHERE h.path = f.path
        ORDER BY h.heading_id
    ), '[]') AS headers,
    COALESCE((
        SELECT json_group_array(json_object(
            'id', todo.task_id,
            'status', todo.status,
            'marker', todo.status_char,
            'text', todo.text,
            'line', todo.line,
            'completed', json(CASE WHEN todo.completed = 1 THEN 'true' ELSE 'false' END),
            'due', todo.due,
            'scheduled', todo.scheduled,
            'start', todo.start_date,
            'done', todo.done_date,
            'created', todo.created_date,
            'priority', todo.priority,
            'recurrence', todo.recurrence
        ))
        FROM tasks todo
        WHERE todo.path = f.path
        ORDER BY todo.task_id
    ), '[]') AS todos
FROM files f
LEFT JOIN file_frontmatter fm ON fm.path = f.path
WHERE f.file_kind = 'markdown';

CREATE VIEW IF NOT EXISTS tasks_v AS
SELECT * FROM tasks;

CREATE VIEW IF NOT EXISTS backlinks AS
SELECT
    target_path AS path,
    path AS source_path,
    display_text,
    target_heading,
    is_embed
FROM links
WHERE target_path IS NOT NULL;

-- FTS: content synced by application code on file index/delete
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    path UNINDEXED,
    title,
    headings,
    body,
    tags,
    tokenize = 'unicode61'
);
