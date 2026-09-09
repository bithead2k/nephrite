import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  bangShellCommand,
  renderCommandBar,
  renderPersistentCommandBar,
  type AppCommand,
} from "../ui/src/command-bar";
import {
  showContextMenu,
  type CtxAction,
  type CtxTarget,
} from "../ui/src/context-menu";
import { hydrateNoteEmbeds } from "../ui/src/note-embed";
import { hydrateTableOfContents, renderBlockHtml, renderPreview } from "../ui/src/preview";
import { splitMarkdownBlocks } from "../ui/src/preview-blocks";
import { applyAppearanceFonts, normalizeAppearanceFonts } from "../ui/src/appearance";
import { pluginIframeDocument, type PluginDescriptor } from "../ui/src/plugin-host";
import { installObsidianDom } from "../ui/src/obsidian-dom";
import { htmlToMarkdown, looksLikeMarkdown, smartPasteText } from "../ui/src/smart-paste";
import { highlightPreviewCode, highlightSource, resolveHighlightLanguage } from "../ui/src/syntax-highlight";
import { applyPandocInlineCodeAttrs, parsePandocAttributeBlock } from "../ui/src/pandoc-attrs";
import { isCodePath, isPdfPath, languageFromPath } from "../ui/src/file-kinds";
import { extractMath } from "../ui/src/math";
import { shortestWikilinkTarget } from "../ui/src/wikilinks";
import { buildLinkHealth, filterLinkHealth } from "../ui/src/link-health";
import { graphNodeColor } from "../ui/src/graph-view";
import { filterVaultTags, groupBacklinks, linkRefLabel } from "../ui/src/note-context";
import { filterPluginCatalog } from "../ui/src/plugin-manager";
import {
  dailyPathForDate,
  existingDailyKeysForMonth,
  ereyesterday,
  formatDailyPath,
  formatMoment,
  isoWeek,
  monthCells,
  overmorrow,
  parseDailyNotesSettings,
  periodNotePath,
  shiftDate,
} from "../ui/src/daily-notes";
import { hydrateMermaid, looksLikeMermaidFence } from "../ui/src/mermaid";
import { nextTaskForm } from "../ui/src/tasks";
import { findNextTaskStatusEdit, hydratePreviewTaskMarkers } from "../ui/src/tasks";
import { nextTaskStatusChar } from "../ui/src/task-status";
import { slashCompletionMatch } from "../ui/src/slash-commands";
import { hydrateCsvFences, parseCsv } from "../ui/src/csv-view";
import { parseSimpleYaml } from "../ui/src/structured-view";
import { isAudioPath, isBasePath, isCsvPath, isStructuredPath, isVideoPath } from "../ui/src/file-kinds";
import {
  bindPreviewPrintMenu,
  accessiblePrintColor,
  printablePreviewHtml,
  previewPrintTitle,
  PRINT_PAGE_CSS,
  stagePrintDocument,
} from "../ui/src/preview-print";
import { bindImmediateKanbanDrag } from "../ui/src/kanban-drag";
import { bindImmediateTreeDrag } from "../ui/src/tree-drag";
import { createNotePreviewHeader } from "../ui/src/note-preview-header";
import { openFootnoteComposer } from "../ui/src/footnote-composer";
import { footnoteEditTarget } from "../ui/src/footnotes";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLInputElement: { configurable: true, value: dom.window.HTMLInputElement },
  Event: { configurable: true, value: dom.window.Event },
  DOMParser: { configurable: true, value: dom.window.DOMParser },
  Node: { configurable: true, value: dom.window.Node },
  KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
  MouseEvent: { configurable: true, value: dom.window.MouseEvent },
  requestAnimationFrame: {
    configurable: true,
    value: (callback: FrameRequestCallback) => callback(0),
  },
});

dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.alert = () => {};

test("note preview header opens its underlying note from the upper-right action", () => {
  let opened = 0;
  const head = createNotePreviewHeader({
    className: "link-preview-head",
    title: "Bible Reading",
    path: "Journal/Bible Reading.md",
    onOpen: () => { opened += 1; },
  });

  assert.equal(head.classList.contains("note-preview-head"), true);
  assert.equal(head.querySelector(".note-preview-head-title")?.textContent, "Bible Reading");
  const button = head.querySelector<HTMLButtonElement>(".note-preview-open-button");
  assert.equal(button?.textContent, "");
  assert.ok(button?.querySelector("svg.note-preview-open-icon"));
  assert.equal(button?.getAttribute("aria-label"), "Open Bible Reading in editor");
  button?.click();
  assert.equal(opened, 1);
});

test("footnotes render as linked superscripts with return links", () => {
  const preview = document.createElement("main");
  preview.innerHTML = renderPreview([
    "A claim[^source] with a repeated reference[^source].",
    "",
    "[^source]: Supporting detail",
    "  continued on another line.",
  ].join("\n"));
  document.body.append(preview);
  hydrateTableOfContents(preview);

  const references = preview.querySelectorAll<HTMLElement>("sup.footnote-ref");
  const definition = preview.querySelector<HTMLElement>("#fn-1");
  assert.equal(references.length, 2);
  assert.equal(references[0].textContent, "1");
  assert.equal(references[1].textContent, "1");
  assert.match(definition?.textContent ?? "", /Supporting detail.*continued on another line/);
  assert.ok(definition?.querySelector("br"));
  assert.equal(definition?.querySelectorAll(".footnote-backref").length, 2);

  let definitionScrolled = 0;
  let referenceScrolled = 0;
  if (definition) definition.scrollIntoView = () => { definitionScrolled += 1; };
  references[0].scrollIntoView = () => { referenceScrolled += 1; };
  references[0].querySelector<HTMLAnchorElement>("a")?.click();
  assert.equal(definitionScrolled, 1);
  assert.equal(document.activeElement, definition);
  definition?.querySelector<HTMLAnchorElement>(".footnote-backref")?.click();
  assert.equal(referenceScrolled, 1);
  assert.equal(document.activeElement, references[0]);
  preview.remove();
});

