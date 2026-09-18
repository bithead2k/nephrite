# Deferred: Obsidian sync checkpoint converter

Recorded September 9, 2026. **Deferred at the user's request.** Revisit if someone requests it; potentially a standalone side project or product. No implementation is currently planned.

## Purpose

Let an existing, synchronized Obsidian vault continue syncing through Obsidian Headless (`ob`) without rebuilding all of its sync knowledge and rehashing every unchanged file.

## Investigation findings

Inspection of the locally installed Obsidian 1.13.7 application and obsidian-headless 0.0.14 suggests that their state models are closely related. This is preliminary implementation evidence, not a tested conversion or a supported upstream migration interface.

Obsidian reads an IndexedDB database named `<appId>-sync`, with the state in the `data` object store under the `data` key. Headless stores corresponding records in SQLite:

| Obsidian field | Headless equivalent |
| --- | --- |
| `version` | `meta` version: remote change cursor |
| `initial` | `meta` initial-sync flag |
| `local` | `local_files`: paths, hashes, timestamps, size and sync history |
| `remote` | `server_files`: known remote records, including deletion state |
| `pending` | `pending_files`: received changes awaiting processing |

Copying only the remote cursor is insufficient: the matching file baseline and pending changes are needed to interpret subsequent edits and deletions correctly. The observed Headless “Checking” branch hashes an existing local file when its cached hash is absent.

## Candidate design when requested

An optional “Continue from Obsidian” setup action, or a standalone conversion utility, would extract a consistent snapshot, verify the local and remote vault identities, validate supported state versions and sync settings, and translate the complete checkpoint. Changed local files would still be checked; matching files could reuse cached hashes after validating timestamp and size semantics.

Before enabling it, test conversion on disposable vaults with unchanged files, offline edits, renames, deletions, pending remote changes, differing exclusions and configuration-file settings. Validate crash consistency, rollback and platform-specific extraction. Do not overwrite an active sync database. Do not copy proprietary application code into the implementation.

## Current disposition

The user's vault completed its initial Headless sync and reported “Fully synced.” Its own checkpoint now exists, removing the immediate need for migration. Preserve this idea for future demand; do not resume implementation merely because it appears in this document.
