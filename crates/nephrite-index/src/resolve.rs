//! Obsidian-compatible wikilink / internal-link resolution.
//!
//! Resolution is vault-global: `[[A]]` points at the same file from every note.
//! `from_path` is used only for an empty target and for explicit `./` / `../`.
//! Existing short links are never rewritten when a namesake appears.

use std::collections::HashMap;

/// One indexed vault file used as a resolution candidate.
#[derive(Debug, Clone)]
pub struct IndexedFile {
    pub path: String,
    pub name: String,
    pub stem: String,
}

/// Lookup tables for [`LinkResolver::resolve`].
pub struct LinkResolver {
    /// Exact vault-root path, including `Note` → `Note.md` when present.
    by_exact: HashMap<String, String>,
    /// Path-suffix → candidates, sorted and de-duplicated.
    by_suffix: HashMap<String, Vec<String>>,
    /// Filename stem (no directory, no extension).
    by_stem: HashMap<String, Vec<String>>,
    /// Frontmatter alias → file paths, sorted.
    by_alias: HashMap<String, Vec<String>>,
}

impl IndexedFile {
    pub fn new(path: impl Into<String>, name: impl Into<String>, stem: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            name: name.into(),
            stem: stem.into(),
        }
    }

    fn key(&self) -> String {
        wikilink_key(&self.path)
    }

    fn key_no_ext(&self) -> String {
        match self.path.rfind('/') {
            Some(i) => format!("{}/{}", &self.path[..i], self.stem),
            None => self.stem.clone(),
        }
    }
}

impl LinkResolver {
    pub fn new(
        files: impl IntoIterator<Item = IndexedFile>,
        aliases: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        let mut by_exact = HashMap::new();
        let mut by_suffix: HashMap<String, Vec<String>> = HashMap::new();
        let mut by_stem: HashMap<String, Vec<String>> = HashMap::new();

        for file in files {
            let path = file.path.clone();
            insert_exact(&mut by_exact, &file.path, &path);
            if let Some(stripped) = strip_note_ext(&file.path) {
                insert_exact(&mut by_exact, stripped, &path);
            }
            insert_exact(&mut by_exact, &file.key(), &path);
            insert_exact(&mut by_exact, &file.key_no_ext(), &path);

            for suffix in path_suffixes(&file.key()) {
                push_unique(by_suffix.entry(suffix).or_default(), path.clone());
            }
            let no_ext = file.key_no_ext();
            if no_ext != file.key() {
                for suffix in path_suffixes(&no_ext) {
                    push_unique(by_suffix.entry(suffix).or_default(), path.clone());
                }
            }

            push_unique(by_stem.entry(file.stem.clone()).or_default(), path.clone());
            if file.name != file.stem {
                push_unique(by_stem.entry(file.name.clone()).or_default(), path);
            }
        }

        for paths in by_suffix.values_mut() {
            paths.sort();
        }
        for paths in by_stem.values_mut() {
            paths.sort();
        }

        let mut by_alias: HashMap<String, Vec<String>> = HashMap::new();
        for (alias, path) in aliases {
            push_unique(by_alias.entry(alias).or_default(), path);
        }
        for paths in by_alias.values_mut() {
            paths.sort();
        }

        Self {
            by_exact,
            by_suffix,
            by_stem,
            by_alias,
        }
    }

    /// Resolve `raw` (note + optional `#heading` / `#^block`) to a vault path.
    pub fn resolve(&self, raw: &str, from_path: Option<&str>) -> Option<String> {
        let note = raw.split('#').next().unwrap_or("").trim();
        if note.is_empty() {
            return from_path.map(str::to_string);
        }

        let mut key = note.replace('\\', "/");

        if is_explicit_relative(&key) {
            let parent = from_path.and_then(parent_dir).unwrap_or("");
            let joined = join_rel(parent, &key)?;
            return self.exact(&joined);
        }

        if let Some(absolute) = key.strip_prefix('/') {
            key = absolute.to_string();
            return self.exact(strip_note_ext(&key).unwrap_or(key.as_str()));
        }

        let key = strip_note_ext(&key).unwrap_or(key.as_str()).to_string();

        // Exact vault-root path beats a same-folder namesake.
        if let Some(hit) = self.exact(&key) {
            return Some(hit);
        }

        let suffix = self.by_suffix.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        if suffix.len() == 1 {
            return Some(suffix[0].clone());
        }

        if !key.contains('/') {
            if let Some(hit) = unique(self.by_stem.get(&key)) {
                return Some(hit);
            }
        }

        if let Some(hit) = unique(self.by_alias.get(&key)) {
            return Some(hit);
        }
        if let Some(paths) = self.by_alias.get(&key) {
            if let Some(first) = paths.first() {
                return Some(first.clone());
            }
        }

        if let Some(first) = suffix.first() {
            return Some(first.clone());
        }
        if !key.contains('/') {
            if let Some(paths) = self.by_stem.get(&key) {
                return paths.first().cloned();
            }
        }

        None
    }