test("footnote-looking text in code remains literal", () => {
  const preview = document.createElement("main");
  preview.innerHTML = renderPreview([
    "`[^code]` and a real note[^real].",
    "",
    "```text",
    "[^fenced]: not a definition",
    "```",
    "",
    "[^real]: Real detail",
  ].join("\n"));
  assert.equal(preview.querySelectorAll(".footnote-ref").length, 1);
  assert.match(preview.querySelector("code")?.textContent ?? "", /\[\^code\]/);
  assert.match(preview.textContent ?? "", /\[\^fenced\]: not a definition/);
});

test("inline footnotes render with hover previews", () => {
  const preview = document.createElement("main");
  preview.innerHTML = renderPreview("Claim.^[An *inline* detail with [a link](https://example.com).]");
  document.body.append(preview);
  hydrateTableOfContents(preview);
  const marker = preview.querySelector<HTMLAnchorElement>(".footnote-ref a");
  assert.equal(marker?.textContent, "1");
  assert.equal(preview.querySelector(".footnote-content em")?.textContent, "inline");
  marker?.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  const hover = document.querySelector<HTMLElement>(".footnote-hover-preview");
  assert.match(hover?.textContent ?? "", /An inline detail/);
  assert.equal(hover?.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')?.textContent, "a link");
  hover?.remove();
  preview.remove();
});

test("footnote warnings identify broken document references", () => {
  const preview = document.createElement("main");
  preview.innerHTML = renderPreview("Used[^same] missing[^gone].\n\n[^same]: First\n[^same]: Second\n[^orphan]: Unused");
  const warnings = preview.querySelector(".footnote-warnings")?.textContent ?? "";
  assert.match(warnings, /same.*2 definitions/);
  assert.match(warnings, /gone.*no definition/);
  assert.match(warnings, /orphan.*never referenced/);
  assert.ok(preview.querySelector(".footnote-missing"));
});

test("marker-side composer saves with Ctrl+Enter and exposes both styles", async () => {
  const source = "Claim here.";
  const resultPromise = openFootnoteComposer(footnoteEditTarget(source, 5), null);
  const composer = document.querySelector<HTMLFormElement>(".footnote-composer");
  const input = composer?.querySelector<HTMLTextAreaElement>("textarea");
  const style = composer?.querySelector<HTMLSelectElement>("select");
  assert.ok(composer && input && style);
  assert.equal(style.hidden, false);
  style.value = "reference";
  input.value = "A source note";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  assert.deepEqual(await resultPromise, { content: "A source note", style: "reference" });
  assert.equal(document.querySelector(".footnote-composer"), null);
});

test("empty rendered sections and journal goals collapse and stay out of the TOC", () => {
  const preview = document.createElement("main");
  preview.innerHTML = renderPreview([
    "[toc]",
    "",
    "# Filled",
    "Visible text",
    "",
    "# Interstitial",
    "",
    "<hr>",
    "",
    "# Later",
    "More text",
    "",
    "**Daily goals:**",
    "",
    "- [ ] ",
    "- [ ] ",
    "",
    "**Stretch Goals:**",
    "",
    "- [ ] ",
  ].join("\n"));
  hydrateTableOfContents(preview);

  const headings = [...preview.querySelectorAll<HTMLElement>("h1")];
  assert.equal(headings.find((heading) => heading.textContent === "Interstitial")?.closest(".md-block")?.hidden, true);
  assert.deepEqual(
    [...preview.querySelectorAll(".table-of-contents a")].map((link) => link.textContent),
    ["Filled", "Later"],
  );
  for (const label of ["Daily goals:", "Stretch Goals:"]) {
    const marker = [...preview.querySelectorAll("strong")].find((strong) => strong.textContent === label);
    assert.equal(marker?.closest<HTMLElement>("p")?.hidden, true);
  }
  assert.equal([...preview.querySelectorAll("ul")].every((list) => list.hidden), true);
});

test("empty query mounts collapse but query errors remain visible", () => {
  const preview = document.createElement("main");
  preview.innerHTML = '<div class="dv-block"></div><div class="dv-block"><pre class="dv-error">Query failed</pre></div>';
  hydrateTableOfContents(preview);
  const blocks = preview.querySelectorAll<HTMLElement>(".dv-block");
  assert.equal(blocks[0].hidden, true);
  assert.equal(blocks[1].hidden, false);
  blocks[0].textContent = "Birthday result";
  hydrateTableOfContents(preview);
  assert.equal(blocks[0].hidden, false);
});

test("an incrementally replaced goal list restores its hidden section label", () => {
  const empty = "**Daily goals:**\n\n- [ ] \n- [ ] ";
  const filled = "**Daily goals:**\n\n- [ ] Call Ada\n- [ ] ";
  const preview = document.createElement("main");
  preview.innerHTML = renderPreview(empty);
  hydrateTableOfContents(preview);
  const label = preview.querySelector<HTMLElement>("strong")?.closest<HTMLElement>("p");
  assert.equal(label?.hidden, true);

  const filledBlocks = splitMarkdownBlocks(filled);
  const currentList = preview.querySelector<HTMLElement>('.md-block[data-block-index="1"]');
  assert.ok(currentList);
  const replacement = document.createElement("template");
  replacement.innerHTML = renderBlockHtml(filledBlocks[1], 1);
  currentList.replaceWith(replacement.content.firstElementChild!);
  hydrateTableOfContents(preview);

  assert.equal(label?.hidden, false);
  assert.match(preview.textContent ?? "", /Call Ada/);
});

function pointerEvent(
  type: string,
  init: MouseEventInit & { pointerId?: number; isPrimary?: boolean } = {},
): PointerEvent {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: init.isPrimary ?? true },
  });
  return event as unknown as PointerEvent;
}

