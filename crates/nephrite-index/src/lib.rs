//! Disposable SQLite vault index for Nephrite.
//!
//! - Identity: vault-relative path (case retained)
//! - Refresh on open: reconcile filesystem vs index
//! - **Full rebuild** only when `PROJECT_VERSION` **major** mismatches what is stored
//! - Incremental: re-parse single files on change
//!
//! See `docs/vault-schema.md`, `docs/versioning.md`.

mod error;
mod file_kind;
mod parse;
mod pathutil;
mod version;

pub use error::{IndexError, Result};
pub use file_kind::FileKind;
pub use parse::MarkdownFacts;
pub use version::{Version, PROJECT_VERSION};

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use file_kind::FileKind as FK;
use parse::parse_markdown;
use pathutil::{
    abs_from_rel, name_of, normalize_rel, parent_of, rel_from_abs_cached, should_skip_rel, stem_ext,
};

const SCHEMA_SQL: &str = include_str!("schema.sql");

pub struct VaultIndex {
    vault_root: PathBuf,
    conn: Connection,
}

/// Stats from open reconcile / full rebuild.
#[derive(Debug, Clone)]
pub struct ReconcileStats {
    pub scanned: usize,
    pub unchanged: usize,
    pub updated: usize,
    pub removed: usize,
    pub full_rebuild: bool,
}

/// Progress callback phase for long-running index work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressPhase {
    Scan,
    Index,
    Resolve,
}

pub type ProgressFn<'a> = dyn FnMut(ProgressPhase, usize, usize, Option<&str>) + 'a;

impl VaultIndex {
    /// Open (or create) `.nephrite/index.db` under the vault and **reconcile on open**.
    pub fn open(vault_root: impl AsRef<Path>) -> Result<(Self, ReconcileStats)> {
        Self::open_with_progress(vault_root, |_, _, _, _| {})
    }

    /// Like [`open`](Self::open), with progress: `(phase, done, total, optional_path)`.
    pub fn open_with_progress(
        vault_root: impl AsRef<Path>,
        mut progress: impl FnMut(ProgressPhase, usize, usize, Option<&str>),
    ) -> Result<(Self, ReconcileStats)> {
        let vault_root = vault_root.as_ref().to_path_buf();
        if !vault_root.is_dir() {
            return Err(IndexError::NotADirectory(vault_root));
        }

        let nephrite_dir = vault_root.join(".nephrite");
        fs::create_dir_all(&nephrite_dir)?;
        let db_path = nephrite_dir.join("index.db");

        let conn = Connection::open(&db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;",
        )?;

        let mut idx = Self { vault_root, conn };
        idx.ensure_schema()?;
        let stats = idx.reconcile_with_progress(&mut progress)?;
        Ok((idx, stats))
    }

