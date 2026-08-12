# PostgreSQL function compatibility

Nephrite validates native SQL with PostgreSQL's parser and executes a safe,
read-only lowering on SQLite. `nephrite_pg_proc()` returns the comma-separated
inventory of callable PostgreSQL-compatible functions in the current build.

The compatibility layer includes:

- native conditional and aggregate functions such as `coalesce`, `nullif`,
  `count`, `sum`, `avg`, `min`, and `max`;
- `string_agg`, `bool_and`, `bool_or`, and `every` lowering;
- text, padding, quoting, regular-expression, and encoding functions;
- numeric and mathematical functions;
- one-dimensional array constructors and functions;
- JSON/JSONB construction, inspection, formatting, and null stripping;
- UTC timestamps, date construction, `date_part`, and PostgreSQL
  `EXTRACT(field FROM value)` syntax;
- safe informational functions such as `version`, `pg_typeof`, and
  `pg_client_encoding`.

`concat_ws(separator, ...)` is the PostgreSQL spelling. Nephrite also provides
`ws_concat(separator, ...)` as an alias. Both ignore NULL value arguments.
`coalesce(...)` and text concatenation with `||` use the native SQLite
implementations, whose relevant NULL behavior matches PostgreSQL: `coalesce`
returns the first non-NULL value, while either NULL operand makes `||` return
NULL.

The compatibility boundary is intentionally semantic rather than a fabricated
copy of PostgreSQL's physical `pg_proc` table. Nephrite does not advertise
server administration, filesystem, network, procedural-language, replication,
or mutation routines that cannot safely operate in a local read-only vault
query. PostgreSQL arrays are currently one-dimensional, timestamps are handled
as ISO text in UTC or without a zone, and Rust regex syntax is used for the
supported PostgreSQL regex functions.
