mod state;
mod postgres_compat;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use nephrite_index::{ProgressPhase, VaultIndex, PROJECT_VERSION};
use parking_lot::Mutex;
use serde::Serialize;
use state::AppState;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VaultInfo {
    pub root: String,
    pub project_version: String,
    pub scanned: usize,
    pub unchanged: usize,
    pub updated: usize,
    pub removed: usize,
    pub full_rebuild: bool,
    pub file_count: i64,
    pub task_count: i64,
    pub link_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VaultOpenPlan {
    pub rebuild: bool,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VaultOpenProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub parent_path: String,
    pub file_kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct OpenFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct MediaFile {
    pub path: String,
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Serialize)]
pub struct SqlQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct UserVimrc {
    pub path: String,
    pub content: String,
    pub sourced_paths: Vec<String>,
    pub source_warnings: Vec<String>,
}

const MAX_VIMRC_FILES: usize = 64;
const MAX_VIMRC_BYTES: usize = 4 * 1024 * 1024;

#[tauri::command]
fn project_version() -> String {
    PROJECT_VERSION.to_string()
}

#[tauri::command]
fn vault_open_plan(path: String) -> Result<VaultOpenPlan, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err("Vault folder does not exist".into());
    }
    let database = root.join(".nephrite").join("index.db");
    if !database.is_file() {
        return Ok(VaultOpenPlan {
            rebuild: true,
            action: format!(
                "Building the Nephrite {} vault index for the first time…",
                PROJECT_VERSION
            ),
        });
    }
    let stored = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()
    .and_then(|connection| {
        connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'project_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
    })
    .and_then(|value| value.parse::<nephrite_index::Version>().ok());
    let rebuild = stored
        .map(|version| PROJECT_VERSION.requires_rebuild(version))
        .unwrap_or(true);
    Ok(VaultOpenPlan {
        rebuild,
        action: if rebuild {
            format!(
                "Rebuilding the vault index for Nephrite {}…",
                PROJECT_VERSION
            )
        } else {
            "Checking the vault for changed files…".to_string()
        },
    })
}

#[tauri::command]
fn read_user_vimrc() -> Result<Option<UserVimrc>, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            Some(PathBuf::from(drive).join(path))
        });
    let Some(home) = home else {
        return Ok(None);
    };
    for name in [".vimrc", "_vimrc"] {
        let path = home.join(name);
        if !path.is_file() {
            continue;
        }
        let main_path = path.canonicalize().unwrap_or(path);
        let mut loader = VimrcLoader {
            home: home.clone(),
            main_path: main_path.clone(),
            visited: HashSet::new(),
            sourced_paths: Vec::new(),
            warnings: Vec::new(),
            bytes_read: 0,
        };
        let content = loader.load(&main_path, true)?;
        return Ok(Some(UserVimrc {
            path: main_path.to_string_lossy().into_owned(),
            content,
            sourced_paths: loader.sourced_paths,
            source_warnings: loader.warnings,
        }));
    }
    Ok(None)
}

/// Reuse the user's existing Obsidian Templater folder choice without loading
/// or executing the Obsidian plugin itself.
#[tauri::command]
fn templater_templates_folder(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let path = index
        .vault_root()
        .join(".obsidian")
        .join("plugins")
        .join("templater-obsidian")
        .join("data.json");
    if !path.is_file() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(value
        .get("templates_folder")
        .and_then(|folder| folder.as_str())
        .map(|folder| folder.trim_matches('/').replace('\\', "/"))
        .filter(|folder| !folder.is_empty()))
}

struct VimrcLoader {
    home: PathBuf,
    main_path: PathBuf,
    visited: HashSet<PathBuf>,
    sourced_paths: Vec<String>,
    warnings: Vec<String>,
    bytes_read: usize,
}

impl VimrcLoader {
    fn load(&mut self, path: &Path, is_main: bool) -> Result<String, String> {
        if self.visited.len() >= MAX_VIMRC_FILES {
            self.warnings.push(format!(
                "source limit ({MAX_VIMRC_FILES} files) reached before {}",
                path.display()
            ));
            return Ok(String::new());
        }
        let canonical = match path.canonicalize() {
            Ok(value) => value,
            Err(error) => {
                self.warnings
                    .push(format!("could not source {}: {error}", path.display()));
                return Ok(String::new());
            }
        };
        if !self.visited.insert(canonical.clone()) {
            return Ok(String::new());
        }
        if !is_main {
            self.sourced_paths
                .push(canonical.to_string_lossy().into_owned());
        }
        let content = std::fs::read_to_string(&canonical)
            .map_err(|e| format!("failed to read {}: {e}", canonical.display()))?;
        self.bytes_read = self.bytes_read.saturating_add(content.len());
        if self.bytes_read > MAX_VIMRC_BYTES {
            self.warnings.push(format!(
                "source size limit ({} MiB) reached at {}",
                MAX_VIMRC_BYTES / 1024 / 1024,
                canonical.display()
            ));
            return Ok(String::new());
        }

        let mut expanded = String::with_capacity(content.len());
        for raw_line in content.split_inclusive('\n') {
            let line = raw_line.trim_end_matches(['\r', '\n']);
            if let Some(source_arg) = vim_source_argument(line) {
                if matches!(
                    source_arg.trim(),
                    "$VIMRUNTIME/mswin.vim" | "${VIMRUNTIME}/mswin.vim"
                ) {
                    expanded
                        .push_str("\" nephrite: Vim's mswin compatibility profile\nbehave mswin\n");
                    continue;
                }
                match self.resolve_source(&canonical, source_arg) {
                    Some(source_path) => {
                        expanded.push_str(&format!(
                            "\" nephrite: begin source {}\n",
                            source_path.display()
                        ));
                        expanded.push_str(&self.load(&source_path, false)?);
                        expanded.push_str(&format!(
                            "\" nephrite: end source {}\n",
                            source_path.display()
                        ));
                    }
                    None => {
                        self.warnings.push(format!(
                            "unsupported source path in {}: {}",
                            canonical.display(),
                            source_arg
                        ));
                    }
                }
            } else {
                expanded.push_str(raw_line);
                if !raw_line.ends_with('\n') {
                    expanded.push('\n');
                }
            }
        }
        Ok(expanded)
    }

    fn resolve_source(&self, including_file: &Path, raw: &str) -> Option<PathBuf> {
        let mut value = unescape_vim_path(raw.trim());
        if value == "$MYVIMRC" || value == "${MYVIMRC}" {
            return Some(self.main_path.clone());
        }
        for prefix in ["$MYVIMRC/", "${MYVIMRC}/"] {
            if let Some(rest) = value.strip_prefix(prefix) {
                return self.main_path.parent().map(|parent| parent.join(rest));
            }
        }
        if value == "~" || value == "$HOME" || value == "${HOME}" {
            return Some(self.home.clone());
        }
        for prefix in ["~/", "$HOME/", "${HOME}/"] {
            if let Some(rest) = value.strip_prefix(prefix) {
                return Some(self.home.join(rest));
            }
        }
        if value.contains('$') || value.contains('%') || value.starts_with('~') {
            return None;
        }
        let path = PathBuf::from(std::mem::take(&mut value));
        if path.is_absolute() {
            Some(path)
        } else {
            including_file.parent().map(|parent| parent.join(path))
        }
    }
}

fn vim_source_argument(line: &str) -> Option<&str> {
    let command = line
        .trim_start()
        .strip_prefix(':')
        .unwrap_or(line.trim_start());
    if command.starts_with('"') {
        return None;
    }
    let (name, rest) = command
        .split_once(char::is_whitespace)
        .unwrap_or((command, ""));
    if !matches!(
        name.to_ascii_lowercase().as_str(),
        "source" | "source!" | "so" | "so!"
    ) {
        return None;
    }
    let argument = rest.trim();
    (!argument.is_empty()).then_some(argument)
}

fn unescape_vim_path(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            output.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            output.push(character);
        }
    }
    if escaped {
        output.push('\\');
    }
    output
}

