mod page_sql;
mod plugins;
mod postgres_compat;
mod state;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, Weekday};
use nephrite_index::{
    archive_index_order, plan_open, should_skip_rel, IndexTouch, ProgressPhase, VaultIndex,
    PROJECT_VERSION,
};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use state::{AppState, VisiblePages};
use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
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
    /// Pending feature backfills with truthful remaining counts, used to
    /// compose `action` while `vault_open_plan` remains read-only. Always
    /// serialized (possibly empty) so the frontend can read `migrations`.
    pub migrations: Vec<VaultMigration>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VaultMigration {
    pub id: String,
    pub action: String,
    pub remaining: i64,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginManifestFile {
    id: String,
    name: String,
    version: String,
    main: Option<String>,
    description: Option<String>,
    permissions: Option<Vec<String>>,
    api_version: Option<u32>,
    min_app_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PluginDescriptor {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub permissions: Vec<String>,
    pub api_version: u32,
    pub min_app_version: Option<String>,
    pub source: String,
    pub compatibility: String,
    pub style: Option<String>,
    pub assets: HashMap<String, String>,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub content_type: Option<String>,
    pub body: Option<serde_json::Value>,
    #[serde(rename = "throw")]
    pub throw_on_error: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub text: String,
    pub json: Option<serde_json::Value>,
    pub array_buffer_base64: String,
}

#[tauri::command]
fn plugin_http_request(request: PluginHttpRequest) -> Result<PluginHttpResponse, String> {
    const MAX_RESPONSE: usize = 16 * 1024 * 1024;
    let url = request.url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.contains(['\r', '\n']) {
        return Err("Plugin network requests require an HTTP(S) URL".into());
    }
    let authority = url
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""))
        .unwrap_or("");
    if authority.contains('@') {
        return Err("Plugin network URLs cannot contain credentials".into());
    }
    let method = request
        .method
        .unwrap_or_else(|| {
            if request.body.is_some() {
                "POST".into()
            } else {
                "GET".into()
            }
        })
        .to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
    ) {
        return Err(format!("Unsupported plugin HTTP method: {method}"));
    }
    let mut outgoing = ureq::request(&method, url).set("User-Agent", "Nephrite/0.8 (plugin host)");
    if let Some(content_type) = request.content_type.as_deref() {
        outgoing = outgoing.set("Content-Type", content_type);
    }
    for (name, value) in request.headers.unwrap_or_default() {
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            return Err("Invalid plugin HTTP header".into());
        }
        outgoing = outgoing.set(&name, &value);
    }
    let response_result = match request.body {
        Some(serde_json::Value::String(body)) => outgoing.send_string(&body),
        Some(body) => outgoing.send_string(&body.to_string()),
        None => outgoing.call(),
    };
    let response = match response_result {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) if request.throw_on_error == Some(false) => response,
        Err(error) => return Err(format!("Plugin request failed: {error}")),
    };
    let status = response.status();
    let headers = response
        .headers_names()
        .into_iter()
        .filter_map(|name| {
            response
                .header(&name)
                .map(|value| (name, value.to_string()))
        })
        .collect();
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_RESPONSE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RESPONSE {
        return Err("Plugin response exceeded 16 MiB".into());
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let json = serde_json::from_str(&text).ok();
    let array_buffer_base64 = BASE64.encode(&bytes);
    Ok(PluginHttpResponse {
        status,
        headers,
        text,
        json,
        array_buffer_base64,
    })
}

const MAX_PLUGIN_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PLUGIN_ASSET_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PLUGIN_ASSETS_TOTAL: u64 = 16 * 1024 * 1024;
const PLUGIN_PERMISSIONS: &[&str] = &[
    "vault.read",
    "vault.write",
    "index.query",
    "editor.read",
    "editor.write",
    "workspace.commands",
    "workspace.views",
    "network.request",
    "shell.execute",
];

/// Obsidian community plugins whose functionality Nephrite now provides
/// natively. These are hidden from the Plugins list and never loaded, so users
/// are not offered redundant Obsidian packages (or scared by their errors).
pub(crate) const CORE_OBSIDIAN_PLUGIN_IDS: &[&str] = &[
    "dataview",
    "obsidian-kanban",
    "obsidian-tasks",
    "templater-obsidian",
    "obsidian-excalidraw-plugin",
    // Mermaid is a native preview renderer. Do not load vault copies.
    "mermaid",
    "mermaid-tools",
    "obsidian-mermaid",
    "obsidian-mermaid-plugin",
    "obsidian-mermaid-view",
    "obsidian-git",
    "obsidian-vimrc-support",
    "obsidian-dynamic-toc",
    "table-of-contents",
    "table-of-content",
];

fn is_core_replaced_obsidian_plugin(id: &str) -> bool {
    plugins::is_core_replaced_obsidian_plugin(id)
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[tauri::command]
fn list_plugins(state: State<'_, AppState>) -> Result<Vec<PluginDescriptor>, String> {
    let root = {
        let guard = state.index.lock();
        guard
            .as_ref()
            .ok_or_else(|| "No vault open".to_string())?
            .vault_root()
            .canonicalize()
            .map_err(|error| error.to_string())?
    };
    let mut plugins = discover_plugins(&root.join(".nephrite").join("plugins"), "nephrite", None)?;
    let native_ids: HashSet<String> = plugins.iter().map(|plugin| plugin.id.clone()).collect();
    let enabled_obsidian: HashSet<String> = plugins::read_enabled_ids(&root).into_iter().collect();
    let obsidian = discover_plugins(
        &root.join(".obsidian").join("plugins"),
        "obsidian",
        Some(&enabled_obsidian),
    )?;
    plugins.extend(obsidian.into_iter().filter(|plugin| {
        !native_ids.contains(&plugin.id) && !is_core_replaced_obsidian_plugin(&plugin.id)
    }));
    plugins.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(plugins)
}

#[tauri::command]
fn plugin_catalog(state: State<'_, AppState>) -> Result<Vec<PluginCatalogItem>, String> {
    let root = vault_root(&state)?;
    let source = plugins::download_text(plugins::COMMUNITY_REGISTRY, 8 * 1024 * 1024)?;
    let enabled: HashSet<String> = plugins::read_enabled_ids(&root).into_iter().collect();
    let installed: HashSet<String> = std::fs::read_dir(root.join(".obsidian").join("plugins"))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    Ok(plugins::parse_community_catalog(&source)?
        .into_iter()
        .filter(|entry| !plugins::hides_core_plugin(&entry.id, &entry.name, &entry.description))
        .map(|entry| PluginCatalogItem {
            native: false,
            installed: installed.contains(&entry.id)
                || plugins::plugin_dir(&root, &entry.id).is_dir(),
            enabled: enabled.contains(&entry.id),
            id: entry.id,
            name: entry.name,
            author: entry.author,
            description: entry.description,
            repo: entry.repo,
        })
        .collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct PluginCatalogItem {
    id: String,
    name: String,
    author: String,
    description: String,
    repo: String,
    installed: bool,
    enabled: bool,
    native: bool,
}

#[tauri::command]
fn install_community_plugin(
    id: String,
    repo: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = vault_root(&state)?;
    plugins::install_release_files(&root, &id, &repo)
}

#[tauri::command]
fn uninstall_community_plugin(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = vault_root(&state)?;
    plugins::uninstall_plugin_files(&root, &id)
}

#[tauri::command]
fn set_community_plugin_enabled(
    id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !plugins::valid_plugin_id(&id) {
        return Err("Invalid plugin id".into());
    }
    let root = vault_root(&state)?;
    let next = plugins::set_enabled_id(&plugins::read_enabled_ids(&root), &id, enabled);
    plugins::write_enabled_ids(&root, &next)
}

/// Read validated, bundled plugin entrypoints. Both native Nephrite packages
/// and already-installed Obsidian packages execute inside the same isolated
/// frontend host; their compatibility name does not bypass permissions.
fn discover_plugins(
    plugin_root: &Path,
    compatibility: &str,
    enabled_ids: Option<&HashSet<String>>,
) -> Result<Vec<PluginDescriptor>, String> {
    if !plugin_root.is_dir() {
        return Ok(Vec::new());
    }
    let canonical_plugin_root = plugin_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut plugins = Vec::new();
    let entries = std::fs::read_dir(plugin_root).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }
        let manifest_text = std::fs::read_to_string(&manifest_path)
            .map_err(|error| format!("{}: {error}", manifest_path.display()))?;
        let manifest: PluginManifestFile = serde_json::from_str(&manifest_text)
            .map_err(|error| format!("{}: {error}", manifest_path.display()))?;
        if !valid_plugin_id(&manifest.id) || entry.file_name().to_string_lossy() != manifest.id {
            return Err(format!(
                "Plugin folder and manifest id must match: {}",
                entry.path().display()
            ));
        }
        let main = manifest.main.unwrap_or_else(|| "main.js".to_string());
        let canonical_entry = entry
            .path()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let main_path = canonical_entry.join(main.replace('/', std::path::MAIN_SEPARATOR_STR));
        let canonical_main = main_path
            .canonicalize()
            .map_err(|error| format!("{}: {error}", main_path.display()))?;
        if !canonical_main.starts_with(&canonical_plugin_root)
            || !canonical_main.starts_with(&canonical_entry)
        {
            return Err(format!(
                "Plugin main file escapes its folder: {}",
                manifest.id
            ));
        }
        let metadata = std::fs::metadata(&canonical_main).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_PLUGIN_SOURCE_BYTES {
            return Err(format!(
                "Plugin {} exceeds the 16 MiB bundled source limit",
                manifest.id
            ));
        }
        let permissions = manifest.permissions.unwrap_or_else(|| {
            if compatibility == "obsidian" {
                vec![
                    "vault.read".into(),
                    "vault.write".into(),
                    "index.query".into(),
                    "editor.read".into(),
                    "editor.write".into(),
                    "workspace.commands".into(),
                    "workspace.views".into(),
                    "network.request".into(),
                ]
            } else {
                Vec::new()
            }
        });
        if let Some(permission) = permissions
            .iter()
            .find(|permission| !PLUGIN_PERMISSIONS.contains(&permission.as_str()))
        {
            return Err(format!(
                "Plugin {} requests unknown permission: {permission}",
                manifest.id
            ));
        }
        let plugin_id = manifest.id;
        let enabled = match compatibility {
            "obsidian" => enabled_ids
                .map(|ids| ids.contains(&plugin_id))
                .unwrap_or(true),
            _ => true,
        };
        plugins.push(PluginDescriptor {
            id: plugin_id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description.unwrap_or_default(),
            permissions,
            api_version: manifest.api_version.unwrap_or(1),
            min_app_version: manifest.min_app_version,
            source: std::fs::read_to_string(&canonical_main)
                .map_err(|error| format!("{}: {error}", canonical_main.display()))?,
            compatibility: compatibility.to_string(),
            enabled,
            style: {
                let style_path = canonical_entry.join("styles.css");
                std::fs::metadata(&style_path)
                    .ok()
                    .filter(|metadata| metadata.len() <= 2 * 1024 * 1024)
                    .and_then(|_| std::fs::read_to_string(style_path).ok())
            },
            assets: read_plugin_assets(&canonical_entry, &canonical_main)?,
        });
    }
    Ok(plugins)
}

fn read_plugin_assets(root: &Path, main: &Path) -> Result<HashMap<String, String>, String> {
    fn visit(
        root: &Path,
        dir: &Path,
        main: &Path,
        total: &mut u64,
        output: &mut HashMap<String, String>,
    ) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_dir() {
                visit(root, &path, main, total, output)?;
                continue;
            }
            if !file_type.is_file() || path == main {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if matches!(relative.as_str(), "manifest.json" | "styles.css") {
                continue;
            }
            let size = entry.metadata().map_err(|error| error.to_string())?.len();
            if size > MAX_PLUGIN_ASSET_BYTES || *total + size > MAX_PLUGIN_ASSETS_TOTAL {
                continue;
            }
            let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
            *total += size;
            output.insert(
                relative.clone(),
                format!(
                    "data:{};base64,{}",
                    plugin_asset_mime(&relative),
                    BASE64.encode(bytes)
                ),
            );
        }
        Ok(())
    }
    let mut output = HashMap::new();
    let mut total = 0;
    visit(root, root, main, &mut total, &mut output)?;
    Ok(output)
}

fn plugin_asset_mime(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AttachmentRow {
    pub path: String,
    pub name: String,
    pub file_kind: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub reference_count: i64,
    pub orphaned: bool,
    pub text_indexed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScope {
    pub folders: Vec<String>,
    pub tags: Vec<String>,
    pub property: String,
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
            migrations: Vec::new(),
        });
    }
    let connection = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    let plan = plan_open(&connection).map_err(|e| e.to_string())?;
    Ok(VaultOpenPlan {
        rebuild: plan.rebuild,
        action: plan.action,
        migrations: plan
            .migrations
            .into_iter()
            .map(|migration| VaultMigration {
                id: migration.id.to_string(),
                action: migration.action.to_string(),
                remaining: migration.remaining,
            })
            .collect(),
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
        Arc::clone(&state.visible),
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

/// Archive-bit pass: only dirty watcher paths. On-screen dirty files go last.
/// Already-current files (mtime/size match) are a no-op so a save echo cannot
/// reparse the open editor note.
fn index_dirty_then_visible(
    index: &Arc<Mutex<Option<VaultIndex>>>,
    visible: &VisiblePages,
    dirty: impl IntoIterator<Item = String>,
) -> Result<VaultChangeEvent, String> {
    let showing = visible.snapshot();
    let order = archive_index_order(dirty, &showing);
    if order.is_empty() {
        return Ok(VaultChangeEvent {
            scanned: 0,
            updated: 0,
            removed: 0,
            paths: Vec::new(),
        });
    }

    let mut changed = Vec::new();
    let mut updated = 0usize;
    let mut removed = 0usize;

    for path in order {
        let mut guard = index.lock();
        let Some(open) = guard.as_mut() else {
            return Err("No vault open".to_string());
        };
        match open.touch_path(&path).map_err(|error| error.to_string())? {
            IndexTouch::Unchanged => {}
            IndexTouch::Updated => {
                updated += 1;
                changed.push(path);
            }
            IndexTouch::Removed => {
                removed += 1;
                changed.push(path);
            }
        }
    }

    Ok(VaultChangeEvent {
        scanned: changed.len(),
        updated,
        removed,
        paths: changed,
    })
}

const WATCH_DEBOUNCE: Duration = Duration::from_millis(50);

fn event_dirty_paths(root: &Path, event: &Event) -> HashSet<String> {
    if matches!(event.kind, EventKind::Access(_)) {
        return HashSet::new();
    }
    let mut dirty = HashSet::new();
    for path in &event.paths {
        if let Some(rel) = archive_rel(root, path) {
            dirty.insert(rel);
        }
    }
    dirty
}

/// Watcher path → vault-relative file. Directories are not expanded; inotify
/// already names the file that flipped the archive bit.
fn archive_rel(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let relative_text = relative.to_string_lossy().replace('\\', "/");
    if relative_text.is_empty() {
        return None;
    }
    if should_skip_rel(&relative_text) {
        return None;
    }
    if matches!(
        relative_text.as_str(),
        ".nephrite/index.db"
            | ".nephrite/index.db-shm"
            | ".nephrite/index.db-wal"
            | ".nephrite/index.db-journal"
    ) {
        return None;
    }
    if path.is_dir() {
        return None;
    }
    Some(relative_text)
}

fn apply_archive_bits(
    app: &AppHandle,
    index: &Arc<Mutex<Option<VaultIndex>>>,
    visible: &VisiblePages,
    dirty: HashSet<String>,
    watcher_generation: &AtomicU64,
    generation: u64,
) -> bool {
    if watcher_generation.load(Ordering::Acquire) != generation {
        return false;
    }
    if dirty.is_empty() {
        return true;
    }
    match index_dirty_then_visible(index, visible, dirty) {
        Ok(change) if change.updated > 0 || change.removed > 0 => {
            let _ = app.emit("vault-index-changed", change);
        }
        Ok(_) => {}
        Err(error) => eprintln!("vault watcher archive pass failed: {error}"),
    }
    watcher_generation.load(Ordering::Acquire) == generation
}

/// inotify/FSEvents names the files whose archive bit flipped. Coalesce a
/// burst, index those files, then the pages on screen. Never walk the vault.
fn start_vault_watcher(
    app: AppHandle,
    index: Arc<Mutex<Option<VaultIndex>>>,
    visible: Arc<VisiblePages>,
    watcher_generation: Arc<AtomicU64>,
    generation: u64,
) {
    std::thread::spawn(move || {
        let root = {
            let guard = index.lock();
            let Some(index) = guard.as_ref() else {
                return;
            };
            index.vault_root().to_path_buf()
        };

        let (sender, receiver) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                eprintln!("native vault watcher unavailable: {error}");
                return;
            }
        };
        if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
            eprintln!(
                "native vault watcher could not watch {}: {error}",
                root.display()
            );
            return;
        }

        while watcher_generation.load(Ordering::Acquire) == generation {
            let first = match receiver.recv() {
                Ok(Ok(event)) => event,
                Ok(Err(error)) => {
                    eprintln!("vault watcher event error: {error}");
                    continue;
                }
                Err(_) => return,
            };
            let mut dirty = event_dirty_paths(&root, &first);
            let mut deadline = Instant::now() + WATCH_DEBOUNCE;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match receiver.recv_timeout(remaining) {
                    Ok(Ok(event)) => {
                        let extra = event_dirty_paths(&root, &event);
                        if !extra.is_empty() {
                            dirty.extend(extra);
                            deadline = Instant::now() + WATCH_DEBOUNCE;
                        }
                    }
                    Ok(Err(error)) => eprintln!("vault watcher event error: {error}"),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if !apply_archive_bits(
                &app,
                &index,
                &visible,
                dirty,
                &watcher_generation,
                generation,
            ) {
                return;
            }
        }
    });
}