test("kanban drag acquires after three pixels and activates a lane synchronously", () => {
  document.body.innerHTML = `
    <section class="kanban-col" data-col="0"><div class="kanban-cards"><article class="kanban-card"><button>Card</button></article></div></section>
    <section class="kanban-col" data-col="1"><div class="kanban-cards" id="target"></div></section>`;
  const card = document.querySelector<HTMLElement>(".kanban-card");
  const target = document.querySelector<HTMLElement>("#target");
  assert.ok(card && target);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => target,
  });
  const drops: Array<[number, number, number]> = [];
  let acquired = 0;
  bindImmediateKanbanDrag(card, { fromCol: 0, fromIdx: 2 }, {
    onAcquire: () => { acquired += 1; },
    onDrop: (origin, toCol) => drops.push([origin.fromCol, origin.fromIdx, toCol]),
  });

  card.querySelector("button")?.dispatchEvent(pointerEvent("pointerdown", {
    button: 0,
    clientX: 10,
    clientY: 10,
  }));
  window.dispatchEvent(pointerEvent("pointermove", { clientX: 12, clientY: 10 }));
  assert.equal(card.classList.contains("dragging"), false);
  window.dispatchEvent(pointerEvent("pointermove", { clientX: 13, clientY: 10 }));
  assert.equal(acquired, 1);
  assert.equal(card.classList.contains("dragging"), true);
  assert.ok(document.querySelector(".kanban-drag-ghost"));
  assert.equal(target.classList.contains("drag-over"), true);
  window.dispatchEvent(pointerEvent("pointerup", { clientX: 13, clientY: 10 }));
  assert.deepEqual(drops, [[0, 2, 1]]);
  assert.equal(target.classList.contains("drag-over"), false);
  assert.equal(document.querySelector(".kanban-drag-ghost"), null);
  assert.equal(card.draggable, false);
});

test("vault tree drag acquires immediately and highlights a folder target", () => {
  document.body.innerHTML = `
    <div id="file-tree"><button class="tree-file" data-path="A.md">A</button>
    <button class="tree-folder" data-path="Archive">Archive</button></div>`;
  const file = document.querySelector<HTMLElement>(".tree-file");
  const folder = document.querySelector<HTMLElement>(".tree-folder");
  assert.ok(file && folder);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => folder,
  });
  const drops: Array<[string, string]> = [];
  bindImmediateTreeDrag(file, "A.md", {
    onDrop: (from, target) => drops.push([from, target]),
  });
  file.dispatchEvent(pointerEvent("pointerdown", { button: 0, clientX: 5, clientY: 5 }));
  window.dispatchEvent(pointerEvent("pointermove", { clientX: 8, clientY: 5 }));
  assert.equal(file.classList.contains("dragging"), true);
  assert.equal(folder.classList.contains("tree-drop"), true);
  window.dispatchEvent(pointerEvent("pointerup", { clientX: 8, clientY: 5 }));
  assert.deepEqual(drops, [["A.md", "Archive"]]);
  assert.equal(folder.classList.contains("tree-drop"), false);
});

test("a bundled CommonJS Obsidian plugin receives the inherited app bootstrap", () => {
  const descriptor: PluginDescriptor = {
    id: "compat-smoke",
    name: "Compatibility smoke test",
    version: "1.0.0",
    description: "",
    permissions: ["vault.read", "editor.read"],
    api_version: 1,
    min_app_version: null,
    compatibility: "obsidian",
    source: `
      const { Plugin } = require("obsidian");
      module.exports = class extends Plugin {
        onload() {
          window.compatResult = {
            paths: this.app.vault.getMarkdownFiles().map(file => file.path),
            active: this.app.workspace.getActiveFile().path,
            cache: this.app.metadataCache.getFileCache({ path: "People/Ada.md" }).properties,
            link: this.app.fileManager.generateMarkdownLink({ path: "People/Ada.md" }, "Daily.md", "#Work", "Ada"),
          };
        }
      };
    `,
  };
  const document = pluginIframeDocument(descriptor);
  assert.match(document, /window\.require = \(name\)/);
  assert.match(document, /if \(name === "obsidian"\) return obsidian/);
  assert.match(document, /const app = window\.app = Object\.freeze/);
  assert.match(document, /generateMarkdownLink/);
  assert.match(document, /window\.__startObsidianPlugin\(\)/);
  assert.match(document, /module\.exports = class extends Plugin/);
  assert.match(document, /function installObsidianDom/);
  assert.match(document, /window\.activeDocument = window\.document/);
  assert.match(document, /try \{ tab\.display\?\.\(\); \}/);
});

test("Obsidian DOM helpers implement empty, createEl, and addClass", () => {
  installObsidianDom(dom.window);
  const host = document.createElement("div");
  host.textContent = "stale";
  (host as HTMLElement & { empty: () => HTMLElement }).empty();
  assert.equal(host.childNodes.length, 0);
  const row = (host as HTMLElement & { createDiv: (info: object) => HTMLElement }).createDiv({ cls: "kroki-header-row" });
  row.addClass("kroki-with-header");
  const area = (row as HTMLElement & { createEl: (tag: string, info: object) => HTMLTextAreaElement })
    .createEl("textarea", { cls: "kroki-header-textarea", attr: { rows: "3" } });
  const fragment = document.createDocumentFragment() as DocumentFragment & {
    createEl: (tag: string, info: object) => HTMLAnchorElement;
  };
  fragment.createEl("a", { text: "https://kroki.io", href: "https://kroki.io" });
  assert.equal(host.querySelector(".kroki-header-row"), row);
  assert.equal(row.classList.contains("kroki-with-header"), true);
  assert.equal(area.getAttribute("rows"), "3");
  assert.equal(fragment.querySelector("a")?.textContent, "https://kroki.io");
});

test("a Kroki-shaped settings tab can display after empty()", () => {
  installObsidianDom(dom.window);
  type ObsidianEl = HTMLElement & {
    empty: () => ObsidianEl;
    createDiv: (info: object) => ObsidianEl;
    addClass: (name: string) => ObsidianEl;
  };
  const containerEl = document.createElement("div") as ObsidianEl;
  containerEl.textContent = "previous";
  const tab = {
    containerEl,
    display() {
      const host = this.containerEl;
      host.empty();
      host.createDiv({ cls: "setting-item setting-item-heading", text: "Diagram types" }).addClass("shown");
      const link = document.createDocumentFragment() as DocumentFragment & {
        createEl: (tag: string, info: object) => HTMLElement;
      };
      link.createEl("a", { text: "https://kroki.io/", href: "https://kroki.io/" });
      host.append(link);
    },
  };
  tab.display();
  assert.equal(containerEl.textContent?.includes("previous"), false);
  assert.ok(containerEl.querySelector(".setting-item-heading"));
  assert.equal(containerEl.querySelector("a")?.getAttribute("href"), "https://kroki.io/");
});

