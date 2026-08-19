import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { pluginIframeDocument, type PluginDescriptor } from "../ui/src/plugin-host";

function publicRuntimeExports(): string[] {
  const source = ts.createSourceFile(
    "obsidian.d.ts",
    readFileSync("node_modules/obsidian/obsidian.d.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (
      "name" in statement
      && statement.name
      && "text" in statement.name
      && !ts.isInterfaceDeclaration(statement)
      && !ts.isTypeAliasDeclaration(statement)
    ) names.push(String(statement.name.text));
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return [...new Set(names)].sort();
}

function descriptor(source: string, assets?: Record<string, string>): PluginDescriptor {
  return {
    id: "official-api-smoke",
    name: "Official API smoke",
    version: "1.0.0",
    description: "",
    permissions: ["vault.read", "editor.read", "editor.write", "workspace.commands", "workspace.views"],
    api_version: 1,
    min_app_version: null,
    compatibility: "obsidian",
    source,
    assets,
  };
}

test("CommonJS plugin packages can require bundled sibling modules", async () => {
  const helper = Buffer.from("module.exports = { answer: 42 };", "utf8").toString("base64");
  const plugin = descriptor(`
    const { Plugin } = require("obsidian");
    const helper = require("./lib/helper");
    window.packageAudit = helper.answer;
    module.exports = class extends Plugin {};
  `, { "lib/helper.js": "data:text/javascript;base64," + helper });
  const dom = new JSDOM(pluginIframeDocument(plugin), {
    runScripts: "dangerously",
    url: "https://plugin.nephrite.invalid/",
    beforeParse(window) {
      Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
      Object.defineProperty(window, "TextEncoder", { value: TextEncoder });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((dom.window as unknown as { packageAudit: number }).packageAudit, 42);
  dom.window.close();
});

test("CommonJS bundles do not treat ESM examples in generated comments as code", async () => {
  const dom = await boot(`
    // <script lang="ts"> export let metadata; </script>
    const { Plugin } = require("obsidian");
    window.commentAudit = true;
    module.exports = class extends Plugin {};
  `);
  assert.equal((dom.window as unknown as { commentAudit: boolean }).commentAudit, true);
  dom.window.close();
});

test("unbundled ESM plugin packages can import and re-export sibling modules", async () => {
  const helper = Buffer.from("export const answer = 42; export default answer;", "utf8").toString("base64");
  const plugin = descriptor(`
    import { Plugin } from "obsidian";
    import answer, { answer as namedAnswer } from "./lib/helper.js";
    window.esmPackageAudit = answer + namedAnswer;
    export default class extends Plugin {};
  `, { "lib/helper.js": "data:text/javascript;base64," + helper });
  const dom = new JSDOM(pluginIframeDocument(plugin), {
    runScripts: "dangerously",
    url: "https://plugin.nephrite.invalid/",
    beforeParse(window) {
      Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
      Object.defineProperty(window, "TextEncoder", { value: TextEncoder });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((dom.window as unknown as { esmPackageAudit: number }).esmPackageAudit, 84);
  dom.window.close();
});

test("editor commands receive a mutable Obsidian Editor backed by host writes", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const plugin = descriptor(`
    const { Plugin } = require("obsidian");
    module.exports = class extends Plugin {
      onload() {
        this.addCommand({
          id: "edit-selection",
          name: "Edit selection",
          editorCallback(editor) {
            window.editorAudit = {
              before: editor.getSelection(),
              cursor: editor.getCursor("head"),
              lines: editor.lineCount(),
            };
            editor.replaceSelection("gamma");
          }
        });
      }
    };
  `);
  const dom = new JSDOM(pluginIframeDocument(plugin), {
    runScripts: "dangerously",
    url: "https://plugin.nephrite.invalid/",
    beforeParse(window) {
      Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
      Object.defineProperty(window, "TextEncoder", { value: TextEncoder });
      window.addEventListener("message", (event) => {
        const message = event.data as { nephritePlugin?: boolean; type?: string; requestId?: number; method?: string; args?: unknown[] };
        if (!message.nephritePlugin || message.type !== "request" || message.requestId == null || !message.method) return;
        calls.push({ method: message.method, args: message.args || [] });
        const result = message.method === "editor.getState"
          ? { path: "Daily.md", content: "alpha\nbeta", selection: "beta", from: 6, to: 10 }
          : true;
        window.dispatchEvent(new window.MessageEvent("message", { data: {
          nephriteHost: true,
          pluginId: "official-api-smoke",
          type: "response",
          requestId: message.requestId,
          result,
        } }));
      });
    },
  });
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    nephriteHost: true, pluginId: "official-api-smoke", type: "load",
    files: [], metadata: [], activeFile: { path: "Daily.md" },
  } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    nephriteHost: true, pluginId: "official-api-smoke", type: "command", id: "edit-selection", requestId: 700,
  } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const audit = (dom.window as unknown as { editorAudit: { before: string; cursor: { line: number; ch: number }; lines: number } }).editorAudit;
  assert.equal(audit.before, "beta");
  assert.equal(audit.lines, 2);
  assert.equal(audit.cursor.line, 1);
  assert.ok(calls.some((call) => call.method === "editor.setValue" && call.args[0] === "alpha\ngamma"));
  assert.ok(calls.some((call) => call.method === "editor.setSelection"));
  dom.window.close();
});

test("plugin modals render inside the sandbox and request a host overlay", async () => {
  const messages: string[] = [];
  const dom = new JSDOM(pluginIframeDocument(descriptor(`
    const { Plugin, Modal } = require("obsidian");
    module.exports = class extends Plugin {
      onload() {
        const modal = new Modal(this.app);
        modal.setTitle("Compatibility dialog");
        modal.contentEl.createEl("p", { text: "Visible content" });
        modal.open();
      }
    };
  `)), {
    runScripts: "dangerously",
    url: "https://plugin.nephrite.invalid/",
    beforeParse(window) {
      window.addEventListener("message", (event) => {
        if (event.data?.nephritePlugin && event.data?.type) messages.push(event.data.type);
      });
    },
  });
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    nephriteHost: true, pluginId: "official-api-smoke", type: "load",
    files: [], metadata: [], activeFile: null,
  } }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(dom.window.document.querySelector(".modal-title")?.textContent, "Compatibility dialog");
  assert.equal(dom.window.document.querySelector(".modal-content")?.textContent, "Visible content");
  assert.ok(messages.includes("modal-open"));
  dom.window.close();
});

test("ribbon and status contributions remain interactive outside the command catalog", async () => {
  const messages: Array<{ type: string; text?: string }> = [];
  const dom = new JSDOM(pluginIframeDocument(descriptor(`
    const { Plugin } = require("obsidian");
    module.exports = class extends Plugin {
      onload() {
        this.addRibbonIcon("sparkles", "Run fixture", () => { window.ribbonRuns = (window.ribbonRuns || 0) + 1; });
        const status = this.addStatusBarItem();
        status.setText("Ready");
        status.addEventListener("click", () => { window.statusRuns = (window.statusRuns || 0) + 1; });
      }
    };
  `)), {
    runScripts: "dangerously",
    url: "https://plugin.nephrite.invalid/",
    beforeParse(window) {
      window.addEventListener("message", (event) => {
        if (event.data?.nephritePlugin && event.data?.type) messages.push(event.data);
      });
    },
  });
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    nephriteHost: true, pluginId: "official-api-smoke", type: "load",
    files: [], metadata: [], activeFile: null,
  } }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(messages.some((message) => message.type === "ribbon-registered"));
  assert.ok(messages.some((message) => message.type === "status-updated" && message.text === "Ready"));
  for (const id of ["ribbon-1", "status-2"]) {
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
      nephriteHost: true, pluginId: "official-api-smoke", type: "ui-action", id, requestId: id === "ribbon-1" ? 91 : 92,
    } }));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((dom.window as unknown as { ribbonRuns: number }).ribbonRuns, 1);
  assert.equal((dom.window as unknown as { statusRuns: number }).statusRuns, 1);
  dom.window.close();
});