/// Toolbar refresh reindexes on-screen pages only. The watcher owns dirty bits.
#[tauri::command]
fn refresh_vault(state: State<'_, AppState>) -> Result<VaultChangeEvent, String> {
    index_dirty_then_visible(&state.index, &state.visible, state.visible.snapshot())
}

#[tauri::command]
fn set_visible_paths(paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    state.visible.set(paths);
    Ok(())
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

#[tauri::command]
fn list_attachments(state: State<'_, AppState>) -> Result<Vec<AttachmentRow>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let mut statement = index
        .connection()
        .prepare(
            "SELECT f.path, f.name, f.file_kind,
                COALESCE(a.mime_type, 'application/octet-stream'), f.size_bytes,
                a.width, a.height,
                COUNT(DISTINCT l.path),
                COALESCE(a.text_indexed, 0)
           FROM files f
           LEFT JOIN attachment_metadata a ON a.path = f.path
           LEFT JOIN links l ON l.target_path = f.path
          WHERE f.file_kind NOT IN ('markdown', 'canvas', 'excalidraw')
          GROUP BY f.path
          ORDER BY f.path COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let reference_count: i64 = row.get(7)?;
            Ok(AttachmentRow {
                path: row.get(0)?,
                name: row.get(1)?,
                file_kind: row.get(2)?,
                mime_type: row.get(3)?,
                size_bytes: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
                reference_count,
                orphaned: reference_count == 0,
                text_indexed: row.get::<_, i64>(8)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
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
    rows.collect::<std::result::Result<Vec<_>, _>>()
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
            "SELECT path, COALESCE(NULLIF(title, ''), name, path), tags
             FROM pages ORDER BY path COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let nodes = node_statement
        .query_map([], |row| {
            let tags_json: String = row.get(2)?;
            Ok(GraphNode {
                path: row.get(0)?,
                title: row.get(1)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            })
        })
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
        .query_map([], |row| {
            Ok(GraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                embeds: row.get::<_, i64>(2)? != 0,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(GraphData { nodes, edges })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LinkHealthNote {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LinkPlaceholder {
    pub source: String,
    pub target: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LinkHealth {
    pub orphans: Vec<LinkHealthNote>,
    pub placeholders: Vec<LinkPlaceholder>,
}

#[tauri::command]
fn link_health(state: State<'_, AppState>) -> Result<LinkHealth, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let connection = index.connection();
    let mut orphan_stmt = connection
        .prepare(
            "SELECT p.path, COALESCE(NULLIF(p.title, ''), p.name, p.path)
             FROM pages p
             WHERE p.file_kind = 'markdown'
               AND NOT EXISTS (
                 SELECT 1 FROM links l
                 WHERE l.target_path = p.path AND l.path <> p.path
             )
             ORDER BY p.path COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let orphans = orphan_stmt
        .query_map([], |row| {
            Ok(LinkHealthNote {
                path: row.get(0)?,
                title: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut placeholder_stmt = connection
        .prepare(
            "SELECT path, target_raw, COUNT(*)
             FROM links
             WHERE target_path IS NULL
               AND TRIM(target_raw) <> ''
               AND link_kind = 'wikilink'
             GROUP BY path, target_raw
             ORDER BY target_raw COLLATE NOCASE, path COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let placeholders = placeholder_stmt
        .query_map([], |row| {
            Ok(LinkPlaceholder {
                source: row.get(0)?,
                target: row.get(1)?,
                count: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(LinkHealth {
        orphans,
        placeholders,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NoteLinkRef {
    pub path: String,
    pub title: String,
    pub target: String,
    pub heading: Option<String>,
    pub block: Option<String>,
    pub display: Option<String>,
    pub embed: bool,
    pub resolved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NoteHeading {
    pub level: i64,
    pub text: String,
    pub line: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct UnlinkedMention {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub line: Option<usize>,
    pub term: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NoteContext {
    pub path: String,
    pub title: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub headings: Vec<NoteHeading>,
    pub backlinks: Vec<NoteLinkRef>,
    pub outgoing: Vec<NoteLinkRef>,
    pub unlinked: Vec<UnlinkedMention>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VaultTag {
    pub tag: String,
    pub count: i64,
}

#[tauri::command]
fn note_context(path: String, state: State<'_, AppState>) -> Result<NoteContext, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let connection = index.connection();
    let title: String = connection
        .query_row(
            "SELECT COALESCE(NULLIF(title, ''), name, path) FROM pages WHERE path = ?1",
            rusqlite::params![path],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| {
            path.rsplit('/')
                .next()
                .unwrap_or(&path)
                .trim_end_matches(".md")
                .to_string()
        });
    let aliases = query_strings(
        connection,
        "SELECT alias FROM aliases WHERE path = ?1 ORDER BY alias COLLATE NOCASE",
        &path,
    )?;
    let tags = query_strings(
        connection,
        "SELECT DISTINCT tag FROM tags WHERE path = ?1 ORDER BY tag COLLATE NOCASE",
        &path,
    )?;
    let headings = {
        let mut stmt = connection
            .prepare(
                "SELECT level, text, start_line FROM headings
                 WHERE path = ?1 ORDER BY heading_id",
            )
            .map_err(|error| error.to_string())?;
        let rows: Vec<NoteHeading> = stmt
            .query_map(rusqlite::params![path], |row| {
                Ok(NoteHeading {
                    level: row.get(0)?,
                    text: row.get(1)?,
                    line: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let map_link = |row: &rusqlite::Row<'_>| -> rusqlite::Result<NoteLinkRef> {
        let source: String = row.get(0)?;
        let label: String = row.get(1)?;
        let target_raw: String = row.get(2)?;
        let target_path: Option<String> = row.get(3)?;
        let resolved = target_path.is_some();
        let dest = target_path.unwrap_or_else(|| target_raw.clone());
        Ok(NoteLinkRef {
            title: label,
            path: source,
            target: dest,
            heading: row.get(4)?,
            block: row.get(5)?,
            display: row.get(6)?,
            embed: row.get::<_, i64>(7)? != 0,
            resolved,
        })
    };
    let backlinks = {
        let mut stmt = connection
            .prepare(
                "SELECT l.path,
                        COALESCE(NULLIF(p.title, ''), p.name, l.path),
                        l.target_raw, l.target_path, l.target_heading, l.target_block,
                        l.display_text, l.is_embed
                 FROM links l
                 LEFT JOIN pages p ON p.path = l.path
                 WHERE l.target_path = ?1 AND l.path <> ?1
                 ORDER BY l.path COLLATE NOCASE, l.link_id",
            )
            .map_err(|error| error.to_string())?;
        let rows: Vec<NoteLinkRef> = stmt
            .query_map(rusqlite::params![path], map_link)
            .map_err(|error| error.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let outgoing = {
        let mut stmt = connection
            .prepare(
                "SELECT l.path,
                        COALESCE(NULLIF(p.title, ''), p.name, l.target_raw),
                        l.target_raw, l.target_path, l.target_heading, l.target_block,
                        l.display_text, l.is_embed
                 FROM links l
                 LEFT JOIN pages p ON p.path = l.target_path
                 WHERE l.path = ?1
                 ORDER BY COALESCE(l.target_path, l.target_raw) COLLATE NOCASE, l.link_id",
            )
            .map_err(|error| error.to_string())?;
        let rows: Vec<NoteLinkRef> = stmt
            .query_map(rusqlite::params![path], map_link)
            .map_err(|error| error.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let linked = backlinks
        .iter()
        .map(|item| item.path.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut terms = vec![wikilink_key(&path)];
    if !title.is_empty() {
        terms.push(title.clone());
    }
    terms.extend(aliases.iter().cloned());
    terms.sort();
    terms.dedup();
    let mut unlinked = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for term in terms {
        let cleaned = term.trim();
        if cleaned.chars().count() < 3 {
            continue;
        }
        let expression = fts_query(cleaned);
        if expression.is_empty() {
            continue;
        }
        let mut stmt = connection
            .prepare(
                "SELECT f.path,
                        COALESCE(NULLIF(p.title, ''), f.path),
                        snippet(files_fts, -1, '[[HIT]]', '[[/HIT]]', ' … ', 18)
                 FROM files_fts f
                 LEFT JOIN pages p ON p.path = f.path
                 WHERE files_fts MATCH ?1 AND f.path <> ?2
                 ORDER BY bm25(files_fts)
                 LIMIT 24",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![expression, path], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (source, mention_title, snippet) = row.map_err(|error| error.to_string())?;
            if linked.contains(&source) || !seen.insert(source.clone()) {
                continue;
            }
            let line = std::fs::read_to_string(index.vault_root().join(&source))
                .ok()
                .and_then(|content| {
                    content.lines().position(|candidate| {
                        candidate.to_lowercase().contains(&cleaned.to_lowercase())
                            && !candidate.contains("[[")
                    })
                })
                .map(|index| index + 1);
            unlinked.push(UnlinkedMention {
                path: source,
                title: mention_title,
                snippet,
                line,
                term: cleaned.to_string(),
            });
            if unlinked.len() >= 40 {
                break;
            }
        }
        if unlinked.len() >= 40 {
            break;
        }
    }
    Ok(NoteContext {
        path,
        title,
        aliases,
        tags,
        headings,
        backlinks,
        outgoing,
        unlinked,
    })
}

#[tauri::command]
fn vault_tags(state: State<'_, AppState>) -> Result<Vec<VaultTag>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let mut stmt = index
        .connection()
        .prepare(
            "SELECT TRIM(tag, '#'), COUNT(DISTINCT path)
             FROM tags
             WHERE TRIM(tag, '#') <> ''
             GROUP BY 1
             ORDER BY 2 DESC, 1 COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let tags: Vec<VaultTag> = stmt
        .query_map([], |row| {
            Ok(VaultTag {
                tag: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(tags)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TagPage {
    pub path: String,
    pub title: String,
}

#[tauri::command]
fn pages_for_tag(tag: String, state: State<'_, AppState>) -> Result<Vec<TagPage>, String> {
    let needle = tag.trim().trim_start_matches('#').to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let mut stmt = index
        .connection()
        .prepare(
            "SELECT DISTINCT t.path, COALESCE(NULLIF(p.title, ''), p.name, t.path)
             FROM tags t
             LEFT JOIN pages p ON p.path = t.path
             WHERE lower(trim(t.tag, '#')) = ?1
             ORDER BY t.path COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let pages: Vec<TagPage> = stmt
        .query_map(rusqlite::params![needle], |row| {
            Ok(TagPage {
                path: row.get(0)?,
                title: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(pages)
}

fn query_strings(
    connection: &rusqlite::Connection,
    sql: &str,
    path: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows: Vec<String> = stmt
        .query_map(rusqlite::params![path], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
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
    let abs = {
        let guard = state.index.lock();
        let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
        vault_abs(index, &path)?
    };
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
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        _ => return Err(format!("Unsupported embedded media type: {extension}")),
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
fn write_file(
    path: String,
    content: String,
    expected_content: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
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
        let canonical_parent = parent.canonicalize().map_err(|e| e.to_string())?;
        if !canonical_parent.starts_with(&root) {
            return Err("Path escapes vault through a symbolic link".into());
        }
    }
    if abs.exists() {
        let canonical_target = abs.canonicalize().map_err(|e| e.to_string())?;
        if !canonical_target.starts_with(&root) {
            return Err("Path escapes vault through a symbolic link".into());
        }
        if let Some(expected) = expected_content.as_deref() {
            let current = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
            if current != expected {
                return Err(
                    "File changed on disk since it was opened; reload or merge before saving"
                        .into(),
                );
            }
        }
    } else if expected_content.is_some() {
        return Err("File was removed on disk since it was opened; reload before saving".into());
    }
    atomic_write_file(&abs, content.as_bytes())?;
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

/// Replace a vault file from a same-directory temporary file. This prevents a
/// crash or interrupted write from leaving half a Markdown document behind.
fn atomic_write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let parent = path
        .parent()
        .ok_or_else(|| format!("File has no parent directory: {}", path.display()))?;
    let permissions = std::fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).map_err(|e| e.to_string())?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|e| e.to_string())?;
    if let Some(permissions) = permissions {
        temporary
            .as_file_mut()
            .set_permissions(permissions)
            .map_err(|e| e.to_string())?;
    }
    temporary
        .persist(path)
        .map_err(|error| error.error.to_string())?;
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

/// Write a binary attachment (image, audio, …) from base64. Markdown is not rewritten.
#[tauri::command]
fn write_media_file(path: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let bytes = BASE64
        .decode(data.trim())
        .map_err(|error| format!("Invalid attachment encoding: {error}"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Attachment exceeds the 64 MiB limit".into());
    }
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
        let canonical_parent = parent.canonicalize().map_err(|e| e.to_string())?;
        if !canonical_parent.starts_with(&root) {
            return Err("Path escapes vault through a symbolic link".into());
        }
    }
    if abs.exists() {
        let canonical_target = abs.canonicalize().map_err(|e| e.to_string())?;
        if !canonical_target.starts_with(&root) {
            return Err("Path escapes vault through a symbolic link".into());
        }
    }
    atomic_write_file(&abs, &bytes)?;
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
    index.index_path(&path).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PageRow {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub mtime_ms: i64,
    pub size_bytes: i64,
    /// JSON object of frontmatter / properties when available
    pub properties: serde_json::Value,
    pub tags: serde_json::Value,
    pub aliases: serde_json::Value,
    pub links: serde_json::Value,
    pub tasks: serde_json::Value,
    pub inline_fields: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TaskRow {
    pub path: String,
    pub task_id: i64,
    pub status: String,
    pub status_char: String,
    pub text: String,
    pub raw_line: String,
    pub line: i64,
    pub completed: bool,
    pub due: Option<String>,
    pub scheduled: Option<String>,
    pub priority: Option<String>,
    pub recurrence: Option<String>,
    pub start_date: Option<String>,
    pub done_date: Option<String>,
    pub created_date: Option<String>,
    pub cancelled_date: Option<String>,
    pub task_uid: Option<String>,
    pub depends_on: Vec<String>,
    pub on_completion: Option<String>,
    pub tags: Vec<String>,
}

#[tauri::command]
fn list_tasks(
    completed: Option<bool>,
    scope: Option<TaskScope>,
    state: State<'_, AppState>,
) -> Result<Vec<TaskRow>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let sql = "SELECT t.path, t.task_id, t.status, t.status_char, t.text, t.raw_line, t.line, t.completed,
                      t.due, t.scheduled, t.priority, t.recurrence, COALESCE(t.tags_json, '[]'),
                      t.start_date, t.done_date, t.created_date, t.cancelled_date, t.task_uid,
                      COALESCE(t.depends_on_json, '[]'), t.on_completion
               FROM tasks t
               LEFT JOIN file_frontmatter fm ON fm.path = t.path
               WHERE (?1 IS NULL OR t.completed = ?1)
                 AND (?2 = 0
                   OR EXISTS (SELECT 1 FROM json_each(?3) folders
                              WHERE t.path = folders.value OR t.path LIKE folders.value || '/%')
                   OR EXISTS (SELECT 1 FROM json_each(?4) wanted
                              JOIN json_each(COALESCE(t.tags_json, '[]')) actual
                                ON lower(ltrim(actual.value, '#')) = lower(ltrim(wanted.value, '#')))
                   OR (?5 <> '' AND json_type(fm.json, '$.' || ?5) IS NOT NULL
                       AND lower(CAST(json_extract(fm.json, '$.' || ?5) AS TEXT))
                           NOT IN ('', '0', 'false', 'no', 'off', 'null')))
               ORDER BY t.completed, COALESCE(t.due, '9999-12-31'), t.path COLLATE NOCASE, t.line";
    let mut statement = index.connection().prepare(sql).map_err(|e| e.to_string())?;
    let completed_value = completed.map(|value| if value { 1_i64 } else { 0_i64 });
    let scope = scope.unwrap_or(TaskScope {
        folders: Vec::new(),
        tags: Vec::new(),
        property: String::new(),
    });
    let scope_enabled =
        if scope.folders.is_empty() && scope.tags.is_empty() && scope.property.is_empty() {
            0_i64
        } else {
            1_i64
        };
    let folders = serde_json::to_string(&scope.folders).map_err(|error| error.to_string())?;
    let tags = serde_json::to_string(&scope.tags).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            rusqlite::params![
                completed_value,
                scope_enabled,
                folders,
                tags,
                scope.property
            ],
            |row| {
                Ok(TaskRow {
                    path: row.get(0)?,
                    task_id: row.get(1)?,
                    status: row.get(2)?,
                    status_char: row.get(3)?,
                    text: row.get(4)?,
                    raw_line: row.get(5)?,
                    line: row.get(6)?,
                    completed: row.get::<_, i64>(7)? != 0,
                    due: row.get(8)?,
                    scheduled: row.get(9)?,
                    priority: row.get(10)?,
                    recurrence: row.get(11)?,
                    tags: serde_json::from_str(&row.get::<_, String>(12)?).unwrap_or_default(),
                    start_date: row.get(13)?,
                    done_date: row.get(14)?,
                    created_date: row.get(15)?,
                    cancelled_date: row.get(16)?,
                    task_uid: row.get(17)?,
                    depends_on: serde_json::from_str(&row.get::<_, String>(18)?)
                        .unwrap_or_default(),
                    on_completion: row.get(19)?,
                })
            },
        )
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
    let (start, end, recurrence, on_completion, indexed_line): (i64, i64, Option<String>, Option<String>, String) = index
        .connection()
        .query_row(
            "SELECT start_offset, end_offset, recurrence, on_completion, raw_line FROM tasks WHERE path = ?1 AND task_id = ?2",
            rusqlite::params![path, task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| format!("Task is stale or missing: {e}"))?;
    let absolute = vault_abs(index, &path)?;
    let mut content = std::fs::read_to_string(&absolute).map_err(|e| e.to_string())?;
    let from = usize::try_from(start).map_err(|_| "Invalid task offset".to_string())?;
    let to = usize::try_from(end).map_err(|_| "Invalid task offset".to_string())?;
    let line = content
        .get(from..to)
        .ok_or_else(|| "Task offsets are stale".to_string())?;
    let eol = if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    if line.trim_end_matches(['\r', '\n']) != indexed_line {
        return Err("Task changed on disk; refresh before editing its status".into());
    }
    let marker = line
        .find('[')
        .and_then(|open| line[open + 1..].find(']').map(|close| open + 1 + close))
        .ok_or_else(|| "Task checkbox is no longer present".to_string())?;
    let marker_from = from + marker;
    let marker_to = marker_from + 1;
    if !content.is_char_boundary(marker_from) || !content.is_char_boundary(marker_to) {
        return Err("Task checkbox has an invalid byte boundary".into());
    }
    if completed {
        if let Some(recurrence) = recurrence.as_deref() {
            let source = line.trim_end_matches(['\r', '\n']);
            let today = Local::now().date_naive();
            let (completed_line, next_line) = recurring_task_lines(source, recurrence, today)?;
            let replacement = if on_completion.as_deref() == Some("delete") {
                format!("{next_line}{eol}")
            } else {
                format!("{completed_line}{eol}{next_line}{eol}")
            };
            content.replace_range(from..to, &replacement);
        } else if on_completion.as_deref() == Some("delete") {
            content.replace_range(from..to, "");
        } else {
            content.replace_range(marker_from..marker_to, "x");
            let updated_to = to;
            let current = content.get(from..updated_to).unwrap_or_default();
            if !current.contains('✅') {
                let dated = insert_task_metadata(
                    current.trim_end_matches(['\r', '\n']),
                    &format!("✅ {}", Local::now().date_naive().format("%Y-%m-%d")),
                )?;
                content.replace_range(from..updated_to, &format!("{dated}{eol}"));
            }
        }
    } else {
        content.replace_range(marker_from..marker_to, " ");
        let current = content.get(from..to).unwrap_or_default();
        let cleaned = regex::Regex::new(r"\s*✅\s*\d{4}-\d{2}-\d{2}")
            .map_err(|error| error.to_string())?
            .replace_all(current.trim_end_matches(['\r', '\n']), "")
            .into_owned();
        content.replace_range(from..to, &format!("{}{eol}", cleaned.trim_end()));
    }
    atomic_write_file(&absolute, content.as_bytes())?;
    index.index_path(&path).map_err(|e| e.to_string())
}

fn task_line_with_status(line: &str, status: char) -> Result<String, String> {
    let open = line
        .find('[')
        .ok_or_else(|| "Task checkbox is no longer present".to_string())?;
    let close = line[open + 1..]
        .find(']')
        .map(|value| open + 1 + value)
        .ok_or_else(|| "Task checkbox is no longer present".to_string())?;
    let mut output = line.to_string();
    output.replace_range(open + 1..close, &status.to_string());
    Ok(output)
}

fn insert_task_metadata(line: &str, metadata: &str) -> Result<String, String> {
    let block =
        regex::Regex::new(r"(\s+\^[A-Za-z0-9-]+\s*)$").map_err(|error| error.to_string())?;
    let mut output = line.trim_end().to_string();
    if let Some(found) = block.find(&output) {
        output.insert_str(found.start(), &format!(" {metadata}"));
    } else {
        output.push_str(&format!(" {metadata}"));
    }
    Ok(output)
}

fn recurring_task_lines(
    line: &str,
    recurrence: &str,
    today: NaiveDate,
) -> Result<(String, String), String> {
    let mut completed = task_line_with_status(line, 'x')?;
    if !completed.contains('✅') {
        let block =
            regex::Regex::new(r"(\s+\^[A-Za-z0-9-]+\s*)$").map_err(|error| error.to_string())?;
        if let Some(found) = block.find(&completed) {
            completed.insert_str(found.start(), &format!(" ✅ {}", today.format("%Y-%m-%d")));
        } else {
            completed.push_str(&format!(" ✅ {}", today.format("%Y-%m-%d")));
        }
    }
    let mut next = task_line_with_status(line, ' ')?;
    let done =
        regex::Regex::new(r"\s*✅\s*\d{4}-\d{2}-\d{2}").map_err(|error| error.to_string())?;
    next = done.replace_all(&next, "").into_owned();
    let date = regex::Regex::new(r"(📅|⏳|🛫)\s*(\d{4}-\d{2}-\d{2})")
        .map_err(|error| error.to_string())?;
    let when_done = recurrence.to_ascii_lowercase().contains("when done");
    let mut shifted = false;
    next = date
        .replace_all(&next, |captures: &regex::Captures<'_>| {
            let source = if when_done {
                today
            } else {
                NaiveDate::parse_from_str(&captures[2], "%Y-%m-%d").unwrap_or(today)
            };
            match next_recurrence_date(source, recurrence) {
                Ok(value) => {
                    shifted = true;
                    format!("{} {}", &captures[1], value.format("%Y-%m-%d"))
                }
                Err(_) => captures[0].to_string(),
            }
        })
        .into_owned();
    if !shifted {
        let date = next_recurrence_date(today, recurrence)?;
        let block =
            regex::Regex::new(r"(\s+\^[A-Za-z0-9-]+\s*)$").map_err(|error| error.to_string())?;
        if let Some(found) = block.find(&next) {
            next.insert_str(found.start(), &format!(" 📅 {}", date.format("%Y-%m-%d")));
        } else {
            next.push_str(&format!(" 📅 {}", date.format("%Y-%m-%d")));
        }
    }
    Ok((completed, next))
}

fn next_recurrence_date(date: NaiveDate, recurrence: &str) -> Result<NaiveDate, String> {
    let normalized = recurrence.to_ascii_lowercase().replace("when done", "");
    let value = normalized
        .trim()
        .strip_prefix("every ")
        .unwrap_or(normalized.trim())
        .trim();
    if value == "weekday" || value == "weekdays" {
        let mut next = date + ChronoDuration::days(1);
        while matches!(next.weekday(), Weekday::Sat | Weekday::Sun) {
            next += ChronoDuration::days(1);
        }
        return Ok(next);
    }
    let weekdays = [
        ("monday", Weekday::Mon),
        ("tuesday", Weekday::Tue),
        ("wednesday", Weekday::Wed),
        ("thursday", Weekday::Thu),
        ("friday", Weekday::Fri),
        ("saturday", Weekday::Sat),
        ("sunday", Weekday::Sun),
    ];
    let weekday_named = |name: &str| {
        weekdays
            .iter()
            .find(|(candidate, _)| *candidate == name)
            .map(|(_, day)| *day)
    };
    if let Some((_, weekday)) = weekdays.iter().find(|(name, _)| value == *name) {
        let mut next = date + ChronoDuration::days(1);
        while next.weekday() != *weekday {
            next += ChronoDuration::days(1);
        }
        return Ok(next);
    }
    let words = value.split_whitespace().collect::<Vec<_>>();
    if let Some(on) = words.iter().position(|word| *word == "on") {
        let prefix = &words[..on];
        let suffix = &words[on + 1..];
        let count = prefix
            .first()
            .and_then(|word| word.parse::<i64>().ok())
            .unwrap_or(1)
            .max(1);
        let unit = prefix.last().copied().unwrap_or("").trim_end_matches('s');
        if unit == "week" {
            if let Some(target) = suffix.first().and_then(|word| weekday_named(word)) {
                let mut next = date + ChronoDuration::days(1);
                while next.weekday() != target {
                    next += ChronoDuration::days(1);
                }
                return Ok(next + ChronoDuration::weeks(count - 1));
            }
        }
        if unit == "month" {
            let spec = suffix.strip_prefix(&["the"]).unwrap_or(suffix);
            let next_month =
                add_calendar_months(date.with_day(1).ok_or("Invalid recurrence date")?, count)?;
            if spec.first() == Some(&"last") && spec.len() == 1 {
                return last_day_of_month(next_month.year(), next_month.month());
            }
            if let Some(day) = spec.first().and_then(|word| parse_ordinal_number(word)) {
                if spec.len() == 1 {
                    return day_of_month_clamped(next_month.year(), next_month.month(), day);
                }
                if let Some(weekday) = spec.get(1).and_then(|word| weekday_named(word)) {
                    return ordinal_weekday_of_month(
                        next_month.year(),
                        next_month.month(),
                        day,
                        weekday,
                    );
                }
            }
            if spec.first() == Some(&"last") {
                if let Some(weekday) = spec.get(1).and_then(|word| weekday_named(word)) {
                    return last_weekday_of_month(next_month.year(), next_month.month(), weekday);
                }
            }
        }
        if unit == "year" && suffix.len() >= 2 {
            if let Some(month) = parse_month(suffix[0]) {
                if let Some(day) = parse_ordinal_number(suffix[1]) {
                    return day_of_month_clamped(
                        date.year()
                            + i32::try_from(count)
                                .map_err(|_| "Recurrence year is out of range")?,
                        month,
                        day,
                    );
                }
            }
        }
    }
    let (count, unit) = if words.len() >= 2 {
        (words[0].parse::<i64>().unwrap_or(1).max(1), words[1])
    } else {
        (1, words.first().copied().unwrap_or(""))
    };
    match unit.trim_end_matches('s') {
        "day" | "daily" => Ok(date + ChronoDuration::days(count)),
        "week" | "weekly" => Ok(date + ChronoDuration::weeks(count)),
        "month" | "monthly" => add_calendar_months(date, count),
        "year" | "yearly" | "annually" => add_calendar_months(date, count * 12),
        _ => Err(format!("Unsupported recurrence: {recurrence}")),
    }
}

fn parse_ordinal_number(value: &str) -> Option<u32> {
    match value {
        "first" => Some(1),
        "second" => Some(2),
        "third" => Some(3),
        "fourth" => Some(4),
        "fifth" => Some(5),
        _ => value
            .trim_end_matches(|ch: char| ch.is_ascii_alphabetic())
            .parse::<u32>()
            .ok()
            .filter(|day| *day > 0),
    }
}

fn parse_month(value: &str) -> Option<u32> {
    [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ]
    .iter()
    .position(|month| *month == value)
    .map(|index| index as u32 + 1)
}

fn last_day_of_month(year: i32, month: u32) -> Result<NaiveDate, String> {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .map(|date| date - ChronoDuration::days(1))
        .ok_or_else(|| "Invalid recurrence month".into())
}

fn day_of_month_clamped(year: i32, month: u32, day: u32) -> Result<NaiveDate, String> {
    let last = last_day_of_month(year, month)?;
    NaiveDate::from_ymd_opt(year, month, day.min(last.day()))
        .ok_or_else(|| "Invalid recurrence date".into())
}

fn ordinal_weekday_of_month(
    year: i32,
    month: u32,
    ordinal: u32,
    weekday: Weekday,
) -> Result<NaiveDate, String> {
    let mut date = NaiveDate::from_ymd_opt(year, month, 1).ok_or("Invalid recurrence month")?;
    while date.weekday() != weekday {
        date += ChronoDuration::days(1);
    }
    let candidate = date + ChronoDuration::weeks(i64::from(ordinal.saturating_sub(1)));
    if candidate.month() == month {
        Ok(candidate)
    } else {
        last_weekday_of_month(year, month, weekday)
    }
}

fn last_weekday_of_month(year: i32, month: u32, weekday: Weekday) -> Result<NaiveDate, String> {
    let mut date = last_day_of_month(year, month)?;
    while date.weekday() != weekday {
        date -= ChronoDuration::days(1);
    }
    Ok(date)
}

fn add_calendar_months(date: NaiveDate, months: i64) -> Result<NaiveDate, String> {
    let month_index = date.year() as i64 * 12 + date.month0() as i64 + months;
    let year =
        i32::try_from(month_index.div_euclid(12)).map_err(|_| "Recurrence year is out of range")?;
    let month =
        u32::try_from(month_index.rem_euclid(12) + 1).map_err(|_| "Invalid recurrence month")?;
    let mut day = date.day();
    while day > 0 {
        if let Some(value) = NaiveDate::from_ymd_opt(year, month, day) {
            return Ok(value);
        }
        day -= 1;
    }
    Err("Could not calculate recurring date".into())
}

#[tauri::command]
fn set_task_status(
    path: String,
    task_id: i64,
    status: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let status = status
        .chars()
        .next()
        .ok_or_else(|| "Task status is empty".to_string())?;
    if status == 'x' || status == 'X' {
        return set_task_completed(path, task_id, true, state);
    }
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let (start, end, indexed_line): (i64, i64, String) = index
        .connection()
        .query_row(
            "SELECT start_offset, end_offset, raw_line FROM tasks WHERE path = ?1 AND task_id = ?2",
            rusqlite::params![path, task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Task is stale or missing: {error}"))?;
    let absolute = vault_abs(index, &path)?;
    let mut content = std::fs::read_to_string(&absolute).map_err(|error| error.to_string())?;
    let from = usize::try_from(start).map_err(|_| "Invalid task offset".to_string())?;
    let to = usize::try_from(end).map_err(|_| "Invalid task offset".to_string())?;
    let current = content
        .get(from..to)
        .ok_or_else(|| "Task offsets are stale".to_string())?;
    let eol = if current.ends_with("\r\n") {
        "\r\n"
    } else if current.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    if current.trim_end_matches(['\r', '\n']) != indexed_line {
        return Err("Task changed on disk; refresh before editing its status".into());
    }
    let mut replacement = task_line_with_status(&indexed_line, status)?;
    let cancelled =
        regex::Regex::new(r"\s*❌\s*\d{4}-\d{2}-\d{2}").map_err(|error| error.to_string())?;
    replacement = cancelled.replace_all(&replacement, "").into_owned();
    if status == '-' {
        replacement = insert_task_metadata(
            &replacement,
            &format!("❌ {}", Local::now().date_naive().format("%Y-%m-%d")),
        )?;
    }
    content.replace_range(from..to, &format!("{replacement}{eol}"));
    atomic_write_file(&absolute, content.as_bytes())?;
    index.index_path(&path).map_err(|error| error.to_string())
}

/// Replace one indexed task line after checking that its source offsets and
/// checkbox still identify the same task. The frontend uses this for due,
/// scheduled, and priority edits while Markdown remains authoritative.
#[tauri::command]
fn replace_task_line(
    path: String,
    task_id: i64,
    replacement: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if replacement.contains(['\r', '\n']) || replacement.len() > 16_384 {
        return Err("A task replacement must be one reasonably sized line".into());
    }
    if !replacement.contains("[") || !replacement.contains("]") {
        return Err("The replacement is no longer a Markdown task".into());
    }
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let (start, end, indexed_line): (i64, i64, String) = index
        .connection()
        .query_row(
            "SELECT start_offset, end_offset, raw_line FROM tasks WHERE path = ?1 AND task_id = ?2",
            rusqlite::params![path, task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("Task is stale or missing: {error}"))?;
    let absolute = vault_abs(index, &path)?;
    let mut content = std::fs::read_to_string(&absolute).map_err(|error| error.to_string())?;
    let from = usize::try_from(start).map_err(|_| "Invalid task offset".to_string())?;
    let to = usize::try_from(end).map_err(|_| "Invalid task offset".to_string())?;
    let current = content
        .get(from..to)
        .ok_or_else(|| "Task offsets are stale".to_string())?;
    let eol = if current.ends_with("\r\n") {
        "\r\n"
    } else if current.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    if current.trim_end_matches(['\r', '\n']) != indexed_line {
        return Err("Task changed on disk; refresh before editing its metadata".into());
    }
    content.replace_range(from..to, &format!("{replacement}{eol}"));
    atomic_write_file(&absolute, content.as_bytes())?;
    index.index_path(&path).map_err(|error| error.to_string())
}

/// Pages for Dataview-style queries. `source` examples: `"people"`, `"folder/sub"`, empty = all markdown.

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NoteFileMeta {
    pub path: String,
    pub bytes: i64,
    pub user: Option<String>,
    pub group: Option<String>,
    pub mode: Option<u32>,
    pub mtime_ms: Option<i64>,
    pub ctime_ms: Option<i64>,
}

/// Filesystem metadata for the note-level `this.file` object (owner/size).
#[tauri::command]
fn note_file_meta(path: String, state: State<'_, AppState>) -> Result<NoteFileMeta, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    let meta = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    let bytes = meta.len() as i64;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let ctime_ms = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let uid = meta.uid();
        let gid = meta.gid();
        let mode = meta.mode();
        Ok(NoteFileMeta {
            path,
            bytes,
            user: Some(unix_user_name(uid)),
            group: Some(unix_group_name(gid)),
            mode: Some(mode),
            mtime_ms,
            ctime_ms,
        })
    }
    #[cfg(not(unix))]
    {
        Ok(NoteFileMeta {
            path,
            bytes,
            user: None,
            group: None,
            mode: None,
            mtime_ms,
            ctime_ms,
        })
    }
}

#[cfg(unix)]
fn unix_user_name(uid: u32) -> String {
    if let Ok(output) = std::process::Command::new("getent")
        .args(["passwd", &uid.to_string()])
        .output()
    {
        if output.status.success() {
            let line = String::from_utf8_lossy(&output.stdout);
            if let Some(name) = line.split(':').next() {
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    uid.to_string()
}

#[cfg(unix)]
fn unix_group_name(gid: u32) -> String {
    if let Ok(output) = std::process::Command::new("getent")
        .args(["group", &gid.to_string()])
        .output()
    {
        if output.status.success() {
            let line = String::from_utf8_lossy(&output.stdout);
            if let Some(name) = line.split(':').next() {
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    gid.to_string()
}

#[tauri::command]

fn list_pages(source: Option<String>, state: State<'_, AppState>) -> Result<Vec<PageRow>, String> {
    let guard = state.index.lock();
    let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
    let conn = index.connection();

    let src = source.unwrap_or_default();
    let src = src.trim().trim_matches('"').trim_matches('\'').trim();

    let mut sql = String::from(
        "SELECT p.path, p.name, p.folder, p.mtime_ms, f.size_bytes,
                p.properties, p.tags, p.aliases, p.links, p.todos,
                COALESCE((
                    SELECT json_group_array(json_object(
                        'key', inline.key,
                        'value', json(COALESCE(inline.value_json, 'null')),
                        'type', inline.value_type,
                        'line', inline.line
                    ))
                    FROM inline_fields inline
                    WHERE inline.path = p.path
                    ORDER BY inline.field_id
                ), '[]')
         FROM pages p
         JOIN files f ON f.path = p.path
         WHERE 1 = 1",
    );
    let mut rows_out = Vec::new();

    if !src.is_empty() {
        // folder path prefix (Dataview FROM "people")
        sql.push_str(" AND (p.folder = ?1 OR p.folder LIKE ?2 OR p.path LIKE ?3)");
        let like_folder = format!("{src}/%");
        let like_path = format!("{src}/%");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([src, like_folder.as_str(), like_path.as_str()], |r| {
                let path: String = r.get(0)?;
                let name: String = r.get(1)?;
                let folder: String = r.get(2)?;
                let mtime_ms: i64 = r.get(3)?;
                let size_bytes: i64 = r.get(4)?;
                let properties: String = r.get(5)?;
                let tags: String = r.get(6)?;
                let aliases: String = r.get(7)?;
                let links: String = r.get(8)?;
                let tasks: String = r.get(9)?;
                let inline_fields: String = r.get(10)?;
                Ok((
                    path,
                    name,
                    folder,
                    mtime_ms,
                    size_bytes,
                    properties,
                    tags,
                    aliases,
                    links,
                    tasks,
                    inline_fields,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in mapped {
            let (
                path,
                name,
                folder,
                mtime_ms,
                size_bytes,
                properties,
                tags,
                aliases,
                links,
                tasks,
                inline_fields,
            ) = row.map_err(|e| e.to_string())?;
            rows_out.push(PageRow {
                path,
                name,
                folder,
                mtime_ms,
                size_bytes,
                properties: page_properties(Some(&properties)),
                tags: page_json_array(&tags),
                aliases: page_json_array(&aliases),
                links: page_json_array(&links),
                tasks: page_json_array(&tasks),
                inline_fields: page_json_array(&inline_fields),
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
                let size_bytes: i64 = r.get(4)?;
                let properties: String = r.get(5)?;
                let tags: String = r.get(6)?;
                let aliases: String = r.get(7)?;
                let links: String = r.get(8)?;
                let tasks: String = r.get(9)?;
                let inline_fields: String = r.get(10)?;
                Ok((
                    path,
                    name,
                    folder,
                    mtime_ms,
                    size_bytes,
                    properties,
                    tags,
                    aliases,
                    links,
                    tasks,
                    inline_fields,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in mapped {
            let (
                path,
                name,
                folder,
                mtime_ms,
                size_bytes,
                properties,
                tags,
                aliases,
                links,
                tasks,
                inline_fields,
            ) = row.map_err(|e| e.to_string())?;
            rows_out.push(PageRow {
                path,
                name,
                folder,
                mtime_ms,
                size_bytes,
                properties: page_properties(Some(&properties)),
                tags: page_json_array(&tags),
                aliases: page_json_array(&aliases),
                links: page_json_array(&links),
                tasks: page_json_array(&tasks),
                inline_fields: page_json_array(&inline_fields),
            });
        }
    }

    Ok(rows_out)
}

fn page_json_array(json: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .filter(serde_json::Value::is_array)
        .unwrap_or_else(|| serde_json::json!([]))
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
        ValueRef::Blob(b"nephrite:bool:true") => serde_json::Value::Bool(true),
        ValueRef::Blob(b"nephrite:bool:false") => serde_json::Value::Bool(false),
        ValueRef::Blob(value) => serde_json::Value::String(BASE64.encode(value)),
    })
}

fn metadata_case_fold(value: &str) -> String {
    value.chars().flat_map(char::to_lowercase).collect()
}

fn page_property_value<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    requested: &str,
) -> Result<Option<&'a serde_json::Value>, String> {
    if let Some(value) = object.get(requested) {
        return Ok(Some(value));
    }
    let folded = metadata_case_fold(requested);
    let mut matches = object
        .iter()
        .filter(|(key, _)| metadata_case_fold(key) == folded)
        .map(|(_, value)| value);
    let first = matches.next();
    if first.is_some() && matches.next().is_some() {
        return Err(format!(
            "Ambiguous frontmatter property {requested:?}: multiple keys differ only by case"
        ));
    }
    Ok(first)
}

fn strict_page_cast(
    value: rusqlite::types::ValueRef<'_>,
    target: &str,
) -> rusqlite::Result<rusqlite::types::Value> {
    use rusqlite::types::{Value, ValueRef};
    if matches!(value, ValueRef::Null) {
        return Ok(Value::Null);
    }
    let source_text = || -> rusqlite::Result<String> {
        Ok(match value {
            ValueRef::Null => return Ok(String::new()),
            ValueRef::Integer(value) => value.to_string(),
            ValueRef::Real(value) => value.to_string(),
            ValueRef::Text(value) => {
                String::from_utf8(value.to_vec()).map_err(user_function_error)?
            }
            ValueRef::Blob(value) => BASE64.encode(value),
        })
    };
    let invalid = |message: String| {
        user_function_error(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            message,
        ))
    };
    let scalar_target = target.strip_suffix("[]").unwrap_or(target);
    if target.ends_with("[]") {
        let text = source_text()?;
        let parsed: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| invalid(format!("Cannot cast value to {target}: expected an array")))?;
        if !parsed.is_array() {
            return Err(invalid(format!(
                "Cannot cast value to {target}: expected an array"
            )));
        }
        return Ok(Value::Text(parsed.to_string()));
    }
    match scalar_target {
        "text" | "tag" | "alias" | "link" | "header" | "todo" => Ok(Value::Text(source_text()?)),
        "smallint" | "integer" | "bigint" => {
            let integer = match value {
                ValueRef::Integer(value) => value,
                ValueRef::Real(value) if value.fract() == 0.0 => value as i64,
                _ => source_text()?
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| invalid(format!("Cannot cast value to {scalar_target}")))?,
            };
            if scalar_target == "smallint" && !(-32_768..=32_767).contains(&integer) {
                return Err(invalid("smallint out of range".into()));
            }
            if scalar_target == "integer" && !(i32::MIN as i64..=i32::MAX as i64).contains(&integer)
            {
                return Err(invalid("integer out of range".into()));
            }
            Ok(Value::Integer(integer))
        }
        "numeric" | "real" | "double precision" => {
            let number = match value {
                ValueRef::Integer(value) => value as f64,
                ValueRef::Real(value) => value,
                _ => source_text()?
                    .trim()
                    .parse::<f64>()
                    .map_err(|_| invalid(format!("Cannot cast value to {scalar_target}")))?,
            };
            if !number.is_finite() {
                return Err(invalid(format!("Cannot cast non-finite {scalar_target}")));
            }
            Ok(Value::Real(number))
        }
        "boolean" => {
            let folded = metadata_case_fold(source_text()?.trim());
            match folded.as_str() {
                "true" | "t" | "yes" | "y" | "on" | "1" => Ok(Value::Integer(1)),
                "false" | "f" | "no" | "n" | "off" | "0" => Ok(Value::Integer(0)),
                _ => Err(invalid("Cannot cast value to boolean".into())),
            }
        }
        "json" | "jsonb" => {
            let parsed: serde_json::Value = serde_json::from_str(&source_text()?)
                .map_err(|_| invalid(format!("Cannot cast value to {scalar_target}")))?;
            Ok(Value::Text(parsed.to_string()))
        }
        "date" => {
            let text = source_text()?;
            chrono::NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d")
                .map_err(|_| invalid("Cannot cast value to date (expected YYYY-MM-DD)".into()))?;
            Ok(Value::Text(text.trim().to_string()))
        }
        "timestamp" | "timestamp with time zone" | "time" | "time with time zone" => {
            let text = source_text()?;
            let trimmed = text.trim();
            let valid =
                if scalar_target.starts_with("time") && !scalar_target.starts_with("timestamp") {
                    chrono::NaiveTime::parse_from_str(trimmed, "%H:%M:%S%.f").is_ok()
                        || chrono::DateTime::parse_from_rfc3339(&format!("1970-01-01T{trimmed}"))
                            .is_ok()
                } else {
                    chrono::DateTime::parse_from_rfc3339(trimmed).is_ok()
                        || chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S%.f")
                            .is_ok()
                        || chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f")
                            .is_ok()
                };
            if !valid {
                return Err(invalid(format!("Cannot cast value to {scalar_target}")));
            }
            Ok(Value::Text(trimmed.to_string()))
        }
        _ => Err(invalid(format!(
            "Unsupported PostgreSQL cast target: {target}"
        ))),
    }
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
        .create_scalar_function("page_bool", 1, SAFE, |context| {
            Ok(if context.get::<i64>(0)? == 0 {
                b"nephrite:bool:false".to_vec()
            } else {
                b"nephrite:bool:true".to_vec()
            })
        })
        .map_err(|error| format!("register page_bool: {error}"))?;
    connection
        .create_scalar_function("page_cast", 2, SAFE, |context| {
            let target = context.get::<String>(1)?;
            strict_page_cast(context.get_raw(0), &target)
        })
        .map_err(|error| format!("register page_cast: {error}"))?;
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
        .create_scalar_function("jsonb_array_length", 1, SAFE, |context| {
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
    for (name, sample) in [("array_shuffle", false), ("array_sample", true)] {
        connection
            .create_scalar_function(
                name,
                if sample { 2 } else { 1 },
                FunctionFlags::SQLITE_INNOCUOUS,
                move |context| {
                    use std::sync::atomic::{AtomicU64, Ordering};
                    static SEED: AtomicU64 = AtomicU64::new(0x9e3779b97f4a7c15);
                    let mut array = parse_page_array(context.get::<String>(0)?.as_str())?;
                    let mut state = SEED.fetch_add(0x9e3779b97f4a7c15, Ordering::Relaxed)
                        ^ std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|duration| duration.as_nanos() as u64)
                            .unwrap_or(0);
                    for index in (1..array.len()).rev() {
                        state ^= state << 13;
                        state ^= state >> 7;
                        state ^= state << 17;
                        array.swap(index, state as usize % (index + 1));
                    }
                    if sample {
                        let count = context.get::<i64>(1)?;
                        if count < 0 {
                            return Err(user_function_error(std::io::Error::new(
                                std::io::ErrorKind::InvalidInput,
                                "sample size must not be negative",
                            )));
                        }
                        array.truncate((count as usize).min(array.len()));
                    }
                    serde_json::to_string(&array).map_err(user_function_error)
                },
            )
            .map_err(|error| error.to_string())?;
    }
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
        .pragma_update(None, "case_sensitive_like", true)
        .map_err(|error| format!("enable PostgreSQL LIKE case semantics: {error}"))?;
    connection
        .create_scalar_function(
            "unicode_lower",
            1,
            FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
            |context| Ok(metadata_case_fold(&context.get::<String>(0)?)),
        )
        .map_err(|error| error.to_string())?;
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
                let wanted = metadata_case_fold(wanted);
                Ok(tags
                    .iter()
                    .any(|tag| metadata_case_fold(tag.trim_start_matches('#')) == wanted))
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
                let value = object
                    .as_object()
                    .map(|object| page_property_value(object, &key))
                    .transpose()
                    .map_err(|message| {
                        user_function_error(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            message,
                        ))
                    })?
                    .flatten()
                    .unwrap_or(&serde_json::Value::Null);
                Ok(match value {
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
    connection
        .create_scalar_function(
            "page_has_key",
            2,
            FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
            |context| {
                let source = context.get::<String>(0)?;
                let key = context.get::<String>(1)?;
                let object = serde_json::from_str::<serde_json::Value>(&source).unwrap_or_default();
                object
                    .as_object()
                    .map(|object| page_property_value(object, &key).map(|value| value.is_some()))
                    .transpose()
                    .map(|value| value.unwrap_or(false))
                    .map_err(|message| {
                        user_function_error(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            message,
                        ))
                    })
            },
        )
        .map_err(|error| error.to_string())?;
    let translated =
        page_sql::lower_page_sql(sql, translate_page_sql, translate_page_sql_residual)?;
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
///
/// Supported page surface (v0.2 → expanded):
///   properties['key']          → page_property(properties, 'key')
///   properties->>'key'         → page_property(properties, 'key')
///   properties->'key'          → page_property(properties, 'key')  (text for now)
///   properties ? 'key'         → page_has_key(properties, 'key')
///   properties ?& ARRAY[...]   → AND of page_has_key
///   properties ?| ARRAY[...]   → OR of page_has_key
///   tags @> ARRAY[...]         → AND of page_has_tag
///   tags && ARRAY[...]         → OR  of page_has_tag
///   aliases @> / && ARRAY[...] → same, using page_has_tag helper (array of strings)
///   'x' = ANY(tags)            → page_has_tag
///   ARRAY[...]                 → page_array(...)
///   EXTRACT(field FROM expr)   → date_part('field', expr)
///   string_agg / bool_and / bool_or / every → SQLite equivalents
fn translate_page_sql(sql: &str) -> Result<String, String> {
    let translated = translate_page_sql_forms(sql)?;
    translate_page_sql_residual(&translated)
}

/// Page-semantic forms still handled textually when the AST walker misses them.
fn translate_page_sql_forms(sql: &str) -> Result<String, String> {
    // properties['key']
    let property_bracket = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?properties)\s*\[\s*'((?:''|[^'])*)'\s*\]",
    )
    .map_err(|error| error.to_string())?;
    let mut translated = property_bracket
        .replace_all(sql, |captures: &regex::Captures<'_>| {
            format!("page_property({}, '{}')", &captures[1], &captures[2])
        })
        .into_owned();

    // properties->>'key' and properties->'key'
    let property_arrow =
        regex::Regex::new(r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?properties)\s*->>?\s*'((?:''|[^'])*)'")
            .map_err(|error| error.to_string())?;
    translated = property_arrow
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("page_property({}, '{}')", &captures[1], &captures[2])
        })
        .into_owned();

    // jsonb_exists(properties, 'key')
    let jsonb_exists = regex::Regex::new(
        r"(?i)\bjsonb_exists\s*\(\s*((?:[a-z_][a-z0-9_]*\.)?properties)\s*,\s*'((?:''|[^'])*)'\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = jsonb_exists
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("page_has_key({}, '{}')", &captures[1], &captures[2])
        })
        .into_owned();

    // properties ? 'key'
    let property_exists =
        regex::Regex::new(r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?properties)\s*\?\s*'((?:''|[^'])*)'")
            .map_err(|error| error.to_string())?;
    translated = property_exists
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("page_has_key({}, '{}')", &captures[1], &captures[2])
        })
        .into_owned();

    let string_literal =
        regex::Regex::new(r"'((?:''|[^'])*)'").map_err(|error| error.to_string())?;

    // properties ?& ARRAY[...]  (all keys exist)
    let property_all_keys = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?properties)\s*\?&\s*ARRAY\s*\[([^\]]*)\]",
    )
    .map_err(|error| error.to_string())?;
    translated = property_all_keys
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let items = string_literal
                .captures_iter(&captures[2])
                .map(|m| m[1].to_string())
                .collect::<Vec<_>>();
            let residue = string_literal.replace_all(&captures[2], "");
            if !residue.chars().all(|c| c.is_whitespace() || c == ',') {
                return captures[0].to_string();
            }
            if items.is_empty() {
                return "1".to_string();
            }
            format!(
                "({})",
                items
                    .iter()
                    .map(|item| format!("page_has_key({}, '{}')", &captures[1], item))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            )
        })
        .into_owned();

    // properties ?| ARRAY[...]  (any key exists)
    let property_any_keys = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?properties)\s*\?\|\s*ARRAY\s*\[([^\]]*)\]",
    )
    .map_err(|error| error.to_string())?;
    translated = property_any_keys
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let items = string_literal
                .captures_iter(&captures[2])
                .map(|m| m[1].to_string())
                .collect::<Vec<_>>();
            let residue = string_literal.replace_all(&captures[2], "");
            if !residue.chars().all(|c| c.is_whitespace() || c == ',') {
                return captures[0].to_string();
            }
            if items.is_empty() {
                return "0".to_string();
            }
            format!(
                "({})",
                items
                    .iter()
                    .map(|item| format!("page_has_key({}, '{}')", &captures[1], item))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )
        })
        .into_owned();

    // jsonb_exists_all(properties, ARRAY[...])
    let jsonb_exists_all = regex::Regex::new(
        r"(?i)\bjsonb_exists_all\s*\(\s*((?:[a-z_][a-z0-9_]*\.)?properties)\s*,\s*ARRAY\s*\[([^\]]*)\]\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = jsonb_exists_all
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let items = string_literal
                .captures_iter(&captures[2])
                .map(|m| m[1].to_string())
                .collect::<Vec<_>>();
            if items.is_empty() {
                return "1".to_string();
            }
            format!(
                "({})",
                items
                    .iter()
                    .map(|item| format!("page_has_key({}, '{}')", &captures[1], item))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            )
        })
        .into_owned();

    // jsonb_exists_any(properties, ARRAY[...])
    let jsonb_exists_any = regex::Regex::new(
        r"(?i)\bjsonb_exists_any\s*\(\s*((?:[a-z_][a-z0-9_]*\.)?properties)\s*,\s*ARRAY\s*\[([^\]]*)\]\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = jsonb_exists_any
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let items = string_literal
                .captures_iter(&captures[2])
                .map(|m| m[1].to_string())
                .collect::<Vec<_>>();
            if items.is_empty() {
                return "0".to_string();
            }
            format!(
                "({})",
                items
                    .iter()
                    .map(|item| format!("page_has_key({}, '{}')", &captures[1], item))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )
        })
        .into_owned();

    // 'x' = ANY(tags|aliases)
    let any_array = regex::Regex::new(
        r"(?i)'((?:''|[^'])*)'\s*=\s*ANY\s*\(\s*((?:[a-z_][a-z0-9_]*\.)?(?:tags|aliases))\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = any_array
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("page_has_tag({}, '{}')", &captures[2], &captures[1])
        })
        .into_owned();

    // (tags|aliases) @> ARRAY[...]
    let contains = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?(?:tags|aliases))\s*@>\s*ARRAY\s*\[([^\]]*)\]",
    )
    .map_err(|error| error.to_string())?;
    translated = contains
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let items = string_literal
                .captures_iter(&captures[2])
                .map(|m| m[1].to_string())
                .collect::<Vec<_>>();
            let residue = string_literal.replace_all(&captures[2], "");
            if !residue.chars().all(|c| c.is_whitespace() || c == ',') {
                return captures[0].to_string();
            }
            if items.is_empty() {
                return "1".to_string();
            }
            format!(
                "({})",
                items
                    .iter()
                    .map(|item| format!("page_has_tag({}, '{}')", &captures[1], item))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            )
        })
        .into_owned();

    // (tags|aliases) && ARRAY[...]
    let overlaps = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?(?:tags|aliases))\s*&&\s*ARRAY\s*\[([^\]]*)\]",
    )
    .map_err(|error| error.to_string())?;
    translated = overlaps
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let items = string_literal
                .captures_iter(&captures[2])
                .map(|m| m[1].to_string())
                .collect::<Vec<_>>();
            let residue = string_literal.replace_all(&captures[2], "");
            if !residue.chars().all(|c| c.is_whitespace() || c == ',') {
                return captures[0].to_string();
            }
            if items.is_empty() {
                return "0".to_string();
            }
            format!(
                "({})",
                items
                    .iter()
                    .map(|item| format!("page_has_tag({}, '{}')", &captures[1], item))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )
        })
        .into_owned();

    // (tags|aliases) && page_array(...)
    let overlaps_pa = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?(?:tags|aliases))\s*&&\s*page_array\s*\(([^)]*)\)",
    )
    .map_err(|error| error.to_string())?;
    translated = overlaps_pa
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let items = string_literal
                .captures_iter(&captures[2])
                .map(|m| m[1].to_string())
                .collect::<Vec<_>>();
            if items.is_empty() {
                return "0".to_string();
            }
            format!(
                "({})",
                items
                    .iter()
                    .map(|item| format!("page_has_tag({}, '{}')", &captures[1], item))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )
        })
        .into_owned();

    // (tags|aliases) @> page_array(...)
    let contains_pa = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_]*\.)?(?:tags|aliases))\s*@>\s*page_array\s*\(([^)]*)\)",
    )
    .map_err(|error| error.to_string())?;
    translated = contains_pa
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let items = string_literal
                .captures_iter(&captures[2])
                .map(|m| m[1].to_string())
                .collect::<Vec<_>>();
            if items.is_empty() {
                return "1".to_string();
            }
            format!(
                "({})",
                items
                    .iter()
                    .map(|item| format!("page_has_tag({}, '{}')", &captures[1], item))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            )
        })
        .into_owned();

    Ok(translated)
}

/// Residual lowering after AST page rewrites (or as the tail of full textual).
fn translate_page_sql_residual(sql: &str) -> Result<String, String> {
    // Fill page forms whose sibling source spans were not selected by the AST
    // rewrite. This transformation is idempotent.
    let mut translated = translate_page_sql_forms(sql)?;
    translated = lower_textual_casts(&translated)?;
    // Casts must be handled by the PostgreSQL AST path and perform a real
    // conversion. Never erase a cast: that silently changes query semantics.
    let unresolved_cast =
        regex::Regex::new(r"(?i)::\s*[a-z_]|\bCAST\s*\(").map_err(|error| error.to_string())?;
    if unresolved_cast.is_match(&translated) {
        return Err(format!(
            "A PostgreSQL cast could not be lowered safely: {translated}"
        ));
    }
    // Syntax residual only (operators, SQL-standard forms). Function names
    // stay intact for postgres_compat UDFs.
    translated = page_sql::lower_pg_syntax(&translated);

    // ARRAY constructor (not already consumed by page tag forms)
    let array_constructor =
        regex::Regex::new(r"(?i)\bARRAY\s*\[([^\[\]]*)\]").map_err(|error| error.to_string())?;
    translated = array_constructor
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("page_array({})", &captures[1])
        })
        .into_owned();
    translated = page_sql::lower_json_operators(&translated);
    translated = page_sql::lower_array_operators(&translated);

    let extract = regex::Regex::new(r"(?i)\bEXTRACT\s*\(\s*([a-z_]+)\s+FROM\s+([^()]+?)\s*\)")
        .map_err(|error| error.to_string())?;
    translated = extract
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("date_part('{}', {})", &captures[1], &captures[2])
        })
        .into_owned();

    // ILIKE → case-insensitive LIKE
    let ilike = regex::Regex::new(
        r"(?i)\b((?:[a-z_][a-z0-9_$.]*)|page_property\([^)]+\)|page_has_key\([^)]+\))\s+ILIKE\s+('(?:''|[^'])*')",
    )
    .map_err(|error| error.to_string())?;
    translated = ilike
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!(
                "unicode_lower({}) LIKE unicode_lower({})",
                &captures[1], &captures[2]
            )
        })
        .into_owned();

    let aggregate = regex::Regex::new(r"(?i)\b(string_agg|array_agg|json_agg|jsonb_agg|json_object_agg|jsonb_object_agg|bool_and|bool_or|every)\s*\(")
        .map_err(|error| error.to_string())?;
    translated = aggregate
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let function = match captures[1].to_ascii_lowercase().as_str() {
                "string_agg" => "group_concat",
                "array_agg" => "json_group_array",
                "json_agg" | "jsonb_agg" => "json_group_array",
                "json_object_agg" | "jsonb_object_agg" => "json_group_object",
                "bool_or" => "max",
                _ => "min",
            };
            format!("{function}(")
        })
        .into_owned();

    // PostgreSQL: (VALUES (...), ...) AS alias(col1, col2)
    // SQLite (bundled): VALUES columns are column1..columnN; table(col) alias form
    // is not always available — expand to SELECT columnN AS col FROM (VALUES ...) AS alias
    // to_char(x, format) — common ISO-ish formats only
    let to_char = regex::Regex::new(r"(?i)\bto_char\s*\(\s*([^,]+?)\s*,\s*'([^']*)'\s*\)")
        .map_err(|error| error.to_string())?;
    translated = to_char
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let source = captures[1].trim();
            let fmt = &captures[2];
            let sqlite_fmt = match fmt {
                "YYYY-MM-DD" | "yyyy-mm-dd" => "%Y-%m-%d",
                "YYYY-MM" | "yyyy-mm" => "%Y-%m",
                "YYYY" | "yyyy" => "%Y",
                "HH24:MI:SS" | "hh24:mi:ss" => "%H:%M:%S",
                "YYYY-MM-DD HH24:MI:SS" | "yyyy-mm-dd hh24:mi:ss" => "%Y-%m-%d %H:%M:%S",
                _ => "",
            };
            if sqlite_fmt.is_empty() {
                captures[0].to_string()
            } else {
                format!("strftime('{sqlite_fmt}', {source})")
            }
        })
        .into_owned();

    // strpos(haystack, needle) / position(needle in haystack) → instr
    let strpos = regex::Regex::new(r"(?i)\bstrpos\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)")
        .map_err(|error| error.to_string())?;
    translated = strpos
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("instr({}, {})", captures[1].trim(), captures[2].trim())
        })
        .into_owned();
    let position = regex::Regex::new(r"(?i)\bposition\s*\(\s*([^)]+?)\s+IN\s+([^)]+?)\s*\)")
        .map_err(|error| error.to_string())?;
    translated = position
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("instr({}, {})", captures[2].trim(), captures[1].trim())
        })
        .into_owned();

    // substring(s from n for len) → substr(s, n, len); substring(s from n) → substr(s, n)
    let substr_for = regex::Regex::new(
        r"(?i)\bsubstring\s*\(\s*([^)]+?)\s+FROM\s+([^)]+?)\s+FOR\s+([^)]+?)\s*\)",
    )
    .map_err(|error| error.to_string())?;
    translated = substr_for
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!(
                "substr({}, {}, {})",
                captures[1].trim(),
                captures[2].trim(),
                captures[3].trim()
            )
        })
        .into_owned();
    let substr_from = regex::Regex::new(r"(?i)\bsubstring\s*\(\s*([^)]+?)\s+FROM\s+([^)]+?)\s*\)")
        .map_err(|error| error.to_string())?;
    translated = substr_from
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            format!("substr({}, {})", captures[1].trim(), captures[2].trim())
        })
        .into_owned();

    // date_trunc('unit', source) → SQLite date/strftime
    let date_trunc = regex::Regex::new(r"(?i)\bdate_trunc\s*\(\s*'([^']+)'\s*,\s*([^)]+?)\s*\)")
        .map_err(|error| error.to_string())?;
    translated = date_trunc
        .replace_all(&translated, |captures: &regex::Captures<'_>| {
            let unit = captures[1].to_ascii_lowercase();
            let source = captures[2].trim();
            match unit.as_str() {
                "day" | "days" => format!("date({source})"),
                "month" | "months" => format!("strftime('%Y-%m-01', {source})"),
                "year" | "years" => format!("strftime('%Y-01-01', {source})"),
                "hour" | "hours" => format!("strftime('%Y-%m-%d %H:00:00', {source})"),
                _ => captures[0].to_string(),
            }
        })
        .into_owned();

    // IS [NOT] DISTINCT FROM → SQLite null-safe IS / IS NOT
    // SQLite: `IS` / `IS NOT` are null-safe, matching DISTINCT FROM semantics.
    let not_distinct = regex::Regex::new(r"(?i)\bIS\s+NOT\s+DISTINCT\s+FROM\b")
        .map_err(|error| error.to_string())?;
    translated = not_distinct.replace_all(&translated, "IS").into_owned();
    let is_distinct =
        regex::Regex::new(r"(?i)\bIS\s+DISTINCT\s+FROM\b").map_err(|error| error.to_string())?;
    translated = is_distinct.replace_all(&translated, "IS NOT").into_owned();

    translated = lower_values_table_alias(&translated);

    Ok(translated)
}

