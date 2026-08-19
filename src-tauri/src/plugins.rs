//! Community plugin catalog, install, and enable list.
//! Packages live where Obsidian expects them: `.obsidian/plugins/<id>/`
//! and `.obsidian/community-plugins.json`.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const COMMUNITY_REGISTRY: &str =
    "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
pub const USER_AGENT: &str = "Nephrite/0.9 (plugin catalog)";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_MAIN_BYTES: usize = 16 * 1024 * 1024;
const MAX_STYLE_BYTES: usize = 2 * 1024 * 1024;
const MAX_EXTRA_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MAX_EXTRA_ASSETS_TOTAL: usize = 64 * 1024 * 1024;

pub fn is_core_replaced_obsidian_plugin(id: &str) -> bool {
    hides_core_plugin(id, "", "")
}

/// Community plugins Nephrite already ships in core, plus Vim add-ons that
/// fight the built-in editor. These stay out of the browse list and are never loaded.
pub fn hides_core_plugin(id: &str, name: &str, description: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    if crate::CORE_OBSIDIAN_PLUGIN_IDS.contains(&id.as_str()) {
        return true;
    }
    if id.contains("mermaid") || name.contains("mermaid") {
        return true;
    }
    if word_in(&id, "vim")
        || word_in(&name, "vim")
        || id.contains("vimrc")
        || name.contains("vimrc")
    {
        return true;
    }
    if word_in(&id, "git") || word_in(&name, "git") {
        return true;
    }
    if is_toc_plugin(&id, &name, description) {
        return true;
    }
    if id.contains("templater") || name.contains("templater") {
        return true;
    }
    if id.contains("dataview") || name.contains("dataview") {
        return true;
    }
    if id.contains("excalidraw") || name.contains("excalidraw") {
        return true;
    }
    if word_in(&id, "kanban") || word_in(&name, "kanban") {
        return true;
    }
    if id == "obsidian-tasks" || id.contains("obsidian-tasks") || name == "tasks" {
        return true;
    }
    if id == "calendar" || name == "calendar" {
        return true;
    }
    if is_leader_hotkey_plugin(&id, &name, description) {
        return true;
    }
    if is_relative_line_plugin(&id, &name, description) {
        return true;
    }
    false
}

fn is_leader_hotkey_plugin(id: &str, name: &str, description: &str) -> bool {
    let desc = description.to_ascii_lowercase();
    let hay = format!("{id} {name} {desc}");
    (hay.contains("leader")
        && (hay.contains("hotkey") || hay.contains("keymap") || hay.contains("shortcut")))
        || id.contains("leader-hotkey")
        || id.contains("leaderhotkey")
        || name.contains("leader hotkey")
}

fn is_relative_line_plugin(id: &str, name: &str, description: &str) -> bool {
    let desc = description.to_ascii_lowercase();
    let hay = format!("{id} {name} {desc}");
    hay.contains("relative-line-number")
        || hay.contains("relative line number")
        || hay.contains("relativenumber")
        || (hay.contains("relative") && hay.contains("line number"))
}

fn is_toc_plugin(id: &str, name: &str, description: &str) -> bool {
    let desc = description.to_ascii_lowercase();
    id.contains("table-of-content")
        || id.contains("table_of_content")
        || name.contains("table of content")
        || desc.contains("table of contents") && (id.contains("toc") || name.contains("toc"))
        || id.contains("dynamic-toc")
        || id.ends_with("-toc")
        || id.starts_with("toc-")
        || id == "toc"
        || name == "toc"
        || name.ends_with(" toc")
        || name.starts_with("toc ")
}

fn word_in(haystack: &str, word: &str) -> bool {
    haystack
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|part| part == word)
}

pub fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub fn plugin_dir(root: &Path, id: &str) -> PathBuf {
    root.join(".obsidian").join("plugins").join(id)
}

pub fn community_plugins_path(root: &Path) -> PathBuf {
    root.join(".obsidian").join("community-plugins.json")
}

pub fn github_release_asset_url(repo: &str, filename: &str) -> Result<String, String> {
    let repo = valid_repo(repo)?;
    if !matches!(filename, "manifest.json" | "main.js" | "styles.css") {
        return Err(format!("Refusing to download {filename}"));
    }
    Ok(format!(
        "https://github.com/{repo}/releases/latest/download/{filename}"
    ))
}

