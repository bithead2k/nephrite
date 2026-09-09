# Table editing: source editor workflow

## Implemented for this iteration

- **Creation:** use the existing `/table` completion in the source editor. No separate grid dialog.
- **Navigation:** Tab selects the next cell's text; Shift+Tab selects the previous cell. The separator row is skipped. Tab in the final cell inserts an empty body row. Shift+Tab in the first cell stays there. Outside a complete table, existing editor shortcuts apply.
- **Structure and alignment:** right-click the source cell to insert, duplicate, delete, or move its row/column. Header and separator rows cannot be deleted as body rows. Moving a column also moves its alignment. `Align column: left / center / right / block justified` changes the Markdown marker; the current choice has a checkmark. These menu items are confined to source mode.
- **Repair:** right-click → `Inspect / repair table…`. A panel attached to the source editor lists the issues, current Markdown, and proposed Markdown. Apply is one undoable change; Cancel leaves the source alone. Editing the document closes an outdated proposal. Missing cells get blanks, extra cells expand the table, and missing/malformed separators receive a proposed correction. Ambiguous unescaped pipes are explained, not silently guessed: cancel and escape a literal pipe, or approve preserving it as another cell.

## Additional implemented workflows

### Spreadsheet paste

Recognize a rectangular TSV grid or clipboard HTML table. After Ctrl+V, show a panel attached to the source editor, keeping the note visible and unchanged until acceptance:

```text
Spreadsheet paste · 3 rows × 4 columns
[✓] First row contains headings
[Insert table]  [Paste plain text]  [Cancel]
```

Inside an existing table, use the current cell as the top-left destination:

```text
Paste 3 × 4 cells starting at row 2, column 3
Replaces 8 populated cells; adds 1 row and 2 columns.
[Apply to highlighted cells]  [Paste plain text]  [Cancel]
```

Show the destination cells with a temporary highlight, and current and proposed Markdown, including new rows/columns. Enter accepts, Escape cancels, and Ctrl+Z undoes the paste as one action. Preserve Unicode, parse quoted tabs/newlines correctly, escape literal pipes, and explicitly show how multiline spreadsheet cells become `<br>` within one Markdown row. Never guess CSV from ordinary comma-separated prose.

### Formatting commands

Offer these in the application command palette, available while the caret stays in the editor:

```text
> format table
  Format current table
  Format tables in selection
  Format all tables in this note
  Toggle live table formatting
```

Keep table formatting restricted to spacing and the selected alignments. Preserve text, row order, and non-table blocks. A note-wide command should report `Formatted 6 tables; 1 malformed table skipped` and use a single undo step. A vault-wide rewrite is unnecessary for this workflow.

### Settings

Use **Settings → Editor → Tables** for live formatting, cell padding, Tab navigation, source overflow (horizontal scroll or visual soft wrap), and preferred preview column width. Source rows remain one physical Markdown line; visual wrapping does not insert newlines into cells. Default to horizontal scrolling when maintaining the source's aligned column boundaries matters. Per-column alignment continues to live in Markdown separator markers.

### Sorting affordance

Right-click a source column and choose **Sort rows by <heading>: ascending / descending**. The command palette also offers **Sort table rows by current column** in either direction. Sorting rewrites body rows in Markdown as one undoable edit. It preserves the header, separator, alignment, and each row's content. Entirely numeric columns sort numerically; other columns use natural text ordering. Equal values keep their original order, and blank cells go last in both directions. Formatting never sorts rows.

### Cell-region selection

A source-editor command or context item, **Select table cells**, starts a temporary selection mode. Click the first cell and Shift-click the last, or extend with Shift+Arrow. Highlight each cell's content while leaving pipes unselected:

```text
| Name | Monday   | Tuesday  |
| ---- | -------- | -------- |
| Ada  | [Review] | [Write]  |
| Lin  | [Test]   | [Ship]   |
         ← 2 rows × 2 columns →
```

A compact hint reads `2 × 2 cells · Ctrl+C copy · Delete clear · Esc exit`. Copy produces TSV for spreadsheets. Delete clears the cells while preserving the table structure. Paste fills the selected rectangle, showing a proposal for mismatched dimensions. Escape returns to ordinary text selection. This keeps rectangular cell selection distinct from selecting source characters across pipes.