fn textual_cast_name(raw: &str) -> Result<String, String> {
    let compact = raw
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let array = compact.ends_with("[]");
    let scalar = compact
        .trim_end_matches("[]")
        .split('(')
        .next()
        .unwrap_or("")
        .trim();
    let canonical = match scalar {
        "text" | "varchar" | "character varying" | "char" | "character" | "name" => "text",
        "int2" | "smallint" => "smallint",
        "int" | "int4" | "integer" => "integer",
        "int8" | "bigint" => "bigint",
        "numeric" | "decimal" => "numeric",
        "float4" | "real" => "real",
        "float8" | "double precision" => "double precision",
        "bool" | "boolean" => "boolean",
        "json" => "json",
        "jsonb" => "jsonb",
        "date" => "date",
        "timestamp" | "timestamp without time zone" => "timestamp",
        "timestamptz" | "timestamp with time zone" => "timestamp with time zone",
        "time" | "time without time zone" => "time",
        "timetz" | "time with time zone" => "time with time zone",
        "tag" | "alias" | "link" | "header" | "todo" => scalar,
        _ => return Err(format!("Unsupported PostgreSQL cast target: {raw}")),
    };
    Ok(if array {
        format!("{canonical}[]")
    } else {
        canonical.into()
    })
}

fn lower_textual_casts(sql: &str) -> Result<String, String> {
    let atom = r"(?:'(?:''|[^'])*'|-?[0-9]+(?:\.[0-9]+)?|[A-Za-z_][A-Za-z0-9_$.]*|page_property\([^()]*\)|page_array\([^()]*\))";
    let type_name = r"[A-Za-z_][A-Za-z0-9_]*(?:\s+(?:precision|varying|with\s+time\s+zone|without\s+time\s+zone))?(?:\s*\([^)]*\))?(?:\[\])?";
    let postfix = regex::Regex::new(&format!(r"(?i)({atom})\s*::\s*({type_name})"))
        .map_err(|error| error.to_string())?;
    let mut failure = None;
    let mut lowered = postfix
        .replace_all(
            sql,
            |captures: &regex::Captures<'_>| match textual_cast_name(&captures[2]) {
                Ok(target) => format!("page_cast({}, '{target}')", &captures[1]),
                Err(error) => {
                    failure = Some(error);
                    captures[0].to_string()
                }
            },
        )
        .into_owned();
    if let Some(error) = failure.take() {
        return Err(error);
    }
    let cast = regex::Regex::new(&format!(
        r"(?i)\bCAST\s*\(\s*({atom})\s+AS\s+({type_name})\s*\)"
    ))
    .map_err(|error| error.to_string())?;
    lowered = cast
        .replace_all(
            &lowered,
            |captures: &regex::Captures<'_>| match textual_cast_name(&captures[2]) {
                Ok(target) => format!("page_cast({}, '{target}')", &captures[1]),
                Err(error) => {
                    failure = Some(error);
                    captures[0].to_string()
                }
            },
        )
        .into_owned();
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(lowered)
}