fn valid_repo(repo: &str) -> Result<&str, String> {
    let repo = repo.trim().trim_start_matches('/');
    if repo.is_empty()
        || repo.contains("..")
        || repo.chars().filter(|ch| *ch == '/').count() != 1
        || !repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
    {
        return Err(format!("Invalid plugin repository: {repo}"));
    }
    Ok(repo)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub author: String,
    pub description: String,
    pub repo: String,
}

pub fn parse_community_catalog(source: &str) -> Result<Vec<CatalogEntry>, String> {
    serde_json::from_str(source).map_err(|error| format!("Plugin catalog is invalid: {error}"))
}

pub fn parse_enabled_ids(source: &str) -> Result<Vec<String>, String> {
    let ids: Vec<String> =
        serde_json::from_str(source).map_err(|error| format!("community-plugins.json: {error}"))?;
    Ok(ids.into_iter().filter(|id| valid_plugin_id(id)).collect())
}

pub fn format_enabled_ids(ids: &[String]) -> String {
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if seen.insert(id) {
            unique.push(id.clone());
        }
    }
    unique.sort();
    format!(
        "{}\n",
        serde_json::to_string_pretty(&unique).unwrap_or_else(|_| "[]".into())
    )
}

pub fn set_enabled_id(ids: &[String], id: &str, enabled: bool) -> Vec<String> {
    let mut next: Vec<String> = ids.iter().filter(|item| *item != id).cloned().collect();
    if enabled {
        next.push(id.to_string());
    }
    next
}

pub fn read_enabled_ids(root: &Path) -> Vec<String> {
    std::fs::read_to_string(community_plugins_path(root))
        .ok()
        .and_then(|source| parse_enabled_ids(&source).ok())
        .unwrap_or_default()
}

pub fn write_enabled_ids(root: &Path, ids: &[String]) -> Result<(), String> {
    let path = community_plugins_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, format_enabled_ids(ids)).map_err(|error| error.to_string())
}

