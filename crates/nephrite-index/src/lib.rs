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
mod migration;
mod parse;
mod pathutil;
mod resolve;
mod version;

pub use error::{IndexError, Result};
pub use file_kind::FileKind;
use migration::has_migration_state_table;
pub use migration::{
    format_count, format_open_action, pending_migrations, plan_open, remaining_for, Migration,
    OpenPlan, PlannedMigration, MIGRATIONS, MIGRATION_DATAVIEW_INLINE_FIELDS,
    MIGRATION_LEGACY_02_CANVAS,
};
pub use parse::MarkdownFacts;
pub use resolve::{wikilink_key, IndexedFile, LinkResolver};
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
        let rows = statement.query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?;
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

        // Feature backfills that still need to run, in registry order.
        let pending = pending_migrations(&self.conn)?;
        let has_state = has_migration_state_table(&self.conn)?;
        // Per-migration set of paths already backfilled (resumable checkpoints).
        let mut migration_done: HashMap<&'static str, HashSet<String>> = HashMap::new();
        if has_state {
            for migration in &pending {
                let mut done = HashSet::new();
                let mut stmt = self
                    .conn
                    .prepare("SELECT path FROM migration_state WHERE migration_id = ?1")?;
                let rows = stmt.query_map(params![migration.id], |row| row.get::<_, String>(0))?;
                for row in rows {
                    done.insert(row?);
                }
                migration_done.insert(migration.id, done);
            }
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
        // Re-index in batches so a backfill over a large vault commits in a
        // single transaction per chunk instead of one per file.
        let mut batch: Vec<String> = Vec::new();
        for (rel, mtime_ms, size_bytes) in &disk {
            stats.scanned += 1;
            disk_paths.insert(rel.clone());
            // Any pending migration needs this file re-parsed and it hasn't
            // been checkpointed yet?
            let backfill_needed = pending.iter().any(|migration| {
                (migration.targets)(Path::new(rel))
                    && !migration_done
                        .get(migration.id)
                        .is_some_and(|done| done.contains(rel))
            });
            let reindex = match index_meta.get(rel) {
                Some((im, is)) if *im == *mtime_ms && *is == *size_bytes => backfill_needed,
                _ => true,
            };
            if reindex {
                batch.push(rel.clone());
                stats.updated += 1;
            } else {
                stats.unchanged += 1;
            }
            if batch.len() >= 500 {
                self.reindex_and_checkpoint(&batch, &pending, &mut migration_done, has_state)?;
                batch.clear();
            }
            if stats.scanned.is_multiple_of(50) || stats.scanned == total {
                progress(
                    ProgressPhase::Index,
                    stats.scanned,
                    total,
                    Some(rel.as_str()),
                );
            }
        }
        if !batch.is_empty() {
            self.reindex_and_checkpoint(&batch, &pending, &mut migration_done, has_state)?;
            batch.clear();
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

        // Complete migrations whose targeted files are all checkpointed.
        for migration in &pending {
            let all_done = disk.iter().all(|(rel, _, _)| {
                !(migration.targets)(Path::new(rel))
                    || migration_done
                        .get(migration.id)
                        .is_some_and(|done| done.contains(rel))
            });
            if all_done {
                (migration.complete)(&self.conn)?;
                if has_state {
                    self.conn.execute(
                        "DELETE FROM migration_state WHERE migration_id = ?1",
                        params![migration.id],
                    )?;
                }
            }
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
            DELETE FROM attachment_metadata;
            DELETE FROM properties;
            DELETE FROM tasks;
            DELETE FROM tags;
            DELETE FROM links;
            DELETE FROM blocks;
            DELETE FROM headings;
            DELETE FROM aliases;
            DELETE FROM files;
            DELETE FROM files_fts;
            DELETE FROM migration_state;
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
        let mut batch: Vec<String> = Vec::new();
        for (i, (rel, _, _)) in disk.iter().enumerate() {
            batch.push(rel.clone());
            stats.updated += 1;
            let done = i + 1;
            if batch.len() >= 500 || done == total {
                self.reindex_batch(&batch)?;
                batch.clear();
            }
            if done.is_multiple_of(25) || done == total {
                progress(ProgressPhase::Index, done, total, Some(rel.as_str()));
            }
        }
        progress(ProgressPhase::Resolve, 0, 1, Some("resolving links"));
        self.resolve_all_links()?;
        progress(ProgressPhase::Resolve, 1, 1, None);
        self.write_project_version_meta()?;
        // A full rebuild re-parses every file, so every named migration is done.
        for migration in MIGRATIONS {
            (migration.complete)(&self.conn)?;
        }
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
        let prepared = prepare_file(&self.vault_root, &rel, markdown_content)?;
        let tx = self.conn.unchecked_transaction()?;
        write_file_index(&tx, &prepared)?;
        tx.commit()?;
        Ok(())
    }

    /// Re-index many vault-relative paths inside one transaction. Used by
    /// reconcile so a migration backfill over a large vault commits in
    /// batches instead of once per file.
    fn reindex_batch(&mut self, rels: &[String]) -> Result<()> {
        let mut empty = HashMap::new();
        self.reindex_and_checkpoint(rels, &[], &mut empty, false)
    }

    /// Re-index a batch and record resumable backfill checkpoints in the same
    /// committed transaction. An interruption then resumes after the last
    /// finished chunk instead of restarting the whole job or losing a
    /// completed parse.
    fn reindex_and_checkpoint(
        &mut self,
        rels: &[String],
        pending: &[&'static Migration],
        done: &mut HashMap<&'static str, HashSet<String>>,
        has_state: bool,
    ) -> Result<()> {
        let mut prepared: Vec<PreparedFile> = Vec::with_capacity(rels.len());
        for rel in rels {
            let rel = normalize_rel(rel)?;
            if should_skip_rel(&rel) {
                continue;
            }
            match prepare_file(&self.vault_root, &rel, None) {
                Ok(file) => prepared.push(file),
                Err(_) => continue, // file vanished between scan and write
            }
        }
        if prepared.is_empty() && (!has_state || pending.is_empty()) {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for file in &prepared {
            write_file_index(&tx, file)?;
        }
        if has_state && !pending.is_empty() {
            for rel in rels {
                for migration in pending {
                    if (migration.targets)(Path::new(rel)) {
                        tx.execute(
                            "INSERT OR IGNORE INTO migration_state(migration_id, path) VALUES (?1, ?2)",
                            params![migration.id, rel],
                        )?;
                        done.entry(migration.id).or_default().insert(rel.clone());
                    }
                }
            }
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
            let entry = entry.map_err(|e| IndexError::Io(std::io::Error::other(e.to_string())))?;
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
            let meta = entry
                .metadata()
                .map_err(|e| IndexError::Io(std::io::Error::other(e.to_string())))?;
            let mtime_ms = mtime_to_ms(meta.modified().ok());
            let size = meta.len() as i64;
            out.push((rel, mtime_ms, size));
        }
        Ok(out)
    }

    /// Resolve `links.target_path` with Obsidian's vault-global search path.
    pub fn resolve_all_links(&self) -> Result<()> {
        let resolver = self.link_resolver()?;

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
                let resolved = resolver.resolve(&target_raw, Some(&src));
                upd.execute(params![resolved, src, link_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Build the Obsidian-order link resolver from the current index.
    pub fn link_resolver(&self) -> Result<LinkResolver> {
        let mut files_stmt = self.conn.prepare("SELECT path, name, stem FROM files")?;
        let files = files_stmt
            .query_map([], |r| {
                Ok(IndexedFile::new(
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(files_stmt);

        let mut alias_stmt = self.conn.prepare("SELECT alias, path FROM aliases")?;
        let aliases = alias_stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(LinkResolver::new(files, aliases))
    }

    /// Count rows helper for tests / CLI.
    pub fn count(&self, table: &str) -> Result<i64> {
        // only allow known tables
        let allowed = [
            "files",
            "attachment_metadata",
            "aliases",
            "headings",
            "blocks",
            "links",
            "tags",
            "tasks",
            "properties",
            "file_frontmatter",
            "inline_fields",
            "footnotes",
            "canvas_nodes",
            "canvas_edges",
            "kanban_boards",
            "kanban_columns",
            "kanban_cards",
        ];
        if !allowed.contains(&table) {
            return Ok(0);
        }
        let n: i64 = self
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        Ok(n)
    }
}

/// Everything `write_file_index` needs: filesystem metadata plus the parsed
/// content bytes, prepared before a transaction is opened.
struct PreparedFile {
    rel: String,
    abs: PathBuf,
    mtime_ms: i64,
    size_bytes: i64,
    name: String,
    stem: String,
    extension: String,
    kind: FK,
    parent: String,
    indexed_at: i64,
    text_attachment: bool,
    content_hash: Option<String>,
    content: String,
    search_title: String,
}

/// Read filesystem metadata and content for a single path. Callers that can
/// provide the Markdown bytes (saves) pass them to avoid a redundant disk read.
fn prepare_file(
    vault_root: &Path,
    rel: &str,
    markdown_content: Option<&str>,
) -> Result<PreparedFile> {
    let abs = abs_from_rel(vault_root, rel)?;
    let meta = fs::metadata(&abs)?;
    let mtime_ms = mtime_to_ms(meta.modified().ok());
    let size_bytes = meta.len() as i64;
    let name = name_of(rel).to_string();
    let (stem, extension) = stem_ext(&name);
    let kind = FK::from_extension(&extension);
    let parent = parent_of(rel);
    let indexed_at = now_ms();

    let text_attachment = is_text_attachment(&extension) && size_bytes <= 8 * 1024 * 1024;
    let content = if matches!(kind, FK::Markdown | FK::Canvas) || text_attachment {
        markdown_content
            .map(str::to_owned)
            .unwrap_or_else(|| fs::read_to_string(&abs).unwrap_or_default())
    } else {
        String::new()
    };
    let content_hash = if matches!(kind, FK::Markdown | FK::Canvas) || text_attachment {
        Some(hash_str(&content))
    } else {
        None
    };

    let search_title = if kind == FK::Markdown {
        stem.clone()
    } else {
        name.clone()
    };

    Ok(PreparedFile {
        rel: rel.to_string(),
        abs,
        mtime_ms,
        size_bytes,
        name,
        stem,
        extension,
        kind,
        parent,
        indexed_at,
        text_attachment,
        content_hash,
        content,
        search_title,
    })
}

/// Write a fully-prepared file into the index inside the caller's transaction.
fn write_file_index(tx: &rusqlite::Transaction, file: &PreparedFile) -> Result<()> {
    let rel = &file.rel;
    // CASCADE clears dependents
    tx.execute("DELETE FROM files WHERE path = ?1", params![rel])?;
    // FTS row
    tx.execute("DELETE FROM files_fts WHERE path = ?1", params![rel])?;

    tx.execute(
        "INSERT INTO files(
            path, parent_path, name, stem, extension, file_kind,
            mtime_ms, size_bytes, content_hash, parse_version, frontmatter_raw, indexed_at_ms
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            rel,
            file.parent,
            file.name,
            file.stem,
            file.extension,
            file.kind.as_str(),
            file.mtime_ms,
            file.size_bytes,
            file.content_hash,
            PROJECT_VERSION.major as i64,
            Option::<String>::None,
            file.indexed_at,
        ],
    )?;

    if !matches!(file.kind, FK::Markdown | FK::Canvas | FK::Excalidraw) {
        let (mime_type, width, height) = attachment_metadata(&file.abs, &file.extension);
        tx.execute(
            "INSERT INTO attachment_metadata(path, mime_type, width, height, text_indexed)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                rel,
                mime_type,
                width,
                height,
                if file.text_attachment { 1 } else { 0 }
            ],
        )?;
    }

    if file.kind == FK::Markdown {
        let facts = parse_markdown(&file.content);
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
        for field in &facts.inline_fields {
            tx.execute(
                "INSERT INTO inline_fields(
                    path, field_id, key, value_text, value_type, value_json, line, start_offset
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    rel,
                    field.field_id,
                    field.key,
                    field.value_text,
                    field.value_type,
                    field.value_json,
                    field.line,
                    field.start_offset,
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
                file.search_title,
                facts.heading_texts_for_fts,
                facts.body_for_fts,
                tag_str
            ],
        )?;
    } else if file.kind == FK::Canvas {
        let value: serde_json::Value = serde_json::from_str(&file.content).unwrap_or_default();
        let mut canvas_text = Vec::new();
        let mut canvas_link_id = 0i64;
        for node in value
            .get("nodes")
            .and_then(|nodes| nodes.as_array())
            .into_iter()
            .flatten()
        {
            let node_id = node
                .get("id")
                .and_then(|item| item.as_str())
                .unwrap_or_default();
            if node_id.is_empty() {
                continue;
            }
            let node_type = node
                .get("type")
                .and_then(|item| item.as_str())
                .unwrap_or("text");
            let file_path = node.get("file").and_then(|item| item.as_str());
            let text = node
                .get("text")
                .or_else(|| node.get("label"))
                .or_else(|| node.get("url"))
                .and_then(|item| item.as_str());
            if let Some(value) = text {
                canvas_text.push(value);
            }
            if let Some(value) = file_path {
                canvas_text.push(value);
                canvas_link_id += 1;
                tx.execute(
                    "INSERT INTO links(
                        path, link_id, target_raw, target_path, target_heading, target_block,
                        display_text, link_kind, is_embed, start_offset, end_offset
                    ) VALUES (?1,?2,?3,NULL,NULL,NULL,?4,'canvas',1,0,0)",
                    params![rel, canvas_link_id, value, node_id],
                )?;
            }
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
        for edge in value
            .get("edges")
            .and_then(|edges| edges.as_array())
            .into_iter()
            .flatten()
        {
            let edge_id = edge
                .get("id")
                .and_then(|item| item.as_str())
                .unwrap_or_default();
            let from_node = edge
                .get("fromNode")
                .and_then(|item| item.as_str())
                .unwrap_or_default();
            let to_node = edge
                .get("toNode")
                .and_then(|item| item.as_str())
                .unwrap_or_default();
            if edge_id.is_empty() || from_node.is_empty() || to_node.is_empty() {
                continue;
            }
            let label = edge.get("label").and_then(|item| item.as_str());
            if let Some(value) = label {
                canvas_text.push(value);
            }
            tx.execute(
                "INSERT INTO canvas_edges(path, edge_id, from_node, to_node, label)
                 VALUES (?1,?2,?3,?4,?5)",
                params![rel, edge_id, from_node, to_node, label],
            )?;
        }
        tx.execute(
            "INSERT INTO files_fts(path, title, headings, body, tags) VALUES (?1,?2,'',?3, '')",
            params![rel, file.search_title, canvas_text.join(" ")],
        )?;
    } else if !matches!(file.kind, FK::Excalidraw) {
        tx.execute(
            "INSERT INTO files_fts(path, title, headings, body, tags) VALUES (?1,?2,'',?3,'')",
            params![rel, file.search_title, file.content],
        )?;
    }

    Ok(())
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

fn is_text_attachment(extension: &str) -> bool {
    matches!(
        extension,
        "txt"
            | "text"
            | "csv"
            | "tsv"
            | "json"
            | "jsonl"
            | "xml"
            | "html"
            | "htm"
            | "css"
            | "js"
            | "ts"
            | "toml"
            | "ini"
            | "conf"
            | "log"
            | "sql"
            | "sh"
            | "py"
            | "rs"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
    )
}

fn attachment_metadata(path: &Path, extension: &str) -> (String, Option<i64>, Option<i64>) {
    let mime = mime_for_extension(extension).to_string();
    let dimensions = if mime.starts_with("image/") {
        fs::read(path)
            .ok()
            .and_then(|bytes| image_dimensions(&bytes, extension))
    } else {
        None
    };
    (
        mime,
        dimensions.map(|value| value.0),
        dimensions.map(|value| value.1),
    )
}

fn mime_for_extension(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" | "text" | "log" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" | "jsonl" => "application/json",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "text/javascript",
        "ts" => "text/typescript",
        "sql" => "application/sql",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn image_dimensions(bytes: &[u8], extension: &str) -> Option<(i64, i64)> {
    let pair = match extension {
        "png" if bytes.len() >= 24 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" => Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?),
            u32::from_be_bytes(bytes[20..24].try_into().ok()?),
        )),
        "gif" if bytes.len() >= 10 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") => {
            Some((
                u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32,
                u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32,
            ))
        }
        "bmp" if bytes.len() >= 26 && &bytes[..2] == b"BM" => Some((
            u32::from_le_bytes(bytes[18..22].try_into().ok()?),
            u32::from_le_bytes(bytes[22..26].try_into().ok()?),
        )),
        "webp"
            if bytes.len() >= 30
                && &bytes[..4] == b"RIFF"
                && &bytes[8..12] == b"WEBP"
                && &bytes[12..16] == b"VP8X" =>
        {
            let width = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
            let height = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
            Some((width, height))
        }
        "jpg" | "jpeg" => jpeg_dimensions(bytes),
        _ => None,
    }?;
    (pair.0 > 0 && pair.1 > 0).then_some((pair.0 as i64, pair.1 as i64))
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[..2] != [0xff, 0xd8] {
        return None;
    }
    let mut offset = 2usize;
    while offset + 4 <= bytes.len() {
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;
        if matches!(marker, 0xd8 | 0xd9) {
            continue;
        }
        let length = u16::from_be_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?) as usize;
        if length < 2 || offset + length > bytes.len() {
            return None;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) && length >= 7
        {
            let height = u16::from_be_bytes(bytes[offset + 3..offset + 5].try_into().ok()?) as u32;
            let width = u16::from_be_bytes(bytes[offset + 5..offset + 7].try_into().ok()?) as u32;
            return Some((width, height));
        }
        offset += length;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_basic_raster_dimensions_without_decoding_pixels() {
        let mut png = vec![0u8; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&640u32.to_be_bytes());
        png[20..24].copy_from_slice(&480u32.to_be_bytes());
        assert_eq!(image_dimensions(&png, "png"), Some((640, 480)));

        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&320u16.to_le_bytes());
        gif.extend_from_slice(&200u16.to_le_bytes());
        assert_eq!(image_dimensions(&gif, "gif"), Some((320, 200)));
    }

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

Rating:: 5

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
        assert_eq!(idx.count("inline_fields").unwrap(), 1);
        let (inline_key, inline_type, inline_json): (String, String, String) = idx
            .connection()
            .query_row(
                "SELECT key, value_type, value_json FROM inline_fields WHERE path = 'Note.md'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (
                inline_key.as_str(),
                inline_type.as_str(),
                inline_json.as_str()
            ),
            ("Rating", "number", "5")
        );

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
    fn resolve_all_links_uses_obsidian_vault_global_order() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        fs::create_dir_all(vault.join("Folder")).unwrap();
        fs::write(vault.join("A.md"), "root A\n").unwrap();
        fs::write(vault.join("Folder/A.md"), "folder A\n").unwrap();
        fs::write(
            vault.join("Folder/B.md"),
            "[[A]]\n[[./A]]\n[[/A]]\n[[Missing]]\n",
        )
        .unwrap();

        let (idx, _) = VaultIndex::open(vault).unwrap();
        let targets: Vec<(String, Option<String>)> = idx
            .connection()
            .prepare("SELECT target_raw, target_path FROM links WHERE path = 'Folder/B.md' ORDER BY link_id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();

        assert_eq!(
            targets,
            vec![
                ("A".into(), Some("A.md".into())),
                ("./A".into(), Some("Folder/A.md".into())),
                ("/A".into(), Some("A.md".into())),
                ("Missing".into(), None),
            ]
        );
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
    fn migration_backfill_is_resumable_and_completes() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        fs::write(vault.join("A.md"), "a:: 1\n").unwrap();
        fs::write(vault.join("B.md"), "b:: 2\n").unwrap();

        // First open runs the dataview-inline-fields backfill and completes it.
        let (idx, stats) = VaultIndex::open(vault).unwrap();
        assert!(stats.full_rebuild || stats.updated >= 2);
        assert_eq!(idx.count("inline_fields").unwrap(), 2);
        assert!(pending_migrations(idx.connection()).unwrap().is_empty());
        let remaining = remaining_for(
            idx.connection(),
            MIGRATIONS
                .iter()
                .find(|m| m.id == MIGRATION_DATAVIEW_INLINE_FIELDS)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(remaining, 0);

        // Simulate an interrupted run: mark the migration pending again and
        // checkpoint only one file, as a crashed previous open would have left.
        idx.connection()
            .execute(
                "UPDATE schema_meta SET value = '0' WHERE key = 'dataview_inline_fields_version'",
                [],
            )
            .unwrap();
        let state_exists: i64 = idx
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='migration_state'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state_exists, 1);
        idx.connection()
            .execute(
                "INSERT OR IGNORE INTO migration_state(migration_id, path) VALUES (?1, ?2)",
                params![MIGRATION_DATAVIEW_INLINE_FIELDS, "A.md"],
            )
            .unwrap();

        // Reopening should only re-run the backfill for B.md (resumable), then
        // clear the checkpoint table and re-mark the migration complete.
        let (idx2, stats2) = VaultIndex::open(vault).unwrap();
        assert!(!stats2.full_rebuild);
        assert_eq!(stats2.updated, 1);
        let state_count: i64 = idx2
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM migration_state WHERE migration_id = ?1",
                params![MIGRATION_DATAVIEW_INLINE_FIELDS],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state_count, 0);
        assert!(pending_migrations(idx2.connection()).unwrap().is_empty());
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
        fs::write(vault.join("Roadmap.md"), "# Roadmap\n").unwrap();
        fs::write(
            vault.join("Planning.canvas"),
            r#"{"nodes":[{"id":"one","type":"text","text":"Release checklist","x":10,"y":20,"width":220,"height":90},{"id":"two","type":"file","file":"Roadmap.md","x":300,"y":20,"width":220,"height":90}],"edges":[{"id":"edge","fromNode":"one","toNode":"two","label":"feeds"}]}"#,
        )
        .unwrap();
        let (index, _) = VaultIndex::open(vault).unwrap();
        let nodes: i64 = index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM canvas_nodes WHERE path = 'Planning.canvas'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let edges: i64 = index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM canvas_edges WHERE path = 'Planning.canvas'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let matches: i64 = index
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM files_fts WHERE files_fts MATCH 'checklist'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(nodes, 2);
        assert_eq!(edges, 1);
        assert_eq!(matches, 1);
        let card_link: (String, Option<String>) = index
            .connection()
            .query_row(
                "SELECT target_raw, target_path FROM links WHERE path = 'Planning.canvas'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(card_link.0, "Roadmap.md");
        assert_eq!(card_link.1.as_deref(), Some("Roadmap.md"));
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
        let current_version = PROJECT_VERSION.to_string();
        assert_eq!(
            migrated.get_meta("project_version").unwrap().as_deref(),
            Some(current_version.as_str())
        );
        assert_eq!(migrated.count("canvas_nodes").unwrap(), 1);
    }
}
