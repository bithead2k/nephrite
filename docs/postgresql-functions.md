# PostgreSQL function compatibility

Nephrite validates native SQL with PostgreSQL's parser and audits the exposed
surface against PostgreSQL 18.4's `pg_catalog`. It executes a safe,
read-only lowering on SQLite. `nephrite_pg_proc()` returns the comma-separated
inventory of callable PostgreSQL-compatible functions. The same inventory is
queryable as rows in `pg_catalog.pg_proc`; supported operator signatures are
in `pg_catalog.pg_operator`.

The compatibility layer includes:

- native conditional and aggregate functions such as `coalesce`, `nullif`,
  `count`, `sum`, `avg`, `min`, and `max`;
- `string_agg`, `array_agg`, JSON/JSONB aggregates, `bool_and`, `bool_or`, and
  `every` lowering;
- text, padding, quoting, regular-expression, and encoding functions;
- numeric and mathematical functions;
- typed one-dimensional array constructors, functions, subscripts, slices,
  quantified comparisons, concatenation, containment, overlap, and ordering;
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

The compatibility boundary is semantic. The catalog-shaped tables advertise
only behavior Nephrite can execute; they are not copies of a server's complete
physical catalogs. Nephrite does not advertise
server administration, filesystem, network, procedural-language, replication,
or mutation routines that cannot safely operate in a local read-only vault
query. PostgreSQL arrays are currently one-dimensional, timestamps are handled
as ISO text in UTC or without a zone, and Rust regex syntax is used for the
supported PostgreSQL regex functions.

PostgreSQL 18 array additions `array_sort`, `array_reverse`, `array_shuffle`,
and `array_sample` are included. JSONPath operators and set-returning
record-expansion functions are intentionally not advertised: implementing
those requires a genuine JSONPath/table-function runtime, not a misleading
approximation.

The ordinary read-only relational surface—CTEs, `VALUES`, joins, subqueries,
`CASE`, aggregates, `FILTER`, grouping, `HAVING`, set operations, ordering,
limits, and SQLite-supported window functions—passes through after PostgreSQL
validation.

```sql
SELECT proname FROM pg_catalog.pg_proc ORDER BY proname;
SELECT oprname, oprleft, oprright, oprresult
FROM pg_catalog.pg_operator ORDER BY oprname, oprleft;
```

## Page semantic types

Native page queries use the `pages` view. The following PostgreSQL-looking
forms are lowered into SQLite helpers before execution:

| PostgreSQL form | Lowering |
|---|---|
| `properties['key']` | `page_property(properties, 'key')` |
| `properties->>'key'` / `properties->'key'` | `page_property(properties, 'key')` |
| `properties ? 'key'` | `page_has_key(properties, 'key')` |
| `tags @> ARRAY['a','b']` | `page_has_tag` AND chain |
| `tags && ARRAY['a','b']` | `page_has_tag` OR chain |
| `'x' = ANY(tags)` | `page_has_tag(tags, 'x')` |
| `aliases @>` / `&&` / `ANY` | same helpers (aliases are string arrays) |
| `ARRAY[...]` | `page_array(...)` |
| `EXTRACT(field FROM expr)` | `date_part('field', expr)` |
| `a[n]`, `a[l:u]` | typed array get/slice helpers |
| `a @> b`, `a <@ b`, `a && b` | array containment/overlap helpers |
| `a || b`, array comparisons | concatenation and lexicographic comparison |
| `value OP ANY(a)` / `ALL(a)` | quantified comparison helper |
| JSON `->`, `->>`, `#>`, `#>>` | JSON path extraction helpers |
| JSON `?`, `?&`, `?|`, `@>`, `<@`, `-`, `||` | JSONB-compatible helpers |

The public model remains:

```text
page.record
├── properties  page.properties
├── tags        page.tag[]
├── aliases     page.alias[]
├── links       page.link[]
├── headers     page.header[]
└── todos       page.todo[]
```

Page-owned property and array indirection now lower from `A_Indirection` AST
nodes. Recognized AST statements run only the syntax residual; the complete
textual page pass remains solely as a compatibility fallback when no safe AST
rewrite can be recovered.

## AST → IR lowering

Native page SQL walks the `libpg_query` parse tree, lowers recognized forms
into `PageExpr` (`src-tauri/src/page_sql.rs`), recovers spans (token scan +
node locations + name-search fallback), and rewrites those spans to SQLite
helpers.

Pipeline:

1. **AST rewrite** of recognized page forms, FuncCalls, arrays, null tests, casts.
2. **EXTRACT keyword** scan for raw `EXTRACT(field FROM expr)` not already covered.
3. **Residual syntax lowering** for grammar SQLite cannot parse directly.
4. **Compatibility fallback** only when AST span recovery produces no rewrite.

| Form | IR | Emission |
|------|----|----------|
| `tags` / `aliases` `@> ARRAY[...]` | `AllTags` | `page_has_tag` AND |
| `tags` / `aliases` `&& ARRAY[...]` | `AnyTag` | `page_has_tag` OR |
| `'x' = ANY(tags\|aliases)` | `HasTag` | `page_has_tag` |
| `properties ? 'key'` | `HasKey` | `page_has_key` |
| `properties ?&` / `?\|` `ARRAY[...]` | `AllKeys` / `AnyKeys` | AND / OR of `page_has_key` |
| `jsonb_exists(properties, 'key')` | `HasKey` | `page_has_key` |
| `jsonb_exists_all` / `_any` | `AllKeys` / `AnyKeys` | AND / OR of `page_has_key` |
| `properties->'key'` / `->>'key'` / `[...]` | `PropertyGet` | `page_property` |
| `ARRAY[...]` (standalone / casted) | `ArrayLit` | `page_array` |
| `date_part` / `extract` / `EXTRACT(...)` | `DatePart` | `date_part('field', …)` |
| `string_agg` / `bool_or` / `bool_and` / `every` | `AggRename` | SQLite aggregates |
| `… IS [NOT] NULL` on page forms | `NullCheck` | null test on lowered expr |
| `TypeCast` wrappers | (peeled) | inner lowerer |

`analyze_page_forms(sql)` returns IR for diagnostics and tests.
