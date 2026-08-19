//! Named, resumable feature backfills for the disposable index.
//!
//! A migration is a one-time re-parse pass over a file kind. Completion is
//! recorded with a `schema_meta` key; while a migration is still pending,
//! per-file progress lives in `migration_state` so an interrupted open resumes
//! where it stopped instead of restarting the whole job.
//!
//! See `docs/versioning.md` and AGENTS.md (Immediate Resume Checklist).

use std::path::Path;
use std::str::FromStr;

use rusqlite::{params, Connection};

use crate::error::Result;
use crate::{Version, PROJECT_VERSION};

pub const DATAVIEW_INLINE_FIELDS_VERSION: &str = "1";
pub const TASKS_EXTENDED_METADATA_VERSION: &str = "1";

pub const MIGRATION_DATAVIEW_INLINE_FIELDS: &str = "dataview-inline-fields";
pub const MIGRATION_TASKS_EXTENDED_METADATA: &str = "tasks-extended-metadata";
pub const MIGRATION_LEGACY_02_CANVAS: &str = "legacy-02-canvas";

pub struct Migration {
    pub id: &'static str,
    pub action: &'static str,
    /// Singular noun used in preflight action text ("note", "canvas").
    pub unit: &'static str,
    /// Plural noun used in preflight action text ("notes", "canvases").
    pub units: &'static str,
    /// Files this migration must re-parse.
    pub targets: fn(&Path) -> bool,
    /// Key whose presence marks this migration complete.
    pub completion_key: &'static str,
    pub pending: fn(&Connection) -> Result<bool>,
    pub complete: fn(&Connection) -> Result<()>,
}

/// One pending named backfill, ready for the UI / preflight planner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedMigration {
    pub id: &'static str,
    pub action: &'static str,
    pub unit: &'static str,
    pub units: &'static str,
    pub remaining: i64,
}

/// Read-only open plan: rebuild vs reconcile vs named backfills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPlan {
    pub rebuild: bool,
    pub action: String,
    pub migrations: Vec<PlannedMigration>,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        id: MIGRATION_DATAVIEW_INLINE_FIELDS,
        action: "Backfilling Dataview fields",
        unit: "note",
        units: "notes",
        targets: |path| extension_is(path, "md"),
        completion_key: "dataview_inline_fields_version",
        pending: |conn| {
            meta_missing(
                conn,
                "dataview_inline_fields_version",
                DATAVIEW_INLINE_FIELDS_VERSION,
            )
        },
        complete: |conn| {
            set_meta(
                conn,
                "dataview_inline_fields_version",
                DATAVIEW_INLINE_FIELDS_VERSION,
            )
        },
    },
    Migration {
        id: MIGRATION_TASKS_EXTENDED_METADATA,
        action: "Backfilling Tasks metadata",
        unit: "note",
        units: "notes",
        targets: |path| extension_is(path, "md"),
        completion_key: "tasks_extended_metadata_version",
        pending: |conn| {
            meta_missing(
                conn,
                "tasks_extended_metadata_version",
                TASKS_EXTENDED_METADATA_VERSION,
            )
        },
        complete: |conn| {
            set_meta(
                conn,
                "tasks_extended_metadata_version",
                TASKS_EXTENDED_METADATA_VERSION,
            )
        },
    },
    Migration {
        id: MIGRATION_LEGACY_02_CANVAS,
        action: "Renumbering legacy canvas files",
        unit: "canvas",
        units: "canvases",
        targets: |path| extension_is(path, "canvas"),
        completion_key: "project_version",
        // The stored project version write that ends every reconcile records
        // this migration as complete; nothing extra is needed here.
        pending: |conn| {
            Ok(stored_version(conn)?.is_some_and(|v| PROJECT_VERSION.is_legacy_02_renumbering(v)))
        },
        complete: |_conn| Ok(()),
    },
];

fn extension_is(path: &Path, want: &str) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(want))
}

fn meta_missing(conn: &Connection, key: &str, expected: &str) -> Result<bool> {
    Ok(get_meta(conn, key)?.as_deref() != Some(expected))
}

