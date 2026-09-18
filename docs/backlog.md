# Backlog disposition

Updated September 9, 2026 from user review. This records scope, not a new implementation commitment.

- **Templater:** Remaining compatibility work, particularly `<%* … %>` JavaScript execution. A broader workflow engine is not requested.
- **Git:** Full-file merge interface remains documented as partial.
- **Note embeds:** Considered fixed following extensive practical use during job-search Kanban work. Remove from the active bug backlog; retain regression coverage.
- **Vim:** `syntax`, `filetype`, `autocmd`, and `colorscheme` compatibility limitations warrant scope discussion. They are not four equivalent small improvements; no implementation commitment yet.
- **Plugins:** Technically implemented, lightly tested. Expand real-plugin tests as useful cases arise; exhaustive ecosystem validation is not a finite deliverable.
- **SQL:** Additional query test cases are wanted. No specific defect is asserted. Define the supported behavior and expected results as a deliverable contract rather than treating broad PostgreSQL compatibility as an unbounded requirement.
- **Sync converter:** Deferred, potentially a separate project if requested; see [investigation](deferred-sync-converter.md).

Generic compatibility and polish suggestions are not automatically approved backlog features.