test("appearance fonts are sanitized and applied independently", () => {
  const fonts = normalizeAppearanceFonts({
    ui: '"Inter", sans-serif',
    editor: '"DejaVu Sans Mono", monospace',
    preview: "serif",
    powerline: "bad; color: red",
  });
  applyAppearanceFonts(fonts, document.documentElement);
  assert.equal(document.documentElement.style.getPropertyValue("--font"), '"Inter", sans-serif');
  assert.equal(
    document.documentElement.style.getPropertyValue("--editor-font"),
    '"DejaVu Sans Mono", monospace',
  );
  assert.equal(document.documentElement.style.getPropertyValue("--preview-font"), "serif");
  assert.equal(document.documentElement.style.getPropertyValue("--powerline-font"), "");
});

test("a mounted file-tab menu exposes file actions without redundant open actions", () => {
  const selected: Array<{ action: CtxAction; target: CtxTarget }> = [];
  const target: CtxTarget = { kind: "tab", path: "People/Ada.md" };
  showContextMenu(20, 30, target, (action, clickedTarget) => {
    selected.push({ action, target: clickedTarget });
  });

  const menu = document.querySelector<HTMLElement>(".ctx-menu");
  assert.ok(menu);
  const labels = [...menu.querySelectorAll("button")].map((button) => button.textContent);
  assert.equal(menu.classList.contains("hidden"), false);
  assert.deepEqual(labels.slice(0, 5), [
    "Close tab",
    "Pin tab",
    "Make a copy",
    "Move file to…",
    "Bookmark…",
  ]);
  assert.equal(labels.includes("Open in new tab"), false);
  assert.equal(labels.includes("Open to the right"), false);
  assert.equal(labels.includes("Open in new window"), false);
  assert.equal(labels.includes("Rename…"), true);
  assert.equal(labels.includes("Delete"), true);

  const rename = [...menu.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Rename…");
  assert.ok(rename);
  rename.click();
  assert.deepEqual(selected, [{ action: "rename", target }]);
  assert.equal(menu.classList.contains("hidden"), true);
});

test("right-clicking a preview offers to print the current rendered document", () => {
  document.body.replaceChildren();
  const preview = document.createElement("div");
  preview.innerHTML = "<h1>First note</h1>";
  document.body.append(preview);
  const printed: Array<{ root: HTMLElement; path: string }> = [];
  bindPreviewPrintMenu(preview, "journals/2026_08_19.md", (root, path) => {
    printed.push({ root, path });
  });

  preview.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 30,
  }));
  const print = [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")]
    .find((button) => button.textContent === "Print current document…");
  assert.ok(print);
  print.click();
  assert.deepEqual(printed, [{ root: preview, path: "journals/2026_08_19.md" }]);

  bindPreviewPrintMenu(preview, "journals/2026_08_20.md", (root, path) => {
    printed.push({ root, path });
  });
  preview.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const updatedPrint = [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")]
    .find((button) => button.textContent === "Print current document…");
  assert.ok(updatedPrint);
  updatedPrint.click();
  assert.equal(printed.at(-1)?.path, "journals/2026_08_20.md");
});

test("printable preview defaults frontmatter off and can include it explicitly", () => {
  const preview = document.createElement("div");
  preview.innerHTML = [
    '<details class="props-block"><summary>Properties</summary><div>reading_date</div></details>',
    '<div class="dv-block"><table><tbody><tr><td>Live result</td></tr></tbody></table></div>',
    '<input type="checkbox">',
    '<div class="hidden">stale result</div>',
  ].join("");
  const checkbox = preview.querySelector<HTMLInputElement>("input");
  assert.ok(checkbox);
  checkbox.checked = true;

  const bodyOnly = printablePreviewHtml(preview);
  assert.doesNotMatch(bodyOnly, /props-block/);
  const html = printablePreviewHtml(preview, { includeFrontmatter: true });
  assert.match(html, /<details class="props-block"[^>]*open=""/);
  assert.match(html, /Live result/);
  assert.match(html, /checked=""/);
  assert.doesNotMatch(html, /stale result/);
  assert.equal(previewPrintTitle("People/Ada Lovelace.md"), "Ada Lovelace");
});

test("print colors preserve hue while making screen colors paper-readable", () => {
  assert.equal(accessiblePrintColor("rgb(20, 90, 70)"), "rgb(20, 90, 70)");
  const brightGreen = accessiblePrintColor("rgb(90, 240, 170)");
  assert.ok(brightGreen);
  assert.notEqual(brightGreen, "rgb(0, 0, 0)");
  assert.notEqual(brightGreen, "rgb(90, 240, 170)");
});