#[tauri::command]
async fn open_vault(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VaultInfo, String> {
    let root = PathBuf::from(&path);
    let index_state = Arc::clone(&state.index);
    let watcher_generation = Arc::clone(&state.watcher_generation);
    let generation = watcher_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let progress_app = app.clone();
    let (index, stats) = tauri::async_runtime::spawn_blocking(move || {
        VaultIndex::open_with_progress(&root, |phase, done, total, path| {
            let phase = match phase {
                ProgressPhase::Scan => "scan",
                ProgressPhase::Index => "index",
                ProgressPhase::Resolve => "resolve",
            };
            let _ = progress_app.emit(
                "vault-open-progress",
                VaultOpenProgress {
                    phase: phase.to_string(),
                    done,
                    total,
                    path: path.map(str::to_string),
                },
            );
        })
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Vault indexing task failed: {error}"))??;
    let info = vault_info_from(&index, &stats);
    *index_state.lock() = Some(index);
    start_vault_watcher(
        app,
        Arc::clone(&index_state),
        Arc::clone(&watcher_generation),
        generation,
    );
    Ok(info)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VaultChangeEvent {
    pub scanned: usize,
    pub updated: usize,
    pub removed: usize,
    pub paths: Vec<String>,
}

fn indexed_file_state(index: &VaultIndex) -> Result<HashMap<String, (i64, i64)>, String> {
    let mut statement = index
        .connection()
        .prepare("SELECT path, mtime_ms, size_bytes FROM files")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

fn reconcile_vault(index: &mut VaultIndex) -> Result<VaultChangeEvent, String> {
    let before = indexed_file_state(index)?;
    let stats = index.reconcile().map_err(|error| error.to_string())?;
    let after = indexed_file_state(index)?;
    let mut paths: Vec<String> = before
        .keys()
        .chain(after.keys())
        .filter(|path| before.get(*path) != after.get(*path))
        .cloned()
        .collect();
    paths.sort_unstable();
    paths.dedup();
    Ok(VaultChangeEvent {
        scanned: stats.scanned,
        updated: stats.updated,
        removed: stats.removed,
        paths,
    })
}

/// A lightweight background reconciler catches changes made by scripts,
/// editors, sync tools, and shell commands. Reconcile compares filesystem
/// metadata first and parses only changed files, so the steady-state scan does
/// not reread Markdown contents.
fn start_vault_watcher(
    app: AppHandle,
    index: Arc<Mutex<Option<VaultIndex>>>,
    watcher_generation: Arc<AtomicU64>,
    generation: u64,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1_000));
        if watcher_generation.load(Ordering::Acquire) != generation {
            break;
        }
        // Clone only the root while holding the database mutex. Walking a
        // large vault can take long enough to starve query hydration if the
        // walk shares this lock with SQL and DataviewJS.
        let root = {
            let guard = index.lock();
            let Some(index) = guard.as_ref() else {
                break;
            };
            index.vault_root().to_path_buf()
        };
        let disk = match VaultIndex::scan_vault_files(&root) {
            Ok(disk) => disk,
            Err(error) => {
                eprintln!("vault watcher scan failed: {error}");
                continue;
            }
        };
        if watcher_generation.load(Ordering::Acquire) != generation {
            break;
        }
        let change = {
            let mut guard = index.lock();
            let Some(index) = guard.as_mut() else {
                break;
            };
            match index.filesystem_changed_from(&disk) {
                Ok(false) => None,
                Ok(true) => Some(reconcile_vault(index)),
                Err(error) => Some(Err(error.to_string())),
            }
        };
        if watcher_generation.load(Ordering::Acquire) != generation {
            break;
        }
        match change {
            Some(Ok(change)) if change.updated > 0 || change.removed > 0 => {
                let _ = app.emit("vault-index-changed", change);
            }
            Some(Ok(_)) | None => {}
            Some(Err(error)) => eprintln!("vault watcher reconcile failed: {error}"),
        }
    });
}

/// Explicit repair/refresh path for the toolbar. This runs the same complete
/// filesystem reconciliation immediately rather than waiting for the watcher.
#[tauri::command]
fn refresh_vault(state: State<'_, AppState>) -> Result<VaultChangeEvent, String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    reconcile_vault(index)
}

#[tauri::command]
fn vault_stats(state: State<'_, AppState>) -> Result<VaultInfo, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let dummy = nephrite_index::ReconcileStats {
        scanned: 0,
        unchanged: 0,
        updated: 0,
        removed: 0,
        full_rebuild: false,
    };
    Ok(vault_info_from(index, &dummy))
}

