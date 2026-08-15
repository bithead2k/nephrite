import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderCommandBar, type AppCommand } from "../ui/src/command-bar";
import {
  showContextMenu,
  type CtxAction,
  type CtxTarget,
} from "../ui/src/context-menu";
import { hydrateNoteEmbeds } from "../ui/src/note-embed";
import { renderPreview } from "../ui/src/preview";
import { applyAppearanceFonts, normalizeAppearanceFonts } from "../ui/src/appearance";
import { pluginIframeDocument, type PluginDescriptor } from "../ui/src/plugin-host";
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
import { hydratePreviewTaskMarkers } from "../ui/src/tasks";
import { nextTaskStatusChar } from "../ui/src/task-status";
import { slashCompletionMatch } from "../ui/src/slash-commands";
import { hydrateCsvFences, parseCsv } from "../ui/src/csv-view";
import { parseSimpleYaml } from "../ui/src/structured-view";
import { isAudioPath, isCsvPath, isStructuredPath, isVideoPath } from "../ui/src/file-kinds";

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
  assert.match(document, /window\.__obsidianPluginInstance\?\._postProcessor/);
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
  assert.equal(isCodePath("config.yaml"), false);
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