/// Rewrite `(VALUES ...) AS alias(c1, c2, ...)` for SQLite.
fn lower_values_table_alias(sql: &str) -> String {
    // Match: (VALUES ...) AS name(col, col, ...)
    // Non-greedy VALUES body; columns are simple identifiers.
    let re = match regex::Regex::new(
        r"(?is)\(\s*VALUES\s*((?:\([^;]*?\))(?:\s*,\s*\([^;]*?\))*)\s*\)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\)",
    ) {
        Ok(r) => r,
        Err(_) => return sql.to_string(),
    };
    re.replace_all(sql, |captures: &regex::Captures<'_>| {
        let values_body = captures[1].trim();
        let alias = &captures[2];
        let cols: Vec<&str> = captures[3]
            .split(',')
            .map(|c| c.trim())
            .filter(|c| !c.is_empty())
            .collect();
        if cols.is_empty() {
            return captures[0].to_string();
        }
        let select_list = cols
            .iter()
            .enumerate()
            .map(|(i, col)| format!("column{} AS {col}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        format!("(SELECT {select_list} FROM (VALUES {values_body}) AS _nephrite_values) AS {alias}")
    })
    .into_owned()
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
    index
        .resolve_link(&target, from_path.as_deref())
        .map_err(|e| e.to_string())
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

fn wikilink_key(path: &str) -> String {
    nephrite_index::wikilink_key(path)
}

fn base_segment(key: &str) -> String {
    key.rsplit('/').next().unwrap_or(key).to_string()
}

/// Whether `base` uniquely identifies the renamed target across the whole vault.
/// Matches the by_stem/name/no_ext resolution semantics used by `resolve_target`.
fn base_target_unique(index: &VaultIndex, base: &str) -> Result<bool, String> {
    let n: i64 = index
        .connection()
        .query_row(
            "SELECT COUNT(*) FROM files WHERE stem = ?1 OR name = ?1 OR path = ?1",
            rusqlite::params![base],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n <= 1)
}

/// Compute the replacement text for one indexed wikilink/embed after a rename.
/// Returns `None` when the link should be left untouched.
struct WikilinkRewriteContext<'a> {
    from: &'a str,
    to: &'a str,
    from_key: &'a str,
    to_key: &'a str,
    to_base_unique: bool,
}

fn compute_wikilink_rewrite(
    target_raw: &str,
    target_heading: &Option<String>,
    target_block: &Option<String>,
    display_text: &Option<String>,
    is_embed: bool,
    resolved_target_path: Option<&str>,
    context: &WikilinkRewriteContext<'_>,
) -> Option<String> {
    let new_raw: String = if let Some(rtp) = resolved_target_path {
        // Resolved link: rewrite the resolved path, preserving link "shape".
        let suffix = rtp.strip_prefix(context.from)?;
        let new_full = if suffix.is_empty() {
            context.to.to_string()
        } else {
            format!("{}{suffix}", context.to)
        };
        let new_full_key = wikilink_key(&new_full);
        if target_raw.contains('/') {
            new_full_key
        } else if context.to_base_unique {
            base_segment(&new_full_key)
        } else {
            new_full_key
        }
    } else {
        // Unresolved wikilink: match by raw identity against the old file.
        let raw_key = wikilink_key(target_raw.trim());
        let raw_base = base_segment(&raw_key);
        let from_base = base_segment(context.from_key);
        let to_base = base_segment(context.to_key);
        if raw_key == context.from_key || raw_key == wikilink_key(context.from) {
            context.to_key.to_string()
        } else if raw_base == from_base {
            if raw_key.contains('/') {
                if let Some(rest) = raw_key.strip_prefix(context.from_key) {
                    format!("{}{rest}", context.to_key)
                } else {
                    context.to_key.to_string()
                }
            } else {
                to_base
            }
        } else {
            return None;
        }
    };
    let mut inner = new_raw;
    if let Some(h) = target_heading {
        inner.push('#');
        inner.push_str(h);
    }
    if let Some(b) = target_block {
        inner.push_str("#^");
        inner.push_str(b);
    }
    if let Some(d) = display_text {
        if !d.is_empty() {
            inner.push('|');
            inner.push_str(d);
        }
    }
    let mut link = String::new();
    if is_embed {
        link.push('!');
    }
    link.push_str("[[");
    link.push_str(&inner);
    link.push_str("]]");
    Some(link)
}

struct LinkRewrite {
    source: String,
    start: i64,
    end: i64,
    new_text: String,
}

/// Collect wikilink/embed rewrites across every file that references `from`.
fn collect_link_rewrites(
    index: &VaultIndex,
    from: &str,
    to: &str,
) -> Result<Vec<LinkRewrite>, String> {
    let conn = index.connection();
    let from_key = wikilink_key(from);
    let to_key = wikilink_key(to);
    let from_base = base_segment(&from_key);
    let to_base_unique = base_target_unique(index, &base_segment(&to_key))?;
    let context = WikilinkRewriteContext {
        from,
        to,
        from_key: &from_key,
        to_key: &to_key,
        to_base_unique,
    };
    let mut rewrites: Vec<LinkRewrite> = Vec::new();

    // Resolved links (target_path == from, or a child of `from` for dir moves).
    {
        let mut stmt = conn
            .prepare(
                "SELECT path, target_raw, target_heading, target_block, display_text, is_embed, \
                 start_offset, end_offset, target_path \
                 FROM links \
                 WHERE link_kind = 'wikilink' AND (target_path = ?1 OR target_path LIKE ?1 || '/%')",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![from], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (src, raw, heading, block, display, is_embed, start, end, target_path) =
                row.map_err(|e| e.to_string())?;
            if let Some(text) = compute_wikilink_rewrite(
                &raw,
                &heading,
                &block,
                &display,
                is_embed != 0,
                target_path.as_deref(),
                &context,
            ) {
                rewrites.push(LinkRewrite {
                    source: src,
                    start,
                    end,
                    new_text: text,
                });
            }
        }
    }

    // Unresolved wikilinks whose raw target identifies the old file.
    {
        let mut stmt = conn
            .prepare(
                "SELECT path, target_raw, target_heading, target_block, display_text, is_embed, \
                 start_offset, end_offset \
                 FROM links \
                 WHERE link_kind = 'wikilink' AND target_path IS NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (src, raw, heading, block, display, is_embed, start, end) =
                row.map_err(|e| e.to_string())?;
            let raw_key = wikilink_key(raw.trim());
            let raw_base = base_segment(&raw_key);
            let matches =
                raw_key == from_key || raw_key == wikilink_key(from) || raw_base == from_base;
            if !matches {
                continue;
            }
            if let Some(text) = compute_wikilink_rewrite(
                &raw,
                &heading,
                &block,
                &display,
                is_embed != 0,
                None,
                &context,
            ) {
                rewrites.push(LinkRewrite {
                    source: src,
                    start,
                    end,
                    new_text: text,
                });
            }
        }
    }

    Ok(rewrites)
}

/// Rewrite the path portion of ordinary Markdown `[text](url)` / `![](url)` refs.
fn rewrite_ref_url(url: &str, variants: &[(String, String)]) -> Option<String> {
    let (path, fragment) = match url.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (url, None),
    };
    let path_trim = path.trim();
    let norm = path_trim.trim_start_matches("./").trim_start_matches('/');
    for (from, to) in variants {
        if norm == *from {
            let mut repl = to.clone();
            if path_trim.starts_with("./") {
                repl = format!("./{repl}");
            } else if path_trim.starts_with('/') {
                repl = format!("/{repl}");
            }
            if let Some(f) = fragment {
                repl.push('#');
                repl.push_str(f);
            }
            return Some(repl);
        }
    }
    None
}

