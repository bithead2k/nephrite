# Nephrite 0.16.0

`PROJECT_VERSION` 0.16 is a compatible minor release. Existing 0.15 indexes
remain usable without a full vault rebuild. Markdown files are unchanged.

## Performance in very large vaults

Significant performance issues were fixed for vaults with a very large number
of objects, including vaults containing more than 100,000 files.

- Removed an unnecessary full-vault metadata fetch on preview refresh when a
  note contains no embedded Base tables. This was a major cause of interface
  stalls after pausing while typing.
- Shared query metadata across previews, refreshed changed pages incrementally,
  and updated only affected backlinks instead of rebuilding the entire cache.
- Reduced query preparation work and added indexed birthday lookups for common
  birth-date field names. Supported queries retain their original filters to
  reject false positives; unsupported expressions use the existing evaluator.
- Made file-tree updates independent of deferred editor/preview work, with
  scoped file lookups and coalesced filesystem notifications.
- Suppressed automatic file-tree expansion when opening notes, including through
  automation, and reduced repeated plugin metadata refreshes.

Large-vault testing showed substantially faster preview loading and removal of
the major typing-pause lockup. A small residual delay remains under investigation;
this release does not claim all editor latency has been eliminated.
