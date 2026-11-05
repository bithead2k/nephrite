import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  emptyBaseSource,
  evaluateBase,
  evaluateExpression,
  evaluateFormula,
  pageFromIndexRow,
  parseBase,
} from "../ui/src/bases";
import { renderBaseView, hydrateBaseFencesWhenNeeded } from "../ui/src/base-view";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
});

function page(path: string, extra: Record<string, unknown> = {}) {
  return pageFromIndexRow({
    path,
    name: path.replace(/^.*\//, ""),
    folder: path.includes("/") ? path.replace(/\/[^/]+$/, "") : "",
    size_bytes: 12,
    tags: extra.tags ?? [],
    links: extra.links ?? [],
    properties: (extra.properties as Record<string, unknown> | undefined) ?? extra,
  });
}

test("parseBase reads filters, formulas, views, and sort", () => {
  const base = parseBase(`
filters:
  and:
    - file.hasTag("job")
formulas:
  score: 1 + 2
properties:
  file.name:
    displayName: Name
views:
  - type: table
    name: Open
    limit: 10
    order:
      - file.name
      - company
    sort:
      - property: file.name
        direction: DESC
    filters:
      status != "closed"
`);
  assert.equal(base.filters?.kind, "and");
  assert.equal(base.formulas.score, "1 + 2");
  assert.equal(base.views[0].name, "Open");
  assert.equal(base.views[0].limit, 10);
  assert.deepEqual(base.views[0].order, ["file.name", "company"]);
  assert.deepEqual(base.views[0].sort, [{ property: "file.name", direction: "DESC" }]);
});

test("evaluateBase filters tags, compares properties, and applies formulas", () => {
  const base = parseBase(`
filters:
  and:
    - file.hasTag("job")
    - status != "closed"
formulas:
  label: company
views:
  - type: table
    name: Table
    order:
      - file.name
      - formula.label
    sort:
      - property: file.name
        direction: ASC
`);
  const table = evaluateBase(base, [
    page("jobs/Zed.md", { tags: ["#job"], properties: { status: "open", company: "Zed" } }),
    page("jobs/Acme.md", { tags: ["job"], properties: { status: "open", company: "Acme" } }),
    page("jobs/Old.md", { tags: ["job"], properties: { status: "closed", company: "Old" } }),
    page("people/Kirk.md", { tags: ["people"], properties: { status: "open" } }),
  ]);
  assert.deepEqual(table.rows.map((row) => row.cells), [
    ["Acme", "Acme"],
    ["Zed", "Zed"],
  ]);
});

test("file.inFolder and comparisons work in expressions", () => {
  const kirk = page("people/Kirk.md", { properties: { count: 3 } });
  assert.equal(evaluateExpression('file.inFolder("people")', kirk), true);
  assert.equal(evaluateExpression('file.inFolder("jobs")', kirk), false);
  assert.equal(evaluateExpression("count > 2", kirk), true);
  assert.equal(evaluateFormula("count + 4", kirk), 7);
});

test("emptyBaseSource is a valid default table", () => {
  const base = parseBase(emptyBaseSource());
  const table = evaluateBase(base, [
    page("note.md"),
    page("logo.png"),
  ]);
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].path, "note.md");
});

test("renderBaseView draws view tabs and opens a row", () => {
  const host = document.createElement("div");
  const opened: string[] = [];
  renderBaseView(host, emptyBaseSource(), [page("Inbox.md")], {
    path: "vault.base",
    onOpen: (path) => opened.push(path),
  });
  assert.ok(host.querySelector(".base-view-tab"));
  host.querySelector<HTMLButtonElement>(".base-link")?.click();
  assert.deepEqual(opened, ["Inbox.md"]);
});


test("ordinary preview refreshes never load the vault for Bases", async () => {
  const root = document.createElement("div");
  root.innerHTML = '<p>Journal text</p><pre><code class="language-text">weather</code></pre><pre><code class="language-dataviewjs">dv.current()</code></pre>';
  for (let i = 0; i < 5; i++) {
    root.querySelector("p")!.textContent += " another edit";
    await hydrateBaseFencesWhenNeeded(root, async () => { throw new Error("Unnecessary vault scan"); });
  }
  assert.match(root.textContent!, /another edit/);
});

test("Base fences load once and stale hydration leaves the preview intact", async () => {
  const root = document.createElement("div");
  root.innerHTML = '<pre><code class="language-BASE">views:\n  - type: table\n    name: Notes</code></pre>';
  let calls = 0;
  const load = async () => {calls++; return [page("Example.md")];};
  await hydrateBaseFencesWhenNeeded(root, load);
  assert.equal(calls, 1);
  assert.match(root.textContent!, /Example/);
  await hydrateBaseFencesWhenNeeded(root, load);
  assert.equal(calls, 1);
  root.innerHTML = '<pre><code class="language-bases">views: []</code></pre>';
  const original = root.innerHTML;
  let live = true;
  await hydrateBaseFencesWhenNeeded(root, async () => {live=false; return [];}, () => live);
  assert.equal(root.innerHTML, original);
});
