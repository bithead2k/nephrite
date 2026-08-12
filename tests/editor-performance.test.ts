import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Text } from "@codemirror/state";
import { frontmatterFoldRange } from "../ui/src/editor";
import { DeferredDocumentWork, type TimerHandle } from "../ui/src/edit-scheduler";
import { frontmatterForDecorations } from "../ui/src/yaml-booleans";
import {
  evaluateDql,
  extractScriptBlocks,
  lowerDqlFunctionAliases,
  type DvPage,
} from "../ui/src/dv-engine";
import { rowToDvPage } from "../ui/src/dv-context";
import { renderPropertiesHtml } from "../ui/src/frontmatter";
import { formatQueryUri } from "../ui/src/query-uri";
import { renderPreview } from "../ui/src/preview";
import { planTemplateApplication } from "../ui/src/template-application";
import { renderTemplater } from "../ui/src/templater";
import { formatTimestampPart } from "../ui/src/timestamp-shortcuts";
import { findTaskCheckboxEdit } from "../ui/src/tasks";
import { RefreshGate } from "../ui/src/refresh-gate";
import { canPersistSession } from "../ui/src/session-guard";
import { vaultChangeTouchesFileTree } from "../ui/src/vault-change";
import { previewPatchWindow } from "../ui/src/preview-patch";
import { parseVimrc } from "../ui/src/vimrc";
import { layoutGraph } from "../ui/src/graph-view";
import { parseCanvas, serializeCanvas } from "../ui/src/canvas-view";
import { resizedKanbanLaneWidth } from "../ui/src/kanban-resize";
import { findInKanbanLane, kanbanCardSearchText } from "../ui/src/kanban-find";
import {
  bindScrollSync,
  clearScrollSync,
  CURSOR_SYNC_DELAY_MS,
  setEditorDocumentEnd,
  syncEditorCursorMovement,
  withoutScrollSync,
} from "../ui/src/scroll-sync";

class FakeTimers {
  private next = 1;
  readonly callbacks = new Map<number, () => void>();
  cleared = 0;

  set = (callback: () => void): TimerHandle => {
    const handle = this.next++;
    this.callbacks.set(handle, callback);
    return handle as unknown as TimerHandle;
  };

  clear = (handle: TimerHandle): void => {
    if (this.callbacks.delete(handle as unknown as number)) this.cleared++;
  };

  flush(): void {
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    pending.forEach((callback) => callback());
  }
}

test("startup cannot overwrite a saved vault session with an empty workspace", () => {
  assert.equal(canPersistSession(false, false), false);
  assert.equal(canPersistSession(true, true), false);
  assert.equal(canPersistSession(true, false), true);
});

test("vimrc compatibility evaluates conditionals, variables, execute, and commands", () => {
  const parsed = parseVimrc([
    "let mapleader = ','",
    "let g:save_key = '<leader>s'",
    "if has('gui_running') && exists('+number')",
    "  execute 'nnoremap ' . g:save_key . ' :write<CR>'",
    "else",
    "  nnoremap <leader>x :write<CR>",
    "endif",
    "silent set number relativenumber shiftwidth=4",
    "command! -nargs=0 SaveNow write",
  ].join("\n"));
  assert.deepEqual(parsed.commands, ["nnoremap ,s :write<CR>"]);
  assert.equal(parsed.settings.relativeLineNumbers, true);
  assert.equal(parsed.settings.shiftWidth, 4);
  assert.deepEqual(parsed.userCommands, [{ name: "SaveNow", command: "write" }]);
  assert.equal(parsed.skipped.length, 0);
});

test("graph layout is deterministic and bounded", () => {
  const graph = {
    nodes: [{ path: "A.md", title: "A" }, { path: "B.md", title: "B" }],
    edges: [{ source: "A.md", target: "B.md", embeds: false }],
  };
  const first = layoutGraph(graph, 500, 300);
  const second = layoutGraph(graph, 500, 300);
  assert.deepEqual(first, second);
  for (const point of first.values()) {
    assert.ok(point.x >= 18 && point.x <= 482);
    assert.ok(point.y >= 18 && point.y <= 282);
  }
});