    fn exact(&self, key: &str) -> Option<String> {
        let stripped = strip_note_ext(key).unwrap_or(key);
        if let Some(path) = self.by_exact.get(key) {
            return Some(path.clone());
        }
        if stripped != key {
            if let Some(path) = self.by_exact.get(stripped) {
                return Some(path.clone());
            }
        }
        if let Some(path) = self.by_exact.get(&format!("{stripped}.md")) {
            return Some(path.clone());
        }
        None
    }
}

fn unique(paths: Option<&Vec<String>>) -> Option<String> {
    match paths {
        Some(list) if list.len() == 1 => Some(list[0].clone()),
        _ => None,
    }
}

fn insert_exact(map: &mut HashMap<String, String>, key: &str, path: &str) {
    match map.get(key) {
        None => {
            map.insert(key.to_string(), path.to_string());
        }
        Some(existing) if !is_note_path(existing) && is_note_path(path) => {
            map.insert(key.to_string(), path.to_string());
        }
        _ => {}
    }
}

fn is_note_path(path: &str) -> bool {
    strip_note_ext(path).is_some()
}

fn push_unique(list: &mut Vec<String>, path: String) {
    if !list.iter().any(|existing| existing == &path) {
        list.push(path);
    }
}

fn is_explicit_relative(key: &str) -> bool {
    key == "." || key == ".." || key.starts_with("./") || key.starts_with("../")
}

fn parent_dir(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(parent, _)| parent)
}

fn strip_note_ext(path: &str) -> Option<&str> {
    path.strip_suffix(".markdown")
        .or_else(|| path.strip_suffix(".md"))
}

/// Vault-relative path without a note extension — Obsidian's wikilink key.
pub fn wikilink_key(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    strip_note_ext(&path).unwrap_or(path.as_str()).to_string()
}

fn path_suffixes(key: &str) -> Vec<String> {
    let parts: Vec<&str> = key.split('/').filter(|part| !part.is_empty()).collect();
    (0..parts.len()).map(|i| parts[i..].join("/")).collect()
}

