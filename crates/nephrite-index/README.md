# nephrite-index

Disposable SQLite vault index for Nephrite.

- **Open path:** create/open `.nephrite/index.db`, WAL mode, **reconcile with filesystem**
- **Identity:** vault-relative path only
- **Not** PostgreSQL `REINDEX CONCURRENTLY` — vault refresh is reparse + row rewrite

See `docs/vault-schema.md`.