test("canvas parsing preserves Obsidian fields while serializing edits", () => {
  const source = JSON.stringify({
    nodes: [{ id: "n", type: "file", file: "A.md", x: 1, y: 2, width: 3, height: 4, subpath: "#Heading" }],
    edges: [],
    metadata: { preserved: true },
  });
  const canvas = parseCanvas(source);
  canvas.nodes[0].x = 42;
  const roundTrip = JSON.parse(serializeCanvas(canvas));
  assert.equal(roundTrip.nodes[0].subpath, "#Heading");
  assert.equal(roundTrip.nodes[0].x, 42);
  assert.equal(roundTrip.metadata.preserved, true);
});

test("date and time shortcuts insert distinct local ISO components", () => {
  const local = new Date(2026, 7, 11, 4, 5, 6);
  assert.equal(formatTimestampPart("date", local), "2026-08-11");
  assert.equal(formatTimestampPart("time", local), "04:05:06");
});

test("preview task checkboxes surgically update their Markdown marker", () => {
  const source = [
    "---",
    "example: '- [ ] YAML text is not a task'",
    "---",
    "- [ ] first task #work",
    "```markdown",
    "- [ ] fenced example",
    "```",
    "> - [x] quoted task",
    "  - [ ] nested task",
  ].join("\n");

  const first = findTaskCheckboxEdit(source, 0, true);
  const quoted = findTaskCheckboxEdit(source, 1, false);
  const nested = findTaskCheckboxEdit(source, 2, true);
  assert.ok(first && quoted && nested);
  assert.equal(applySourceChanges(source, [first]), source.replace("- [ ] first", "- [x] first"));
  assert.equal(applySourceChanges(source, [quoted]), source.replace("> - [x] quoted", "> - [ ] quoted"));
  assert.equal(applySourceChanges(source, [nested]), source.replace("  - [ ] nested", "  - [x] nested"));
  assert.equal(findTaskCheckboxEdit(source, 3, true), null);
});

function applySourceChanges(
  source: string,
  changes: readonly { from: number; to: number; insert: string }[],
): string {
  return [...changes]
    .sort((left, right) => right.from - left.from)
    .reduce((result, change) =>
      result.slice(0, change.from) + change.insert + result.slice(change.to), source);
}

test("template YAML merges surgically and its body is inserted at the caret", () => {
  const source = [
    "---",
    "title: Existing title",
    "status: old",
    "# keep this comment",
    "aliases:",
    "  - Existing alias",
    "---",
    "Before  after",
  ].join("\n");
  const caret = source.indexOf(" after");
  const template = [
    "---",
    "status: active",
    "company: Acme",
    "---",
    "inserted",
  ].join("\n");
  const application = planTemplateApplication(
    source,
    { from: caret, to: caret },
    template,
    null,
  );
  const result = applySourceChanges(source, application.changes);

  assert.equal(result, [
    "---",
    "title: Existing title",
    "status: active",
    "# keep this comment",
    "aliases:",
    "  - Existing alias",
    "company: Acme",
    "---",
    "Before inserted after",
  ].join("\n"));
  assert.equal(application.cursor, result.indexOf("inserted") + "inserted".length);
});

test("template application creates one frontmatter block when the caret is at byte zero", () => {
  const application = planTemplateApplication(
    "Original",
    { from: 0, to: 0 },
    "---\ntype: journal\n---\n# <% tp.file.title %>\n",
    null,
  );
  assert.equal(application.changes.length, 1, "coincident YAML and body inserts must be atomic");
  assert.equal(
    applySourceChanges("Original", application.changes),
    "---\ntype: journal\n---\n# <% tp.file.title %>\nOriginal",
  );
});

test("Templater fields are evaluated immediately before template application", async () => {
  const rendered = await renderTemplater(
    "---\nowner: <% tp.frontmatter.owner %>\n---\n<% tp.file.title %> <% tp.system.prompt(\"Role\") %><% tp.file.cursor() %>",
    {
      path: "people/Jane Doe.md",
      content: "---\nowner: Kirk\n---\nBody",
      prompt: async () => "DBA",
    },
  );
  assert.equal(rendered.text, "---\nowner: Kirk\n---\nJane Doe DBA");
  assert.equal(rendered.cursor, rendered.text.length);
  assert.deepEqual(rendered.warnings, []);
});