test("printing stages only the preview in the top-level document", () => {
  document.body.replaceChildren();
  document.title = "Nephrite";
  const app = document.createElement("main");
  app.textContent = "application chrome";
  document.body.append(app);

  const staged = stagePrintDocument(
    document,
    "Ada Lovelace",
    '<h1>Ada</h1><section style="color: rgb(210, 255, 225); background-color: rgb(5, 30, 20)">Rendered query result</section><table><tbody><tr><td>one</td></tr><tr><td>two</td></tr></tbody></table><aside class="callout" style="background-color: rgb(5, 20, 45)"><div class="callout-title" style="color: rgb(80, 150, 255); background-color: rgb(20, 50, 90)">Info</div></aside>',
    ".preview { color: black; }",
  );
  assert.equal(document.title, "Ada Lovelace");
  assert.equal(document.body.classList.contains("nephrite-printing"), true);
  assert.match(staged.root.innerHTML, /Rendered query result/);
  const paperSection = staged.root.querySelector<HTMLElement>("section");
  assert.ok(paperSection);
  assert.notEqual(paperSection.style.color, "rgb(210, 255, 225)");
  assert.notEqual(paperSection.style.backgroundColor, "rgb(5, 30, 20)");
  const style = document.querySelector<HTMLStyleElement>("style[data-nephrite-print-stage]");
  assert.ok(style);
  assert.match(style.textContent ?? "", /body\.nephrite-printing/);
  assert.match(style.textContent ?? "", /\.preview \{ color: black; \}/);
  assert.match(style.textContent ?? "", /color-scheme: light/);
  assert.match(PRINT_PAGE_CSS, /@page \{ margin: 0\.5in 0; \}/);
  assert.match(PRINT_PAGE_CSS, /padding-left: 0\.5in !important;/);
  assert.match(PRINT_PAGE_CSS, /padding-right: 0\.5in !important;/);
  assert.match(PRINT_PAGE_CSS, /font-size: 10pt/);
  const rows = staged.root.querySelectorAll<HTMLTableCellElement>("tbody td");
  assert.equal(rows[0]?.style.backgroundColor, "rgb(255, 255, 255)");
  assert.equal(rows[1]?.style.backgroundColor, "rgb(241, 244, 243)");
  assert.equal(
    staged.root.querySelector<HTMLElement>(".callout-title")?.style.backgroundColor,
    "rgb(255, 255, 255)",
  );

  staged.cleanup();
  assert.equal(document.title, "Nephrite");
  assert.equal(document.body.classList.contains("nephrite-printing"), false);
  assert.equal(document.querySelector(".nephrite-print-stage"), null);
  assert.equal(document.querySelector("style[data-nephrite-print-stage]"), null);
  assert.equal(document.body.contains(app), true);
});

test("the mounted command bar filters and executes the keyboard-selected command", () => {
  document.body.replaceChildren();
  const host = document.createElement("section");
  document.body.append(host);
  const executed: string[] = [];
  let closed = 0;
  const commands: AppCommand[] = [
    { id: "new", title: "New note", run: () => executed.push("new") },
    { id: "preview", title: "View: Preview", keywords: "render mode", run: () => executed.push("preview") },
    { id: "graph", title: "Open graph", run: () => executed.push("graph") },
  ];

  renderCommandBar(host, commands, () => { closed += 1; });
  const input = host.querySelector<HTMLInputElement>("input");
  assert.ok(input);
  assert.equal(document.activeElement, input);
  input.value = "preview";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.deepEqual(
    [...host.querySelectorAll(".command-bar-result span")].map((node) => node.textContent),
    ["View: Preview"],
  );
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(executed, ["preview"]);
  assert.equal(closed, 1);
});

test("Escape closes a mounted command bar without executing an action", () => {
  document.body.replaceChildren();
  const host = document.createElement("section");
  document.body.append(host);
  let closed = false;
  let executed = false;
  renderCommandBar(host, [
    { id: "noop", title: "No operation", run: () => { executed = true; } },
  ], () => { closed = true; });

  host.querySelector("input")?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(closed, true);
  assert.equal(executed, false);
});

test("the persistent Powerline command prompt stays mounted and executes commands", () => {
  document.body.replaceChildren();
  const host = document.createElement("footer");
  document.body.append(host);
  const executed: string[] = [];
  const prompt = renderPersistentCommandBar(host, () => [
    { id: "save", title: "Save current file", run: () => executed.push("save") },
    { id: "graph", title: "Open graph", run: () => executed.push("graph") },
  ]);

  assert.deepEqual(
    [...host.querySelectorAll(".command-bar-segment")].map((node) => node.textContent),
    ["NEPHRITE", "COMMAND"],
  );
  const input = host.querySelector<HTMLInputElement>(".persistent-command-input");
  assert.ok(input);
  prompt.focus();
  input.value = "graph";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(host.querySelector(".command-bar-result span")?.textContent, "Open graph");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.deepEqual(executed, ["graph"]);
  assert.ok(host.querySelector(".persistent-command-input"), "prompt remains mounted");
  assert.equal(input.value, "");
});

test("the persistent command bar shows provider-neutral sync activity and success", () => {
  document.body.replaceChildren();
  const host = document.createElement("footer");
  document.body.append(host);
  let opened = 0;
  const prompt = renderPersistentCommandBar(host, () => [], undefined, () => { opened += 1; });
  const status = host.querySelector<HTMLButtonElement>(".command-bar-sync-status");
  assert.ok(status);
  assert.equal(status.hidden, true);
  prompt.setSyncStatus({ phase: "syncing", message: "Uploading notes", active: true, synced: false });
  assert.equal(status.hidden, false);
  assert.equal(status.classList.contains("sync-syncing"), true);
  status.click();
  assert.equal(opened, 1);
  prompt.setSyncStatus({ phase: "synced", message: "Fully synced", active: true, synced: true });
  assert.equal(status.classList.contains("sync-synced"), true);
  assert.equal(status.title, "Fully synced");
});

test("a leading bang clears the prompt, executes shell code, and displays its output", async () => {
  document.body.replaceChildren();
  const host = document.createElement("footer");
  document.body.append(host);
  const executed: string[] = [];
  const prompt = renderPersistentCommandBar(host, () => [], async (command) => {
    executed.push(command);
    return {
      stdout: "/home/kroybal/Documents/notes\n",
      stderr: "",
      code: 0,
      ok: true,
    };
  });

  assert.equal(bangShellCommand("notes"), null);
  assert.equal(bangShellCommand("! pwd"), "pwd");
  const input = host.querySelector<HTMLInputElement>(".persistent-command-input");
  assert.ok(input);
  prompt.focus();
  input.value = "! pwd";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(host.querySelector(".command-bar-result span")?.textContent, "Run shell: pwd");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(executed, ["pwd"]);
  assert.equal(
    host.querySelector(".command-bar-shell-output")?.textContent,
    "/home/kroybal/Documents/notes",
  );
  assert.equal(input.value, "");
});

test("the main preview hydration path expands an Obsidian heading embed", async () => {
  document.body.replaceChildren();
  const root = document.createElement("main");
  root.innerHTML = renderPreview("![[Target#Details]]");
  document.body.append(root);

  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string) => {
        if (command === "resolve_wikilink") return "notes/Target.md";
        if (command === "read_file") {
          return {
            path: "notes/Target.md",
            content: "# Intro\nIgnore me\n\n## Details\nEmbedded body\n\n## Next\nStop here",
            mtime_ms: 0,
            size_bytes: 0,
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    },
  });

  await hydrateNoteEmbeds(root, "notes/Source.md", { openLink: () => {} });
  const embed = root.querySelector<HTMLElement>(".note-embed");
  assert.ok(embed);
  assert.match(embed.textContent || "", /Details\s+Embedded body/);
  assert.doesNotMatch(embed.textContent || "", /Ignore me|Stop here/);
  assert.equal(root.querySelector("a.preview-wikilink.embed"), null);
});