/// Join `./` / `../` onto a vault-relative directory. `None` if it leaves the vault.
fn join_rel(from_dir: &str, target: &str) -> Option<String> {
    let mut parts: Vec<&str> = from_dir
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    for part in target.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop()?;
            continue;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(paths: &[&str]) -> LinkResolver {
        let files = paths.iter().map(|path| {
            let name = path.rsplit('/').next().unwrap();
            let stem = name
                .rsplit_once('.')
                .filter(|(base, _)| !base.is_empty())
                .map(|(base, _)| base)
                .unwrap_or(name);
            IndexedFile::new(*path, name, stem)
        });
        LinkResolver::new(files, std::iter::empty())
    }

    fn resolver_with_aliases(paths: &[&str], aliases: &[(&str, &str)]) -> LinkResolver {
        let files = paths.iter().map(|path| {
            let name = path.rsplit('/').next().unwrap();
            let stem = name
                .rsplit_once('.')
                .filter(|(base, _)| !base.is_empty())
                .map(|(base, _)| base)
                .unwrap_or(name);
            IndexedFile::new(*path, name, stem)
        });
        let aliases = aliases
            .iter()
            .map(|(alias, path)| ((*alias).to_string(), (*path).to_string()));
        LinkResolver::new(files, aliases)
    }

    #[test]
    fn empty_target_is_the_source_file() {
        let r = resolver(&["Folder/B.md"]);
        assert_eq!(
            r.resolve("", Some("Folder/B.md")).as_deref(),
            Some("Folder/B.md")
        );
        assert_eq!(
            r.resolve("#Heading", Some("Folder/B.md")).as_deref(),
            Some("Folder/B.md")
        );
    }

    #[test]
    fn vault_root_exact_beats_same_folder_namesake() {
        let r = resolver(&["A.md", "Folder/A.md", "Folder/B.md"]);
        assert_eq!(r.resolve("A", Some("Folder/B.md")).as_deref(), Some("A.md"));
        assert_eq!(
            r.resolve("A.md", Some("Folder/B.md")).as_deref(),
            Some("A.md")
        );
    }

    #[test]
    fn explicit_relative_selects_the_sibling() {
        let r = resolver(&["A.md", "Folder/A.md", "Folder/B.md"]);
        assert_eq!(
            r.resolve("./A", Some("Folder/B.md")).as_deref(),
            Some("Folder/A.md")
        );
        assert_eq!(
            r.resolve("../A", Some("Folder/B.md")).as_deref(),
            Some("A.md")
        );
    }

    #[test]
    fn leading_slash_is_vault_root_only() {
        let r = resolver(&["A.md", "Folder/A.md"]);
        assert_eq!(
            r.resolve("/A", Some("Folder/B.md")).as_deref(),
            Some("A.md")
        );
        let r = resolver(&["Folder/A.md"]);
        assert_eq!(r.resolve("/A", Some("Folder/B.md")), None);
    }

    #[test]
    fn unique_suffix_finds_a_nested_file() {
        let r = resolver(&["other/Folder/A.md", "X.md"]);
        assert_eq!(
            r.resolve("A", Some("X.md")).as_deref(),
            Some("other/Folder/A.md")
        );
        assert_eq!(
            r.resolve("Folder/A", Some("X.md")).as_deref(),
            Some("other/Folder/A.md")
        );
    }

    #[test]
    fn exact_path_beats_a_longer_suffix() {
        let r = resolver(&["Folder/A.md", "other/Folder/A.md"]);
        assert_eq!(
            r.resolve("Folder/A", Some("X.md")).as_deref(),
            Some("Folder/A.md")
        );
    }

    #[test]
    fn ambiguous_basename_is_first_by_path_not_source_folder() {
        let r = resolver(&["Folder2/A.md", "Folder1/A.md", "Folder2/B.md"]);
        assert_eq!(
            r.resolve("A", Some("Folder2/B.md")).as_deref(),
            Some("Folder1/A.md")
        );
    }

    #[test]
    fn unique_stem_resolves_extensionless_attachments() {
        let r = resolver(&["assets/photo.png", "Note.md"]);
        assert_eq!(
            r.resolve("photo", Some("Note.md")).as_deref(),
            Some("assets/photo.png")
        );
        assert_eq!(
            r.resolve("photo.png", Some("Note.md")).as_deref(),
            Some("assets/photo.png")
        );
    }

    #[test]
    fn markdown_wins_exact_stem_over_same_named_attachment() {
        let r = resolver(&["Note.png", "Note.md"]);
        assert_eq!(
            r.resolve("Note", Some("Other.md")).as_deref(),
            Some("Note.md")
        );
    }

    #[test]
    fn alias_is_after_real_filenames() {
        let r = resolver_with_aliases(
            &["Real.md", "Aliased.md"],
            &[("Real", "Aliased.md"), ("Nickname", "Aliased.md")],
        );
        assert_eq!(r.resolve("Real", Some("X.md")).as_deref(), Some("Real.md"));
        assert_eq!(
            r.resolve("Nickname", Some("X.md")).as_deref(),
            Some("Aliased.md")
        );
    }

    #[test]
    fn same_link_resolves_the_same_from_every_source() {
        let r = resolver(&["A.md", "Folder/A.md", "Elsewhere/C.md"]);
        assert_eq!(
            r.resolve("A", Some("Elsewhere/C.md")).as_deref(),
            Some("A.md")
        );
        assert_eq!(r.resolve("A", Some("Folder/A.md")).as_deref(), Some("A.md"));
        assert_eq!(r.resolve("A", Some("A.md")).as_deref(), Some("A.md"));
    }
}