test("rapid edits defer document reads and collapse into one preview", () => {
  const timers = new FakeTimers();
  const work = new DeferredDocumentWork(350, timers);
  let reads = 0;
  let renders = 0;
  const read = () => {
    reads++;
    return "large document";
  };

  const started = performance.now();
  for (let edit = 0; edit < 20_000; edit++) {
    work.schedule(read, () => renders++);
  }
  const schedulingMs = performance.now() - started;

  assert.equal(reads, 0, "the document must not be serialized on a keystroke");
  assert.equal(renders, 0);
  assert.equal(timers.callbacks.size, 1, "only the latest preview remains queued");
  assert.equal(timers.cleared, 19_999);
  assert.ok(schedulingMs < 1_000, `scheduling took ${schedulingMs.toFixed(1)}ms`);

  timers.flush();
  assert.equal(reads, 1);
  assert.equal(renders, 1);
  assert.equal(work.pending, false);
});

test("preview patching preserves unchanged top-level content around one edit", () => {
  assert.deepEqual(
    previewPatchWindow(
      ["<h1>Journal</h1>", "<p>old text</p>", "<p>unchanged tail</p>"],
      ["<h1>Journal</h1>", "<p>new text</p>", "<p>unchanged tail</p>"],
    ),
    { prefix: 1, currentEnd: 2, nextEnd: 2 },
  );
});

test("preview patching preserves the suffix when a block is inserted", () => {
  assert.deepEqual(
    previewPatchWindow(
      ["<h1>Journal</h1>", "<p>tail</p>"],
      ["<h1>Journal</h1>", "<p>inserted</p>", "<p>tail</p>"],
    ),
    { prefix: 1, currentEnd: 1, nextEnd: 2 },
  );
});

test("YAML title is metadata while filename remains page identity", () => {
  const page = rowToDvPage({
    path: "people/Example Person.md",
    name: "Example Person.md",
    folder: "people",
    mtime_ms: 0,
    properties: { title: "Database Architect" },
  });
  assert.equal(page.title, "Database Architect");
  assert.equal(page.file.name, "Example Person");
  assert.equal(page.path, "people/Example Person.md");
});

test("filename is not synthesized into a missing YAML title", () => {
  const page = rowToDvPage({
    path: "people/Example Person.md",
    name: "Example Person.md",
    folder: "people",
    mtime_ms: 0,
    properties: {},
  });
  assert.equal(page.title, undefined);
  assert.equal(page.file.name, "Example Person");
});

test("cancelled preview work never reads the document", () => {
  const timers = new FakeTimers();
  const work = new DeferredDocumentWork(350, timers);
  let reads = 0;
  work.schedule(() => { reads++; return "unused"; }, () => {});
  work.cancel();
  timers.flush();
  assert.equal(reads, 0);
  assert.equal(work.pending, false);
});

test("vault changes do not cancel an active dynamic preview", () => {
  const gate = new RefreshGate();
  gate.begin();
  for (let change = 0; change < 1_000; change++) {
    assert.equal(gate.request(), false);
  }
  assert.equal(gate.end(), true, "many changes collapse into one follow-up render");
  assert.equal(gate.end(), false);
  assert.equal(gate.request(), true, "an idle renderer may refresh immediately");
});

test("ordinary vault content changes do not rebuild the file browser", () => {
  const known = ["journals/2026_08_11.md", "people/Kirk.md"];
  assert.equal(vaultChangeTouchesFileTree({
    scanned: 2,
    updated: 1,
    removed: 0,
    paths: ["journals/2026_08_11.md"],
  }, known), false);
  assert.equal(vaultChangeTouchesFileTree({
    scanned: 3,
    updated: 1,
    removed: 0,
    paths: ["people/New Person.md"],
  }, known), true);
  assert.equal(vaultChangeTouchesFileTree({
    scanned: 1,
    updated: 0,
    removed: 1,
    paths: ["people/Kirk.md"],
  }, known), true);
});

