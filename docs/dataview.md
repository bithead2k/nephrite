# Dataview compatibility

Dataview is a compatibility frontend over Nephrite's disposable vault index. Markdown remains authoritative; executing a query does not rewrite a note.

## DQL

Use an ordinary `dataview` fence. Nephrite supports `TABLE`, `TABLE WITHOUT ID`, `LIST`, `TASK`, and `CALENDAR`, with `FROM`, repeated `WHERE`, repeated `FLATTEN`, `GROUP BY`, repeated/multi-column `SORT`, and `LIMIT`. Transforming clauses execute in written order.

`FROM` sources may select folders (`"people"`), tags (`#recruiter`, including nested tags), incoming links (`[[Brady Gunter]]`), outgoing links (`outgoing([[Brady Gunter]])`), and parenthesized `AND`, `OR`, `NOT`, or `-` combinations.

```dataview
TABLE WITHOUT ID file.link AS Person, company AS Company
FROM "people" AND (#recruiter OR #interviewer)
WHERE company
SORT company ASC, file.name ASC
```

`TASK` results contain source-backed checkboxes. Checking one performs the same surgical Markdown task edit used by Nephrite's task dashboard. `CALENDAR` renders one calendar per result month.

The expression runtime includes comparison and boolean operators, links, dates, durations, conditionals/defaults, string and regular-expression functions, numeric aggregates, collection transforms, object extraction, and link metadata. YAML properties and typed `key:: value` inline fields are both page fields. Page metadata includes `file.tags`, `file.etags`, `file.aliases`, `file.tasks`, `file.frontmatter`, `file.outlinks`, and `file.inlinks`.

Single-backtick `= expression` queries use the same expression runtime. Longer backtick spans remain literal Markdown code.

## DataviewJS

Use a `dataviewjs` fence. The synchronous page snapshot API includes:

- `dv.current()`, `dv.page()`, `dv.pages()`, and `dv.pagePaths()`;
- proxy-backed DataArrays with swizzling, `where`, `map`, `flatMap`, keyed sorting, grouping, distinct values, slicing, and limits;
- `dv.list`, `dv.table`, `dv.taskList`, `dv.paragraph`, `dv.header`, `dv.el`, and `dv.span`;
- Markdown list/table/task renderers and file/section/block link constructors;
- `dv.query`, `dv.tryQuery`, `dv.execute`, `dv.executeJs`, `dv.evaluate`, and `dv.tryEvaluate`;
- `dv.io.load`, `dv.io.csv`, path normalization, and vault-backed custom `dv.view` scripts;
- date/duration helpers plus comparison, equality, array, and cloning helpers.

External file access is restricted to the open vault through Nephrite's vault API. Mutating Obsidian internals, plugin discovery, network access, and the Obsidian application object are not compatibility targets. They are not Dataview's portable data/query model and would violate Nephrite's plugin and safety boundaries.

## Rebuilding old indexes

Inline fields are now indexed as typed values. On first open after this upgrade, Nephrite performs a one-time Markdown backfill through the normal visible index-progress path. Deleting `.nephrite/index.db` remains safe and forces a complete rebuild.