async function boot(source: string): Promise<JSDOM> {
  const dom = new JSDOM(pluginIframeDocument(descriptor(source)), {
    runScripts: "dangerously",
    url: "https://plugin.nephrite.invalid/",
    beforeParse(window) {
      Object.defineProperty(window, "TextDecoder", { value: TextDecoder });
      Object.defineProperty(window, "TextEncoder", { value: TextEncoder });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return dom;
}

test("every public runtime export in the official Obsidian typings can be imported", async () => {
  const expected = publicRuntimeExports();
  assert.ok(expected.length >= 150, "official API audit unexpectedly found too few runtime exports");
  const dom = await boot(`
    const api = require("obsidian");
    window.importAudit = Object.fromEntries(${JSON.stringify(expected)}.map(name => [name, { type: typeof api[name], implementation: api[name]?.name || "" }]));
    module.exports = class extends api.Plugin {};
  `);
  const audit = (dom.window as unknown as { importAudit: Record<string, { type: string; implementation: string }> }).importAudit;
  assert.deepEqual(Object.entries(audit).filter(([, value]) => value.type === "undefined"), []);
  assert.deepEqual(Object.entries(audit).filter(([, value]) => value.implementation === "GenericObsidianClass"), []);
  dom.window.close();
});

test("Obsidian compatibility objects provide live DOM, workspace, date, and component behavior", async () => {
  const dom = await boot(`
    const { Plugin, Component, Setting, MarkdownView, Vault, moment, getFrontMatterInfo, parseLinktext } = require("obsidian");
    const { Prec } = require("@codemirror/state");
    const { keymap } = require("@codemirror/view");
    const { insertBlankLine } = require("@codemirror/commands");
    module.exports = class extends Plugin {
      onload() {
        const host = document.body.createDiv({ cls: "fixture" });
        new Setting(host).setName("Enabled").addToggle(toggle => toggle.setValue(true));
        const first = new Component(), second = new Component();
        let firstDisposed = 0, secondDisposed = 0;
        first.register(() => firstDisposed++);
        second.register(() => secondDisposed++);
        first.unload();
        const leaf = this.app.workspace.getLeaf();
        const children = [];
        Vault.recurseChildren(this.app.vault.getRoot(), file => children.push(file.path));
        window.compatAudit = {
          toggle: host.querySelector("input").checked,
          leafType: leaf.getViewState().type,
          markdownView: leaf.view instanceof MarkdownView,
          date: moment("2026-08-19").add(1, "day").format("YYYY-MM-DD"),
          momentGlobal: window.moment.localeData()._week.dow,
          codeMirror: Prec.highest(keymap.of([{ key: "Enter", run: insertBlankLine }])).value[0].key,
          children,
          frontmatter: getFrontMatterInfo("---\\nstatus: active\\n---\\nBody").exists,
          link: parseLinktext("People/Ada#Work|Ada"),
          firstDisposed,
          secondDisposed,
        };
      }
    };
  `);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    nephriteHost: true,
    pluginId: "official-api-smoke",
    type: "load",
    files: [{ path: "Daily.md", name: "Daily.md", basename: "Daily", extension: "md", file_kind: "markdown" }],
    metadata: [],
    activeFile: { path: "Daily.md", name: "Daily.md", basename: "Daily", extension: "md" },
  } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const audit = (dom.window as unknown as { compatAudit: Record<string, unknown> }).compatAudit;
  assert.equal(audit.toggle, true);
  assert.equal(audit.leafType, "markdown");
  assert.equal(audit.markdownView, true);
  assert.equal(audit.date, "2026-08-20");
  assert.equal(audit.momentGlobal, 0);
  assert.equal(audit.codeMirror, "Enter");
  assert.equal(JSON.stringify(audit.children), JSON.stringify(["Daily.md"]));
  assert.equal(audit.frontmatter, true);
  assert.equal(JSON.stringify(audit.link), JSON.stringify({ path: "People/Ada", subpath: "#Work" }));
  assert.equal(audit.firstDisposed, 1);
  assert.equal(audit.secondDisposed, 0);
  dom.window.close();
});

test("real-plugin compatibility aliases expose globals, command registries, events, and custom CSS", async () => {
  const dom = await boot(`
    const { Plugin } = require("obsidian");
    module.exports = class extends Plugin {
      onload() {
        let events = 0;
        this.registerEvent(this.app.workspace.on("fixture-event", () => events++));
        this.app.workspace.trigger("fixture-event");
        const command = this.addCommand({ id: "fixture-command", name: "Fixture", callback: () => true });
        this.app.customCss.setCssEnabledStatus("fixture", true);
        window.aliasAudit = {
          globalDiv: createDiv({ cls: "global-fixture" }).hasClass("global-fixture"),
          globalFragment: createFragment(fragment => fragment.createSpan({ text: "ok" })).textContent,
          pluginMap: typeof this.app.plugins.plugins === "object",
          commandReturn: command.id,
          commandRegistry: this.app.commands.commands["fixture-command"].name,
          events,
          snippet: this.app.customCss.enabledSnippets.has("fixture"),
          snippetPath: this.app.customCss.getSnippetPath("fixture"),
        };
      }
    };
  `);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    nephriteHost: true, pluginId: "official-api-smoke", type: "load",
    files: [], metadata: [], activeFile: null,
  } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const audit = (dom.window as unknown as { aliasAudit: Record<string, unknown> }).aliasAudit;
  assert.equal(audit.globalDiv, true);
  assert.equal(audit.globalFragment, "ok");
  assert.equal(audit.pluginMap, true);
  assert.equal(audit.commandReturn, "fixture-command");
  assert.equal(audit.commandRegistry, "Fixture");
  assert.equal(audit.events, 1);
  assert.equal(audit.snippet, true);
  assert.equal(audit.snippetPath, ".obsidian/snippets/fixture.css");
  dom.window.close();
});

test("Bases values, collections, dates, tasks, and view configuration have working semantics", async () => {
  const dom = await boot(`
    const { Plugin, Value, NullValue, StringValue, NumberValue, ListValue, ObjectValue, DateValue, DurationValue, LinkValue, Tasks, BasesViewConfig, BasesEntry, BasesEntryGroup } = require("obsidian");
    module.exports = class extends Plugin {
      onload() {
        const list = new ListValue(["alpha", 2]);
        const object = new ObjectValue({ enabled: true });
        const date = new DateValue("2026-08-19T00:00:00Z");
        const tasks = new Tasks();
        tasks.add(async () => 20);
        tasks.addPromise(Promise.resolve(22));
        const config = new BasesViewConfig({ name: "Cards", order: ["note.title"], sort: [{ property: "note.title", direction: "ASC" }] });
        const entry = new BasesEntry({ path: "People/Ada.md" }, { score: 42 });
        window.basesAudit = {
          strictEqual: Value.equals(new NumberValue(2), new NumberValue(2)),
          looseEqual: Value.looseEquals(new NumberValue(2), new StringValue("2")),
          nullSingleton: NullValue.value.isTruthy(),
          list: [list.length(), list.get(1).toString(), list.includes(new NumberValue(2))],
          object: [object.isEmpty(), object.get("enabled").isTruthy()],
          date: new DurationValue(86400000).addToDate(date).toString().slice(0, 10),
          link: LinkValue.parseFromString(this.app, "[[People/Ada|Ada]]", "Daily.md").toString(),
          tasksQueued: !tasks.isEmpty(),
          config: [config.name, config.getOrder()[0], config.getSort()[0].direction, config.getDisplayName("note.title")],
          entry: entry.getValue("score").toString(),
          group: new BasesEntryGroup("team", [entry]).hasKey(),
        };
        tasks.promise().then(values => window.basesAudit.tasks = values);
      }
    };
  `);
  const hostMessages: unknown[] = [];
  dom.window.addEventListener("message", (event) => {
    if ((event.data as { nephritePlugin?: boolean })?.nephritePlugin) hostMessages.push(event.data);
  });
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    nephriteHost: true, pluginId: "official-api-smoke", type: "load", files: [], metadata: [], activeFile: null,
  } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const audit = (dom.window as unknown as { basesAudit: Record<string, unknown> }).basesAudit;
  assert.ok(audit, JSON.stringify(hostMessages));
  assert.equal(audit.strictEqual, true);
  assert.equal(audit.looseEqual, true);
  assert.equal(audit.nullSingleton, false);
  assert.equal(JSON.stringify(audit.list), JSON.stringify([2, "2", true]));
  assert.equal(JSON.stringify(audit.object), JSON.stringify([false, true]));
  assert.equal(audit.date, "2026-08-20");
  assert.equal(audit.link, "[[People/Ada|Ada]]");
  assert.equal(audit.tasksQueued, true);
  assert.equal(JSON.stringify(audit.tasks), JSON.stringify([20, 22]));
  assert.equal(JSON.stringify(audit.config), JSON.stringify(["Cards", "note.title", "ASC", "title"]));
  assert.equal(audit.entry, "42");
  assert.equal(audit.group, true);
  dom.window.close();
});