    pub fn vault_root(&self) -> &Path {
        &self.vault_root
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    fn ensure_schema(&mut self) -> Result<()> {
        // Additive / IF NOT EXISTS DDL — safe across minor bumps.
        self.conn.execute_batch(SCHEMA_SQL)?;
        Ok(())
    }

    fn stored_project_version(&self) -> Result<Option<Version>> {
        if let Some(s) = self.get_meta("project_version")? {
            return Ok(Some(Version::from_str(&s)?));
        }
        // Legacy prototype keys → best-effort parse, then rebuild path if unclear
        for key in ["index_version", "product_version", "schema_version"] {
            if let Some(s) = self.get_meta(key)? {
                if let Ok(v) = Version::from_str(&s) {
                    return Ok(Some(v));
                }
                if let Ok(major) = s.parse::<u32>() {
                    return Ok(Some(Version::new(major, 0)));
                }
            }
        }
        Ok(None)
    }

    fn write_project_version_meta(&self) -> Result<()> {
        self.set_meta("project_version", &PROJECT_VERSION.to_string())?;
        Ok(())
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    fn get_meta(&self, key: &str) -> Result<Option<String>> {
        let r = self.conn.query_row(
            "SELECT value FROM schema_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        );
        match r {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Bring index in line with the filesystem. Called on open; can be called anytime.
    ///
    /// Full rebuild only if stored `project_version` **major** ≠ `PROJECT_VERSION.major`
    /// (see `docs/versioning.md`). Minor-only bumps do not wipe the index.
    pub fn reconcile(&mut self) -> Result<ReconcileStats> {
        self.reconcile_with_progress(&mut |_, _, _, _| {})
    }

    /// Cheap metadata-only check used by the live tracker. It performs no
    /// database writes and does not parse file contents.
    pub fn filesystem_changed(&self) -> Result<bool> {
        let disk = Self::scan_vault_files(&self.vault_root)?;
        self.filesystem_changed_from(&disk)
    }

    /// Read vault file metadata without opening or locking the index database.
    /// The live tracker uses this to keep a potentially long directory walk
    /// from blocking SQL and Dataview queries.
    pub fn scan_vault_files(vault_root: &Path) -> Result<Vec<(String, i64, i64)>> {
        Self::list_vault_files_at(vault_root)
    }

    /// Compare a previously scanned filesystem snapshot with the index. The
    /// database is touched only for this short in-memory comparison.
    pub fn filesystem_changed_from(&self, files: &[(String, i64, i64)]) -> Result<bool> {
        let disk: HashMap<String, (i64, i64)> = files
            .iter()
            .cloned()
            .map(|(path, mtime, size)| (path, (mtime, size)))
            .collect();
        let mut indexed = HashMap::new();
        let mut statement = self
            .conn
            .prepare("SELECT path, mtime_ms, size_bytes FROM files")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))
        })?;
        for row in rows {
            let (path, metadata) = row?;
            indexed.insert(path, metadata);
        }
        Ok(disk != indexed)
    }

    pub fn reconcile_with_progress(
        &mut self,
        progress: &mut impl FnMut(ProgressPhase, usize, usize, Option<&str>),
    ) -> Result<ReconcileStats> {
        let stored_version = self.stored_project_version()?;
        let legacy_02_renumbering = stored_version
            .map(|stored| PROJECT_VERSION.is_legacy_02_renumbering(stored))
            .unwrap_or(false);
        let needs_rebuild = match stored_version {
            None => true, // empty or brand-new db content
            Some(stored) => PROJECT_VERSION.requires_rebuild(stored),
        };

        // Empty files table also means rebuild even if meta was written early.
        let file_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
            .unwrap_or(0);
        let needs_rebuild = needs_rebuild || file_count == 0;

        if needs_rebuild {
            return self.full_rebuild_with_progress(progress);
        }

        progress(ProgressPhase::Scan, 0, 0, Some("listing vault files"));
        let disk = self.list_vault_files()?;
        progress(ProgressPhase::Scan, disk.len(), disk.len(), None);

        // Map path -> (mtime, size) from index
        let mut index_meta: HashMap<String, (i64, i64)> = HashMap::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT path, mtime_ms, size_bytes FROM files")?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (p, m, s) = row?;
                index_meta.insert(p, (m, s));
            }
        }

        let mut stats = ReconcileStats {
            scanned: 0,
            unchanged: 0,
            updated: 0,
            removed: 0,
            full_rebuild: false,
        };

