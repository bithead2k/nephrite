# Versioning

There is **one** version for Nephrite: **`PROJECT_VERSION`**.

Everything else serves it: crates, release notes, `.nephrite/index.db` metadata, rebuild policy, and UI “About”.

## Form

PostgreSQL-style **two-part** number:

```text
MAJOR.MINOR
```

Examples: `0.1`, `0.2`, `1.0`, `1.1`.

Cargo may store `MAJOR.MINOR.0` because the ecosystem expects three components; only **major** and **minor** are meaningful. Do not invent a second product/index/semver axis.

## Semantics

| Part | When it increases | Effect |
|------|-------------------|--------|
| **MAJOR** | Incompatible change: index schema or parse that invalidates existing disposable index rows | **Full index rebuild** on open (re-read vault → rewrite `.nephrite/index.db`). User Markdown is not rewritten. |
| **MINOR** | Compatible change: features, fixes, additive schema, UI | **No rebuild.** Open still reconciles by mtime/size as usual. |

**Rule:** if an existing index from the previous `PROJECT_VERSION` would be wrong without reparsing the vault, bump **MAJOR**. Otherwise bump **MINOR**.

## On-disk

`schema_meta` stores the project version that last successfully owned the index:

| key | value |
|-----|--------|
| `project_version` | e.g. `0.1` |

On open:

```text
stored = meta.project_version   # if missing → treat as rebuild
if PROJECT_VERSION.major != stored.major:
    full_rebuild()
else:
    reconcile_mtime_size()
meta.project_version = PROJECT_VERSION
```

No separate `index_version`, `INDEX_VERSION`, or parallel version clocks.

## Source of truth

| Location | Role |
|----------|------|
| `nephrite-index` → `PROJECT_VERSION` in `version.rs` | Canonical constant for the workspace until a single top-level crate owns it |
| Workspace `Cargo.toml` `version` | Must match as `MAJOR.MINOR.0` |
| `docs/versioning.md` | This policy |

When the app crate exists, it imports or re-exports the same `PROJECT_VERSION`—it does not define another.

## Current release

**`PROJECT_VERSION` = `0.4`** — the current public milestone. This is a minor
upgrade from 0.3, so opening an existing 0.3 index does not force a full rebuild.
It performs a one-time Markdown backfill for typed Dataview inline fields.
When the earlier 0.2 milestone opened an index written by the internal 2.0
development version, it performed a clean, disposable rebuild because the
stored major differed.

## Release notes

State `PROJECT_VERSION` and whether a **major** bump implies rebuild (always yes for major, no for minor-only).