test("YAML boolean decoration scans only frontmatter, not a large note body", () => {
  const body = Array.from({ length: 100_000 }, (_, index) => `body line ${index}`);
  const doc = Text.of([
    "---",
    "Bible: true",
    "sleep: false",
    "---",
    ...body,
    "BODY_SENTINEL",
  ]);

  const started = performance.now();
  const frontmatter = frontmatterForDecorations(doc);
  const scanMs = performance.now() - started;

  assert.equal(frontmatter.source, "---\nBible: true\nsleep: false\n---");
  assert.ok(frontmatter.end < 64);
  assert.doesNotMatch(frontmatter.source, /BODY_SENTINEL/);
  assert.ok(scanMs < 250, `frontmatter scan took ${scanMs.toFixed(1)}ms`);
});

test("a note without frontmatter does not scan its body", () => {
  const doc = Text.of(["# Note", ...Array.from({ length: 100_000 }, () => "body")]);
  assert.deepEqual(frontmatterForDecorations(doc), { source: "", end: 0 });
});

test("YAML frontmatter exposes a source fold without consuming the Markdown body", () => {
  const doc = Text.of(["---", "title: Person", "status: active", "---", "# Body"]);
  const range = frontmatterFoldRange(doc);
  assert.deepEqual(range, { from: 3, to: 33 });
  assert.equal(doc.sliceString(range!.to), "---\n# Body");
  assert.equal(frontmatterFoldRange(Text.of(["# Body", "---"])), null);
});

class FakeScroller extends EventTarget {
  scrollTop = 0;
  scrollHeight = 1_000;
  clientHeight = 100;
}

test("repeated final-line cursor reports do not measure preview layout", () => {
  const editor = new FakeScroller();
  const preview = new FakeScroller();
  let measurements = 0;
  Object.defineProperty(preview, "scrollHeight", {
    configurable: true,
    get() {
      measurements++;
      return 1_000;
    },
  });
  bindScrollSync(
    editor as unknown as HTMLElement,
    preview as unknown as HTMLElement,
  );
  setEditorDocumentEnd(false);
  setEditorDocumentEnd(true);
  const afterEnteringFinalLine = measurements;
  for (let edit = 0; edit < 1_000; edit++) setEditorDocumentEnd(true);
  assert.equal(measurements, afterEnteringFinalLine);
  setEditorDocumentEnd(false);
  clearScrollSync();
});

test("typing and preview rendering cannot reposition the editor", () => {
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
  });
  const flushFrame = () => frames.splice(0).forEach((callback) => callback(0));
  const editor = new FakeScroller();
  const preview = new FakeScroller();
  editor.scrollTop = 800;
  preview.scrollTop = 300;
  bindScrollSync(
    editor as unknown as HTMLElement,
    preview as unknown as HTMLElement,
  );

  // CodeMirror keeping the typed line visible is programmatic, not a scroll gesture.
  editor.scrollTop = 810;
  editor.dispatchEvent(new Event("scroll"));
  flushFrame();
  assert.equal(preview.scrollTop, 300);

  // Even recent preview interaction must not let render-time restoration feed back.
  preview.dispatchEvent(new Event("wheel"));
  withoutScrollSync(preview as unknown as HTMLElement, () => {
    preview.scrollTop = 320;
    preview.dispatchEvent(new Event("scroll"));
  });
  flushFrame();
  flushFrame();
  assert.equal(editor.scrollTop, 810, "preview rendering must leave the cursor viewport alone");
  clearScrollSync();
});

test("an actual wheel scroll still synchronizes the panes", () => {
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
  });
  const editor = new FakeScroller();
  const preview = new FakeScroller();
  bindScrollSync(
    editor as unknown as HTMLElement,
    preview as unknown as HTMLElement,
  );
  editor.dispatchEvent(new Event("wheel"));
  editor.scrollTop = 450;
  editor.dispatchEvent(new Event("scroll"));
  frames.splice(0).forEach((callback) => callback(0));
  assert.equal(preview.scrollTop, 450);
  clearScrollSync();
});

test("scroll sync leaves an editor at the end of the page alone", () => {
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
  });
  const editor = new FakeScroller();
  const preview = new FakeScroller();
  editor.scrollTop = editor.scrollHeight - editor.clientHeight;
  preview.scrollTop = 300;
  bindScrollSync(
    editor as unknown as HTMLElement,
    preview as unknown as HTMLElement,
  );

  preview.dispatchEvent(new Event("wheel"));
  preview.scrollTop = 700;
  preview.dispatchEvent(new Event("scroll"));
  editor.dispatchEvent(new Event("wheel"));
  editor.dispatchEvent(new Event("scroll"));
  frames.splice(0).forEach((callback) => callback(0));

  assert.equal(editor.scrollTop, 900);
  assert.equal(preview.scrollTop, 700);
  assert.equal(frames.length, 0, "no cross-pane scroll should be scheduled at EOF");
  clearScrollSync();
});