fn rewrite_markdown_refs(text: &str, variants: &[(String, String)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fenced: Option<char> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().filter(|ch| *ch == '`' || *ch == '~');
        let marker_count = marker
            .map(|ch| {
                trimmed
                    .chars()
                    .take_while(|candidate| *candidate == ch)
                    .count()
            })
            .unwrap_or(0);
        if marker_count >= 3 {
            if fenced == marker {
                fenced = None;
            } else if fenced.is_none() {
                fenced = marker;
            }
            out.push_str(line);
            continue;
        }
        if fenced.is_some() {
            out.push_str(line);
            continue;
        }
        out.push_str(&rewrite_markdown_ref_line(line, variants));
    }
    out
}

fn rewrite_markdown_ref_line(line: &str, variants: &[(String, String)]) -> String {
    let bytes = line.as_bytes();
    let mut output = String::with_capacity(line.len());
    let mut cursor = 0;
    let mut index = 0;
    let mut inline_ticks = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'`' {
            let run = bytes[index..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            inline_ticks = if inline_ticks == run {
                0
            } else if inline_ticks == 0 {
                run
            } else {
                inline_ticks
            };
            index += run;
            continue;
        }
        if inline_ticks == 0 && bytes[index] == b']' && bytes.get(index + 1) == Some(&b'(') {
            let mut start = index + 2;
            while bytes
                .get(start)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                start += 1;
            }
            let (url_start, mut end, angled) = if bytes.get(start) == Some(&b'<') {
                (start + 1, start + 1, true)
            } else {
                (start, start, false)
            };
            let mut nested = 0usize;
            let mut escaped = false;
            while end < bytes.len() {
                let byte = bytes[end];
                if escaped {
                    escaped = false;
                    end += 1;
                    continue;
                }
                if byte == b'\\' {
                    escaped = true;
                    end += 1;
                    continue;
                }
                if angled && byte == b'>' {
                    break;
                }
                if !angled {
                    if byte == b'(' {
                        nested += 1;
                    } else if byte == b')' {
                        if nested == 0 {
                            break;
                        }
                        nested -= 1;
                    } else if byte.is_ascii_whitespace() && nested == 0 {
                        break;
                    }
                }
                end += 1;
            }
            if end > url_start {
                if let Some(replacement) = rewrite_ref_url(&line[url_start..end], variants) {
                    output.push_str(&line[cursor..url_start]);
                    output.push_str(&replacement);
                    cursor = end;
                    index = end;
                    continue;
                }
            }
        }
        index += 1;
    }
    output.push_str(&line[cursor..]);
    output
}

