import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { buildTree, filterTree } from "../ui/src/tree.ts";

const files = Array.from({ length: 100_000 }, (_, i) => ({
  path: `people/Person ${String(i).padStart(6, "0")}.md`,
  name: `Person ${String(i).padStart(6, "0")}.md`,
  parent_path: "people", file_kind: "markdown",
}));

test("a 100,000-note folder builds promptly without losing or duplicating files", () => {
  const start = performance.now();
  const tree = buildTree([...files, files[0]]);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].children.length, files.length);
  assert.equal(tree.children[0].children.at(-1)?.path, files.at(-1)?.path);
  assert.ok(performance.now() - start < 3000, "large folder construction exceeded 3 seconds");
});

test("tree retains separate file and folder names and deduplicates exact paths", () => {
  const tree = buildTree([
    { path: "people", name: "people", parent_path: "", file_kind: "markdown" },
    files[1], files[0], files[1],
  ]);
  assert.deepEqual(tree.children.map(n => n.kind), ["dir", "file"]);
  assert.deepEqual(tree.children[0].children.map(n => n.path), files.slice(0, 2).map(f => f.path));
});

test("expanded large folder mounts a batch; later entries remain reachable by loading and filtering", () => {
  // Exercise the actual application render functions, with only platform actions stubbed.
  const source = readFileSync(new URL("../ui/src/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["renderTree", "renderNode", "escapeHtml"]);
  const snippets = ast.statements.filter(node =>
    ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? "") ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
      ts.isIdentifier(d.name) && ["treeBatchSize", "treeVisibleCounts"].includes(d.name.text)),
  ).map(node => node.getText(ast)).join("\n");
  const dom = new JSDOM('<div id="file-tree"></div>');
  const factory = new Function("document", "fixture", ts.transpileModule(`
    const { treeRoot, mdFiles, filterTree } = fixture;
    let filterQuery = "";
    const expanded = new Set(["people"]);
    const currentPath = null;
    const opened = [];
    const $ = id => document.getElementById(id);
    const bindCtx = () => {}, bindTreeDrag = () => {}, saveExpanded = () => {};
    const installTreeHostListeners = () => {};
    const openVaultEntry = path => opened.push(path);
    ${snippets}
    return { renderTree, opened, setQuery: q => { filterQuery = q; renderTree(); } };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  const app = factory(dom.window.document, { treeRoot: buildTree(files), mdFiles: files, filterTree });
  app.renderTree();
  const host = dom.window.document.getElementById("file-tree")!;
  assert.equal(host.querySelectorAll("button[data-path]").length, 200);
  assert.match(host.querySelector(".tree-load-more")!.textContent!, /200 of 100,000 shown/);
  host.scrollTop = 500;
  (host.querySelector(".tree-load-more") as HTMLElement).click();
  assert.equal(host.querySelectorAll("button[data-path]").length, 400);
  assert.equal(host.scrollTop, 500);
  app.setQuery("Person 099999");
  assert.equal(host.querySelectorAll("button[data-path]").length, 1);
  (host.querySelector("button[data-path]") as HTMLElement).click();
  assert.deepEqual(app.opened, [files.at(-1)!.path]);
  app.setQuery("");
  assert.equal(host.querySelectorAll("button[data-path]").length, 400);
  dom.window.close();
});
