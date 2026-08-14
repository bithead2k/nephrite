import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  evaluateDql,
  filterPagesBySource,
  parseDql,
  runDqlBlock,
  runScriptBlock,
  type DvPage,
  type EngineContext,
} from "../ui/src/dv-engine";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLInputElement: { configurable: true, value: dom.window.HTMLInputElement },
  Event: { configurable: true, value: dom.window.Event },
});

function page(path: string, tags: string[], extra: Record<string, unknown> = {}): DvPage {
  const name = path.replace(/^.*\//, "").replace(/\.md$/, "");
  return {
    path,
    ...extra,
    file: {
      path,
      name,
      folder: path.includes("/") ? path.replace(/\/[^/]+$/, "") : "",
      link: `[[${path.replace(/\.md$/, "")}]]`,
      mtime: null,
      ctime: null,
      day: null,
      tags,
      aliases: [],
      outlinks: [],
      inlinks: [],
      frontmatter: extra,
      tasks: [],
    },
  };
}

const brady = page("people/Brady Gunter.md", ["#recruiter"], {
  company: "Acme",
  skills: ["sql", "typescript"],
  interview: "2026-08-13",
});
const josh = page("people/Josh Flanders.md", ["#recruiter", "#interviewer"], {
  company: "Acme",
  skills: ["rust"],
  interview: "2026-08-14",
});
josh.file.tasks = [{ path: josh.path, task_id: 3, text: "Call Josh", completed: false }];
const project = page("projects/Nephrite.md", ["#project"], { company: "Nephrite" });
project.file.outlinks = ["people/Brady Gunter"];
const pages = [brady, josh, project];

function context(changes: unknown[] = []): EngineContext {
  return {
    currentPath: brady.path,
    currentSource: "",
    loadPages: async () => pages,
    loadPage: async (path) => pages.find((value) => value.path === path) ?? null,
    runSql: async () => ({ columns: [], rows: [], truncated: false }),
    readFile: async (path) => path.endsWith("people.csv")
      ? "name,role\nAda,Engineer\nGrace,Admiral\n"
      : "dv.paragraph(input.name)",
    setTaskCompleted: async (...args) => { changes.push(args); },
    resolveLink: () => {},
  };
}

test("DQL parser preserves the complete ordered clause surface", () => {
  const query = parseDql(`TABLE WITHOUT ID company AS "Company"
FROM "people" AND #recruiter
WHERE company = "Acme"
FLATTEN skills AS skill
GROUP BY company AS employer
SORT employer ASC
SORT length(rows) DESC
LIMIT 20`);
  assert.equal(query.kind, "TABLE");
  assert.equal(query.withoutId, true);
  assert.equal(query.source, '"people" AND #recruiter');
  assert.deepEqual(query.flatten, [{ expression: "skills", alias: "skill" }]);
  assert.deepEqual(query.group, { expression: "company", alias: "employer" });
  assert.equal(query.sort.length, 2);
  assert.equal(query.limit, 20);
});

test("Dataview source selectors compose folders, tags, links, and booleans", () => {
  assert.deepEqual(filterPagesBySource(pages, '"people" AND (#recruiter OR #interviewer)').map((p) => p.file.name), ["Brady Gunter", "Josh Flanders"]);
  assert.deepEqual(filterPagesBySource(pages, "#recruiter AND -#interviewer").map((p) => p.file.name), ["Brady Gunter"]);
  assert.deepEqual(filterPagesBySource(pages, "[[Brady Gunter]]").map((p) => p.file.name), ["Nephrite"]);
});

test("DQL functions cover collection, string, date, and duration operations", () => {
  assert.equal(evaluateDql("length(skills)", brady, brady), 2);
  assert.equal(evaluateDql('icontains(company, "ACME")', brady, brady), true);
  assert.equal(evaluateDql("sum(list(2, 3, 5))", brady, brady), 10);
  assert.equal(evaluateDql("date(interview).year", brady, brady), 2026);
  assert.equal(evaluateDql("dur(2 days).days", brady, brady), 2);
});

test("DQL executes WHERE, FLATTEN, and GROUP BY in written order", async () => {
  const mount = document.createElement("div");
  await runDqlBlock(`TABLE skill
FROM #recruiter
FLATTEN skills AS skill
WHERE startswith(skill, "s")`, mount, context());
  assert.match(mount.textContent ?? "", /sql/);
  assert.doesNotMatch(mount.textContent ?? "", /typescript|rust/);
});

test("TASK queries render live source-backed checkboxes", async () => {
  const changes: unknown[] = [];
  const mount = document.createElement("div");
  await runDqlBlock("TASK\nFROM #interviewer\nWHERE !completed", mount, context(changes));
  const checkbox = mount.querySelector<HTMLInputElement>("input[type=checkbox]");
  assert.ok(checkbox);
  assert.match(mount.textContent ?? "", /Call Josh/);
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(changes, [[josh.path, 3, true]]);
});

test("CALENDAR queries render dated pages in a month grid", async () => {
  const mount = document.createElement("div");
  await runDqlBlock("CALENDAR interview\nFROM #recruiter", mount, context());
  assert.match(mount.textContent ?? "", /August 2026/);
  assert.equal(mount.querySelectorAll(".dv-calendar-day").length, 31);
});

test("DataviewJS DataArrays support sources, swizzling, grouping, and markdown helpers", async () => {
  const mount = document.createElement("div");
  await runScriptBlock(`
const recruiters = dv.pages("#recruiter").sort(p => p.file.name, "asc");
dv.paragraph(recruiters.file.name.join(", "));
dv.paragraph(recruiters.groupBy(p => p.company).first().rows.length);
dv.paragraph(dv.markdownList(recruiters.file.link));
const csv = await dv.io.csv("people.csv");
dv.paragraph(csv.name.join(", "));
const result = await dv.tryQuery("LIST file.name\\nFROM #interviewer");
dv.paragraph(result.values.join(", "));
await dv.view("views/person", { name: "Naruto" });
dv.paragraph((await app.vault.getMarkdownFiles()).length);
dv.paragraph(app.workspace.getActiveFile().path);
dv.paragraph((await app.metadataCache.getFileCache({ path: "people/Josh Flanders.md" })).company);
`, mount, context());
  assert.match(mount.textContent ?? "", /Brady Gunter, Josh Flanders/);
  assert.match(mount.textContent ?? "", /2/);
  assert.match(mount.textContent ?? "", /Brady Gunter/);
  assert.match(mount.textContent ?? "", /Ada, Grace/);
  assert.match(mount.textContent ?? "", /Josh Flanders/);
  assert.match(mount.textContent ?? "", /Naruto/);
  assert.match(mount.textContent ?? "", /people\/Brady Gunter\.md/);
  assert.match(mount.textContent ?? "", /Acme/);
  assert.equal(mount.querySelector(".dv-error"), null);
});

test("inline DQL uses the same expression runtime", async () => {
  const mount = document.createElement("span");
  await runScriptBlock("= upper(this.file.name)", mount, context(), true);
  assert.equal(mount.textContent, "BRADY GUNTER");
});
