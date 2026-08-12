# Kanban card-move hooks

When a card is dragged to another column, Nephrite:

1. **Leave** — emit `kanban:card-left`, run `onCardLeave` / `onCardLeaveFile` (board not rewritten yet)  
2. Rewrite board Markdown and save  
3. **Land** — emit `kanban:card-moved`, run `onCardMove` / `onCardMoveFile`  

## Global listeners (app / future plugins)

```ts
import { on, Events } from "./hooks";

on(Events.KanbanCardLeft, async (event) => {
  console.log("leaving", event.fromColumn, event.card.label);
});

on(Events.KanbanCardMoved, async (event) => {
  console.log("landed", event.toColumn, event.card.label);
});
```

### Event payload (`phase`: `"leave"` | `"land"`)

| Field | Meaning |
|-------|---------|
| `boardPath` | Vault path of the board note |
| `card` | `{ label, link, text, checked, raw }` |
| `fromColumn` / `toColumn` | Column titles (`##` headings) |
| `fromColumnIndex` / `toColumnIndex` | Column indices |
| `fromIndex` / `toIndex` | Card indices |
| `columns` | Board state: **before** move on leave, **after** on land |
| `phase` | `"leave"` or `"land"` |

## Board-local hooks (settings JSON)

In the board footer (`%% kanban:settings %%`), add a `nephrite.hooks` object:

````markdown
%% kanban:settings
```
{
  "kanban-plugin": "board",
  "nephrite": {
    "hooks": {
      "onCardLeaveFile": "automation/job-board-on-card-leave.js",
      "onCardMoveFile": "automation/job-board-on-card-move.js",
      "onCardLeave": "log('bye', event.fromColumn);",
      "onCardMove": "log('hi', event.toColumn);"
    }
  }
}
```
%%
````

| Key | When |
|-----|------|
| `onCardLeave` / `onCardLeaveFile` | Leaving the source swim lane |
| `onCardMove` / `onCardMoveFile` | Landing in the destination swim lane |

### Script bindings

Async is fine. Available:

| Name | Role |
|------|------|
| `event` | Payload above |
| `phase` | `"leave"` or `"land"` |
| `open(path)` | Open a vault note |
| `openLink(target)` | Resolve wikilink and open |
| `log(...args)` | Console log |
| `invoke(cmd, args)` | Tauri command |
| `$` / `$$` / `shell` | Host shell (`await $("jobctl …")`) |

### Example land script (`jobctl stage`)

```js
// automation/job-board-on-card-move.js
const stage = event.toColumn.trim().toLowerCase();
const slug = event.card.link?.split("/").pop()?.replace(/\.md$/i, "");
await $(`jobctl stage '${slug}' '${stage}'`);
```

### Example leave script

```js
// automation/job-board-on-card-leave.js
log("leaving", event.fromColumn, "→", event.toColumn, event.card.label);
// await $(`something-on-exit …`);
```

## Compatibility

- Existing Obsidian Kanban boards keep working; hooks are optional and Nephrite-only.  
- Unknown settings keys are preserved on board rewrite when possible.  
- Hook errors are logged and shown as a banner on the board; the move itself still saves.