/// Scan every Markdown file for Markdown-style references to the renamed path and
/// rewrite them, returning the set of changed files.
fn collect_markdown_ref_rewrites(
    index: &VaultIndex,
    from: &str,
    to: &str,
) -> Result<Vec<(String, String)>, String> {
    let from_key = wikilink_key(from);
    let to_key = wikilink_key(to);
    let variants: Vec<(String, String)> = vec![
        (from.to_string(), to.to_string()),
        (from_key.clone(), to_key.clone()),
        (base_segment(from), base_segment(to)),
        (base_segment(&from_key), base_segment(&to_key)),
    ];
    let paths: Vec<String> = index
        .connection()
        .prepare("SELECT path FROM files WHERE file_kind = 'markdown'")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let mut changed = Vec::new();
    for rel in paths {
        let abs = vault_abs(index, &rel)?;
        let raw = match std::fs::read(&abs) {
            Ok(b) => match String::from_utf8(b) {
                Ok(s) => s,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        let rewritten = rewrite_markdown_refs(&raw, &variants);
        if rewritten != raw {
            changed.push((rel, rewritten));
        }
    }
    Ok(changed)
}

/// Apply collected rewrites to the vault: splice wikilinks by byte offset and
/// rewrite Markdown refs, then re-index every changed file.
fn apply_rewrites(
    index: &mut VaultIndex,
    from: &str,
    to: &str,
    mut rewrites: Vec<LinkRewrite>,
) -> Result<Vec<String>, String> {
    let from_key = wikilink_key(from);
    let to_key = wikilink_key(to);
    let variants: Vec<(String, String)> = vec![
        (from.to_string(), to.to_string()),
        (from_key.clone(), to_key.clone()),
        (base_segment(from), base_segment(to)),
        (base_segment(&from_key), base_segment(&to_key)),
    ];

    let mut by_source: HashMap<String, Vec<(i64, i64, String)>> = HashMap::new();
    for rw in rewrites.drain(..) {
        by_source
            .entry(rw.source.clone())
            .or_default()
            .push((rw.start, rw.end, rw.new_text));
    }
    let mut modified: HashSet<String> = HashSet::new();

    for (source, mut spans) in by_source {
        // Apply descending so earlier offsets stay valid.
        spans.sort_by(|a, b| b.0.cmp(&a.0));
        let abs = vault_abs(index, &source)?;
        let raw = std::fs::read(&abs).map_err(|e| e.to_string())?;
        let mut text = String::from_utf8_lossy(&raw).into_owned();
        for (start, end, new_text) in &spans {
            let (s, e) = (*start as usize, *end as usize);
            if s > text.len() || e > text.len() || s > e {
                continue;
            }
            let before = text[..s].to_string();
            let after = text[e..].to_string();
            text = format!("{before}{new_text}{after}");
        }
        let text = rewrite_markdown_refs(&text, &variants);
        atomic_write_file(&abs, text.as_bytes())?;
        reindex_path(index, &source)?;
        modified.insert(source);
    }

    // The global Markdown-ref scan covers files that had no indexed wikilinks.
    let markdown_rewrites = collect_markdown_ref_rewrites(index, from, to)?;
    for (rel, content) in markdown_rewrites {
        if modified.contains(&rel) {
            continue;
        }
        let abs = vault_abs(index, &rel)?;
        atomic_write_file(&abs, content.as_bytes())?;
        reindex_path(index, &rel)?;
        modified.insert(rel);
    }

    Ok(modified.into_iter().collect())
}

#[tauri::command]
fn create_folder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    ensure_secure_parent(index.vault_root(), &abs)?;
    std::fs::create_dir_all(&abs).map_err(|e| e.to_string())?;
    ensure_existing_inside(index.vault_root(), &abs)?;
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
    ensure_secure_parent(index.vault_root(), &abs)?;
    atomic_write_file(&abs, content.as_bytes())?;
    reindex_path(index, &path)?;
    Ok(())
}

#[tauri::command]
fn rename_path(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
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
    ensure_existing_inside(index.vault_root(), &src)?;
    ensure_secure_parent(index.vault_root(), &dst)?;
    let was_dir = src.is_dir();
    // Collect reference rewrites before the index identity changes, so links
    // pointing at the old path are still resolvable in `links.target_path`.
    let rewrites = collect_link_rewrites(index, &from, &to)?;
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    // Drop old index identity; re-index new path (or full reconcile for dirs).
    let _ = index.remove_path(&from);
    if was_dir {
        index.reconcile().map_err(|e| e.to_string())?;
    } else {
        reindex_path(index, &to).map_err(|e| format!("renamed on disk but reindex failed: {e}"))?;
    }
    let modified = apply_rewrites(index, &from, &to, rewrites)?;
    Ok(modified)
}

#[tauri::command]
fn delete_path(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.index.lock();
    let index = guard.as_mut().ok_or_else(|| "No vault open".to_string())?;
    let abs = vault_abs(index, &path)?;
    if !abs.exists() {
        return Err(format!("Not found: {path} (resolved {})", abs.display()));
    }
    ensure_existing_inside(index.vault_root(), &abs)?;
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
    ensure_existing_inside(index.vault_root(), &src)?;
    ensure_secure_parent(index.vault_root(), &dst)?;
    if src.is_dir() {
        copy_dir_recursive(&src, &dst).map_err(|e| e.to_string())?;
        index.reconcile().map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        reindex_path(index, &to)?;
    }
    Ok(())
}

fn ensure_existing_inside(vault_root: &Path, path: &Path) -> Result<(), String> {
    let root = vault_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("Path escapes vault through a symbolic link".into());
    }
    Ok(())
}