test("note embed hydration turns a wikilink image into an img", async () => {
  document.body.replaceChildren();
  const root = document.createElement("main");
  root.innerHTML = renderPreview("![[myself.png|250]]");
  document.body.append(root);
  assert.ok(root.querySelector("a.preview-wikilink.embed"));

  Object.defineProperty(dom.window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args?: { path?: string; target?: string }) => {
        if (command === "resolve_wikilink") {
          assert.equal(args?.target, "myself.png");
          return "assets/myself.png";
        }
        if (command === "absolute_path") {
          throw new Error("asset protocol unavailable in unit test");
        }
        if (command === "read_media_file") {
          return { path: "assets/myself.png", mime: "image/png", data: "AAAA" };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    },
  });

  await hydrateNoteEmbeds(root, "job_search/2026/aaa-sr-data-engineer.md", {
    openLink: () => {},
  });
  const image = root.querySelector<HTMLImageElement>("img.image-embed");
  assert.ok(image);
  assert.match(image.src, /data:image\/png;base64,AAAA/);
  assert.equal(image.style.width, "250px");
  assert.equal(root.querySelector("a.preview-wikilink.embed"), null);
});

test("a bundled plugin registers post/code processors that the sandbox can run", () => {
  const descriptor: PluginDescriptor = {
    id: "processor-smoke",
    name: "Processor smoke test",
    version: "1.0.0",
    description: "",
    permissions: ["vault.read"],
    api_version: 1,
    min_app_version: null,
    compatibility: "obsidian",
    source: `
      const { Plugin } = require("obsidian");
      module.exports = class extends Plugin {
        onload() {
          this.registerMarkdownPostProcessor((el) => {
            el.innerHTML = "<em data-processed>post</em>";
          });
          this.registerMarkdownCodeBlockProcessor("plantuml", (source, el) => {
            el.innerHTML = "<div class=\\"plantuml\\" data-source=\\"" + source + "\\"></div>";
          });
        }
      };
    `,
  };
  const document = pluginIframeDocument(descriptor);
  assert.match(document, /type: "processor-registered", kind: "post"/);
  assert.match(document, /type: "processor-registered", kind: "code", language/);
  assert.match(document, /message\.type === "process-post"/);
  assert.match(document, /message\.type === "process-code"/);
  assert.match(document, /window\.__obsidianPluginInstance\?\._postProcessors/);
  assert.match(document, /window\.__obsidianPluginInstance\?\._codeProcessors\?\.get/);
  assert.match(document, /getService: \(id\) => send\("plugins.getService"/);
});

test("new wikilinks use the shortest unique target", () => {
  const files = [
    { path: "journals/2026-08-15.md" },
    { path: "people/Ada.md" },
    { path: "archive/people/Ada.md" },
  ];
  assert.equal(shortestWikilinkTarget("journals/2026-08-15.md", files), "2026-08-15");
  assert.equal(shortestWikilinkTarget("people/Ada.md", files), "people/Ada");
  assert.equal(shortestWikilinkTarget("archive/people/Ada.md", files), "archive/people/Ada");
});

test("daily notes honor Obsidian folder/format and mark existing days", () => {
  const settings = parseDailyNotesSettings(
    JSON.stringify({ folder: "Daily", format: "YYYY-MM-DD", template: "Templates/Daily" }),
  );
  assert.equal(settings.folder, "Daily");
  assert.equal(settings.template, "Templates/Daily.md");
  const day = new Date(2026, 7, 15);
  assert.equal(formatMoment(day, "YYYY-MM-DD"), "2026-08-15");
  assert.equal(formatDailyPath(day, settings), "Daily/2026-08-15.md");
  assert.equal(shiftDate(day, -1).getDate(), 14);
  const files = [{ path: "Daily/2026-08-15.md", name: "2026-08-15.md", parent_path: "Daily", file_kind: "markdown" as const }];
  assert.equal(dailyPathForDate(files, day, settings).exists, true);
  assert.equal(existingDailyKeysForMonth(files, settings, 2026, 7).has("2026-08-15"), true);
  const cells = monthCells(2026, 7, new Set(["2026-08-15"]), day);
  assert.equal(cells.length, 42);
  assert.ok(cells.some((cell) => cell.isToday && cell.hasNote));
  assert.equal(overmorrow(day).getDate(), 17);
  assert.equal(ereyesterday(day).getDate(), 13);
  assert.equal(periodNotePath(new Date(2026, 0, 8), "week"), "2026-W02.md");
  assert.equal(periodNotePath(new Date(2026, 7, 15), "month"), "2026-08.md");
  assert.equal(periodNotePath(new Date(2026, 7, 15), "quarter"), "2026-Q03.md");
  assert.equal(isoWeek(new Date(2026, 0, 1)).week, 1);
});

test("orphans are notes with no incoming links and placeholders group unresolved targets", () => {
  const health = buildLinkHealth(
    {
      nodes: [
        { path: "Hub.md", title: "Hub", tags: [] },
        { path: "Orphan.md", title: "Alone", tags: [] },
        { path: "Spoke.md", title: "Spoke", tags: [] },
      ],
      edges: [{ source: "Hub.md", target: "Spoke.md", embeds: false }],
    },
    [
      { path: "Hub.md", target: "Missing" },
      { path: "Hub.md", target: "Missing" },
      { path: "Spoke.md", target: "Other" },
    ],
  );
  assert.deepEqual(health.orphans.map((note) => note.path), ["Hub.md", "Orphan.md"]);
  assert.equal(health.placeholders[0].target, "Missing");
  assert.equal(health.placeholders[0].count, 2);
  const filtered = filterLinkHealth(health, "alone");
  assert.deepEqual(filtered.orphans.map((note) => note.path), ["Orphan.md"]);
  assert.equal(filtered.placeholders.length, 0);
});

test("graph node colors are stable per folder or first tag", () => {
  const projects = graphNodeColor("projects/Ada.md", ["person"], "folder");
  const other = graphNodeColor("archive/Ada.md", ["person"], "folder");
  assert.ok(projects);
  assert.notEqual(projects, other);
  assert.equal(projects, graphNodeColor("projects/Bob.md", [], "folder"));
  const byTag = graphNodeColor("projects/Ada.md", ["person"], "tag");
  assert.equal(byTag, graphNodeColor("elsewhere/Note.md", ["person"], "tag"));
  assert.equal(graphNodeColor("projects/Ada.md", [], "none"), null);
});

test("note context groups backlinks and filters tags", () => {
  const groups = groupBacklinks([
    { path: "Hub.md", title: "Hub", target: "Ada.md", heading: "Work", block: null, display: null, embed: false, resolved: true },
    { path: "Hub.md", title: "Hub", target: "Ada.md", heading: null, block: null, display: "Ada", embed: true, resolved: true },
    { path: "Log.md", title: "Log", target: "Ada.md", heading: null, block: null, display: null, embed: false, resolved: true },
  ]);
  assert.equal(groups.get("Hub.md")?.length, 2);
  assert.equal(linkRefLabel(groups.get("Hub.md")![0]), "Hub#Work");
  assert.deepEqual(
    filterVaultTags(
      [{ tag: "journal", count: 12 }, { tag: "tracker", count: 3 }],
      "#track",
    ).map((tag) => tag.tag),
    ["tracker"],
  );
});

test("plugin catalog search matches name author and description", () => {
  const items = [
    { id: "calendar", name: "Calendar", author: "Liam", description: "Monthly view", repo: "a/b", installed: true, enabled: true, native: false },
    { id: "dataview", name: "Dataview", author: "Michael", description: "Query notes", repo: "c/d", installed: false, enabled: false, native: true },
  ];
  assert.equal(filterPluginCatalog(items, "month").map((item) => item.id).join(), "calendar");
  assert.equal(filterPluginCatalog(items.filter((item) => !item.native), "query").length, 0);
});

test("file kind helpers recognize PDFs and source files", () => {
  assert.equal(isPdfPath("docs/Spec.pdf"), true);
  assert.equal(isCodePath("crates/nephrite-index/src/lib.rs"), true);
  assert.equal(isCodePath("Note.md"), false);
  assert.equal(isAudioPath("clip.mp3"), true);
  assert.equal(isVideoPath("demo.webm"), true);
  assert.equal(isCsvPath("rows.csv"), true);
  assert.equal(isStructuredPath("config.yaml"), true);
  assert.equal(isBasePath("Jobs.base"), true);
  assert.equal(isCodePath("config.yaml"), false);
  assert.equal(isCodePath("Jobs.base"), false);
  assert.equal(languageFromPath("ui/src/main.ts"), "typescript");
  assert.equal(languageFromPath("Makefile"), "makefile");
});

test("task cycle walks the extended status set", () => {
  assert.equal(nextTaskForm("plain"), "- [ ] plain");
  assert.equal(nextTaskForm("- [ ] work"), "- [/] work");
  assert.equal(nextTaskForm("- [/] work"), "- [>] work");
  assert.equal(nextTaskForm("- [x] work"), "- [-] work");
  assert.match(nextTaskForm("- [-] work") ?? "", /^work$/);
  assert.equal(nextTaskStatusChar("!"), "x");
  const host = document.createElement("div");
  host.innerHTML = "<ul><li>[/] mid</li><li><input type=checkbox> open</li></ul>";
  hydratePreviewTaskMarkers(host);
  assert.equal(host.querySelectorAll("[data-task-index]").length >= 2, true);
  assert.ok(host.querySelector("button.task-status-marker"));
});

test("repeated preview clicks follow the editor task status order", () => {
  let source = "- [ ] work";
  const statuses = ["/", ">", "<", "?", "!", "x", "-", " "];
  for (const status of statuses) {
    const current = source.match(/\[([^\]])\]/)?.[1] ?? " ";
    const edit = findNextTaskStatusEdit(source, 0, current);
    assert.ok(edit);
    source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
    assert.equal(source, `- [${status}] work`);
  }
});

