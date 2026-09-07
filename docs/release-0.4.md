# Nephrite 0.4.0

`PROJECT_VERSION` 0.4 was a minor application release. Existing 0.3 indexes
remained compatible. A resumable backfill populated typed Dataview inline
fields without requiring a full vault rebuild.

## Dataview compatibility

- DQL added `TABLE`, `LIST`, `TASK`, and `CALENDAR` queries with ordered
  `FROM`, `WHERE`, `FLATTEN`, `GROUP BY`, `SORT`, and `LIMIT` processing.
- Source selectors gained folders, tags, incoming and outgoing links, and
  parenthesized boolean combinations.
- Task results used source-backed checkboxes, calendar results rendered month
  grids, and inline queries shared the full expression runtime.
- DataviewJS added page snapshots, DataArray operations, rendering helpers,
  query/evaluation helpers, vault-scoped I/O, and custom views.

## PostgreSQL and metadata

- PostgreSQL-style casts gained strict runtime conversion for Markdown scalar,
  JSON, date/time, and array values.
- Property lookup, tags, aliases, `ILIKE`, and paths received explicit
  case-retention and comparison rules.
- Per-interface font settings were added with sanitization and independent
  application.

## Regression protection

- Tests covered the complete DQL clause pipeline, source composition,
  collection/date/string functions, live tasks, calendars, DataviewJS, and
  inline expressions.