/// MIGRATIONS is public but crate-private registry accessors below are shared
/// with the index owner (VaultIndex). Key/value helpers operate on any
/// connection so preflight planning can run read-only.
pub(crate) fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    let r = conn.query_row(
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

pub(crate) fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO schema_meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn stored_version(conn: &Connection) -> Result<Option<Version>> {
    if let Some(s) = get_meta(conn, "project_version")? {
        return Ok(Some(Version::from_str(&s)?));
    }
    for key in ["index_version", "product_version", "schema_version"] {
        if let Some(s) = get_meta(conn, key)? {
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

/// The named migrations still pending for this database, in registry order.
///
/// This is a read-only query used by preflight planning and by `reconcile`.
/// Old databases predating `schema_meta` or `migration_state` are treated as
/// having everything pending rather than failing.
pub fn pending_migrations(conn: &Connection) -> Result<Vec<&'static Migration>> {
    let mut pending = Vec::new();
    for migration in MIGRATIONS {
        match (migration.pending)(conn) {
            Ok(true) => pending.push(migration),
            Ok(false) => {}
            Err(_) => pending.push(migration),
        }
    }
    Ok(pending)
}

/// How many indexed files still need this migration, for truthful action text.
/// Files not yet in the index are excluded; the count is an estimate used by
/// preflight, and the actual reconcile walks the vault directly.
///
/// Tolerates databases without a `migration_state` table (pre-0.4): every
/// targeted indexed file counts as remaining. Missing `schema_meta` or
/// `files` is treated as "still pending" rather than failing the planner.
pub fn remaining_for(conn: &Connection, migration: &Migration) -> Result<i64> {
    // A completed migration has nothing remaining even if checkpoints were
    // cleared after completion. A lookup error means we cannot prove
    // completion, so the migration stays pending.
    if let Ok(false) = (migration.pending)(conn) {
        return Ok(0);
    }
    let mut statement = match conn.prepare("SELECT path FROM files") {
        Ok(statement) => statement,
        Err(_) => return Ok(0),
    };
    let paths = match statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()
    {
        Ok(paths) => paths,
        Err(_) => return Ok(0),
    };
    let target = paths
        .iter()
        .filter(|path| (migration.targets)(Path::new(path)))
        .count() as i64;
    // Tolerate databases without a `migration_state` table (pre-0.4).
    let has_state = has_migration_state_table(conn).unwrap_or(false);
    let done: i64 = if has_state {
        conn.query_row(
            "SELECT COUNT(*) FROM migration_state WHERE migration_id = ?1",
            params![migration.id],
            |row| row.get(0),
        )
        .unwrap_or(0)
    } else {
        0
    };
    Ok((target - done).max(0))
}

/// Read-only preflight used by `vault_open_plan`. A major mismatch or empty
/// files table is a rebuild; otherwise named backfills are listed with
/// remaining counts. Rebuilds do not surface migrations — the rebuild itself
/// is the work, and listing them would make the UI say "Backfilling".
pub fn plan_open(conn: &Connection) -> Result<OpenPlan> {
    let stored = stored_version(conn)?;
    let file_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
        .unwrap_or(0);
    let rebuild = match stored {
        None => true,
        Some(version) => PROJECT_VERSION.requires_rebuild(version) || file_count == 0,
    };
    let migrations = if rebuild {
        Vec::new()
    } else {
        pending_migrations(conn)?
            .into_iter()
            .map(|migration| PlannedMigration {
                id: migration.id,
                action: migration.action,
                unit: migration.unit,
                units: migration.units,
                remaining: remaining_for(conn, migration).unwrap_or(0),
            })
            .collect()
    };
    Ok(OpenPlan {
        action: format_open_action(rebuild, &migrations),
        rebuild,
        migrations,
    })
}

/// Compose the status string shown while the index is opening.
pub fn format_open_action(rebuild: bool, migrations: &[PlannedMigration]) -> String {
    if rebuild {
        return format!("Rebuilding the vault index for Nephrite {PROJECT_VERSION}…");
    }
    let Some(first) = migrations.first() else {
        return "Checking the vault for changed files…".to_string();
    };
    let extra = if migrations.len() > 1 {
        let more = migrations.len() - 1;
        format!(" and {more} other step{}", if more == 1 { "" } else { "s" })
    } else {
        String::new()
    };
    if first.remaining <= 0 {
        return format!("Finishing {}{extra}…", first.action.to_ascii_lowercase());
    }
    let noun = if first.remaining == 1 {
        first.unit
    } else {
        first.units
    };
    format!(
        "{} across {} {noun}{extra}…",
        first.action,
        format_count(first.remaining)
    )
}

/// Thousands separators for action text ("9900" → "9,900").
pub fn format_count(value: i64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, ch) in digits.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

/// `true` when the connection already has the resumable checkpoint table.
/// Used by `reconcile` to avoid failing when upgrading an old index in place.
pub(crate) fn has_migration_state_table(conn: &Connection) -> Result<bool> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name = 'migration_state'",
        [],
        |row| row.get(0),
    )?;
    Ok(exists > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_match_expected_kinds() {
        assert!((MIGRATIONS[0].targets)(Path::new("Note.md")));
        assert!((MIGRATIONS[0].targets)(Path::new("sub/Note.MD")));
        assert!(!(MIGRATIONS[0].targets)(Path::new("Plan.canvas")));
        assert!((MIGRATIONS[1].targets)(Path::new("Note.md")));
        assert!(!(MIGRATIONS[1].targets)(Path::new("Plan.canvas")));
        assert!((MIGRATIONS[2].targets)(Path::new("Plan.canvas")));
        assert!(!(MIGRATIONS[2].targets)(Path::new("Note.md")));
    }

    #[test]
    fn pending_follows_completion_key() {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("meta.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        )
        .unwrap();
        let m = &MIGRATIONS[0];
        assert!((m.pending)(&conn).unwrap());
        (m.complete)(&conn).unwrap();
        assert!(!(m.pending)(&conn).unwrap());
    }

    #[test]
    fn remaining_for_tolerates_pre_04_databases() {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("old.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             CREATE TABLE files (path TEXT PRIMARY KEY NOT NULL);
             INSERT INTO schema_meta(key, value) VALUES ('project_version', '0.3');
             INSERT INTO files(path) VALUES ('A.md'), ('B.md'), ('Board.canvas');",
        )
        .unwrap();
        let remaining = remaining_for(&conn, &MIGRATIONS[0]).unwrap();
        assert_eq!(remaining, 2);
        let plan = plan_open(&conn).unwrap();
        assert!(!plan.rebuild);
        assert_eq!(plan.migrations[0].id, MIGRATION_DATAVIEW_INLINE_FIELDS);
        assert_eq!(plan.migrations[0].remaining, 2);
        assert_eq!(
            plan.action,
            "Backfilling Dataview fields across 2 notes and 1 other step…"
        );
    }

    #[test]
    fn plan_open_rebuild_hides_migrations() {
        let dir = tempfile::tempdir().unwrap();
        let conn = Connection::open(dir.path().join("empty.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        )
        .unwrap();
        let plan = plan_open(&conn).unwrap();
        assert!(plan.rebuild);
        assert!(plan.migrations.is_empty());
        assert!(plan.action.starts_with("Rebuilding the vault index"));
    }

    #[test]
    fn format_open_action_uses_counts_units_and_extra_steps() {
        assert_eq!(format_count(9900), "9,900");
        let first = PlannedMigration {
            id: MIGRATION_DATAVIEW_INLINE_FIELDS,
            action: "Backfilling Dataview fields",
            unit: "note",
            units: "notes",
            remaining: 9900,
        };
        let second = PlannedMigration {
            id: MIGRATION_LEGACY_02_CANVAS,
            action: "Renumbering legacy canvas files",
            unit: "canvas",
            units: "canvases",
            remaining: 3,
        };
        assert_eq!(
            format_open_action(false, std::slice::from_ref(&first)),
            "Backfilling Dataview fields across 9,900 notes…"
        );
        assert_eq!(
            format_open_action(false, &[first, second]),
            "Backfilling Dataview fields across 9,900 notes and 1 other step…"
        );
        assert_eq!(
            format_open_action(false, &[]),
            "Checking the vault for changed files…"
        );
    }
}