test("Vim G brings the preview to EOF before scroll sync locks", () => {
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
  });
  const flushFrame = () => frames.splice(0).forEach((callback) => callback(0));
  const editor = new FakeScroller();
  const preview = new FakeScroller();
  editor.scrollTop = 400;
  preview.scrollTop = 400;
  bindScrollSync(
    editor as unknown as HTMLElement,
    preview as unknown as HTMLElement,
  );

  // Vim's G causes CodeMirror to scroll without a wheel/pointer event.
  editor.scrollTop = editor.scrollHeight - editor.clientHeight;
  editor.dispatchEvent(new Event("scroll"));
  flushFrame();
  assert.equal(preview.scrollTop, 900, "preview must accompany the trip to EOF");

  // Once there, even direct preview scrolling cannot pull the editor away.
  preview.dispatchEvent(new Event("wheel"));
  preview.scrollTop = 300;
  preview.dispatchEvent(new Event("scroll"));
  flushFrame();
  assert.equal(editor.scrollTop, 900);
  clearScrollSync();
});

test("Vim G uses the final cursor line when CodeMirror has trailing scroll space", () => {
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => {},
  });
  const editor = new FakeScroller();
  const preview = new FakeScroller();
  // CodeMirror can put the last line on screen without reaching scrollTop max.
  editor.scrollTop = 700;
  preview.scrollTop = 200;
  bindScrollSync(
    editor as unknown as HTMLElement,
    preview as unknown as HTMLElement,
  );

  setEditorDocumentEnd(true);
  assert.equal(preview.scrollTop, 900, "final-line cursor must pin preview to EOF");

  // A preview rebuild/rebind must retain the pin at its new bottom.
  preview.scrollHeight = 1_200;
  bindScrollSync(
    editor as unknown as HTMLElement,
    preview as unknown as HTMLElement,
  );
  assert.equal(preview.scrollTop, 1_100);
  setEditorDocumentEnd(false);
  clearScrollSync();
});

test("Vim cursor-line motions coalesce before driving preview scroll", async () => {
  const frames: FrameRequestCallback[] = [];
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame: () => {},
  });
  const editor = new FakeScroller();
  const preview = new FakeScroller();
  editor.scrollTop = 200;
  preview.scrollTop = 200;
  bindScrollSync(
    editor as unknown as HTMLElement,
    preview as unknown as HTMLElement,
  );

  editor.scrollTop = 600;
  for (let movement = 0; movement < 100; movement++) syncEditorCursorMovement();
  assert.equal(frames.length, 0, "cursor movement must not measure layout in the key handler");
  await new Promise((resolve) => setTimeout(resolve, CURSOR_SYNC_DELAY_MS + 15));
  frames.splice(0).forEach((callback) => callback(0));
  assert.equal(preview.scrollTop, 600);

  setEditorDocumentEnd(true);
  assert.equal(preview.scrollTop, 900);
  preview.dispatchEvent(new Event("wheel"));
  preview.scrollTop = 250;
  preview.dispatchEvent(new Event("scroll"));
  frames.splice(0).forEach((callback) => callback(0));
  assert.equal(editor.scrollTop, 600, "EOF lock must prevent preview-to-editor movement");
  setEditorDocumentEnd(false);
  clearScrollSync();
});

test("native SQL fences allow legal Markdown indentation", () => {
  const blocks = extractScriptBlocks([
    " SQL Text Test",
    "",
    " ```sql",
    " SELECT name FROM pages;",
    " ```",
  ].join("\n"));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, "sql");
  assert.match(blocks[0].code, /SELECT name FROM pages/);
});

