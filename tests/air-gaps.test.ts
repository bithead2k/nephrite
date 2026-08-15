import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { applyYamlFrontmatter, parseFrontmatterTree, serializeSimpleYaml } from "../ui/src/yaml-tree";
import { renderPropertiesEditor } from "../ui/src/properties-editor";
import { renderSqlConsole } from "../ui/src/sql-console";
import { renderAttachmentPanel } from "../ui/src/attachment-panel";
import { renderCommandBar } from "../ui/src/command-bar";
import { isBasePath } from "../ui/src/file-kinds";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLInputElement: { configurable: true, value: dom.window.HTMLInputElement },
  Event: { configurable: true, value: dom.window.Event },
  KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
  requestAnimationFrame: {
    configurable: true,
    value: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(0), 0),
  },
});

test("isBasePath recognizes Obsidian base files", () => {
  assert.equal(isBasePath("Views/Jobs.base"), true);
  assert.equal(isBasePath("Jobs.md"), false);
});

test("nested YAML round-trips maps, lists, and scalars", () => {
  const tree = {
    title: "North",
    aliases: ["PayTrace", "NAB"],
    contact: { email: "a@b.com", count: 2 },
    attention: false,
  };
  const yaml = serializeSimpleYaml(tree);
  assert.match(yaml, /aliases:\n  - PayTrace\n  - NAB/);
  assert.match(yaml, /contact:\n  email: a@b.com\n  count: 2/);
  const next = applyYamlFrontmatter("Body\n", tree);
  assert.equal(parseFrontmatterTree(next) instanceof Object, true);
  assert.match(next, /^---\n/);
  assert.match(next, /\n---\nBody\n$/);
});

test("properties editor rewrites only frontmatter", () => {
  const host = document.createElement("div");
  let saved = "";
  renderPropertiesEditor(host, "---\ncompany: Old\n---\nHello\n", (next) => { saved = next; });
  const key = host.querySelector<HTMLInputElement>(".properties-key");
  const value = host.querySelector<HTMLInputElement>(".properties-value");
  assert.ok(key && value);
  key.value = "company";
  value.value = "North";
  value.dispatchEvent(new Event("change", { bubbles: true }));
  const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save properties");
  save?.click();
  assert.match(saved, /company: North/);
  assert.match(saved, /\n---\nHello\n$/);
});

test("SQL console runs on Ctrl+Enter and links paths", async () => {
  const host = document.createElement("div");
  const opened: string[] = [];
  renderSqlConsole(host, {
    run: async () => ({ columns: ["path", "title"], rows: [["Inbox.md", "Inbox"]], truncated: false }),
    onOpen: (path) => opened.push(path),
  });
  const editor = host.querySelector("textarea");
  assert.ok(editor);
  editor.value = "SELECT path, title FROM pages";
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  host.querySelector<HTMLButtonElement>(".sql-console-link")?.click();
  assert.deepEqual(opened, ["Inbox.md"]);
});

test("attachment panel filters orphans", () => {
  const host = document.createElement("div");
  const opened: string[] = [];
  renderAttachmentPanel(host, [
    {
      path: "assets/used.png",
      name: "used.png",
      file_kind: "image",
      mime_type: "image/png",
      size_bytes: 12,
      width: 1,
      height: 1,
      reference_count: 2,
      orphaned: false,
      text_indexed: false,
    },
    {
      path: "assets/lost.png",
      name: "lost.png",
      file_kind: "image",
      mime_type: "image/png",
      size_bytes: 8,
      width: 1,
      height: 1,
      reference_count: 0,
      orphaned: true,
      text_indexed: false,
    },
  ], (path) => opened.push(path));
  const orphans = host.querySelector<HTMLInputElement>("input[type=checkbox]");
  assert.ok(orphans);
  orphans.checked = true;
  orphans.dispatchEvent(new Event("change", { bubbles: true }));
  const rows = [...host.querySelectorAll(".attachment-row")].map((row) => row.querySelector("strong")?.textContent);
  assert.deepEqual(rows, ["lost.png"]);
});

test("command bar shows powerline context", () => {
  const host = document.createElement("div");
  renderCommandBar(host, [{ id: "x", title: "X", run: () => {} }], () => {}, {
    vault: "notes",
    file: "Inbox.md",
    mode: "live",
  });
  const segments = [...host.querySelectorAll(".command-bar-segment")].map((node) => node.textContent);
  assert.deepEqual(segments, ["notes", "Inbox.md", "live"]);
});
