use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Serialize)]
pub struct LinkSuggestion {
    pub path: String,
    pub target: String,
    pub name: String,
    pub folder: String,
    pub drawing: bool,
}

pub fn search(conn: &Connection, query: &str, embed: bool) -> Result<Vec<LinkSuggestion>, String> {
    let escaped = query
        .trim()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    // Prefix lookups use the name/alias B-trees. Broader contains matching is a
    // bounded fallback in the database worker, never a JS object per vault file.
    for pattern in [format!("{escaped}%"), format!("%{escaped}%")] {
        let sql = if query.trim().is_empty() {
            "SELECT path, stem, parent_path, file_kind FROM files INDEXED BY idx_files_completion
             WHERE file_kind IN ('markdown','excalidraw','canvas')
             ORDER BY stem COLLATE NOCASE, path LIMIT 10"
        } else {
            "SELECT path, stem, parent_path, file_kind FROM files INDEXED BY idx_files_completion
             WHERE file_kind IN ('markdown','excalidraw','canvas') AND stem LIKE ?1 ESCAPE '\\'
             UNION
             SELECT f.path, f.stem, f.parent_path, f.file_kind FROM aliases a INDEXED BY idx_aliases_completion JOIN files f ON f.path=a.path
             WHERE f.file_kind IN ('markdown','excalidraw','canvas') AND a.alias LIKE ?1 ESCAPE '\\'
             UNION
             SELECT path, stem, parent_path, file_kind FROM files INDEXED BY idx_files_completion_path
             WHERE file_kind IN ('markdown','excalidraw','canvas') AND path LIKE ?1 ESCAPE '\\'
             ORDER BY 2 COLLATE NOCASE, 1 LIMIT 10"
        };
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = if query.trim().is_empty() {
            stmt.query([])
        } else {
            stmt.query([&pattern])
        }
        .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let path: String = row.get(0).map_err(|e| e.to_string())?;
            if !seen.insert(path.clone()) {
                continue;
            }
            let name: String = row.get(1).map_err(|e| e.to_string())?;
            let folder = row.get(2).map_err(|e| e.to_string())?;
            let kind: String = row.get(3).map_err(|e| e.to_string())?;
            let ambiguous: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM files WHERE stem=?1 AND path<>?2 AND file_kind IN ('markdown','excalidraw','canvas'))", params![name,path], |r|r.get(0)).map_err(|e|e.to_string())?;
            let target = if ambiguous {
                path.strip_suffix(".md")
                    .or_else(|| path.strip_suffix(".markdown"))
                    .unwrap_or(&path)
                    .to_string()
            } else {
                name.clone()
            };
            let drawing = kind == "excalidraw" || path.ends_with(".excalidraw.md");
            found.push(LinkSuggestion {
                path,
                target,
                name,
                folder,
                drawing,
            });
            if found.len() == 10 {
                break;
            }
        }
        if found.len() == 10 || query.trim().is_empty() {
            break;
        }
    }
    if embed {
        found.sort_by_key(|item| !item.drawing);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_catalog_is_bounded_searchable_and_disambiguated() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../crates/nephrite-index/src/schema.sql"))
            .unwrap();
        let tx = conn.transaction().unwrap();
        {
            let mut insert = tx.prepare("INSERT INTO files(path,name,stem,parent_path,file_kind,mtime_ms,size_bytes,indexed_at_ms) VALUES (?1,?2,?2,'people','markdown',0,0,0)").unwrap();
            for i in 0..100_000 {
                insert
                    .execute(params![
                        format!("people/Person {i:06}.md"),
                        format!("Person {i:06}")
                    ])
                    .unwrap();
            }
            for (path, name) in [
                (
                    "companies/Zzz Example Corporation.md",
                    "Zzz Example Corporation",
                ),
                ("a/Acme.md", "Acme"),
                ("b/Acme.md", "Acme"),
                ("Literal%.md", "Literal%"),
            ] {
                insert.execute(params![path, name]).unwrap();
            }
        }
        tx.execute("INSERT INTO aliases(path,alias) VALUES ('companies/Zzz Example Corporation.md','Example Alias')",[]).unwrap();
        tx.commit().unwrap();
        let start = std::time::Instant::now();
        assert_eq!(search(&conn, "", false).unwrap().len(), 10);
        let rows = search(&conn, "Example Corp", false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target, "Zzz Example Corporation");
        assert_eq!(
            search(&conn, "Example Alias", false).unwrap()[0].path,
            rows[0].path
        );
        assert_eq!(search(&conn, "Literal%", false).unwrap().len(), 1);
        assert_eq!(
            search(&conn, "Acme", false)
                .unwrap()
                .iter()
                .map(|r| r.target.as_str())
                .collect::<Vec<_>>(),
            vec!["a/Acme", "b/Acme"]
        );
        assert_eq!(search(&conn, "companies/Zzz", false).unwrap().len(), 1);
        println!("100k-note completion lookups: {:?}", start.elapsed());
        let plan=conn.prepare("EXPLAIN QUERY PLAN SELECT path FROM files INDEXED BY idx_files_completion WHERE file_kind IN ('markdown','excalidraw','canvas') AND stem LIKE ?1 ESCAPE '\\' ORDER BY stem COLLATE NOCASE,path LIMIT 10").unwrap().query_map(["Exam%"],|r|r.get::<_,String>(3)).unwrap().collect::<Result<Vec<_>,_>>().unwrap().join("\n");
        assert!(
            plan.contains("SEARCH files USING INDEX idx_files_completion"),
            "{plan}"
        );
    }
}