test("Dataview default() lowers to nullish coalesce()", () => {
  const current = {
    path: "people/Kirk Roybal.md",
    file: {
      path: "people/Kirk Roybal.md",
      name: "Kirk Roybal",
      folder: "people",
      link: "[[people/Kirk Roybal]]",
      mtime: null,
      ctime: null,
      day: null,
    },
  } satisfies DvPage;
  const row = {
    ...current,
    phone: null,
    company_phone: "972-555-1212",
  } satisfies DvPage;

  assert.equal(
    lowerDqlFunctionAliases("default(phone, company_phone)"),
    "coalesce(phone, company_phone)",
  );
  assert.equal(
    evaluateDql("default(phone, company_phone)", row, current),
    "972-555-1212",
  );
  assert.equal(evaluateDql("default(0, 42)", row, current), 0);
  assert.equal(evaluateDql("default(false, true)", row, current), false);
  assert.equal(evaluateDql("default('', 'fallback')", row, current), "");
  assert.equal(
    lowerDqlFunctionAliases("contains(notes, 'default(phone)')"),
    "contains(notes, 'default(phone)')",
    "function-like text inside a string must remain literal",
  );
});

test("executable fences render as code elements the executor can discover", () => {
  const markdown = [
    "```sql",
    "SELECT title FROM pages;",
    "```",
    "",
    "```dataviewjs",
    "dv.paragraph('hello');",
    "```",
  ].join("\n");
  const html = renderPreview(markdown);
  assert.match(html, /<code class="language-sql">/);
  assert.match(html, /<code class="language-dataviewjs">/);
  assert.match(html, /SELECT title FROM pages/);
  assert.equal(extractScriptBlocks(markdown).length, 2);
});

test("Kanban lane resizing responds continuously from the first pixel", () => {
  assert.equal(
    resizedKanbanLaneWidth({ startWidth: 260, pointerDelta: 1 }),
    261,
    "a one-pixel drag must change the lane width",
  );
  assert.equal(
    resizedKanbanLaneWidth({ startWidth: 260, pointerDelta: -1 }),
    259,
    "the last lane must also shrink immediately",
  );
  assert.equal(
    resizedKanbanLaneWidth({ startWidth: 590, pointerDelta: 30 }),
    600,
    "the maximum width remains enforced",
  );
});

test("YAML and query results share field-aware URI and MIME detection", () => {
  assert.match(
    formatQueryUri("person@internal", "work_email") || "",
    /href="mailto:person@internal"[^>]*type="message\/rfc822"/,
  );
  assert.match(
    formatQueryUri("example.com/manual.pdf", "company_url") || "",
    /href="https:\/\/example\.com\/manual\.pdf"[^>]*type="application\/pdf"/,
  );
  assert.match(
    formatQueryUri("(513) 555-1212", "home_phone") || "",
    /href="tel:5135551212"[^>]*type="text\/plain"/,
  );
  assert.equal(formatQueryUri("ordinary prose", "notes"), null);
});

test("frontmatter renders scalar and block-list URI values as typed links", () => {
  const html = renderPropertiesHtml([
    "work_email: brady@example.com",
    "website: example.com/profile",
    "resources:",
    "  - https://example.com/guide.pdf",
    "  - plain label",
  ].join("\n"));
  assert.match(html, /data-query-uri="mailto:brady@example\.com"/);
  assert.match(html, /data-query-uri="https:\/\/example\.com\/profile"/);
  assert.match(html, /type="application\/pdf"/);
  assert.match(html, /plain label/);
  assert.doesNotMatch(html, /data-query-uri="plain label"/);
});

test("Kanban find searches complete card data and collapses lanes without matches", () => {
  const linked = {
    raw: "- [ ] [[people/Ada Lovelace|Call Ada]] #followup",
    checked: false,
    text: "[[people/Ada Lovelace|Call Ada]] #followup",
    link: "people/Ada Lovelace",
    label: "Call Ada",
  };
  assert.match(kanbanCardSearchText(linked), /people\/ada lovelace/);

  const matching = findInKanbanLane({ name: "Doing", cards: [linked] }, "FOLLOWUP");
  assert.deepEqual(matching.cardMatches, [true]);
  assert.equal(matching.matchingCards, 1);
  assert.equal(matching.collapse, false);

  const noMatch = findInKanbanLane({ name: "Doing", cards: [linked] }, "postgresql");
  assert.deepEqual(noMatch.cardMatches, [false]);
  assert.equal(noMatch.collapse, true);
  assert.equal(findInKanbanLane({ name: "Empty", cards: [] }, "").collapse, true);
});