test("slash completion matches a line-start command", () => {
  const match = slashCompletionMatch("/mer", 4);
  assert.ok(match);
  assert.equal(match?.query, "mer");
  assert.equal(slashCompletionMatch("see /mer", 8)?.query, "mer");
  assert.equal(slashCompletionMatch("http://x", 8), null);
});

test("CSV and simple YAML parsers build tables and trees", () => {
  const table = parseCsv('name,qty\n"Ada, A",2\nBob,3\n');
  assert.deepEqual(table.headers, ["name", "qty"]);
  assert.equal(table.rows[0][0], "Ada, A");
  const yaml = parseSimpleYaml("title: Demo\ncount: 3\nok: true\n");
  assert.deepEqual(yaml, { title: "Demo", count: 3, ok: true });
  assert.deepEqual(
    parseSimpleYaml("views:\n  - type: table\n    name: Open\n    order:\n      - file.name\n"),
    { views: [{ type: "table", name: "Open", order: ["file.name"] }] },
  );

  const fence = document.createElement("div");
  fence.innerHTML = renderPreview("```csv\nname,qty\nAda,2\n```");
  hydrateCsvFences(fence);
  assert.equal(fence.querySelector("pre > code.language-csv"), null);
  assert.ok(fence.querySelector("figure.csv-block table.csv-table"));
  assert.match(fence.textContent ?? "", /Ada/);
});

test("smart paste converts HTML and wraps selected URLs", () => {
  assert.equal(looksLikeMarkdown("# Title\n\n- item"), true);
  assert.equal(
    smartPasteText({ text: "https://example.com", selection: "Example" }),
    "[Example](https://example.com)",
  );
  assert.equal(
    smartPasteText({ text: "# already markdown", html: "<h1>already markdown</h1>" }),
    "# already markdown",
  );
  assert.match(
    htmlToMarkdown("<h2>Hello</h2><p>See <a href=\"https://x.test\">X</a></p>"),
    /## Hello/,
  );
  assert.match(
    htmlToMarkdown("<h2>Hello</h2><p>See <a href=\"https://x.test\">X</a></p>"),
    /\[X\]\(https:\/\/x\.test\)/,
  );
});