#[tauri::command]
fn list_files(state: State<'_, AppState>) -> Result<Vec<FileEntry>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let conn = index.connection();
    let mut stmt = conn
        .prepare(
            "SELECT path, name, parent_path, file_kind FROM files ORDER BY path COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FileEntry {
                path: r.get(0)?,
                name: r.get(1)?,
                parent_path: r.get(2)?,
                file_kind: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn fts_query(input: &str) -> String {
    vault_search_terms(input)
        .into_iter()
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn vault_search_terms(input: &str) -> Vec<String> {
    input
        .split_whitespace()
        .filter_map(|token| {
            let cleaned = token.trim_matches(|character: char| {
                !character.is_alphanumeric() && !matches!(character, '_' | '-' | '/' | '.')
            });
            (!cleaned.is_empty()).then(|| cleaned.to_lowercase())
        })
        .collect()
}

fn like_search_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn search_yaml_properties(
    connection: &rusqlite::Connection,
    terms: &[String],
    maximum: i64,
) -> Result<Vec<SearchResult>, String> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    const PROPERTY_TEXT: &str =
        "prop_path || ' ' || prop_key || ' ' || COALESCE(value_text, CAST(value_num AS TEXT), CASE value_bool WHEN 1 THEN 'true' WHEN 0 THEN 'false' END, value_json, '')";
    let predicates = terms
        .iter()
        .map(|_| format!(
            "EXISTS (SELECT 1 FROM properties matched WHERE matched.path = f.path AND lower({PROPERTY_TEXT}) LIKE ? ESCAPE '\\')"
        ))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!(
        "SELECT f.path,
                COALESCE(NULLIF(p.title, ''), NULLIF(f.name, ''), f.path),
                (SELECT shown.prop_path || ': ' || COALESCE(shown.value_text, CAST(shown.value_num AS TEXT), CASE shown.value_bool WHEN 1 THEN 'true' WHEN 0 THEN 'false' END, shown.value_json, '')
                   FROM properties shown
                  WHERE shown.path = f.path AND lower({PROPERTY_TEXT}) LIKE ? ESCAPE '\\'
                  ORDER BY shown.is_leaf DESC, shown.prop_path
                  LIMIT 1)
           FROM files f
           LEFT JOIN pages p ON p.path = f.path
          WHERE f.file_kind = 'markdown' AND {predicates}
          ORDER BY f.path COLLATE NOCASE
          LIMIT ?"
    );
    let mut values = Vec::<rusqlite::types::Value>::with_capacity(terms.len() + 2);
    values.push(like_search_pattern(&terms[0]).into());
    values.extend(terms.iter().map(|term| like_search_pattern(term).into()));
    values.push(maximum.into());
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values), |row| {
            let snippet: String = row.get(2)?;
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                snippet: format!("[[HIT]]{snippet}[[/HIT]]"),
                line: None,
                rank: 1000.0,
            })
        })
        .map_err(|error| error.to_string())?;
    rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn search_vault(
    query: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResult>, String> {
    let expression = fts_query(query.trim());
    if expression.is_empty() {
        return Ok(Vec::new());
    }
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let mut statement = index
        .connection()
        .prepare(
            "SELECT f.path,
                    COALESCE(NULLIF(p.title, ''), NULLIF(f.title, ''), f.path),
                    snippet(files_fts, -1, '[[HIT]]', '[[/HIT]]', ' … ', 24),
                    bm25(files_fts, 8.0, 4.0, 2.5, 1.0, 3.0)
             FROM files_fts f
             LEFT JOIN pages p ON p.path = f.path
             WHERE files_fts MATCH ?1
             ORDER BY 4
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let maximum = limit.unwrap_or(80).clamp(1, 250) as i64;
    let rows = statement
        .query_map(rusqlite::params![expression, maximum], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                line: None,
                rank: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let terms = vault_search_terms(&query);
    let mut results = Vec::new();
    for row in rows {
        let mut result = row.map_err(|error| error.to_string())?;
        if let Ok(content) = std::fs::read_to_string(index.vault_root().join(&result.path)) {
            result.line = content.lines().position(|line| {
                let lower = line.to_lowercase();
                terms.iter().all(|term| lower.contains(term))
            }).map(|line| line + 1).or_else(|| content.lines().position(|line| {
                let lower = line.to_lowercase();
                terms.iter().any(|term| lower.contains(term))
            }).map(|line| line + 1));
        }
        results.push(result);
    }
    let existing = results
        .iter()
        .map(|result| result.path.clone())
        .collect::<std::collections::HashSet<_>>();
    for result in search_yaml_properties(index.connection(), &terms, maximum)? {
        if !existing.contains(&result.path) {
            results.push(result);
        }
    }
    results.truncate(maximum as usize);
    for result in &mut results {
        if result.line.is_some() {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(index.vault_root().join(&result.path)) {
            result.line = content
                .lines()
                .position(|line| {
                    let lower = line.to_lowercase();
                    terms.iter().all(|term| lower.contains(term))
                })
                .map(|line| line + 1)
                .or_else(|| {
                    content
                        .lines()
                        .position(|line| {
                            let lower = line.to_lowercase();
                            terms.iter().any(|term| lower.contains(term))
                        })
                        .map(|line| line + 1)
                });
        }
    }
    Ok(results)
}

#[tauri::command]
fn graph_data(state: State<'_, AppState>) -> Result<GraphData, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let connection = index.connection();
    let mut node_statement = connection
        .prepare(
            "SELECT path, COALESCE(NULLIF(title, ''), name, path)
             FROM pages ORDER BY path COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let nodes = node_statement
        .query_map([], |row| Ok(GraphNode { path: row.get(0)?, title: row.get(1)? }))
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut edge_statement = connection
        .prepare(
            "SELECT DISTINCT path, target_path, MAX(is_embed)
             FROM links WHERE target_path IS NOT NULL AND path <> target_path
             GROUP BY path, target_path ORDER BY path, target_path",
        )
        .map_err(|error| error.to_string())?;
    let edges = edge_statement
        .query_map([], |row| Ok(GraphEdge {
            source: row.get(0)?,
            target: row.get(1)?,
            embeds: row.get::<_, i64>(2)? != 0,
        }))
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(GraphData { nodes, edges })
}

#[tauri::command]
fn read_file(path: String, state: State<'_, AppState>) -> Result<OpenFile, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let abs = index
        .vault_root()
        .join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
    // Prevent path escape
    let abs = abs.canonicalize().map_err(|e| e.to_string())?;
    let root = index
        .vault_root()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !abs.starts_with(&root) {
        return Err("Path escapes vault".into());
    }
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    Ok(OpenFile { path, content })
}

/// Read a supported vault image without exposing arbitrary host filesystem paths.
#[tauri::command]
fn read_media_file(path: String, state: State<'_, AppState>) -> Result<MediaFile, String> {
    const MAX_MEDIA_BYTES: u64 = 64 * 1024 * 1024;
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    let extension = abs
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return Err(format!("Unsupported embedded image type: {extension}")),
    };
    let metadata = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_MEDIA_BYTES {
        return Err(format!(
            "Embedded image is too large ({} MiB limit)",
            MAX_MEDIA_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    Ok(MediaFile {
        path,
        mime: mime.to_string(),
        data: BASE64.encode(bytes),
    })
}

#[tauri::command]
fn write_file(path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    // Resolve the target while the current vault identity is stable, but do
    // not hold the database mutex across filesystem I/O.
    let (root, abs) = {
        let guard = state.index.lock();
        let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
        let root = index
            .vault_root()
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let abs = vault_abs(index, &path)?;
        (root, abs)
    };
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&abs, content.as_bytes()).map_err(|e| e.to_string())?;
    let abs_c = abs.canonicalize().map_err(|e| e.to_string())?;
    if !abs_c.starts_with(&root) {
        return Err("Path escapes vault".into());
    }
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    if index
        .vault_root()
        .canonicalize()
        .map_err(|e| e.to_string())?
        != root
    {
        return Err("Vault changed while the file was being saved".into());
    }
    // Re-index this file only, reusing the bytes supplied by the editor.
    index
        .index_path_with_content(&path, Some(&content))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PageRow {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub mtime_ms: i64,
    /// JSON object of frontmatter / properties when available
    pub properties: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TaskRow {
    pub path: String,
    pub task_id: i64,
    pub status: String,
    pub status_char: String,
    pub text: String,
    pub line: i64,
    pub completed: bool,
    pub due: Option<String>,
    pub scheduled: Option<String>,
    pub priority: Option<String>,
    pub recurrence: Option<String>,
}

#[tauri::command]
fn list_tasks(completed: Option<bool>, state: State<'_, AppState>) -> Result<Vec<TaskRow>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let sql = "SELECT path, task_id, status, status_char, text, line, completed,
                      due, scheduled, priority, recurrence
               FROM tasks
               WHERE (?1 IS NULL OR completed = ?1)
               ORDER BY completed, COALESCE(due, '9999-12-31'), path COLLATE NOCASE, line";
    let mut statement = index.connection().prepare(sql).map_err(|e| e.to_string())?;
    let completed_value = completed.map(|value| if value { 1_i64 } else { 0_i64 });
    let rows = statement
        .query_map([completed_value], |row| {
            Ok(TaskRow {
                path: row.get(0)?,
                task_id: row.get(1)?,
                status: row.get(2)?,
                status_char: row.get(3)?,
                text: row.get(4)?,
                line: row.get(5)?,
                completed: row.get::<_, i64>(6)? != 0,
                due: row.get(7)?,
                scheduled: row.get(8)?,
                priority: row.get(9)?,
                recurrence: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Toggle exactly the checkbox marker stored in Markdown, then re-index that file.
#[tauri::command]
fn set_task_completed(
    path: String,
    task_id: i64,
    completed: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let (start, end): (i64, i64) = index
        .connection()
        .query_row(
            "SELECT start_offset, end_offset FROM tasks WHERE path = ?1 AND task_id = ?2",
            rusqlite::params![path, task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Task is stale or missing: {e}"))?;
    let absolute = vault_abs(index, &path)?;
    let mut content = std::fs::read_to_string(&absolute).map_err(|e| e.to_string())?;
    let from = usize::try_from(start).map_err(|_| "Invalid task offset".to_string())?;
    let to = usize::try_from(end).map_err(|_| "Invalid task offset".to_string())?;
    let line = content
        .get(from..to)
        .ok_or_else(|| "Task offsets are stale".to_string())?;
    let marker = line
        .find('[')
        .and_then(|open| line[open + 1..].find(']').map(|close| open + 1 + close))
        .ok_or_else(|| "Task checkbox is no longer present".to_string())?;
    let marker_from = from + marker;
    let marker_to = marker_from + 1;
    if !content.is_char_boundary(marker_from) || !content.is_char_boundary(marker_to) {
        return Err("Task checkbox has an invalid byte boundary".into());
    }
    content.replace_range(marker_from..marker_to, if completed { "x" } else { " " });
    std::fs::write(&absolute, content.as_bytes()).map_err(|e| e.to_string())?;
    index.index_path(&path).map_err(|e| e.to_string())
}

/// Pages for Dataview-style queries. `source` examples: `"people"`, `"folder/sub"`, empty = all markdown.
#[tauri::command]
fn list_pages(source: Option<String>, state: State<'_, AppState>) -> Result<Vec<PageRow>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let conn = index.connection();

    let src = source.unwrap_or_default();
    let src = src.trim().trim_matches('"').trim_matches('\'').trim();

    let mut sql = String::from(
        "SELECT f.path, f.name, f.parent_path, f.mtime_ms, fm.json
         FROM files f
         LEFT JOIN file_frontmatter fm ON fm.path = f.path
         WHERE f.file_kind = 'markdown'",
    );
    let mut rows_out = Vec::new();

    if !src.is_empty() {
        // folder path prefix (Dataview FROM "people")
        sql.push_str(" AND (f.parent_path = ?1 OR f.parent_path LIKE ?2 OR f.path LIKE ?3)");
        let like_folder = format!("{src}/%");
        let like_path = format!("{src}/%");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([src, like_folder.as_str(), like_path.as_str()], |r| {
                let path: String = r.get(0)?;
                let name: String = r.get(1)?;
                let folder: String = r.get(2)?;
                let mtime_ms: i64 = r.get(3)?;
                let json: Option<String> = r.get(4)?;
                Ok((path, name, folder, mtime_ms, json))
            })
            .map_err(|e| e.to_string())?;
        for row in mapped {
            let (path, name, folder, mtime_ms, json) = row.map_err(|e| e.to_string())?;
            let properties = page_properties(json.as_deref());
            rows_out.push(PageRow {
                path,
                name,
                folder,
                mtime_ms,
                properties,
            });
        }
    } else {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |r| {
                let path: String = r.get(0)?;
                let name: String = r.get(1)?;
                let folder: String = r.get(2)?;
                let mtime_ms: i64 = r.get(3)?;
                let json: Option<String> = r.get(4)?;
                Ok((path, name, folder, mtime_ms, json))
            })
            .map_err(|e| e.to_string())?;
        for row in mapped {
            let (path, name, folder, mtime_ms, json) = row.map_err(|e| e.to_string())?;
            let properties = page_properties(json.as_deref());
            rows_out.push(PageRow {
                path,
                name,
                folder,
                mtime_ms,
                properties,
            });
        }
    }

    Ok(rows_out)
}

/// Decode frontmatter without asking SQLite's JSON functions to process every
/// row. A legacy or malformed cached row must not make all Dataview queries
/// fail with `malformed JSON`. The index is disposable, so invalid cached
/// metadata degrades to an empty property bag until that file is reindexed.
///
/// `title`, when present, remains an ordinary property inside this object. It
/// is never synthesized from a filename and never participates in identity.
fn page_properties(frontmatter_json: Option<&str>) -> serde_json::Value {
    frontmatter_json
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

fn sql_value(value: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => value.into(),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(value) => {
            let text = String::from_utf8_lossy(value).into_owned();
            if matches!(text.as_bytes().first(), Some(b'{') | Some(b'[')) {
                if let Ok(json) = serde_json::from_str(&text) {
                    return json;
                }
            }
            serde_json::Value::String(text)
        }
        ValueRef::Blob(value) => {
            serde_json::Value::String(format!("[binary: {} bytes]", value.len()))
        }
    }
}

fn user_function_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(Box::new(error))
}

fn parse_page_array(value: &str) -> rusqlite::Result<Vec<serde_json::Value>> {
    serde_json::from_str::<Vec<serde_json::Value>>(value).map_err(user_function_error)
}

fn context_json_value(
    context: &rusqlite::functions::Context<'_>,
    index: usize,
) -> rusqlite::Result<serde_json::Value> {
    use rusqlite::types::ValueRef;
    Ok(match context.get_raw(index) {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => value.into(),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(value) => serde_json::Value::String(
            String::from_utf8(value.to_vec()).map_err(user_function_error)?,
        ),
        ValueRef::Blob(value) => serde_json::Value::String(BASE64.encode(value)),
    })
}

fn json_compare(left: &serde_json::Value, right: &serde_json::Value) -> std::cmp::Ordering {
    use serde_json::Value;
    let rank = |value: &Value| match value {
        Value::Null => 0,
        Value::Bool(_) => 1,
        Value::Number(_) => 2,
        Value::String(_) => 3,
        Value::Array(_) => 4,
        Value::Object(_) => 5,
    };
    let order = rank(left).cmp(&rank(right));
    if !order.is_eq() {
        return order;
    }
    match (left, right) {
        (Value::Null, Value::Null) => std::cmp::Ordering::Equal,
        (Value::Bool(left), Value::Bool(right)) => left.cmp(right),
        (Value::Number(left), Value::Number(right)) => left
            .as_f64()
            .partial_cmp(&right.as_f64())
            .unwrap_or(std::cmp::Ordering::Equal),
        (Value::String(left), Value::String(right)) => left.cmp(right),
        _ => left.to_string().cmp(&right.to_string()),
    }
}

fn compare_page_arrays(
    left: &[serde_json::Value],
    right: &[serde_json::Value],
) -> std::cmp::Ordering {
    for (left, right) in left.iter().zip(right) {
        let order = json_compare(left, right);
        if !order.is_eq() {
            return order;
        }
    }
    left.len().cmp(&right.len())
}

fn register_page_array_functions(connection: &rusqlite::Connection) -> Result<(), String> {
    use rusqlite::functions::FunctionFlags;
    use rusqlite::types::ValueRef;
    const SAFE: FunctionFlags =
        FunctionFlags::SQLITE_DETERMINISTIC.union(FunctionFlags::SQLITE_INNOCUOUS);

    connection
        .create_scalar_function("page_array", -1, SAFE, |context| {
            let values = (0..context.len())
                .map(|index| context_json_value(context, index))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            serde_json::to_string(&values).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;

    connection
        .create_scalar_function("page_array_contains", 2, SAFE, |context| {
            let left = parse_page_array(context.get::<String>(0)?.as_str())?;
            let right = parse_page_array(context.get::<String>(1)?.as_str())?;
            Ok(right.iter().all(|item| left.contains(item)))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("page_array_overlap", 2, SAFE, |context| {
            let left = parse_page_array(context.get::<String>(0)?.as_str())?;
            let right = parse_page_array(context.get::<String>(1)?.as_str())?;
            Ok(left.iter().any(|item| right.contains(item)))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("page_array_concat", 2, SAFE, |context| {
            let mut left = parse_page_array(context.get::<String>(0)?.as_str())?;
            left.extend(parse_page_array(context.get::<String>(1)?.as_str())?);
            serde_json::to_string(&left).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("page_array_compare", 2, SAFE, |context| {
            let left = parse_page_array(context.get::<String>(0)?.as_str())?;
            let right = parse_page_array(context.get::<String>(1)?.as_str())?;
            Ok(match compare_page_arrays(&left, &right) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            })
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("page_array_get", 2, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let subscript = context.get::<i64>(1)?;
            let value = usize::try_from(subscript - 1)
                .ok()
                .and_then(|index| array.get(index))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            Ok(match value {
                serde_json::Value::Null => rusqlite::types::Value::Null,
                serde_json::Value::Bool(value) => rusqlite::types::Value::Integer(i64::from(value)),
                serde_json::Value::Number(value) => value
                    .as_i64()
                    .map(rusqlite::types::Value::Integer)
                    .or_else(|| value.as_f64().map(rusqlite::types::Value::Real))
                    .unwrap_or(rusqlite::types::Value::Null),
                serde_json::Value::String(value) => rusqlite::types::Value::Text(value),
                value => rusqlite::types::Value::Text(value.to_string()),
            })
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("page_array_slice", 3, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let lower = context.get::<Option<i64>>(1)?.unwrap_or(1).max(1) as usize;
            let upper = context
                .get::<Option<i64>>(2)?
                .unwrap_or(array.len() as i64)
                .max(0) as usize;
            let slice = if lower > upper || lower > array.len() {
                Vec::new()
            } else {
                array[lower - 1..upper.min(array.len())].to_vec()
            };
            serde_json::to_string(&slice).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("page_array_quantified", 4, SAFE, |context| {
            let scalar = context_json_value(context, 0)?;
            let operator = context.get::<String>(1)?;
            let quantifier = context.get::<String>(2)?;
            let array = parse_page_array(context.get::<String>(3)?.as_str())?;
            let compare = |item: &serde_json::Value| match operator.as_str() {
                "=" => scalar == *item,
                "<>" | "!=" => scalar != *item,
                "<" => json_compare(&scalar, item).is_lt(),
                ">" => json_compare(&scalar, item).is_gt(),
                "<=" => !json_compare(&scalar, item).is_gt(),
                ">=" => !json_compare(&scalar, item).is_lt(),
                _ => false,
            };
            Ok(if quantifier.eq_ignore_ascii_case("ALL") {
                array.iter().all(compare)
            } else {
                array.iter().any(compare)
            })
        })
        .map_err(|error| error.to_string())?;

    connection
        .create_scalar_function("cardinality", 1, SAFE, |context| {
            Ok(parse_page_array(context.get::<String>(0)?.as_str())?.len() as i64)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_length", 2, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let dimension = context.get::<i64>(1)?;
            Ok((dimension == 1 && !array.is_empty()).then_some(array.len() as i64))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_lower", 2, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            Ok((context.get::<i64>(1)? == 1 && !array.is_empty()).then_some(1_i64))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_upper", 2, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            Ok((context.get::<i64>(1)? == 1 && !array.is_empty()).then_some(array.len() as i64))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_ndims", 1, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            Ok((!array.is_empty()).then_some(1_i64))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_dims", 1, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            Ok((!array.is_empty()).then(|| format!("[1:{}]", array.len())))
        })
        .map_err(|error| error.to_string())?;

    connection
        .create_scalar_function("array_position", -1, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let needle = context_json_value(context, 1)?;
            let start = if context.len() > 2 {
                context.get::<i64>(2)?.max(1) as usize
            } else {
                1
            };
            Ok(array
                .iter()
                .enumerate()
                .skip(start - 1)
                .find(|(_, item)| **item == needle)
                .map(|(index, _)| index as i64 + 1))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_positions", 2, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let needle = context_json_value(context, 1)?;
            let positions = array
                .iter()
                .enumerate()
                .filter_map(|(index, item)| (item == &needle).then_some(index + 1))
                .collect::<Vec<_>>();
            serde_json::to_string(&positions).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;

    for (name, prepend) in [("array_append", false), ("array_prepend", true)] {
        connection
            .create_scalar_function(name, 2, SAFE, move |context| {
                let (array_index, value_index) = if prepend { (1, 0) } else { (0, 1) };
                let mut array = parse_page_array(context.get::<String>(array_index)?.as_str())?;
                let value = context_json_value(context, value_index)?;
                if prepend {
                    array.insert(0, value);
                } else {
                    array.push(value);
                }
                serde_json::to_string(&array).map_err(user_function_error)
            })
            .map_err(|error| error.to_string())?;
    }
    connection
        .create_scalar_function("array_cat", 2, SAFE, |context| {
            let mut left = parse_page_array(context.get::<String>(0)?.as_str())?;
            left.extend(parse_page_array(context.get::<String>(1)?.as_str())?);
            serde_json::to_string(&left).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_remove", 2, SAFE, |context| {
            let mut array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let needle = context_json_value(context, 1)?;
            array.retain(|item| item != &needle);
            serde_json::to_string(&array).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_replace", 3, SAFE, |context| {
            let mut array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let needle = context_json_value(context, 1)?;
            let replacement = context_json_value(context, 2)?;
            for item in &mut array {
                if item == &needle {
                    *item = replacement.clone();
                }
            }
            serde_json::to_string(&array).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_reverse", 1, SAFE, |context| {
            let mut array = parse_page_array(context.get::<String>(0)?.as_str())?;
            array.reverse();
            serde_json::to_string(&array).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_sort", -1, SAFE, |context| {
            let mut array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let descending = context.len() > 1 && context.get::<bool>(1)?;
            array.sort_by(json_compare);
            if descending {
                array.reverse();
            }
            serde_json::to_string(&array).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("trim_array", 2, SAFE, |context| {
            let mut array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let trim = context.get::<i64>(1)?.max(0) as usize;
            array.truncate(array.len().saturating_sub(trim));
            serde_json::to_string(&array).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("array_to_string", -1, SAFE, |context| {
            let array = parse_page_array(context.get::<String>(0)?.as_str())?;
            let delimiter = context.get::<String>(1)?;
            let null_string = if context.len() > 2 {
                context.get::<Option<String>>(2)?
            } else {
                None
            };
            Ok(array
                .iter()
                .filter_map(|item| match item {
                    serde_json::Value::Null => null_string.clone(),
                    serde_json::Value::String(value) => Some(value.clone()),
                    value => Some(value.to_string()),
                })
                .collect::<Vec<_>>()
                .join(&delimiter))
        })
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function("string_to_array", -1, SAFE, |context| {
            let source = context.get::<String>(0)?;
            let delimiter = context.get::<String>(1)?;
            let null_string = if context.len() > 2 {
                context.get::<Option<String>>(2)?
            } else {
                None
            };
            let values = source
                .split(&delimiter)
                .map(|value| {
                    if null_string.as_deref() == Some(value) {
                        serde_json::Value::Null
                    } else {
                        serde_json::Value::String(value.to_string())
                    }
                })
                .collect::<Vec<_>>();
            serde_json::to_string(&values).map_err(user_function_error)
        })
        .map_err(|error| error.to_string())?;

    // Keep the raw ValueRef import exercised/documented for SQLite callbacks.
    let _ = ValueRef::Null;
    Ok(())
}

fn run_readonly_sql(
    connection: &rusqlite::Connection,
    sql: &str,
) -> Result<SqlQueryResult, String> {
    const MAX_SQL_BYTES: usize = 128 * 1024;
    const MAX_ROWS: usize = 1_000;
    if sql.trim().is_empty() {
        return Err("SQL query is empty".into());
    }
    if sql.len() > MAX_SQL_BYTES {
        return Err("SQL query exceeds the 128 KiB limit".into());
    }
    use rusqlite::functions::FunctionFlags;
    use rusqlite::types::Value;
    let parsed = pg_query::parse(sql).map_err(|error| format!("PostgreSQL syntax: {error}"))?;
    if parsed.protobuf.stmts.len() != 1
        || !matches!(
            parsed.protobuf.nodes().first().map(|node| node.0),
            Some(pg_query::NodeRef::SelectStmt(_))
        )
    {
        return Err("Only one read-only SELECT statement is allowed".into());
    }
    register_page_array_functions(connection)?;
    postgres_compat::register(connection)?;
    connection
        .create_scalar_function(
            "page_has_tag",
            2,
            FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
            |context| {
                let json = context.get::<String>(0)?;
                let wanted = context.get::<String>(1)?;
                let wanted = wanted.trim_start_matches('#');
                let tags = serde_json::from_str::<Vec<String>>(&json).unwrap_or_default();
                Ok(tags
                    .iter()
                    .any(|tag| tag.trim_start_matches('#').eq_ignore_ascii_case(wanted)))
            },
        )
        .map_err(|error| error.to_string())?;
    connection
        .create_scalar_function(
            "page_property",
            2,
            FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
            |context| {
                let source = context.get::<String>(0)?;
                let key = context.get::<String>(1)?;
                let object = serde_json::from_str::<serde_json::Value>(&source).unwrap_or_default();
                Ok(match object.get(&key).unwrap_or(&serde_json::Value::Null) {
                    serde_json::Value::Null => Value::Null,
                    serde_json::Value::Bool(value) => Value::Integer(i64::from(*value)),
                    serde_json::Value::Number(value) => value
                        .as_i64()
                        .map(Value::Integer)
                        .or_else(|| value.as_f64().map(Value::Real))
                        .unwrap_or(Value::Null),
                    serde_json::Value::String(value) => Value::Text(value.clone()),
                    value => Value::Text(value.to_string()),
                })
            },
        )
        .map_err(|error| error.to_string())?;
    let translated = translate_page_sql(sql)?;
    let mut statement = connection
        .prepare(&translated)
        .map_err(|error| error.to_string())?;
    if !statement.readonly() {
        return Err("Only read-only SQL queries are allowed".into());
    }
    if statement.parameter_count() != 0 {
        return Err("Page SQL cannot contain unbound parameters".into());
    }
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("SQL query did not return a result set".into());
    }
    let column_count = columns.len();
    let mut cursor = statement.query([]).map_err(|error| error.to_string())?;
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(row) = cursor.next().map_err(|error| error.to_string())? {
        if rows.len() == MAX_ROWS {
            truncated = true;
            break;
        }
        let mut values = Vec::with_capacity(column_count);
        for column in 0..column_count {
            values.push(sql_value(
                row.get_ref(column).map_err(|error| error.to_string())?,
            ));
        }
        rows.push(values);
    }
    Ok(SqlQueryResult {
        columns,
        rows,
        truncated,
    })
}

/// Lower Nephrite's PostgreSQL custom page types into disposable SQLite
/// storage expressions. The PostgreSQL parser has already validated syntax.
fn translate_page_sql(sql: &str) -> Result<String, String> {
    let property = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?properties)\s*\[\s*'((?:''|[^'])*)'\s*\]",
    )
    .map_err(|error| error.to_string())?;
    let translated = property.replace_all(sql, |captures: &regex::Captures<'_>| {
        format!("page_property({}, '{}')", &captures[1], &captures[2])
    });
    let any_tag = regex::Regex::new(
        r"(?i)'((?:''|[^'])*)'\s*=\s*ANY\s*\(\s*((?:[a-z_][a-z0-9_]*\.)?tags)\s*\)",
    )
    .map_err(|error| error.to_string())?;
    let translated = any_tag
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("page_has_tag({}, '{}')", &captures[2], &captures[1])
        })
        .into_owned();
    let contains_tags =
        regex::Regex::new(r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?tags)\s*@>\s*ARRAY\s*\[([^\]]*)\]")
            .map_err(|error| error.to_string())?;
    let string_literal =
        regex::Regex::new(r"'((?:''|[^'])*)'").map_err(|error| error.to_string())?;
    let translated = contains_tags
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let tags = string_literal
                .captures_iter(&captures[2])
                .map(|tag| tag[1].to_string())
                .collect::<Vec<_>>();
            let residue = string_literal.replace_all(&captures[2], "");
            if !residue
                .chars()
                .all(|character| character.is_whitespace() || character == ',')
            {
                return captures[0].to_string();
            }
            if tags.is_empty() {
                return "1".to_string();
            }
            format!(
                "({})",
                tags.iter()
                    .map(|tag| format!("page_has_tag({}, '{}')", &captures[1], tag))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            )
        })
        .into_owned();
    let overlaps_tags =
        regex::Regex::new(r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?tags)\s*&&\s*ARRAY\s*\[([^\]]*)\]")
            .map_err(|error| error.to_string())?;
    let translated = overlaps_tags
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let tags = string_literal
                .captures_iter(&captures[2])
                .map(|tag| tag[1].to_string())
                .collect::<Vec<_>>();
            let residue = string_literal.replace_all(&captures[2], "");
            if !residue
                .chars()
                .all(|character| character.is_whitespace() || character == ',')
            {
                return captures[0].to_string();
            }
            if tags.is_empty() {
                return "0".to_string();
            }
            format!(
                "({})",
                tags.iter()
                    .map(|tag| format!("page_has_tag({}, '{}')", &captures[1], tag))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )
        })
        .into_owned();

    // PostgreSQL ARRAY constructors become Nephrite's JSON-backed semantic
    // arrays after the page-tag operators above have consumed their operands.
    let array_constructor = regex::Regex::new(r"(?i)\bARRAY\s*\[([^\[\]]*)\]")
        .map_err(|error| error.to_string())?;
    let translated = array_constructor
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("page_array({})", &captures[1])
        })
        .into_owned();

    // SQLite has the implementation as date_part(field, value), while
    // PostgreSQL's canonical spelling is EXTRACT(field FROM value).
    let extract = regex::Regex::new(
        r"(?i)\bEXTRACT\s*\(\s*([a-z_]+)\s+FROM\s+([^()]+?)\s*\)",
    )
    .map_err(|error| error.to_string())?;
    let translated = extract
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("date_part('{}', {})", &captures[1], &captures[2])
        })
        .into_owned();

    // These PostgreSQL aggregates have exact SQLite equivalents for the
    // ordinary (non-ORDER-BY-inside-the-call) form used by page queries.
    let aggregate = regex::Regex::new(r"(?i)\b(string_agg|bool_and|bool_or|every)\s*\(")
        .map_err(|error| error.to_string())?;
    Ok(aggregate
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let function = match captures[1].to_ascii_lowercase().as_str() {
                "string_agg" => "group_concat",
                "bool_or" => "max",
                _ => "min",
            };
            format!("{function}(")
        })
        .into_owned())
}

/// Execute one read-only query against the disposable vault index.
#[tauri::command]
fn query_vault_sql(sql: String, state: State<'_, AppState>) -> Result<SqlQueryResult, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    run_readonly_sql(index.connection(), &sql)
}

/// Resolve a wikilink target (note name / path, optional `#heading`) to a vault path.
#[tauri::command]
fn resolve_wikilink(
    target: String,
    from_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let note = target.split('#').next().unwrap_or("").trim();
    if note.is_empty() {
        return Ok(from_path);
    }
    let key = note.trim_end_matches(".md").replace('\\', "/");
    let conn = index.connection();

    // Prefer a path relative to the source note. Standard Markdown images and
    // Obsidian links commonly use paths such as assets/photo.jpg that are
    // relative to the note's folder rather than the vault root.
    if let Some(from) = from_path.as_deref() {
        let parent = from.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let relative = if parent.is_empty() {
            key.clone()
        } else {
            format!("{parent}/{key}")
        };
        let relative_md = format!("{relative}.md");
        let hit: Option<String> = conn
            .query_row(
                "SELECT path FROM files WHERE path = ?1 OR path = ?2 LIMIT 1",
                [relative.as_str(), relative_md.as_str()],
                |r| r.get(0),
            )
            .ok();
        if hit.is_some() {
            return Ok(hit);
        }
    }

    // Exact vault-root path.
    let exact = format!("{key}.md");
    let hit: Option<String> = conn
        .query_row(
            "SELECT path FROM files WHERE path = ?1 OR path = ?2 LIMIT 1",
            [key.as_str(), exact.as_str()],
            |r| r.get(0),
        )
        .ok();
    if hit.is_some() {
        return Ok(hit);
    }

    // Stem match (filename without extension). This includes attachments so
    // extensionless Obsidian embeds such as ![[Photo]] resolve naturally.
    let filename = key.rsplit('/').next().unwrap_or(&key);
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(filename);
    let mut stmt = conn
        .prepare(
            "SELECT path FROM files WHERE stem = ?1 \
             ORDER BY CASE file_kind \
                 WHEN 'markdown' THEN 0 WHEN 'image' THEN 1 \
                 WHEN 'excalidraw' THEN 2 ELSE 3 END, path LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<String> = stmt
        .query_map([stem], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        // alias table
        let mut a = conn
            .prepare("SELECT path FROM aliases WHERE alias = ?1 LIMIT 1")
            .map_err(|e| e.to_string())?;
        let ap: Option<String> = a.query_row([stem], |r| r.get(0)).ok();
        return Ok(ap);
    }
    if rows.len() == 1 {
        return Ok(Some(rows[0].clone()));
    }
    // Prefer same folder as from_path
    if let Some(from) = from_path {
        let parent = from.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        if let Some(p) = rows.iter().find(|p| {
            p.rsplit_once('/')
                .map(|(dir, _)| dir == parent)
                .unwrap_or(false)
        }) {
            return Ok(Some(p.clone()));
        }
    }
    Ok(Some(rows[0].clone()))
}

fn vault_info_from(index: &VaultIndex, stats: &nephrite_index::ReconcileStats) -> VaultInfo {
    VaultInfo {
        root: index.vault_root().display().to_string(),
        project_version: PROJECT_VERSION.to_string(),
        scanned: stats.scanned,
        unchanged: stats.unchanged,
        updated: stats.updated,
        removed: stats.removed,
        full_rebuild: stats.full_rebuild,
        file_count: index.count("files").unwrap_or(0),
        task_count: index.count("tasks").unwrap_or(0),
        link_count: index.count("links").unwrap_or(0),
    }
}

/// Resolve a vault-relative path (forward-slash form from the index/UI) to an absolute path.
/// Does **not** re-walk absolute components — only joins `rel` segments under the vault root.
fn vault_abs(index: &VaultIndex, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches('/');
    let root = index
        .vault_root()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if rel.is_empty() {
        return Ok(root);
    }
    let mut full = root.clone();
    for part in rel.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("Path escapes vault".into());
        }
        full.push(part);
    }
    // Defense in depth (symlinks could still escape; we don't follow them here)
    if !full.starts_with(&root) {
        return Err("Path escapes vault".into());
    }
    Ok(full)
}

fn reindex_path(index: &mut VaultIndex, rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Ok(());
    }
    index.index_path(rel).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_folder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    std::fs::create_dir_all(&abs).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn create_file(path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    if abs.exists() {
        return Err(format!("Already exists: {path}"));
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&abs, content.as_bytes()).map_err(|e| e.to_string())?;
    reindex_path(index, &path)?;
    Ok(())
}

#[tauri::command]
fn rename_path(from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let src = vault_abs(index, &from)?;
    let dst = vault_abs(index, &to)?;
    if !src.exists() {
        return Err(format!("Not found: {from} (resolved {})", src.display()));
    }
    if dst.exists() {
        return Err(format!("Already exists: {to}"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let was_dir = src.is_dir();
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    // Drop old index identity; re-index new path (or full reconcile for dirs).
    let _ = index.remove_path(&from);
    if was_dir {
        index.reconcile().map_err(|e| e.to_string())?;
    } else {
        reindex_path(index, &to).map_err(|e| format!("renamed on disk but reindex failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_path(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    if !abs.exists() {
        return Err(format!("Not found: {path} (resolved {})", abs.display()));
    }
    if abs.is_dir() {
        std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
        index.reconcile().map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
        index.remove_path(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn copy_path(from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let src = vault_abs(index, &from)?;
    let dst = vault_abs(index, &to)?;
    if !src.exists() {
        return Err(format!("Not found: {from}"));
    }
    if dst.exists() {
        return Err(format!("Already exists: {to}"));
    }
    if src.is_dir() {
        copy_dir_recursive(&src, &dst).map_err(|e| e.to_string())?;
        index.reconcile().map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        reindex_path(index, &to)?;
    }
    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn absolute_path(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    Ok(abs.display().to_string())
}

/// Reveal path in the OS file manager (folder, or parent of a file).
#[tauri::command]
fn reveal_in_explorer(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    let target = if abs.is_file() {
        abs.parent().map(|p| p.to_path_buf()).unwrap_or(abs.clone())
    } else {
        abs
    };
    open::that(&target).map_err(|e| e.to_string())
}

/// Open file/folder with the OS default application.
#[tauri::command]
fn open_with_default_app(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    open::that(&abs).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub ok: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GitEntry {
    pub status: String,
    pub path: String,
    pub conflicted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GitStatus {
    pub available: bool,
    pub repository: bool,
    pub branch: Option<String>,
    pub entries: Vec<GitEntry>,
    pub operation: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GitSyncStatus {
    pub remote: Option<String>,
    pub upstream: Option<String>,
    pub remote_url: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub detached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GitCommitDetails {
    pub hash: String,
    pub author: String,
    pub author_email: String,
    pub timestamp: String,
    pub subject: String,
    pub body: String,
    pub parents: Vec<String>,
    pub patch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub line: Option<usize>,
    pub rank: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GraphNode {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub embeds: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub timestamp: String,
    pub subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GitBranches {
    pub current: Option<String>,
    pub branches: Vec<String>,
}

fn git_output(root: &Path, arguments: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .map_err(|e| format!("Git is unavailable: {e}"))
}

fn git_success(root: &Path, arguments: &[&str]) -> Result<String, String> {
    let output = git_output(root, arguments)?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if error.is_empty() {
            format!("git {} failed", arguments.join(" "))
        } else {
            error
        })
    }
}

fn validate_git_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Select at least one path".into());
    }
    if paths.iter().any(|path| path.is_empty() || path.contains('\0')) {
        return Err("Invalid Git path".into());
    }
    Ok(())
}

fn validate_git_ref(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.starts_with('-')
        || value.contains('\0')
        || value.chars().any(char::is_whitespace)
    {
        return Err(format!("Invalid {label}"));
    }
    Ok(())
}

fn vault_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    index.vault_root().canonicalize().map_err(|e| e.to_string())
}

fn git_operation(root: &Path) -> Option<String> {
    let output = git_output(root, &["rev-parse", "--git-dir"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let git_dir = {
        let path = PathBuf::from(raw);
        if path.is_absolute() { path } else { root.join(path) }
    };
    if git_dir.join("MERGE_HEAD").exists() {
        Some("merge".into())
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase".into())
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick".into())
    } else if git_dir.join("REVERT_HEAD").exists() {
        Some("revert".into())
    } else {
        None
    }
}

fn is_conflict_status(status: &str) -> bool {
    matches!(status, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
}

#[tauri::command]
fn git_status(state: State<'_, AppState>) -> Result<GitStatus, String> {
    let root = vault_root(&state)?;
    let version = match git_output(&root, &["--version"]) {
        Ok(output) => output.status.success(),
        Err(_) => false,
    };
    if !version {
        return Ok(GitStatus {
            available: false,
            repository: false,
            branch: None,
            entries: vec![],
            operation: None,
        });
    }
    let output = git_output(
        &root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=normal",
        ],
    )?;
    if !output.status.success() {
        return Ok(GitStatus {
            available: true,
            repository: false,
            branch: None,
            entries: vec![],
            operation: None,
        });
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut branch = None;
    let mut entries = Vec::new();
    let mut records = text.split('\0');
    while let Some(line) = records.next() {
        if let Some(value) = line.strip_prefix("## ") {
            branch = Some(value.to_string());
        } else if line.len() >= 3 {
            let status = line[..2].to_string();
            entries.push(GitEntry {
                status: status.clone(),
                path: line[3..].to_string(),
                conflicted: is_conflict_status(&status),
            });
            // Porcelain v1 -z emits the original name as the next record for
            // renames/copies. UI actions intentionally target the new path.
            if matches!(status.as_bytes().first().copied(), Some(b'R' | b'C')) {
                let _ = records.next();
            }
        }
    }
    Ok(GitStatus {
        available: true,
        repository: true,
        branch,
        entries,
        operation: git_operation(&root),
    })
}

#[tauri::command]
fn git_sync_status(state: State<'_, AppState>) -> Result<GitSyncStatus, String> {
    let root = vault_root(&state)?;
    let branch = git_output(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let detached = !branch.status.success();
    let upstream_output = git_output(
        &root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )?;
    let upstream = upstream_output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&upstream_output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());
    let remote = upstream.as_deref().and_then(|value| value.split('/').next()).map(str::to_string);
    let remote_url = remote.as_deref().and_then(|name| {
        let output = git_output(&root, &["remote", "get-url", name]).ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    });
    let (ahead, behind) = if upstream.is_some() {
        let output = git_output(&root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])?;
        if output.status.success() {
            let counts = String::from_utf8_lossy(&output.stdout);
            let mut values = counts.split_whitespace().filter_map(|value| value.parse::<usize>().ok());
            (values.next().unwrap_or(0), values.next().unwrap_or(0))
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };
    Ok(GitSyncStatus { remote, upstream, remote_url, ahead, behind, detached })
}

#[tauri::command]
fn git_history(limit: Option<usize>, state: State<'_, AppState>) -> Result<Vec<GitCommit>, String> {
    let root = vault_root(&state)?;
    let count = limit.unwrap_or(50).clamp(1, 200).to_string();
    let output = git_output(
        &root,
        &[
            "log",
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s",
            "-n",
            &count,
        ],
    )?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(5, '\u{1f}');
            Some(GitCommit {
                hash: fields.next()?.to_string(),
                short_hash: fields.next()?.to_string(),
                author: fields.next()?.to_string(),
                timestamp: fields.next()?.to_string(),
                subject: fields.next()?.to_string(),
            })
        })
        .collect())
}

#[tauri::command]
fn git_diff(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    if path.contains('\0') {
        return Err("Invalid Git path".into());
    }
    let working = git_output(&root, &["diff", "--no-ext-diff", "--no-color", "--", &path])?;
    let staged = git_output(
        &root,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            "--",
            &path,
        ],
    )?;
    if !working.status.success() || !staged.status.success() {
        return Err("Git could not produce the diff".into());
    }
    let mut result = String::from_utf8_lossy(&staged.stdout).into_owned();
    result.push_str(&String::from_utf8_lossy(&working.stdout));
    Ok(result)
}

#[tauri::command]
fn git_init(state: State<'_, AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    let output = git_output(&root, &["init"])?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_commit_all(message: String, state: State<'_, AppState>) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty".into());
    }
    let root = vault_root(&state)?;
    let add = git_output(&root, &["add", "--all"])?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    let commit = git_output(&root, &["commit", "-m", message])?;
    if commit.status.success() {
        Ok(String::from_utf8_lossy(&commit.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&commit.stderr).trim().to_string())
    }
}

#[tauri::command]
fn git_stage(paths: Vec<String>, state: State<'_, AppState>) -> Result<String, String> {
    validate_git_paths(&paths)?;
    let root = vault_root(&state)?;
    let mut arguments = vec!["add", "--"];
    arguments.extend(paths.iter().map(String::as_str));
    git_success(&root, &arguments)
}

#[tauri::command]
fn git_unstage(paths: Vec<String>, state: State<'_, AppState>) -> Result<String, String> {
    validate_git_paths(&paths)?;
    let root = vault_root(&state)?;
    let mut arguments = vec!["restore", "--staged", "--"];
    arguments.extend(paths.iter().map(String::as_str));
    git_success(&root, &arguments)
}

#[tauri::command]
fn git_restore(paths: Vec<String>, state: State<'_, AppState>) -> Result<String, String> {
    validate_git_paths(&paths)?;
    let root = vault_root(&state)?;
    let mut arguments = vec!["restore", "--worktree", "--"];
    arguments.extend(paths.iter().map(String::as_str));
    git_success(&root, &arguments)
}

#[tauri::command]
fn git_branches(state: State<'_, AppState>) -> Result<GitBranches, String> {
    let root = vault_root(&state)?;
    let output = git_success(
        &root,
        &["branch", "--format=%(HEAD)%00%(refname:short)"],
    )?;
    let mut current = None;
    let mut branches = Vec::new();
    for line in output.lines() {
        let (head, name) = line.split_once('\0').unwrap_or((" ", line));
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if head == "*" {
            current = Some(name.to_string());
        }
        branches.push(name.to_string());
    }
    Ok(GitBranches { current, branches })
}

#[tauri::command]
fn git_create_branch(
    name: String,
    checkout: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let name = name.trim();
    validate_git_ref(name, "branch name")?;
    let root = vault_root(&state)?;
    if checkout.unwrap_or(true) {
        git_success(&root, &["switch", "-c", name])
    } else {
        git_success(&root, &["branch", name])
    }
}

#[tauri::command]
fn git_switch_branch(name: String, state: State<'_, AppState>) -> Result<String, String> {
    let name = name.trim();
    validate_git_ref(name, "branch name")?;
    let root = vault_root(&state)?;
    git_success(&root, &["switch", name])
}

#[tauri::command]
fn git_pull(state: State<'_, AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    // Avoid creating an implicit merge commit from a GUI action.
    git_success(&root, &["pull", "--ff-only"])
}

#[tauri::command]
fn git_push(state: State<'_, AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    git_success(&root, &["push"])
}

#[tauri::command]
fn git_fetch(state: State<'_, AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    git_success(&root, &["fetch", "--prune"])
}

#[tauri::command]
fn git_commit_staged(message: String, state: State<'_, AppState>) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Commit message cannot be empty".into());
    }
    let root = vault_root(&state)?;
    git_success(&root, &["commit", "-m", message])
}

fn validate_git_commit(value: &str) -> Result<(), String> {
    if (4..=64).contains(&value.len()) && value.chars().all(|character| character.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Invalid Git commit identifier".into())
    }
}

#[tauri::command]
fn git_commit_details(hash: String, state: State<'_, AppState>) -> Result<GitCommitDetails, String> {
    validate_git_commit(&hash)?;
    let root = vault_root(&state)?;
    let format = "%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1e";
    let format_argument = format!("--format={format}");
    let output = git_output(
        &root,
        &["show", "--date=iso-strict", &format_argument, "--patch", "--stat", "--no-ext-diff", "--no-color", &hash],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let (metadata, patch) = text.split_once('\u{1e}').unwrap_or((&text, ""));
    let mut fields = metadata.splitn(7, '\u{1f}');
    Ok(GitCommitDetails {
        hash: fields.next().unwrap_or_default().trim().to_string(),
        author: fields.next().unwrap_or_default().to_string(),
        author_email: fields.next().unwrap_or_default().to_string(),
        timestamp: fields.next().unwrap_or_default().to_string(),
        subject: fields.next().unwrap_or_default().to_string(),
        body: fields.next().unwrap_or_default().trim().to_string(),
        parents: fields.next().unwrap_or_default().split_whitespace().map(str::to_string).collect(),
        patch: patch.trim_start().to_string(),
    })
}

#[tauri::command]
fn git_file_history(
    path: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<GitCommit>, String> {
    validate_git_paths(std::slice::from_ref(&path))?;
    let root = vault_root(&state)?;
    let count = limit.unwrap_or(100).clamp(1, 250).to_string();
    let output = git_output(
        &root,
        &["log", "--follow", "--date=iso-strict", "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s", "-n", &count, "--", &path],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
        let mut fields = line.splitn(5, '\u{1f}');
        Some(GitCommit {
            hash: fields.next()?.to_string(),
            short_hash: fields.next()?.to_string(),
            author: fields.next()?.to_string(),
            timestamp: fields.next()?.to_string(),
            subject: fields.next()?.to_string(),
        })
    }).collect())
}

#[tauri::command]
fn git_restore_from_commit(
    hash: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_git_commit(&hash)?;
    validate_git_paths(std::slice::from_ref(&path))?;
    let root = vault_root(&state)?;
    git_success(&root, &["restore", "--source", &hash, "--worktree", "--", &path])
}

#[tauri::command]
fn git_resolve_conflict(
    path: String,
    resolution: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_git_paths(std::slice::from_ref(&path))?;
    let root = vault_root(&state)?;
    match resolution.as_str() {
        "ours" | "theirs" => {
            let flag = if resolution == "ours" { "--ours" } else { "--theirs" };
            git_success(&root, &["checkout", flag, "--", &path])?;
            git_success(&root, &["add", "--", &path])
        }
        "resolved" => git_success(&root, &["add", "--", &path]),
        _ => Err("Unknown conflict resolution".into()),
    }
}

#[tauri::command]
fn git_continue(state: State<'_, AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    match git_operation(&root).as_deref() {
        Some("merge") => git_success(&root, &["-c", "core.editor=true", "merge", "--continue"]),
        Some("rebase") => git_success(&root, &["-c", "core.editor=true", "rebase", "--continue"]),
        Some("cherry-pick") => git_success(&root, &["-c", "core.editor=true", "cherry-pick", "--continue"]),
        Some("revert") => git_success(&root, &["-c", "core.editor=true", "revert", "--continue"]),
        _ => Err("No Git merge, rebase, cherry-pick, or revert is in progress".into()),
    }
}

#[tauri::command]
fn git_abort(state: State<'_, AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    match git_operation(&root).as_deref() {
        Some("merge") => git_success(&root, &["merge", "--abort"]),
        Some("rebase") => git_success(&root, &["rebase", "--abort"]),
        Some("cherry-pick") => git_success(&root, &["cherry-pick", "--abort"]),
        Some("revert") => git_success(&root, &["revert", "--abort"]),
        _ => Err("No Git operation is in progress".into()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VimPowerlineResult {
    pub screen: String,
    pub stderr: String,
    pub rows: usize,
    pub columns: usize,
    pub ok: bool,
}

/// Ask the user's actual Vim + Powerline Vim binding to draw a statusline.
/// Nephrite only consumes the terminal row; it does not reinterpret the
/// user's Powerline theme or replace the editor with a hidden Vim process.
#[tauri::command]
fn render_vim_powerline(
    path: String,
    line: usize,
    column: usize,
    dirty: bool,
    columns: usize,
    state: State<'_, AppState>,
) -> Result<VimPowerlineResult, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let absolute = vault_abs(index, &path)?;
    drop(guard);

    let home = std::env::var_os("HOME").map(PathBuf::from);
    let vimrc = home.as_ref().map(|home| home.join(".vimrc"));
    let powerline_root = std::env::var_os("POWERLINE_ROOT")
        .map(PathBuf::from)
        .filter(|root| {
            root.join("powerline/bindings/vim/plugin/powerline.vim")
                .is_file()
        })
        .or_else(|| {
            home.as_ref()
                .map(|home| home.join("work/powerline"))
                .filter(|root| {
                    root.join("powerline/bindings/vim/plugin/powerline.vim")
                        .is_file()
                })
        })
        .ok_or_else(|| "Powerline Vim binding was not found".to_string())?;
    let columns = columns.clamp(40, 240);
    let rows = 24usize;
    let powerline_vim_runtime = powerline_root.join("powerline/bindings/vim");
    let runtime_command = format!(
        "set rtp+={}",
        vim_option_escape(&powerline_vim_runtime.to_string_lossy())
    );
    let cursor_command = format!("call cursor({}, {})", line.max(1), column.max(1));

    let mut command = Command::new("vim");
    command.arg("--not-a-term").arg("-n");
    if let Some(path) = vimrc.as_ref().filter(|path| path.is_file()) {
        command.arg("-Nu").arg(path);
    } else {
        command.args(["-Nu", "NONE"]);
    }
    command
        .args(["--cmd", &runtime_command])
        .args(["--cmd", "runtime plugin/powerline.vim"])
        .arg(&absolute)
        .args(["-c", &cursor_command]);
    if dirty {
        command.args(["-c", "set modified"]);
    }
    command
        .args(["-c", "redrawstatus"])
        .args(["-c", "sleep 10m"])
        .args(["-c", "qa!"])
        .env("TERM", "xterm-256color")
        .env("COLUMNS", columns.to_string())
        .env("LINES", rows.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("start Vim Powerline: {e}"))?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = Vec::new();
        let mut stderr = String::new();
        if let Some(ref mut output) = stdout_pipe {
            let _ = output.read_to_end(&mut stdout);
        }
        if let Some(ref mut error) = stderr_pipe {
            let _ = error.read_to_string(&mut stderr);
        }
        let status = child.wait();
        let _ = tx.send((status, stdout, stderr));
    });
    let (status, stdout, stderr) = rx
        .recv_timeout(Duration::from_secs(12))
        .map_err(|_| "Vim Powerline render timed out after 12 seconds".to_string())?;
    Ok(VimPowerlineResult {
        screen: String::from_utf8_lossy(&stdout).into_owned(),
        stderr,
        rows,
        columns,
        ok: status.map(|value| value.success()).unwrap_or(false),
    })
}

fn vim_option_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(' ', "\\ ")
        .replace(',', "\\,")
}

/// Run a shell command for JS hooks (`$()` / `shell()`).
/// Default cwd is the open vault root. Timeout defaults to 60s.
#[tauri::command]
fn shell_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    state: State<'_, AppState>,
) -> Result<ShellResult, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    if command.trim().is_empty() {
        return Err("empty command".into());
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(60_000).max(100));

    let workdir = {
        let guard = state.index.lock();
        if let Some(index) = guard.as_ref() {
            if let Some(c) = cwd.as_ref().filter(|s| !s.is_empty()) {
                // absolute or vault-relative
                let p = std::path::Path::new(c);
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    vault_abs(index, c)?
                }
            } else {
                index.vault_root().to_path_buf()
            }
        } else if let Some(c) = cwd {
            std::path::PathBuf::from(c)
        } else {
            std::env::current_dir().map_err(|e| e.to_string())?
        }
    };

    let mut cmd = {
        #[cfg(unix)]
        {
            let mut c = Command::new("sh");
            c.arg("-c").arg(&command);
            c
        }
        #[cfg(windows)]
        {
            let mut c = Command::new("cmd");
            c.args(["/C", &command]);
            c
        }
    };
    cmd.current_dir(&workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Ensure ~/bin (jobctl, etc.) is on PATH when the GUI was not launched from a login shell.
    if let Ok(home) = std::env::var("HOME") {
        let path = std::env::var("PATH").unwrap_or_default();
        let prepend = format!("{home}/bin:{home}/.local/bin");
        if !path.split(':').any(|p| p == format!("{home}/bin")) {
            cmd.env("PATH", format!("{prepend}:{path}"));
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(ref mut out) = stdout_pipe {
            let _ = out.read_to_string(&mut stdout);
        }
        if let Some(ref mut err) = stderr_pipe {
            let _ = err.read_to_string(&mut stderr);
        }
        let status = child.wait();
        let _ = tx.send((status, stdout, stderr));
    });

    match rx.recv_timeout(timeout) {
        Ok((status, stdout, stderr)) => {
            let (code, ok) = match status {
                Ok(s) => (
                    s.code().unwrap_or(if s.success() { 0 } else { 1 }),
                    s.success(),
                ),
                Err(_) => (1, false),
            };
            Ok(ShellResult {
                stdout,
                stderr,
                code,
                ok,
            })
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("command timed out after {}ms", timeout.as_millis()))
        }
        Err(e) => Err(format!("command failed: {e}")),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            index: Arc::new(Mutex::new(None)),
            watcher_generation: Arc::new(AtomicU64::new(0)),
        })
        .invoke_handler(tauri::generate_handler![
            project_version,
            vault_open_plan,
            read_user_vimrc,
            templater_templates_folder,
            open_vault,
            refresh_vault,
            vault_stats,
            list_files,
            search_vault,
            graph_data,
            read_file,
            read_media_file,
            write_file,
            resolve_wikilink,
            list_pages,
            query_vault_sql,
            list_tasks,
            set_task_completed,
            create_folder,
            create_file,
            rename_path,
            delete_path,
            copy_path,
            absolute_path,
            reveal_in_explorer,
            open_with_default_app,
            shell_command,
            git_status,
            git_sync_status,
            git_history,
            git_diff,
            git_init,
            git_commit_all,
            git_stage,
            git_unstage,
            git_restore,
            git_branches,
            git_create_branch,
            git_switch_branch,
            git_pull,
            git_push,
            git_fetch,
            git_commit_staged,
            git_commit_details,
            git_file_history,
            git_restore_from_commit,
            git_resolve_conflict,
            git_continue,
            git_abort,
            render_vim_powerline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nephrite");
}

#[cfg(test)]
mod sql_query_tests {
    use super::{
        fts_query, is_conflict_status, page_properties, run_readonly_sql,
        search_yaml_properties, translate_page_sql, vault_search_terms,
    };

    #[test]
    fn full_text_terms_are_quoted_and_prefixed() {
        assert_eq!(fts_query("PostgreSQL migration"), "\"postgresql\"* AND \"migration\"*");
        assert_eq!(fts_query("  #jobs  "), "\"jobs\"*");
    }

    #[test]
    fn vault_search_includes_yaml_property_keys_and_values() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE files(path TEXT PRIMARY KEY, name TEXT, file_kind TEXT);
                 CREATE TABLE pages(path TEXT PRIMARY KEY, title TEXT);
                 CREATE TABLE properties(
                   path TEXT, prop_path TEXT, prop_key TEXT, value_text TEXT,
                   value_num REAL, value_bool INTEGER, value_json TEXT, is_leaf INTEGER
                 );
                 INSERT INTO files VALUES ('people/Divya Nidhi.md', 'Divya Nidhi.md', 'markdown');
                 INSERT INTO pages VALUES ('people/Divya Nidhi.md', 'Divya Nidhi');
                 INSERT INTO properties VALUES (
                   'people/Divya Nidhi.md', 'company', 'company',
                   'Deloitte Consulting LLP', NULL, NULL, NULL, 1
                 );",
            )
            .unwrap();
        let terms = vault_search_terms("Deloitte");
        let results = search_yaml_properties(&connection, &terms, 20).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "people/Divya Nidhi.md");
        assert_eq!(results[0].snippet, "[[HIT]]company: Deloitte Consulting LLP[[/HIT]]");
    }

    #[test]
    fn recognizes_all_unmerged_porcelain_states() {
        for status in ["DD", "AU", "UD", "UA", "DU", "AA", "UU"] {
            assert!(is_conflict_status(status));
        }
        for status in [" M", "M ", "??", "R "] {
            assert!(!is_conflict_status(status));
        }
    }

    #[test]
    fn malformed_cached_frontmatter_does_not_break_page_loading() {
        let properties = page_properties(Some("not JSON"));
        assert_eq!(properties, serde_json::json!({}));
    }

    #[test]
    fn yaml_title_remains_an_ordinary_page_property() {
        let properties =
            page_properties(Some(r#"{"title":"YAML title","status":"active"}"#));
        assert_eq!(properties["status"], "active");
        assert_eq!(properties["title"], "YAML title");
    }

    #[test]
    fn executes_ctes_and_preserves_nulls() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "WITH sample(value) AS (VALUES (NULL), ('ok')) SELECT value FROM sample",
        )
        .unwrap();
        assert_eq!(result.columns, ["value"]);
        assert_eq!(result.rows[0][0], serde_json::Value::Null);
        assert_eq!(result.rows[1][0], "ok");
    }

    #[test]
    fn registers_postgres_array_compatibility_functions() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT cardinality(page_array('one', 'two')) AS count, array_to_string(page_array('one', 'two'), ',') AS joined",
        )
        .unwrap();
        assert_eq!(result.columns, ["count", "joined"]);
        assert_eq!(
            result.rows,
            [[serde_json::json!(2), serde_json::json!("one,two")]]
        );
    }

    #[test]
    fn executes_required_null_and_concatenation_functions() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT coalesce(NULL, 'fallback') AS fallback, ws_concat(' / ', 'one', NULL, 'two') AS joined, 'Neph' || 'rite' AS piped, 'prefix' || NULL AS null_piped",
        )
        .unwrap();
        assert_eq!(
            result.rows,
            [[
                serde_json::json!("fallback"),
                serde_json::json!("one / two"),
                serde_json::json!("Nephrite"),
                serde_json::Value::Null,
            ]]
        );
    }

    #[test]
    fn executes_postgres_text_numeric_json_and_date_catalog_functions() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT initcap('hELLO world') AS words, split_part('a/b/c', '/', -1) AS tail, gcd(54, 24) AS divisor, json_typeof(json_build_array(1, 'two')) AS json_kind, date_part('year', make_date(2026, 8, 11)) AS year",
        )
        .unwrap();
        assert_eq!(
            result.rows,
            [[
                serde_json::json!("Hello World"),
                serde_json::json!("c"),
                serde_json::json!(6),
                serde_json::json!("array"),
                serde_json::json!(2026.0),
            ]]
        );
    }

    #[test]
    fn lowers_general_array_constructors_and_extract_syntax() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT array_to_string(ARRAY['one', 'two'], ',') AS items, EXTRACT(year FROM '2026-08-11') AS year",
        )
        .unwrap();
        assert_eq!(
            result.rows,
            [[serde_json::json!("one,two"), serde_json::json!(2026.0)]]
        );
    }

    #[test]
    fn lowers_postgres_aggregate_names() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "WITH sample(label, complete) AS (VALUES ('one', true), ('two', false), (NULL, NULL)) SELECT string_agg(label, ',') AS labels, bool_and(complete) AS all_complete, bool_or(complete) AS any_complete FROM sample",
        )
        .unwrap();
        assert_eq!(
            result.rows,
            [[
                serde_json::json!("one,two"),
                serde_json::json!(0),
                serde_json::json!(1),
            ]]
        );
    }

    #[test]
    fn rejects_mutating_sql() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE sample(value TEXT)", [])
            .unwrap();
        let error = run_readonly_sql(&connection, "DELETE FROM sample").unwrap_err();
        assert!(error.contains("read-only"));
    }

    #[test]
    fn lowers_postgres_page_tag_array_operators() {
        assert_eq!(
            translate_page_sql("SELECT * FROM pages p WHERE p.tags @> ARRAY['recruiter']").unwrap(),
            "SELECT * FROM pages p WHERE (page_has_tag(p.tags, 'recruiter'))"
        );
        assert_eq!(
            translate_page_sql(
                "SELECT * FROM pages p WHERE p.tags @> ARRAY['recruiter', 'linkedin']"
            )
            .unwrap(),
            "SELECT * FROM pages p WHERE (page_has_tag(p.tags, 'recruiter') AND page_has_tag(p.tags, 'linkedin'))"
        );
        assert_eq!(
            translate_page_sql(
                "SELECT * FROM pages p WHERE p.tags && ARRAY['recruiter', 'interviewer']"
            )
            .unwrap(),
            "SELECT * FROM pages p WHERE (page_has_tag(p.tags, 'recruiter') OR page_has_tag(p.tags, 'interviewer'))"
        );
    }

    #[test]
    fn executes_postgres_page_property_and_tag_types() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE pages(properties TEXT, tags TEXT)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO pages VALUES (?1, ?2)",
                [
                    r#"{"company":"CDW","active":true}"#,
                    r#"["recruiter","linkedin"]"#,
                ],
            )
            .unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT properties['company'] AS company FROM pages WHERE tags @> ARRAY['recruiter']",
        )
        .unwrap();
        assert_eq!(result.rows, [[serde_json::json!("CDW")]]);

        let overlap = run_readonly_sql(
            &connection,
            "SELECT properties['company'] AS company FROM pages WHERE tags && ARRAY['manager', 'interviewer', 'recruiter']",
        )
        .unwrap();
        assert_eq!(overlap.rows, [[serde_json::json!("CDW")]]);

        let no_overlap = run_readonly_sql(
            &connection,
            "SELECT properties['company'] AS company FROM pages WHERE tags && ARRAY['manager', 'interviewer']",
        )
        .unwrap();
        assert!(no_overlap.rows.is_empty());
    }
}