        let total = disk.len();
        let mut disk_paths: HashSet<String> = HashSet::new();
        for (rel, mtime_ms, size_bytes) in &disk {
            stats.scanned += 1;
            disk_paths.insert(rel.clone());
            let canvas_backfill = legacy_02_renumbering
                && Path::new(rel)
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("canvas"));
            match index_meta.get(rel) {
                Some((im, is)) if *im == *mtime_ms && *is == *size_bytes && !canvas_backfill => {
                    stats.unchanged += 1;
                }
                _ => {
                    self.index_path(rel)?;
                    stats.updated += 1;
                }
            }
            if stats.scanned % 50 == 0 || stats.scanned == total {
                progress(
                    ProgressPhase::Index,
                    stats.scanned,
                    total,
                    Some(rel.as_str()),
                );
            }
        }

        for path in index_meta.keys() {
            if !disk_paths.contains(path) {
                self.remove_path(path)?;
                stats.removed += 1;
            }
        }

        if stats.updated > 0 || stats.removed > 0 {
            progress(ProgressPhase::Resolve, 0, 1, Some("resolving links"));
            self.resolve_all_links()?;
            progress(ProgressPhase::Resolve, 1, 1, None);
        }

        let now = now_ms();
        self.set_meta("last_open_reconcile_ms", &now.to_string())?;
        self.write_project_version_meta()?;
        Ok(stats)
    }

    pub fn full_rebuild(&mut self) -> Result<ReconcileStats> {
        self.full_rebuild_with_progress(&mut |_, _, _, _| {})
    }

    pub fn full_rebuild_with_progress(
        &mut self,
        progress: &mut impl FnMut(ProgressPhase, usize, usize, Option<&str>),
    ) -> Result<ReconcileStats> {
        self.conn.execute_batch(
            "
            DELETE FROM kanban_cards;
            DELETE FROM kanban_columns;
            DELETE FROM kanban_boards;
            DELETE FROM canvas_edges;
            DELETE FROM canvas_nodes;
            DELETE FROM footnotes;
            DELETE FROM inline_fields;
            DELETE FROM file_frontmatter;
            DELETE FROM properties;
            DELETE FROM tasks;
            DELETE FROM tags;
            DELETE FROM links;
            DELETE FROM blocks;
            DELETE FROM headings;
            DELETE FROM aliases;
            DELETE FROM files;
            DELETE FROM files_fts;
            ",
        )?;

        progress(ProgressPhase::Scan, 0, 0, Some("listing vault files"));
        let disk = self.list_vault_files()?;
        let total = disk.len();
        progress(ProgressPhase::Scan, total, total, None);

        let mut stats = ReconcileStats {
            scanned: total,
            unchanged: 0,
            updated: 0,
            removed: 0,
            full_rebuild: true,
        };
        for (i, (rel, _, _)) in disk.iter().enumerate() {
            self.index_path(rel)?;
            stats.updated += 1;
            let done = i + 1;
            if done % 25 == 0 || done == total {
                progress(ProgressPhase::Index, done, total, Some(rel.as_str()));
            }
        }
        progress(ProgressPhase::Resolve, 0, 1, Some("resolving links"));
        self.resolve_all_links()?;
        progress(ProgressPhase::Resolve, 1, 1, None);
        self.write_project_version_meta()?;
        self.set_meta("last_open_reconcile_ms", &now_ms().to_string())?;
        Ok(stats)
    }

    /// Re-index a single vault-relative path (create/update).
    pub fn index_path(&mut self, rel: &str) -> Result<()> {
        self.index_path_with_content(rel, None)
    }

    /// Re-index a single path using Markdown bytes the caller already has.
    /// Saves use this to avoid writing a note and immediately reading the same
    /// bytes back from disk before parsing them.
    pub fn index_path_with_content(
        &mut self,
        rel: &str,
        markdown_content: Option<&str>,
    ) -> Result<()> {
        let rel = normalize_rel(rel)?;
        if should_skip_rel(&rel) {
            return Ok(());
        }
        let abs = abs_from_rel(&self.vault_root, &rel)?;
        if !abs.is_file() {
            return self.remove_path(&rel);
        }

        let meta = fs::metadata(&abs)?;
        let mtime_ms = mtime_to_ms(meta.modified().ok());
        let size_bytes = meta.len() as i64;
        let name = name_of(&rel).to_string();
        let (stem, extension) = stem_ext(&name);
        let kind = FK::from_extension(&extension);
        let parent = parent_of(&rel);
        let indexed_at = now_ms();

        let content = if matches!(kind, FK::Markdown | FK::Canvas) {
            markdown_content
                .map(str::to_owned)
                .unwrap_or_else(|| fs::read_to_string(&abs).unwrap_or_default())
        } else {
            String::new()
        };
        let content_hash = if matches!(kind, FK::Markdown | FK::Canvas) {
            Some(hash_str(&content))
        } else {
            None
        };

        let tx = self.conn.unchecked_transaction()?;
        // CASCADE clears dependents
        tx.execute("DELETE FROM files WHERE path = ?1", params![rel])?;
        // FTS row
        tx.execute("DELETE FROM files_fts WHERE path = ?1", params![rel])?;

        // Search text only. File/page identity is always the vault-relative
        // path; filename stem is indexed here solely for discoverability.
        let search_title = if kind == FK::Markdown {
            stem.clone()
        } else {
            name.clone()
        };

        tx.execute(
            "INSERT INTO files(
                path, parent_path, name, stem, extension, file_kind,
                mtime_ms, size_bytes, content_hash, parse_version, frontmatter_raw, indexed_at_ms
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                rel,
                parent,
                name,
                stem,
                extension,
                kind.as_str(),
                mtime_ms,
                size_bytes,
                content_hash,
                PROJECT_VERSION.major as i64,
                Option::<String>::None,
                indexed_at,
            ],
        )?;

        if kind == FK::Markdown {
            let facts = parse_markdown(&content);
            if let Some(ref fm) = facts.frontmatter_raw {
                tx.execute(
                    "UPDATE files SET frontmatter_raw = ?1 WHERE path = ?2",
                    params![fm, rel],
                )?;
            }
            if let Some(ref json) = facts.frontmatter_json {
                tx.execute(
                    "INSERT INTO file_frontmatter(path, json) VALUES (?1, ?2)",
                    params![rel, json],
                )?;
            }
            // Dedupe prop_path (YAML parser may emit the same path twice).
            let mut seen_props = HashSet::new();
            for p in &facts.properties {
                if !seen_props.insert(p.prop_path.as_str()) {
                    continue;
                }
                tx.execute(
                    "INSERT OR REPLACE INTO properties(
                        path, prop_path, prop_key, value_type, value_text, value_num, value_bool, value_json, is_leaf
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        rel,
                        p.prop_path,
                        p.prop_key,
                        p.value_type,
                        p.value_text,
                        p.value_num,
                        p.value_bool.map(|b| if b { 1 } else { 0 }),
                        p.value_json,
                        if p.is_leaf { 1 } else { 0 },
                    ],
                )?;
            }
            for h in &facts.headings {
                tx.execute(
                    "INSERT INTO headings(
                        path, heading_id, level, text, slug, start_offset, end_offset, start_line
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        rel,
                        h.heading_id,
                        h.level,
                        h.text,
                        h.slug,
                        h.start_offset,
                        h.end_offset,
                        h.start_line,
                    ],
                )?;
            }
            for l in &facts.links {
                tx.execute(
                    "INSERT INTO links(
                        path, link_id, target_raw, target_path, target_heading, target_block,
                        display_text, link_kind, is_embed, start_offset, end_offset
                    ) VALUES (?1,?2,?3,NULL,?4,?5,?6,?7,?8,?9,?10)",
                    params![
                        rel,
                        l.link_id,
                        l.target_raw,
                        l.target_heading,
                        l.target_block,
                        l.display_text,
                        l.link_kind,
                        if l.is_embed { 1 } else { 0 },
                        l.start_offset,
                        l.end_offset,
                    ],
                )?;
            }
            for t in &facts.tags {
                tx.execute(
                    "INSERT OR IGNORE INTO tags(path, tag, tag_head, source, start_offset, line)
                     VALUES (?1,?2,?3,?4,?5,?6)",
                    params![
                        rel,
                        t.tag,
                        t.tag_head,
                        t.source,
                        t.start_offset.unwrap_or(-1),
                        t.line.unwrap_or(0),
                    ],
                )?;
            }
            for t in &facts.tasks {
                tx.execute(
                    "INSERT INTO tasks(
                        path, task_id, status, status_char, text, raw_line, line,
                        start_offset, end_offset, completed, list_indent, is_recurring,
                        due, scheduled, start_date, done_date, created_date, priority,
                        recurrence, tags_json
                    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
                    params![
                        rel,
                        t.task_id,
                        t.status,
                        t.status_char,
                        t.text,
                        t.raw_line,
                        t.line,
                        t.start_offset,
                        t.end_offset,
                        if t.completed { 1 } else { 0 },
                        t.list_indent,
                        if t.recurrence.is_some() { 1 } else { 0 },
                        t.due,
                        t.scheduled,
                        t.start_date,
                        t.done_date,
                        t.created_date,
                        t.priority,
                        t.recurrence,
                        t.tags_json,
                    ],
                )?;
            }

            let tag_str: String = facts
                .tags
                .iter()
                .map(|t| t.tag.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            tx.execute(
                "INSERT INTO files_fts(path, title, headings, body, tags) VALUES (?1,?2,?3,?4,?5)",
                params![
                    rel,
                    search_title,
                    facts.heading_texts_for_fts,
                    facts.body_for_fts,
                    tag_str
                ],
            )?;
        } else if kind == FK::Canvas {
            let value: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
            let mut canvas_text = Vec::new();
            for node in value.get("nodes").and_then(|nodes| nodes.as_array()).into_iter().flatten() {
                let node_id = node.get("id").and_then(|item| item.as_str()).unwrap_or_default();
                if node_id.is_empty() {
                    continue;
                }
                let node_type = node.get("type").and_then(|item| item.as_str()).unwrap_or("text");
                let file_path = node.get("file").and_then(|item| item.as_str());
                let text = node.get("text").or_else(|| node.get("label")).or_else(|| node.get("url"))
                    .and_then(|item| item.as_str());
                if let Some(value) = text { canvas_text.push(value); }
                if let Some(value) = file_path { canvas_text.push(value); }
                tx.execute(
                    "INSERT INTO canvas_nodes(path, node_id, node_type, file_path, text, x, y, width, height)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        rel, node_id, node_type, file_path, text,
                        node.get("x").and_then(|item| item.as_f64()),
                        node.get("y").and_then(|item| item.as_f64()),
                        node.get("width").and_then(|item| item.as_f64()),
                        node.get("height").and_then(|item| item.as_f64()),
                    ],
                )?;
            }
            for edge in value.get("edges").and_then(|edges| edges.as_array()).into_iter().flatten() {
                let edge_id = edge.get("id").and_then(|item| item.as_str()).unwrap_or_default();
                let from_node = edge.get("fromNode").and_then(|item| item.as_str()).unwrap_or_default();
                let to_node = edge.get("toNode").and_then(|item| item.as_str()).unwrap_or_default();
                if edge_id.is_empty() || from_node.is_empty() || to_node.is_empty() {
                    continue;
                }
                let label = edge.get("label").and_then(|item| item.as_str());
                if let Some(value) = label { canvas_text.push(value); }
                tx.execute(
                    "INSERT INTO canvas_edges(path, edge_id, from_node, to_node, label)
                     VALUES (?1,?2,?3,?4,?5)",
                    params![rel, edge_id, from_node, to_node, label],
                )?;
            }
            tx.execute(
                "INSERT INTO files_fts(path, title, headings, body, tags) VALUES (?1,?2,'',?3, '')",
                params![rel, search_title, canvas_text.join(" ")],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    pub fn remove_path(&mut self, rel: &str) -> Result<()> {
        let rel = normalize_rel(rel)?;
        self.conn
            .execute("DELETE FROM files_fts WHERE path = ?1", params![rel])?;
        self.conn
            .execute("DELETE FROM files WHERE path = ?1", params![rel])?;
        Ok(())
    }

    fn list_vault_files(&self) -> Result<Vec<(String, i64, i64)>> {
        Self::list_vault_files_at(&self.vault_root)
    }

    fn list_vault_files_at(vault_root: &Path) -> Result<Vec<(String, i64, i64)>> {
        let mut out = Vec::new();
        // Canonicalize once; do not canonicalize every file in a large vault.
        let root = vault_root
            .canonicalize()
            .unwrap_or_else(|_| vault_root.to_path_buf());
        for entry in WalkDir::new(&root).into_iter().filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if matches!(
                name.as_ref(),
                ".nephrite"
                    | ".git"
                    | "node_modules"
                    | ".trash"
                    | ".stfolder"
                    | ".stversions"
                    | ".obsidian"
            ) {
                return false;
            }
            true
        }) {
            let entry = entry.map_err(|e| {
                IndexError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))
            })?;
            if !entry.file_type().is_file() {
                continue;
            }
            let abs = entry.path();
            let rel = match rel_from_abs_cached(&root, abs) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if should_skip_rel(&rel) {
                continue;
            }
            let meta = entry.metadata().map_err(|e| {
                IndexError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    e.to_string(),
                ))
            })?;
            let mtime_ms = mtime_to_ms(meta.modified().ok());
            let size = meta.len() as i64;
            out.push((rel, mtime_ms, size));
        }
        Ok(out)
    }

    /// Resolve `links.target_path` by stem / path / alias match.
    pub fn resolve_all_links(&self) -> Result<()> {
        // Build stem → paths map
        let mut by_stem: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT path, stem FROM files WHERE file_kind = 'markdown'")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (path, stem) = row?;
                by_stem.entry(stem).or_default().push(path.clone());
                if let Some(no_ext) = path.strip_suffix(".md") {
                    by_stem.entry(no_ext.to_string()).or_default().push(path);
                }
            }
        }

        let mut stmt = self
            .conn
            .prepare("SELECT path, link_id, target_raw FROM links")?;
        let rows: Vec<(String, i64, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, String>(2)?)))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        let tx = self.conn.unchecked_transaction()?;
        {
            let mut upd =
                tx.prepare("UPDATE links SET target_path = ?1 WHERE path = ?2 AND link_id = ?3")?;
            for (src, link_id, target_raw) in rows {
                let key = target_raw.trim().trim_end_matches(".md").replace('\\', "/");
                let resolved = resolve_target(&key, &src, &by_stem);
                upd.execute(params![resolved, src, link_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Count rows helper for tests / CLI.
    pub fn count(&self, table: &str) -> Result<i64> {
        // only allow known tables
        let allowed = ["files", "links", "tasks", "tags", "headings", "properties"];
        if !allowed.contains(&table) {
            return Ok(0);
        }
        let n: i64 = self
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        Ok(n)
    }
}

fn resolve_target(
    key: &str,
    from_path: &str,
    by_stem: &std::collections::HashMap<String, Vec<String>>,
) -> Option<String> {
    if key.is_empty() {
        return None;
    }
    // exact path
    if let Some(paths) = by_stem.get(key) {
        if paths.len() == 1 {
            return Some(paths[0].clone());
        }
        // prefer same folder
        let parent = parent_of(from_path);
        if let Some(p) = paths.iter().find(|p| parent_of(p) == parent) {
            return Some(p.clone());
        }
        return Some(paths[0].clone());
    }
    // basename
    let base = key.rsplit('/').next().unwrap_or(key);
    if let Some(paths) = by_stem.get(base) {
        if paths.len() == 1 {
            return Some(paths[0].clone());
        }
        let parent = parent_of(from_path);
        if let Some(p) = paths.iter().find(|p| parent_of(p) == parent) {
            return Some(p.clone());
        }
        return paths.first().cloned();
    }
    None
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_to_ms(t: Option<SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hash_str(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn open_reconcile_indexes_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        fs::write(
            vault.join("Note.md"),
            r#"---
status: active
title: YAML Title
---

# Title

Link to [[Other]]

- [ ] Task one #tag
"#,
        )
        .unwrap();
        fs::write(vault.join("Other.md"), "# Other\n").unwrap();

        let (idx, stats) = VaultIndex::open(vault).unwrap();
        assert!(stats.updated >= 2 || stats.full_rebuild);
        assert!(idx.count("files").unwrap() >= 2);
        assert!(idx.count("tasks").unwrap() >= 1);
        assert!(idx.count("links").unwrap() >= 1);
        assert!(idx.count("headings").unwrap() >= 1);

        let (title, properties, tags, links): (String, String, String, String) = idx
            .connection()
            .query_row(
                "SELECT title, properties, tags, links FROM pages WHERE path = 'Note.md'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "YAML Title");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&properties).unwrap()["status"],
            "active"
        );
        assert!(serde_json::from_str::<Vec<String>>(&tags)
            .unwrap()
            .iter()
            .any(|tag| tag == "tag"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&links).unwrap()[0]["target"],
            "Other"
        );

        // second open: unchanged
        let (_idx2, stats2) = VaultIndex::open(vault).unwrap();
        assert!(!stats2.full_rebuild);
        assert_eq!(stats2.updated, 0);
        assert!(stats2.unchanged >= 2);
    }

    #[test]
    fn minor_meta_update_does_not_force_logic_error() {
        // Documented contract: same major ⇒ requires_rebuild is false.
        assert!(!PROJECT_VERSION.requires_rebuild(Version::new(PROJECT_VERSION.major, 0)));
        assert!(PROJECT_VERSION.requires_rebuild(Version::new(PROJECT_VERSION.major + 1, 0)));
    }

    #[test]
    fn external_change_detected_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        let path = vault.join("A.md");
        fs::write(&path, "- [ ] old\n").unwrap();
        let (mut idx, _) = VaultIndex::open(vault).unwrap();
        assert_eq!(idx.count("tasks").unwrap(), 1);
        assert!(!idx.filesystem_changed().unwrap());

        // simulate Sync/Unison while closed
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut f = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        f.write_all(b"- [ ] one\n- [x] two\n").unwrap();
        drop(f);

        assert!(idx.filesystem_changed().unwrap());
        let stats = idx.reconcile().unwrap();
        assert_eq!(stats.updated, 1);
        assert!(!idx.filesystem_changed().unwrap());
        assert_eq!(idx.count("tasks").unwrap(), 2);
    }

    #[test]
    fn save_indexing_reuses_editor_content_without_rereading_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        fs::write(vault.join("A.md"), "- [ ] disk copy\n").unwrap();
        let (mut idx, _) = VaultIndex::open(vault).unwrap();

        idx.index_path_with_content("A.md", Some("- [ ] one\n- [x] two\n"))
            .unwrap();

        assert_eq!(idx.count("tasks").unwrap(), 2);
        assert_eq!(
            fs::read_to_string(vault.join("A.md")).unwrap(),
            "- [ ] disk copy\n"
        );
    }

    #[test]
    fn indexes_canvas_nodes_edges_and_searchable_text() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        fs::write(
            vault.join("Planning.canvas"),
            r#"{"nodes":[{"id":"one","type":"text","text":"Release checklist","x":10,"y":20,"width":220,"height":90},{"id":"two","type":"file","file":"Roadmap.md","x":300,"y":20,"width":220,"height":90}],"edges":[{"id":"edge","fromNode":"one","toNode":"two","label":"feeds"}]}"#,
        )
        .unwrap();
        let (index, _) = VaultIndex::open(vault).unwrap();
        let nodes: i64 = index.connection().query_row(
            "SELECT COUNT(*) FROM canvas_nodes WHERE path = 'Planning.canvas'",
            [],
            |row| row.get(0),
        ).unwrap();
        let edges: i64 = index.connection().query_row(
            "SELECT COUNT(*) FROM canvas_edges WHERE path = 'Planning.canvas'",
            [],
            |row| row.get(0),
        ).unwrap();
        let matches: i64 = index.connection().query_row(
            "SELECT COUNT(*) FROM files_fts WHERE files_fts MATCH 'checklist'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(nodes, 2);
        assert_eq!(edges, 1);
        assert_eq!(matches, 1);
    }

    #[test]
    fn legacy_20_label_migrates_without_rebuilding_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        fs::write(vault.join("Note.md"), "# Keep me\n").unwrap();
        fs::write(
            vault.join("Planning.canvas"),
            r#"{"nodes":[{"id":"one","type":"text","text":"Backfill me","x":0,"y":0,"width":100,"height":50}],"edges":[]}"#,
        )
        .unwrap();

        let (index, _) = VaultIndex::open(vault).unwrap();
        index
            .connection()
            .execute(
                "UPDATE schema_meta SET value = '2.0' WHERE key = 'project_version'",
                [],
            )
            .unwrap();
        index
            .connection()
            .execute("DELETE FROM canvas_nodes", [])
            .unwrap();
        index
            .connection()
            .execute("DELETE FROM files_fts WHERE path = 'Planning.canvas'", [])
            .unwrap();
        drop(index);

        let (migrated, stats) = VaultIndex::open(vault).unwrap();
        assert!(!stats.full_rebuild);
        assert_eq!(stats.updated, 1);
        assert_eq!(stats.unchanged, 1);
        assert_eq!(migrated.get_meta("project_version").unwrap().as_deref(), Some("0.2"));
        assert_eq!(migrated.count("canvas_nodes").unwrap(), 1);
    }
}