fn ensure_secure_parent(vault_root: &Path, path: &Path) -> Result<(), String> {
    let root = vault_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Path has no parent".to_string())?;
    let mut existing = parent;
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "Path has no existing ancestor".to_string())?;
    }
    if !existing
        .canonicalize()
        .map_err(|error| error.to_string())?
        .starts_with(&root)
    {
        return Err("Path escapes vault through a symbolic link".into());
    }
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    if !parent
        .canonicalize()
        .map_err(|error| error.to_string())?
        .starts_with(&root)
    {
        return Err("Path escapes vault through a symbolic link".into());
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
    pub tags: Vec<String>,
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
    if paths
        .iter()
        .any(|path| path.is_empty() || path.contains('\0'))
    {
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
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
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
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )?;
    let upstream = upstream_output
        .status
        .success()
        .then(|| {
            String::from_utf8_lossy(&upstream_output.stdout)
                .trim()
                .to_string()
        })
        .filter(|value| !value.is_empty());
    let remote = upstream
        .as_deref()
        .and_then(|value| value.split('/').next())
        .map(str::to_string);
    let remote_url = remote.as_deref().and_then(|name| {
        let output = git_output(&root, &["remote", "get-url", name]).ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    });
    let (ahead, behind) = if upstream.is_some() {
        let output = git_output(
            &root,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        )?;
        if output.status.success() {
            let counts = String::from_utf8_lossy(&output.stdout);
            let mut values = counts
                .split_whitespace()
                .filter_map(|value| value.parse::<usize>().ok());
            (values.next().unwrap_or(0), values.next().unwrap_or(0))
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };
    Ok(GitSyncStatus {
        remote,
        upstream,
        remote_url,
        ahead,
        behind,
        detached,
    })
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
    let output = git_success(&root, &["branch", "--format=%(HEAD)%00%(refname:short)"])?;
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
    if (4..=64).contains(&value.len())
        && value.chars().all(|character| character.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err("Invalid Git commit identifier".into())
    }
}

#[tauri::command]
fn git_commit_details(
    hash: String,
    state: State<'_, AppState>,
) -> Result<GitCommitDetails, String> {
    validate_git_commit(&hash)?;
    let root = vault_root(&state)?;
    let format = "%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1e";
    let format_argument = format!("--format={format}");
    let output = git_output(
        &root,
        &[
            "show",
            "--date=iso-strict",
            &format_argument,
            "--patch",
            "--stat",
            "--no-ext-diff",
            "--no-color",
            &hash,
        ],
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
        parents: fields
            .next()
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect(),
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
        &[
            "log",
            "--follow",
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s",
            "-n",
            &count,
            "--",
            &path,
        ],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
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
fn git_restore_from_commit(
    hash: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_git_commit(&hash)?;
    validate_git_paths(std::slice::from_ref(&path))?;
    let root = vault_root(&state)?;
    git_success(
        &root,
        &["restore", "--source", &hash, "--worktree", "--", &path],
    )
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
            let flag = if resolution == "ours" {
                "--ours"
            } else {
                "--theirs"
            };
            git_success(&root, &["checkout", flag, "--", &path])?;
            git_success(&root, &["add", "--", &path])
        }
        "resolved" => git_success(&root, &["add", "--", &path]),
        _ => Err("Unknown conflict resolution".into()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GitConflictSides {
    pub path: String,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub base: Option<String>,
    pub working: Option<String>,
}

fn git_show_stage(root: &Path, stage: u8, path: &str) -> Option<String> {
    let spec = format!(":{stage}:{path}");
    let output = git_output(root, &["show", &spec]).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
fn git_conflict_sides(
    path: String,
    state: State<'_, AppState>,
) -> Result<GitConflictSides, String> {
    validate_git_paths(std::slice::from_ref(&path))?;
    let root = vault_root(&state)?;
    let working = {
        let abs = root.join(&path);
        std::fs::read_to_string(&abs).ok()
    };
    Ok(GitConflictSides {
        path: path.clone(),
        ours: git_show_stage(&root, 2, &path),
        theirs: git_show_stage(&root, 3, &path),
        base: git_show_stage(&root, 1, &path),
        working,
    })
}

#[tauri::command]
fn git_continue(state: State<'_, AppState>) -> Result<String, String> {
    let root = vault_root(&state)?;
    match git_operation(&root).as_deref() {
        Some("merge") => git_success(&root, &["-c", "core.editor=true", "merge", "--continue"]),
        Some("rebase") => git_success(&root, &["-c", "core.editor=true", "rebase", "--continue"]),
        Some("cherry-pick") => git_success(
            &root,
            &["-c", "core.editor=true", "cherry-pick", "--continue"],
        ),
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
async fn render_vim_powerline(
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

    let absolute = {
        let guard = state.index.lock();
        let index = guard.as_ref().ok_or_else(|| "No vault open".to_string())?;
        vault_abs(index, &path)?
    };

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

    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|error| format!("Vim Powerline task failed: {error}"))?
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
            visible: Arc::new(VisiblePages::new()),
            watcher_generation: Arc::new(AtomicU64::new(0)),
        })
        .invoke_handler(tauri::generate_handler![
            project_version,
            vault_open_plan,
            read_user_vimrc,
            templater_templates_folder,
            open_vault,
            refresh_vault,
            set_visible_paths,
            vault_stats,
            list_files,
            list_attachments,
            search_vault,
            graph_data,
            link_health,
            note_context,
            vault_tags,
            pages_for_tag,
            list_plugins,
            plugin_http_request,
            plugin_catalog,
            install_community_plugin,
            uninstall_community_plugin,
            set_community_plugin_enabled,
            read_file,
            read_media_file,
            write_file,
            write_media_file,
            resolve_wikilink,
            list_pages,
            note_file_meta,
            query_vault_sql,
            list_tasks,
            set_task_completed,
            set_task_status,
            replace_task_line,
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
            git_conflict_sides,
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
        atomic_write_file, discover_plugins, ensure_secure_parent, fts_query, is_conflict_status,
        is_core_replaced_obsidian_plugin, next_recurrence_date, page_properties,
        plugin_http_request, recurring_task_lines, rewrite_markdown_refs, run_readonly_sql,
        search_yaml_properties, translate_page_sql, translate_page_sql_residual,
        vault_search_terms, PluginHttpRequest,
    };
    use chrono::NaiveDate;

    #[test]
    fn mermaid_obsidian_plugins_are_treated_as_replaced_core() {
        assert!(is_core_replaced_obsidian_plugin("mermaid-tools"));
        assert!(is_core_replaced_obsidian_plugin("obsidian-mermaid-view"));
        assert!(is_core_replaced_obsidian_plugin("My-Mermaid-Helper"));
        assert!(is_core_replaced_obsidian_plugin("obsidian-git"));
        assert!(is_core_replaced_obsidian_plugin("obsidian-vimrc-support"));
        assert!(is_core_replaced_obsidian_plugin("calendar"));
        assert!(is_core_replaced_obsidian_plugin("dataview"));
    }

    #[test]
    fn discovers_native_and_obsidian_plugin_packages_with_distinct_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let native = directory.path().join("native").join("sample.native");
        std::fs::create_dir_all(&native).unwrap();
        std::fs::write(
            native.join("manifest.json"),
            r#"{"id":"sample.native","name":"Native","version":"1.0","permissions":["vault.read"]}"#,
        )
        .unwrap();
        std::fs::write(native.join("main.js"), "nephrite.onLoad(() => {});").unwrap();
        let native_plugins =
            discover_plugins(&directory.path().join("native"), "nephrite", None).unwrap();
        assert_eq!(native_plugins[0].compatibility, "nephrite");
        assert_eq!(native_plugins[0].permissions, ["vault.read"]);

        let obsidian = directory.path().join("obsidian").join("sample-obsidian");
        std::fs::create_dir_all(&obsidian).unwrap();
        std::fs::write(
            obsidian.join("manifest.json"),
            r#"{"id":"sample-obsidian","name":"Obsidian","version":"2.0","minAppVersion":"1.5.0"}"#,
        )
        .unwrap();
        std::fs::write(
            obsidian.join("main.js"),
            "const { Plugin } = require('obsidian'); module.exports = class extends Plugin {};",
        )
        .unwrap();
        std::fs::create_dir_all(obsidian.join("icons")).unwrap();
        std::fs::write(obsidian.join("icons/tool.svg"), "<svg/>").unwrap();
        let obsidian_plugins =
            discover_plugins(&directory.path().join("obsidian"), "obsidian", None).unwrap();
        assert_eq!(obsidian_plugins[0].compatibility, "obsidian");
        assert!(obsidian_plugins[0]
            .permissions
            .contains(&"vault.write".into()));
        assert_eq!(
            obsidian_plugins[0].min_app_version.as_deref(),
            Some("1.5.0")
        );
        assert!(
            obsidian_plugins[0].assets["icons/tool.svg"].starts_with("data:image/svg+xml;base64,")
        );
    }

    #[test]
    fn full_text_terms_are_quoted_and_prefixed() {
        assert_eq!(
            fts_query("PostgreSQL migration"),
            "\"postgresql\"* AND \"migration\"*"
        );
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
        assert_eq!(
            results[0].snippet,
            "[[HIT]]company: Deloitte Consulting LLP[[/HIT]]"
        );
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
    fn markdown_rename_rewrites_destinations_without_touching_code_or_titles() {
        let source = "[note](Old.md \"A title\")\n`[code](Old.md)`\n```md\n[fenced](Old.md)\n```\n[angle](<Old.md>)\n[nested](Old(1).md)\n";
        let rewritten = rewrite_markdown_refs(
            source,
            &[
                ("Old.md".into(), "New.md".into()),
                ("Old(1).md".into(), "New(1).md".into()),
            ],
        );
        assert!(rewritten.contains("[note](New.md \"A title\")"));
        assert!(rewritten.contains("`[code](Old.md)`"));
        assert!(rewritten.contains("[fenced](Old.md)"));
        assert!(rewritten.contains("[angle](<New.md>)"));
        assert!(rewritten.contains("[nested](New(1).md)"));
    }

    #[test]
    fn atomic_write_replaces_complete_content_and_preserves_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("Note.md");
        std::fs::write(&path, "before").unwrap();
        let permissions = std::fs::metadata(&path).unwrap().permissions();
        atomic_write_file(&path, b"after").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().readonly(),
            permissions.readonly()
        );
    }

    #[cfg(unix)]
    #[test]
    fn mutation_parent_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), vault.path().join("escape")).unwrap();
        let error =
            ensure_secure_parent(vault.path(), &vault.path().join("escape/Note.md")).unwrap_err();
        assert!(error.contains("symbolic link"));
    }

    #[test]
    fn plugin_http_transport_rejects_unsafe_urls_before_network_access() {
        let request = |url: &str| PluginHttpRequest {
            url: url.into(),
            method: None,
            headers: None,
            content_type: None,
            body: None,
            throw_on_error: None,
        };
        assert!(plugin_http_request(request("file:///etc/passwd"))
            .unwrap_err()
            .contains("HTTP(S)"));
        assert!(
            plugin_http_request(request("https://user:pass@example.com/"))
                .unwrap_err()
                .contains("credentials")
        );
    }

    #[test]
    fn recurring_tasks_advance_dates_and_preserve_month_ends() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
        let (completed, next) = recurring_task_lines(
            "- [ ] Invoice 🔁 every month 📅 2026-01-31 ^invoice",
            "every month",
            today,
        )
        .unwrap();
        assert!(completed.contains("[x]") && completed.contains("✅ 2026-08-12"));
        assert!(next.contains("[ ]") && next.contains("📅 2026-02-28"));
        assert!(next.ends_with("^invoice"));
        assert_eq!(
            next_recurrence_date(
                NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(),
                "every weekday"
            )
            .unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 17).unwrap(),
        );
        assert_eq!(
            next_recurrence_date(today, "every week on friday").unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(),
        );
        assert_eq!(
            next_recurrence_date(today, "every month on the last friday").unwrap(),
            NaiveDate::from_ymd_opt(2026, 9, 25).unwrap(),
        );
        assert_eq!(
            next_recurrence_date(today, "every year on january 31st").unwrap(),
            NaiveDate::from_ymd_opt(2027, 1, 31).unwrap(),
        );
    }

    #[test]
    fn malformed_cached_frontmatter_does_not_break_page_loading() {
        let properties = page_properties(Some("not JSON"));
        assert_eq!(properties, serde_json::json!({}));
    }

    #[test]
    fn yaml_title_remains_an_ordinary_page_property() {
        let properties = page_properties(Some(r#"{"title":"YAML title","status":"active"}"#));
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
    fn executes_complete_one_dimensional_array_operator_family() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT ARRAY[1,2,3] @> ARRAY[2,3] AS contains, ARRAY[2] <@ ARRAY[1,2] AS contained, ARRAY[1,2] && ARRAY[2,4] AS overlaps, 2 = ANY(ARRAY[1,2,3]) AS any_match, 4 > ALL(ARRAY[1,2,3]) AS all_match, ARRAY[1,2] < ARRAY[1,3] AS ordered, array_to_string(ARRAY[1] || ARRAY[2,3], ',') AS concatenated, array_to_string(ARRAY[true,false], ',') AS booleans",
        ).unwrap();
        assert_eq!(
            result.rows,
            [[
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!("1,2,3"),
                serde_json::json!("true,false"),
            ]]
        );
    }

    #[test]
    fn executes_array_subscripts_slices_and_element_concatenation() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "WITH sample(items) AS (VALUES (ARRAY['a','b','c'])) SELECT items[2] AS item, array_to_string(items[2:3], ',') AS slice, array_to_string(ARRAY['a'] || 'b', ',') AS appended, array_to_string('a' || ARRAY['b'], ',') AS prepended FROM sample",
        ).unwrap();
        assert_eq!(
            result.rows,
            [[
                serde_json::json!("b"),
                serde_json::json!("b,c"),
                serde_json::json!("a,b"),
                serde_json::json!("a,b"),
            ]]
        );
    }

    #[test]
    fn executes_json_path_containment_concat_and_delete_functions() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            r#"SELECT jsonb_extract_path_text('{"person":{"name":"Ada"}}', 'person', 'name') AS name, jsonb_contains('{"tags":["sql","rust"]}', '{"tags":["sql"]}') AS contains, jsonb_concat('{"a":1}', '{"b":2}') AS merged, jsonb_delete('{"a":1,"b":2}', 'a') AS deleted"#,
        ).unwrap();
        assert_eq!(result.rows[0][0], "Ada");
        assert_eq!(result.rows[0][1], serde_json::json!(1));
        assert_eq!(result.rows[0][2], serde_json::json!({"a": 1, "b": 2}));
        assert_eq!(result.rows[0][3], serde_json::json!({"b": 2}));
    }

    #[test]
    fn executes_postgres_jsonb_operator_family() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE sample(payload TEXT)", [])
            .unwrap();
        connection.execute(
            r#"INSERT INTO sample VALUES ('{"person":{"name":"Ada"},"tags":["sql","rust"],"active":true}')"#,
            [],
        ).unwrap();
        let result = run_readonly_sql(
            &connection,
            r#"SELECT payload->'person' AS person, payload #>> ARRAY['person','name'] AS name, payload ? 'active' AS has_key, payload ?& ARRAY['active','tags'] AS has_all, payload @> '{"active":true}'::jsonb AS contains, payload - 'active' AS deleted FROM sample"#,
        ).unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!({"name": "Ada"}));
        assert_eq!(result.rows[0][1], "Ada");
        assert_eq!(result.rows[0][2], serde_json::json!(1));
        assert_eq!(result.rows[0][3], serde_json::json!(1));
        assert_eq!(result.rows[0][4], serde_json::json!(1));
        assert_eq!(
            result.rows[0][5],
            serde_json::json!({
                "person": {"name": "Ada"}, "tags": ["sql", "rust"]
            })
        );
    }

    #[test]
    fn exposes_the_supported_surface_through_pg_catalog() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let functions = run_readonly_sql(
            &connection,
            "SELECT proname FROM pg_catalog.pg_proc WHERE proname IN ('array_replace', 'jsonb_contains', 'regexp_like') ORDER BY proname",
        ).unwrap();
        assert_eq!(
            functions.rows,
            [
                [serde_json::json!("array_replace")],
                [serde_json::json!("jsonb_contains")],
                [serde_json::json!("regexp_like")],
            ]
        );
        let operators = run_readonly_sql(
            &connection,
            "SELECT oprname, oprleft, oprright FROM pg_catalog.pg_operator WHERE oprname = '@>' ORDER BY oprleft",
        ).unwrap();
        assert_eq!(
            operators.rows,
            [
                [
                    serde_json::json!("@>"),
                    serde_json::json!("anyarray"),
                    serde_json::json!("anyarray")
                ],
                [
                    serde_json::json!("@>"),
                    serde_json::json!("jsonb"),
                    serde_json::json!("jsonb")
                ],
            ]
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
    fn lowers_postgres_type_casts_to_real_conversions() {
        let lower = |sql: &str| {
            super::page_sql::lower_page_sql(sql, translate_page_sql, translate_page_sql_residual)
                .unwrap()
        };
        assert_eq!(
            lower(
                "SELECT a.name FROM (VALUES ('Moe'::text), ('Larry'), ('Curly')) AS a(name)"
            ),
            "SELECT a.name FROM (SELECT column1 AS name FROM (VALUES (page_cast('Moe', 'text')), ('Larry'), ('Curly')) AS _nephrite_values) AS a"
        );
        assert_eq!(
            lower("SELECT 1::int AS n"),
            "SELECT page_cast(1, 'integer') AS n"
        );
    }

    #[test]
    fn lowers_jsonb_array_length() {
        let out = translate_page_sql("SELECT jsonb_array_length(tags) FROM pages").unwrap();
        assert!(
            out.contains("jsonb_array_length(tags)"),
            "array length function was corrupted: {out}"
        );
        let out2 = translate_page_sql("SELECT cardinality(tags) FROM pages").unwrap();
        assert!(
            out2.contains("cardinality(tags)"),
            "cardinality function was corrupted: {out2}"
        );
    }

    #[test]
    fn lowers_to_char_strpos_substring() {
        assert_eq!(
            translate_page_sql("SELECT to_char(created, 'YYYY-MM-DD') FROM pages").unwrap(),
            "SELECT strftime('%Y-%m-%d', created) FROM pages"
        );
        assert_eq!(
            translate_page_sql("SELECT strpos(name, 'x') FROM pages").unwrap(),
            "SELECT instr(name, 'x') FROM pages"
        );
        assert_eq!(
            translate_page_sql("SELECT position('x' IN name) FROM pages").unwrap(),
            "SELECT instr(name, 'x') FROM pages"
        );
        assert_eq!(
            translate_page_sql("SELECT substring(name FROM 1 FOR 3) FROM pages").unwrap(),
            "SELECT substr(name, 1, 3) FROM pages"
        );
    }

    #[test]
    fn lowers_date_trunc() {
        assert_eq!(
            translate_page_sql("SELECT date_trunc('day', created) FROM pages").unwrap(),
            "SELECT date(created) FROM pages"
        );
    }

    #[test]
    fn lowers_is_distinct_from() {
        assert_eq!(
            translate_page_sql("SELECT 1 WHERE a IS DISTINCT FROM b").unwrap(),
            "SELECT 1 WHERE a IS NOT b"
        );
        assert_eq!(
            translate_page_sql("SELECT 1 WHERE a IS NOT DISTINCT FROM b").unwrap(),
            "SELECT 1 WHERE a IS b"
        );
    }

    #[test]
    fn executes_strict_postgres_casts_and_values_aliases() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        assert_eq!(
            run_readonly_sql(&connection, "SELECT '12'::int AS n")
                .unwrap()
                .rows,
            [[serde_json::json!(12)]]
        );
        assert_eq!(
            run_readonly_sql(&connection, "SELECT CAST(12 AS text) AS t")
                .unwrap()
                .rows,
            [[serde_json::json!("12")]]
        );
        assert_eq!(
            run_readonly_sql(&connection, "SELECT '1.5'::double precision AS n")
                .unwrap()
                .rows,
            [[serde_json::json!(1.5)]]
        );
        assert_eq!(
            run_readonly_sql(
                &connection,
                "SELECT a.name FROM (VALUES ('Moe'::text), ('Larry'), ('Curly')) AS a(name)"
            )
            .unwrap()
            .rows,
            [
                [serde_json::json!("Moe")],
                [serde_json::json!("Larry")],
                [serde_json::json!("Curly")],
            ]
        );
        assert!(run_readonly_sql(&connection, "SELECT 'not a number'::integer").is_err());
        assert!(run_readonly_sql(&connection, "SELECT 'x'::regclass").is_err());
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
    fn executes_array_aggregates_and_window_functions() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "WITH sample(group_name, value) AS (VALUES ('a', 2), ('a', 1), ('b', 5)) SELECT group_name, array_agg(value) AS values_seen, sum(value) AS total, row_number() OVER (ORDER BY group_name) AS row_number FROM sample GROUP BY group_name ORDER BY group_name",
        ).unwrap();
        assert_eq!(
            result.rows,
            [
                [
                    serde_json::json!("a"),
                    serde_json::json!([2, 1]),
                    serde_json::json!(3),
                    serde_json::json!(1)
                ],
                [
                    serde_json::json!("b"),
                    serde_json::json!([5]),
                    serde_json::json!(5),
                    serde_json::json!(2)
                ],
            ]
        );
    }

    #[test]
    fn executes_postgresql_18_array_and_json_aggregate_additions() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "WITH sample(key, value) AS (VALUES ('a', 1), ('b', 2)) SELECT cardinality(array_shuffle(ARRAY[1,2,3])) AS shuffled, cardinality(array_sample(ARRAY[1,2,3], 2)) AS sampled, json_agg(value) AS json_values, jsonb_object_agg(key, value) AS json_object FROM sample",
        ).unwrap();
        assert_eq!(result.rows[0][0], serde_json::json!(3));
        assert_eq!(result.rows[0][1], serde_json::json!(2));
        assert_eq!(result.rows[0][2], serde_json::json!([1, 2]));
        assert_eq!(result.rows[0][3], serde_json::json!({"a": 1, "b": 2}));
    }

    #[test]
    fn executes_promised_select_cte_join_subquery_group_case_and_filter_surface() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        let result = run_readonly_sql(
            &connection,
            "WITH people(id, company, active) AS (VALUES (1, 'A', true), (2, 'A', false), (3, 'B', true)), companies(name) AS (VALUES ('A'), ('B')) SELECT c.name, CASE WHEN count(*) FILTER (WHERE p.active) > 0 THEN 'active' ELSE 'idle' END AS status, count(*) AS people FROM companies c JOIN people p ON p.company = c.name WHERE p.id IN (SELECT id FROM people WHERE id > 0) GROUP BY c.name HAVING count(*) >= 1 UNION ALL SELECT 'Z', 'idle', 0 ORDER BY name FETCH FIRST 10 ROWS ONLY",
        ).unwrap();
        assert_eq!(
            result.rows,
            [
                [
                    serde_json::json!("A"),
                    serde_json::json!("active"),
                    serde_json::json!(2)
                ],
                [
                    serde_json::json!("B"),
                    serde_json::json!("active"),
                    serde_json::json!(1)
                ],
                [
                    serde_json::json!("Z"),
                    serde_json::json!("idle"),
                    serde_json::json!(0)
                ],
            ]
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
    fn lowers_postgres_page_property_and_alias_forms() {
        assert_eq!(
            translate_page_sql(
                "SELECT properties['company'] FROM pages WHERE properties ? 'company'"
            )
            .unwrap(),
            "SELECT page_property(properties, 'company') FROM pages WHERE page_has_key(properties, 'company')"
        );
        assert_eq!(
            translate_page_sql(
                "SELECT p.properties->>'company' AS company FROM pages p WHERE p.properties->'active' IS NOT NULL"
            )
            .unwrap(),
            "SELECT page_property(p.properties, 'company') AS company FROM pages p WHERE page_property(p.properties, 'active') IS NOT NULL"
        );
        assert_eq!(
            translate_page_sql("SELECT * FROM pages p WHERE p.aliases @> ARRAY['Data']").unwrap(),
            "SELECT * FROM pages p WHERE (page_has_tag(p.aliases, 'Data'))"
        );
        assert_eq!(
            translate_page_sql("SELECT * FROM pages p WHERE 'recruiter' = ANY(p.tags)").unwrap(),
            "SELECT * FROM pages p WHERE page_has_tag(p.tags, 'recruiter')"
        );
        assert_eq!(
            translate_page_sql(
                "SELECT 1 FROM pages WHERE properties ?& ARRAY['a', 'b']"
            )
            .unwrap(),
            "SELECT 1 FROM pages WHERE (page_has_key(properties, 'a') AND page_has_key(properties, 'b'))"
        );
        assert_eq!(
            translate_page_sql(
                "SELECT 1 FROM pages WHERE properties ?| ARRAY['a', 'b']"
            )
            .unwrap(),
            "SELECT 1 FROM pages WHERE (page_has_key(properties, 'a') OR page_has_key(properties, 'b'))"
        );
        assert_eq!(
            translate_page_sql("SELECT 1 FROM pages WHERE jsonb_exists(properties, 'company')")
                .unwrap(),
            "SELECT 1 FROM pages WHERE page_has_key(properties, 'company')"
        );
        let ilike_out =
            translate_page_sql("SELECT path FROM pages WHERE properties->>'name' ILIKE '%roy%'")
                .unwrap();
        assert!(
            ilike_out.contains(
                "unicode_lower(page_property(properties, 'name')) LIKE unicode_lower('%roy%')"
            ),
            "ILIKE not lowered: {ilike_out}"
        );
        assert_eq!(
            translate_page_sql(
                "SELECT 1 FROM pages p WHERE p.tags && page_array('recruiter', 'interviewer')"
            )
            .unwrap(),
            "SELECT 1 FROM pages p WHERE (page_has_tag(p.tags, 'recruiter') OR page_has_tag(p.tags, 'interviewer'))"
        );
        let cte = translate_page_sql(
            "WITH c AS (SELECT properties['company'] AS company FROM pages) SELECT company FROM c",
        )
        .unwrap();
        assert!(
            cte.contains("page_property(properties, 'company') AS company"),
            "CTE property subscript broken: {cte}"
        );
        assert!(!cte.contains("properties["), "raw subscript remains: {cte}");
    }

    #[test]
    fn executes_postgres_page_property_and_tag_types() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute(
                "CREATE TABLE pages(properties TEXT, tags TEXT, aliases TEXT)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO pages VALUES (?1, ?2, ?3)",
                [
                    r#"{"company":"CDW","active":true}"#,
                    r#"["recruiter","linkedin"]"#,
                    r#"["Data","Kirk"]"#,
                ],
            )
            .unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT properties['company'] AS company FROM pages WHERE tags @> ARRAY['recruiter']",
        )
        .unwrap();
        assert_eq!(result.rows, [[serde_json::json!("CDW")]]);

        let arrow = run_readonly_sql(
            &connection,
            "SELECT properties->>'company' AS company FROM pages WHERE properties ? 'company'",
        )
        .unwrap();
        assert_eq!(arrow.rows, [[serde_json::json!("CDW")]]);

        let existence = run_readonly_sql(
            &connection,
            "SELECT 1 FROM pages WHERE properties ? 'missing'",
        )
        .unwrap();
        assert!(existence.rows.is_empty());

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

        let alias_hit = run_readonly_sql(
            &connection,
            "SELECT properties['company'] AS company FROM pages WHERE aliases @> ARRAY['Data']",
        )
        .unwrap();
        assert_eq!(alias_hit.rows, [[serde_json::json!("CDW")]]);
    }

    #[test]
    fn preserves_metadata_case_with_unique_folded_lookup_and_postgres_like() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE pages(properties TEXT, tags TEXT, aliases TEXT); INSERT INTO pages VALUES ('{\"Company\":\"München\"}', '[\"RéCruiter\"]', '[\"Résumé\"]');")
            .unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT properties['Company'] AS exact, properties['company'] AS folded, 'récruiter' = ANY(tags) AS tag_match, 'résumé' = ANY(aliases) AS alias_match, properties['Company'] LIKE 'm%' AS sensitive, properties['Company'] ILIKE 'm%' AS insensitive FROM pages",
        )
        .unwrap();
        assert_eq!(
            result.rows,
            [[
                serde_json::json!("München"),
                serde_json::json!("München"),
                serde_json::json!(1),
                serde_json::json!(1),
                serde_json::json!(0),
                serde_json::json!(1),
            ]]
        );

        connection
            .execute(
                "UPDATE pages SET properties = '{\"Company\":1,\"company\":2}'",
                [],
            )
            .unwrap();
        assert!(
            run_readonly_sql(&connection, "SELECT properties['COMPANY'] FROM pages")
                .unwrap_err()
                .contains("Ambiguous frontmatter property")
        );
    }

    #[test]
    fn lowers_nested_page_expressions_recursively() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE pages(properties TEXT, tags TEXT); INSERT INTO pages VALUES ('{\"Company\":\"  Acme  \",\"Rate\":\"12\"}', '[]');")
            .unwrap();
        let result = run_readonly_sql(
            &connection,
            "SELECT lower(trim(properties['company'])) AS company, coalesce(properties['missing'], properties['rate']::integer + 1) AS rate FROM pages",
        )
        .unwrap();
        assert_eq!(
            result.rows,
            [[serde_json::json!("acme"), serde_json::json!(13)]]
        );
    }
}