test("preview renders inline, display, and fenced KaTeX without rewriting currency or code", () => {
  const inline = renderPreview("Energy is $E=mc^2$.");
  assert.match(inline, /class="katex"/);
  assert.match(inline, />E</);
  assert.doesNotMatch(inline, /\$E=mc\^2\$/);

  const display = renderPreview("$$\\int_0^1 x^2 \\, dx$$");
  assert.match(display, /katex-display/);

  const fence = renderPreview("```math\nE=mc^2\n```");
  assert.match(fence, /katex-display/);
  assert.doesNotMatch(fence, /<code class="language-math"/);

  const reserved = renderPreview("Cost is $20 and `const price = $20` stays code.");
  assert.match(reserved, /\$20/);
  assert.match(reserved, /<code>const price = \$20<\/code>/);
  assert.doesNotMatch(reserved, /katex/);

  const extracted = extractMath("see $$a$$ and $b$");
  assert.equal(extracted.slots.length, 2);
  assert.equal(extracted.slots[0].display, true);
  assert.equal(extracted.slots[1].display, false);
});

test("preview mermaid fences hydrate to SVG and skip highlight.js", async () => {
  assert.equal(looksLikeMermaidFence("mermaid"), true);
  assert.equal(looksLikeMermaidFence("mmd"), true);
  assert.equal(looksLikeMermaidFence("javascript"), false);

  const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";
  const host = document.createElement("div");
  host.innerHTML = renderPreview(markdown);
  assert.match(host.innerHTML, /language-mermaid/);
  highlightPreviewCode(host);
  const code = host.querySelector("pre > code.language-mermaid");
  assert.ok(code);
  assert.notEqual(code?.dataset.highlighted, "1");

  await hydrateMermaid(host, async () => '<svg data-mermaid="ok"><text>A</text></svg>');
  assert.equal(host.querySelector("pre > code.language-mermaid"), null);
  const figure = host.querySelector("figure.mermaid-block");
  assert.ok(figure);
  assert.equal(figure?.dataset.mermaidRendered, "1");
  assert.ok(figure?.querySelector("svg[data-mermaid='ok']"));

  const bad = document.createElement("div");
  bad.innerHTML = renderPreview("```mmd\nnot a diagram\n```");
  await hydrateMermaid(bad, async () => {
    throw new Error("Parse error on line 1");
  });
  assert.match(bad.innerHTML, /mermaid-error/);
  assert.match(bad.innerHTML, /Parse error on line 1/);
  assert.match(bad.innerHTML, /not a diagram/);
});

test("preview code fences receive highlight.js spans", () => {
  const host = document.createElement("div");
  host.innerHTML = renderPreview("```rust\nfn main() {}\n```");
  highlightPreviewCode(host);
  const code = host.querySelector("pre > code");
  assert.ok(code);
  assert.equal(code?.dataset.highlighted, "1");
  assert.match(code?.innerHTML ?? "", /hljs-keyword|fn /);
  assert.match(highlightSource("const x = 1;", "javascript"), /hljs-keyword|const/);
});

test("Pandoc inline code attributes highlight instead of executing", () => {
  assert.equal(parsePandocAttributeBlock(".sqlpostgresql")?.language, "sqlpostgresql");
  const html = applyPandocInlineCodeAttrs("<p>This is a <code>SELECT 1;</code>{.sqlpostgresql} test.</p>");
  assert.match(html, /class="language-sqlpostgresql"/);
  assert.doesNotMatch(html, /\{\.sqlpostgresql\}/);

  const host = document.createElement("div");
  host.innerHTML = renderPreview("This is a ```SELECT 1;```{.sqlpostgresql} test.");
  assert.match(host.innerHTML, /language-sqlpostgresql/);
  assert.doesNotMatch(host.innerHTML, /\{\.sqlpostgresql\}/);
  highlightPreviewCode(host);
  const code = host.querySelector("code.language-sqlpostgresql");
  assert.ok(code);
  assert.equal(code?.dataset.highlighted, "1");
  assert.match(code?.innerHTML ?? "", /hljs-keyword|SELECT/);
});

test("sql and sqlpostgresql fences highlight; pgsql is reserved for the engine", () => {
  assert.equal(resolveHighlightLanguage("sqlpostgresql"), "pgsql");
  const dialect = document.createElement("div");
  dialect.innerHTML = renderPreview("```sqlpostgresql\nWITH person AS (SELECT name FROM people LIMIT 1)\nINSERT INTO people (full_name)\nSELECT name FROM person\nON CONFLICT DO NOTHING\nRETURNING id;\n```");
  highlightPreviewCode(dialect);
  const dialectCode = dialect.querySelector("pre > code");
  assert.ok(dialectCode);
  assert.match(dialectCode?.className ?? "", /language-sqlpostgresql/);
  assert.equal(dialectCode?.dataset.highlighted, "1");
  assert.match(dialectCode?.innerHTML ?? "", /hljs-keyword/);
  assert.match(dialectCode?.innerHTML ?? "", /WITH|INSERT|RETURNING/i);

  const generic = document.createElement("div");
  generic.innerHTML = renderPreview("```sql\nSELECT 1;\n```");
  highlightPreviewCode(generic);
  const genericCode = generic.querySelector("pre > code");
  assert.ok(genericCode);
  assert.equal(genericCode?.dataset.highlighted, "1");
  assert.match(genericCode?.className ?? "", /language-sql/);

  const engine = document.createElement("div");
  engine.innerHTML = renderPreview("```pgsql\nSELECT 1;\n```");
  highlightPreviewCode(engine);
  const engineCode = engine.querySelector("pre > code");
  assert.ok(engineCode);
  assert.match(engineCode?.className ?? "", /language-pgsql/);
  assert.notEqual(engineCode?.dataset.highlighted, "1");
  assert.doesNotMatch(engineCode?.className ?? "", /\bhljs\b/);
});