pub fn download_bytes(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/octet-stream, text/plain, */*")
        .call()
        .map_err(|error| format!("Download failed: {error}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err(format!("Download exceeded {limit} bytes"));
    }
    Ok(bytes)
}

pub fn download_text(url: &str, limit: usize) -> Result<String, String> {
    String::from_utf8(download_bytes(url, limit)?).map_err(|_| "Download was not UTF-8".to_string())
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: usize,
}

fn install_release_assets(dir: &Path, repo: &str) -> Result<(), String> {
    let repo = valid_repo(repo)?;
    let release = download_text(
        &format!("https://api.github.com/repos/{repo}/releases/latest"),
        2 * 1024 * 1024,
    )?;
    let release: GithubRelease = serde_json::from_str(&release)
        .map_err(|error| format!("GitHub release metadata: {error}"))?;
    let mut total = 0usize;
    for asset in release.assets {
        if matches!(
            asset.name.as_str(),
            "manifest.json" | "main.js" | "styles.css"
        ) || !asset
            .name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            || asset.size > MAX_EXTRA_ASSET_BYTES
            || total.saturating_add(asset.size) > MAX_EXTRA_ASSETS_TOTAL
        {
            continue;
        }
        let extension = Path::new(&asset.name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "js" | "mjs"
                | "cjs"
                | "json"
                | "wasm"
                | "css"
                | "svg"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "woff"
                | "woff2"
                | "ttf"
                | "otf"
        ) {
            continue;
        }
        let bytes = download_bytes(&asset.browser_download_url, MAX_EXTRA_ASSET_BYTES)?;
        total += bytes.len();
        std::fs::write(dir.join(asset.name), bytes).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn install_release_files(root: &Path, id: &str, repo: &str) -> Result<String, String> {
    if !valid_plugin_id(id) {
        return Err("Invalid plugin id".into());
    }
    if is_core_replaced_obsidian_plugin(id) {
        return Err(format!(
            "{id} is provided by Nephrite and is not installed as a community plugin"
        ));
    }
    let manifest_text = download_text(
        &github_release_asset_url(repo, "manifest.json")?,
        MAX_MANIFEST_BYTES,
    )?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|error| format!("manifest.json: {error}"))?;
    let manifest_id = manifest
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if manifest_id != id {
        return Err(format!(
            "Release manifest id {manifest_id:?} does not match catalog id {id:?}"
        ));
    }
    let version = manifest
        .get("version")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_string();
    let main = download_text(&github_release_asset_url(repo, "main.js")?, MAX_MAIN_BYTES)?;
    let styles = download_text(
        &github_release_asset_url(repo, "styles.css")?,
        MAX_STYLE_BYTES,
    )
    .ok();
    let dir = plugin_dir(root, id);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    std::fs::write(dir.join("manifest.json"), manifest_text).map_err(|error| error.to_string())?;
    std::fs::write(dir.join("main.js"), main).map_err(|error| error.to_string())?;
    if let Some(css) = styles {
        std::fs::write(dir.join("styles.css"), css).map_err(|error| error.to_string())?;
    }
    let _ = install_release_assets(&dir, repo);
    let mut enabled = read_enabled_ids(root);
    enabled = set_enabled_id(&enabled, id, true);
    write_enabled_ids(root, &enabled)?;
    Ok(version)
}

pub fn uninstall_plugin_files(root: &Path, id: &str) -> Result<(), String> {
    if !valid_plugin_id(id) {
        return Err("Invalid plugin id".into());
    }
    let dir = plugin_dir(root, id);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    let enabled = set_enabled_id(&read_enabled_ids(root), id, false);
    write_enabled_ids(root, &enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_latest_github_asset_urls() {
        assert_eq!(
            github_release_asset_url("blacksmithgu/obsidian-dataview", "main.js").unwrap(),
            "https://github.com/blacksmithgu/obsidian-dataview/releases/latest/download/main.js"
        );
        assert!(github_release_asset_url("../escape", "main.js").is_err());
        assert!(github_release_asset_url("owner/repo", "evil.exe").is_err());
    }

    #[test]
    fn parses_and_formats_enable_lists() {
        let ids = parse_enabled_ids("[\"calendar\", \"calendar\", \"dataview\"]").unwrap();
        let next = set_enabled_id(&ids, "calendar", false);
        assert_eq!(next, vec!["dataview".to_string()]);
        let enabled = set_enabled_id(&next, "calendar", true);
        assert!(format_enabled_ids(&enabled).contains("\"calendar\""));
    }

    #[test]
    fn refuses_core_replacements() {
        let dir = tempfile::tempdir().unwrap();
        let error = install_release_files(dir.path(), "dataview", "blacksmithgu/obsidian-dataview")
            .unwrap_err();
        assert!(error.contains("provided by Nephrite"));
    }

    #[test]
    fn hides_core_and_vim_plugins_from_the_catalog() {
        assert!(hides_core_plugin("mermaid-tools", "Mermaid Tools", ""));
        assert!(hides_core_plugin("templater-obsidian", "Templater", ""));
        assert!(hides_core_plugin("obsidian-git", "Obsidian Git", ""));
        assert!(hides_core_plugin(
            "obsidian-vimrc-support",
            "Vimrc Support",
            ""
        ));
        assert!(hides_core_plugin(
            "better-vim-cursor",
            "Better Vim Cursor",
            ""
        ));
        assert!(hides_core_plugin(
            "obsidian-dynamic-toc",
            "Dynamic Table of Contents",
            "Generate a table of contents",
        ));
        assert!(hides_core_plugin(
            "table-of-content",
            "Table of Content",
            ""
        ));
        assert!(hides_core_plugin(
            "calendar",
            "Calendar",
            "A monthly calendar view"
        ));
        assert!(!hides_core_plugin(
            "digital-garden",
            "Digital Garden",
            "Publish notes",
        ));
        assert!(hides_core_plugin(
            "obsidian-leader-hotkeys",
            "Leader Hotkeys",
            "Space as a leader key",
        ));
        assert!(hides_core_plugin(
            "relative-line-numbers",
            "Relative Line Numbers",
            "Show relative line numbers in the editor",
        ));
    }
}
