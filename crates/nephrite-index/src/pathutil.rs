use std::path::{Component, Path, PathBuf};

use crate::error::{IndexError, Result};

/// Normalize a vault-relative path: `/` separators, no `..`, no leading `/`.
/// Case is retained as given (identity is case-sensitive at the model layer).
pub fn normalize_rel(path: &str) -> Result<String> {
    let path = path.trim().trim_start_matches('/');
    if path.is_empty() {
        return Err(IndexError::InvalidPath(path.to_string()));
    }
    let mut out: Vec<&str> = Vec::new();
    for part in path.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(IndexError::InvalidPath(path.to_string()));
        }
        out.push(part);
    }
    if out.is_empty() {
        return Err(IndexError::InvalidPath(path.to_string()));
    }
    Ok(out.join("/"))
}

pub fn parent_of(rel: &str) -> String {
    match rel.rfind('/') {
        Some(i) => rel[..i].to_string(),
        None => String::new(),
    }
}

pub fn name_of(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

pub fn stem_ext(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i + 1..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// Absolute path under vault → vault-relative normalized path.
#[allow(dead_code)]
pub fn rel_from_abs(vault: &Path, abs: &Path) -> Result<String> {
    let vault = vault.canonicalize().unwrap_or_else(|_| vault.to_path_buf());
    rel_from_abs_cached(&vault, abs)
}

/// Like `rel_from_abs`, but `vault_root` should be the same path WalkDir was started with
/// (canonicalize once outside the walk). Avoids per-file canonicalize in the hot path.
pub fn rel_from_abs_cached(vault_root: &Path, abs: &Path) -> Result<String> {
    if let Ok(rel) = abs.strip_prefix(vault_root) {
        let s = rel.to_string_lossy().replace('\\', "/");
        if s.is_empty() {
            return Err(IndexError::InvalidPath(".".into()));
        }
        return normalize_rel(&s);
    }
    // Symlink / odd path: fall back to canonicalize once
    let vault = vault_root
        .canonicalize()
        .unwrap_or_else(|_| vault_root.to_path_buf());
    let abs = abs.canonicalize().map_err(IndexError::Io)?;
    let rel = abs
        .strip_prefix(&vault)
        .map_err(|_| IndexError::PathEscapesVault(abs.clone()))?;
    let s = rel.to_string_lossy().replace('\\', "/");
    normalize_rel(&s)
}

pub fn abs_from_rel(vault: &Path, rel: &str) -> Result<PathBuf> {
    let rel = normalize_rel(rel)?;
    let mut p = vault.to_path_buf();
    for c in Path::new(&rel).components() {
        match c {
            Component::Normal(s) => p.push(s),
            Component::CurDir => {}
            _ => return Err(IndexError::InvalidPath(rel)),
        }
    }
    Ok(p)
}

/// Skip internal / noise paths when walking the vault.
pub fn should_skip_rel(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or("");
    matches!(
        first,
        ".nephrite"
            | ".git"
            | "node_modules"
            | ".trash"
            | ".stfolder"
            | ".stversions"
            | ".obsidian"
    ) || rel.split('/').any(|p| p == ".git" || p == ".obsidian")
}
