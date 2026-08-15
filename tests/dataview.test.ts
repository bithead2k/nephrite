import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
import { splitFrontmatter } from "../ui/src/frontmatter";
import { rowToDvPage } from "../ui/src/dv-context";

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

test("inline date arithmetic with a page date field computes days", async () => {
  const datedPage = {
    ...brady,
    date: new Date(1968, 10, 14),
  };
  const datedContext = { ...context(), loadPage: async () => datedPage };
  const mount = document.createElement("div");
  await runScriptBlock(
    `= dur(date("1968-11-14") + dur(80 years) - this.date).days`,
    mount,
    datedContext,
    true,
  );
  assert.match(mount.textContent ?? "", /^29200$/);
  assert.doesNotMatch(mount.textContent ?? "", /\.\d|error/i);
});

test("DQL function names are not shadowed by page fields", () => {
  const datedPage = {
    ...brady,
    date: { value: "1968-11-14", valueType: "date", valueText: "1968-11-14" },
  };
  assert.equal(evaluateDql('date("1968-11-14").year', datedPage, datedPage), 1968);
  assert.equal(evaluateDql("date(interview).year", datedPage, datedPage), 2026);
  assert.equal(evaluateDql("date.born", datedPage, datedPage), undefined);
  assert.equal(evaluateDql('default(date, "fallback")', datedPage, datedPage).value, "1968-11-14");
  assert.equal(evaluateDql('number("42")', datedPage, datedPage), 42);
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

function localDayKey(date: Date, sep = "_"): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join(sep);
}

test("dv.date understands today/yesterday and Luxon toFormat", async () => {
  const mount = document.createElement("div");
  await runScriptBlock(`
const today = dv.date("today");
dv.paragraph(today.toFormat("yyyy_MM_dd"));
const start = today.minus({ days: 6 });
const named = dv.date("${localDayKey(new Date(), "-")}");
dv.paragraph(String(named >= start && named <= today));
dv.paragraph(dv.date("yesterday").toFormat("yyyy-MM-dd"));
`, mount, context());
  assert.equal(mount.querySelector(".dv-error"), null);
  assert.match(mount.textContent ?? "", new RegExp(localDayKey(new Date())));
  assert.match(mount.textContent ?? "", /true/);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  assert.match(mount.textContent ?? "", new RegExp(localDayKey(yesterday, "-")));
});

test("Tracker - Water DataviewJS journal queries render without errors", async () => {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const todayPage = page(`journals/${localDayKey(today)}.md`, ["#journal"], {
    water_tumblers: 2,
    water_oz: 64,
    water_goal_oz: 128,
    water_goal_met: false,
  });
  const yesterdayPage = page(`journals/${localDayKey(yesterday)}.md`, ["#journal"], {
    water_tumblers: 4,
    water_oz: 128,
    water_goal_oz: 128,
    water_goal_met: true,
  });
  const pagesForQuery = [todayPage, yesterdayPage, brady];
  const ctx: EngineContext = {
    ...context(),
    currentPath: "reference/Tracker - Water.md",
    loadPages: async () => pagesForQuery,
    loadPage: async (path) => pagesForQuery.find((value) => value.path === path) ?? null,
  };

  const todayBlock = `const today = dv.date("today");
const want = today.toFormat("yyyy_MM_dd");
const pages = dv.pages('"journals"').array().filter((p) => {
  const name = p.file.name.replace(/\\.md$/, "");
  return name === want;
});
if (!pages.length) {
  dv.paragraph("_No journal for today (or index not refreshed yet)._");
} else {
  const rows = pages.map((p) => {
    const t = Number(p.water_tumblers) || 0;
    const o = Number(p.water_oz) || 0;
    const g = Number(p.water_goal_oz) || 128;
    const met = p.water_goal_met === true || o >= g;
    const status = met ? "✅" : t > 0 ? o : "❌";
    return [p.file.link, t, o, g, status];
  });
  dv.table(["date", "tumblers", "oz", "goal", "status"], rows);
}`;

  const weekBlock = `const end = dv.date("today");
const start = end.minus({ days: 6 });
const pages = dv.pages('"journals"').array().filter((p) => {
  const name = p.file.name.replace(/\\.md$/, "");
  const m = name.match(/^(\\d{4})_(\\d{2})_(\\d{2})$/);
  if (!m) return false;
  const d = dv.date(\`\${m[1]}-\${m[2]}-\${m[3]}\`);
  return d && d >= start && d <= end;
});
pages.sort((a, b) => b.file.name.localeCompare(a.file.name));
dv.table(["date", "tumblers", "oz", "status"], pages.map((p) => [p.file.link, p.water_tumblers, p.water_oz, p.water_goal_met ? "✅" : p.water_oz]));
dv.paragraph("**7-day total:**");`;

  for (const code of [todayBlock, weekBlock]) {
    const mount = document.createElement("div");
    await runScriptBlock(code, mount, ctx);
    assert.equal(mount.querySelector(".dv-error"), null, mount.textContent);
    assert.match(mount.textContent ?? "", /64/);
    assert.match(mount.textContent ?? "", /journals\/\d{4}_\d{2}_\d{2}/);
  }
});

test("inline DQL uses the same expression runtime", async () => {
  const mount = document.createElement("span");
  await runScriptBlock("= upper(this.file.name)", mount, context(), true);
  assert.equal(mount.textContent, "BRADY GUNTER");
});

test("DataviewJS pagesFromTags, pagesFromPath, and pagesFromLinks filter the same snapshot", async () => {
  const mount = document.createElement("div");
  await runScriptBlock(`
dv.paragraph(dv.pagesFromTags(["#recruiter"]).file.name.join(", "));
dv.paragraph(dv.pagesFromTags("#interviewer").file.name.join(", "));
dv.paragraph(dv.pagesFromPath("projects").file.name.join(", "));
dv.paragraph(dv.pagesFromLinks("[[Brady Gunter]]").file.name.join(", "));
dv.paragraph(dv.pagesFromLinks("Brady Gunter").file.name.join(", "));
`, mount, context());
  assert.match(mount.textContent ?? "", /Brady Gunter, Josh Flanders/);
  assert.match(mount.textContent ?? "", /Josh Flanders/);
  assert.match(mount.textContent ?? "", /Nephrite/);
  assert.equal(mount.querySelector(".dv-error"), null);
});

test("DataviewJS shadows host globals instead of exposing the WebView", async () => {
  const mount = document.createElement("div");
  await runScriptBlock(
    `dv.paragraph(typeof window);
dv.paragraph(typeof document);
dv.paragraph(typeof fetch);`,
    mount,
    context(),
  );
  assert.equal(mount.querySelector(".dv-error"), null);
  assert.match(mount.textContent ?? "", /undefined/);
  assert.doesNotMatch(mount.textContent ?? "", /\bobject\b|\bfunction\b/);
});

test("DataviewJS duration and DataArray.mutate work", async () => {
  const mount = document.createElement("div");
  await runScriptBlock(`
dv.paragraph(dv.duration("3 days").days);
const rows = dv.pages("#recruiter");
rows.mutate(p => ({ seen: true }));
dv.paragraph(rows.length);
dv.paragraph(rows.first().seen);
`, mount, context());
  assert.match(mount.textContent ?? "", /3/);
  assert.match(mount.textContent ?? "", /2/);
  assert.match(mount.textContent ?? "", /true/);
  assert.equal(mount.querySelector(".dv-error"), null);
});

/* ------------------------------------------------------------------ */
/* Vault-driven Obsidian compatibility                                */
/*                                                                     */
/* These read actual pages from the user's Obsidian vault (no          */
/* fixtures, no synthetic notes), route them through the real          */
/* index→page path (rowToDvPage), and assert Nephrite reproduces       */
/* Obsidian's verified values. Point NEPHRITE_TEST_VAULT at any        */
/* vault; the default is the live vault used for development.          */
/* ------------------------------------------------------------------ */

const VAULT_ROOT = process.env.NEPHRITE_TEST_VAULT ?? "/home/kroybal/Documents/notes";

function frontmatterProps(yaml: string | null): Record<string, string> {
  const props: Record<string, string> = {};
  if (!yaml) return props;
  for (const line of yaml.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_./-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    props[match[1].trim()] = match[2].trim();
  }
  return props;
}

function vaultRow(relativePath: string): { row: unknown; body: string } {
  const source = fs.readFileSync(path.join(VAULT_ROOT, relativePath), "utf8");
  const { yaml, body } = splitFrontmatter(source);
  const properties = frontmatterProps(yaml);
  const parts = relativePath.split("/");
  const name = (parts.pop() ?? "").replace(/\.md$/, "");
  return {
    row: {
      path: relativePath,
      name,
      folder: parts.join("/"),
      mtime_ms: 0,
      properties,
      inline_fields: [],
    },
    body,
  };
}

function inlineExpressions(body: string): string[] {
  const expressions: string[] = [];
  const re = /`=([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) expressions.push(match[1].trim());
  return expressions;
}

test("today's vault journal note reproduces Obsidian Dataview results", async () => {
  const { row, body } = vaultRow("journals/2026_08_14.md");
  const page = rowToDvPage(row as never);
  const ctx = { ...context(), currentPath: page.path, loadPage: async () => page };

  const rendered: Record<string, string> = {};
  for (const expression of inlineExpressions(body)) {
    const mount = document.createElement("div");
    await runScriptBlock(`= ${expression}`, mount, ctx, true);
    rendered[expression] = mount.textContent ?? "";
  }

  const eightyYears = Object.keys(rendered).find((expression) => expression.includes("80 years"));
  assert.ok(eightyYears, "vault page must contain the `dur(80 years)` inline expression");
  // Obsidian: 1968-11-14 + 80y = 2048-11-14; minus 2026-08-14 = 22y 3m;
  // dur(...).days = 22*365 + 3*30 = 8120 (a whole number, no fractional time).
  assert.equal(rendered[eightyYears], "8120");

  const titleLine = Object.keys(rendered).find((expression) => expression.includes("this.title"));
  assert.ok(titleLine, "vault page must contain the title/date inline expression");
  assert.match(rendered[titleLine], /Personal Journal for 2026-08-14/);
  assert.doesNotMatch(rendered[titleLine], /NaN/i);

  // Obsidian `DDDD` renders the long date format, not the literal token.
  assert.equal(evaluateDql('dateformat(date("2026-08-14"), "DDDD")', page, page), "Friday, August 14, 2026");
});
