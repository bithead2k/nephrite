import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  bindDqlFieldIdentifiers,
  dqlContains,
  evaluateDql,
  filterPagesBySource,
  parseDql,
  runDqlBlock,
  runScriptBlock,
  runTasksBlock,
  executeBlocksInPreview,
  type DvPage,
  type EngineContext,
} from "../ui/src/dv-engine";
import { splitFrontmatter } from "../ui/src/frontmatter";
import { rowToDvPage, makeEngineContext, resetEnginePageCache, refreshEnginePageCache } from "../ui/src/dv-context";

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

test("Tasks fences filter sort group and preserve source-backed task controls", async () => {
  const mount = document.createElement("div");
  const taskPage = page("Projects/Launch.md", ["#project"]);
  taskPage.file.tasks = [
    { path: taskPage.path, task_id: 1, text: "Ship release", completed: false, due: "2026-08-20", priority: "high", tags: ["release"] },
    { path: taskPage.path, task_id: 2, text: "Old work", completed: true, due: "2026-08-01", priority: "low", tags: [] },
  ];
  await runTasksBlock("not done\ntag includes #release\nsort by due\ngroup by file\nlimit to 5 tasks", mount, {
    ...context(), loadPages: async () => [taskPage],
  });
  assert.match(mount.textContent ?? "", /Ship release/);
  assert.doesNotMatch(mount.textContent ?? "", /Old work/);
  const checkbox = mount.querySelector<HTMLInputElement>("input[data-task-id='1']");
  assert.equal(checkbox?.dataset.taskPath, "Projects/Launch.md");
});

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

test("contains matches file.tags with or without a leading hash", () => {
  const journal = page("journals/2026_08_15.md", ["#📝journal"]);
  assert.equal(dqlContains(journal.file.tags, "📝journal"), true);
  assert.equal(dqlContains(journal.file.tags, "#📝journal"), true);
  assert.equal(evaluateDql('contains(file.tags, "📝journal")', journal, journal), true);
  assert.equal(evaluateDql('contains(file.path, "2022")', journal, journal), false);
  assert.equal(evaluateDql('contains(file, "tags")', journal, journal), true);
});

test("habit daily DQL returns journals filtered by the journal tag", async () => {
  const journal = page("journals/2026_08_15.md", ["#📝journal"], {
    Bible_Study: false,
    Exercise: false,
  });
  const old = page("journals/2022_01_01.md", ["#📝journal"]);
  const mount = document.createElement("div");
  await runDqlBlock(
    `TABLE WITHOUT ID file.name AS date
FROM "journals"
WHERE !contains(file.path,"2022")
AND contains(file.tags,"📝journal")
SORT file.name DESC
LIMIT 1`,
    mount,
    {
      ...context(),
      loadPages: async () => [...pages, journal, old],
    },
  );
  assert.match(mount.textContent ?? "", /2026_08_15/);
  assert.doesNotMatch(mount.textContent ?? "", /2022_01_01|Brady/);
});

test("DQL functions cover collection, string, date, and duration operations", () => {
  assert.equal(evaluateDql("length(skills)", brady, brady), 2);
  assert.equal(evaluateDql('icontains(company, "ACME")', brady, brady), true);
  assert.equal(evaluateDql("sum(list(2, 3, 5))", brady, brady), 10);
  assert.equal(evaluateDql("date(interview).year", brady, brady), 2026);
  assert.equal(evaluateDql("dur(2 days).days", brady, brady), 2);
});

test("missing YAML fields are null, not a query error", () => {
  const untitled = page("meetings/2026_08_01 Standup.md", []);
  const molina = page("meetings/2026_08_10 Molina.md", [], { company: "Molina Healthcare" });
  const infosys = page("meetings/2026_08_11 Infosys.md", [], { company: "Infosys" });
  assert.equal(
    bindDqlFieldIdentifiers('helpers.string(company)'),
    'helpers.string(row["company"])',
  );
  assert.equal(evaluateDql("string(company)", untitled, untitled), "");
  assert.equal(evaluateDql("string(phone)", untitled, untitled), "");
  assert.equal(evaluateDql('contains(string(company), "Molina")', untitled, untitled), false);
  assert.equal(evaluateDql('contains(string(company), "Molina")', molina, molina), true);
  assert.equal(evaluateDql('icontains(company, "acme")', untitled, untitled), false);
  assert.equal(evaluateDql('default(phone, "none")', untitled, untitled), "none");
  assert.equal(evaluateDql("company.name", untitled, untitled), undefined);
});

test("LIST WHERE string(field) skips pages that lack the field", async () => {
  const untitled = page("meetings/2026_08_01 Standup.md", []);
  const molina = page("meetings/2026_08_10 Molina.md", [], { company: "Molina Healthcare" });
  const infosys = page("meetings/2026_08_11 Infosys.md", [], { company: "Infosys" });
  const stray = page("people/No Company.md", []);
  const mount = document.createElement("div");
  await runDqlBlock(
    `LIST
FROM "meetings"
WHERE contains(string(company), "Molina") OR contains(string(company), "Infosys")
SORT file.name DESC`,
    mount,
    {
      ...context(),
      loadPages: async () => [untitled, molina, infosys, stray, ...pages],
    },
  );
  const text = mount.textContent ?? "";
  assert.doesNotMatch(text, /error/i);
  assert.match(text, /Infosys/);
  assert.match(text, /Molina/);
  assert.doesNotMatch(text, /Standup|No Company|Brady/);
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
  const { row, body } = vaultRow("journals/2026/08_14.md");
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


test("metadata refresh reruns INFO inline queries and preserves neighboring ANSI text", async () => {
  const { renderPreview } = await import("../ui/src/preview");
  const { splitMarkdownBlocks } = await import("../ui/src/preview-blocks");
  const { refreshPreviewDynamics } = await import("../ui/src/preview-dynamics");
  const { highlightPreviewCode } = await import("../ui/src/syntax-highlight");
  const body = '> [!info]\n> `= this.company`\n\n```dataviewjs\ndv.paragraph(dv.current().company)\n```\n\n```text\n\x1b[33m│ ↑ 8 mph │\x1b[0m\n```\n';
  const root = document.createElement("div");
  root.innerHTML = renderPreview(body);
  document.body.append(root);
  const ctx = (company: string): EngineContext => ({ ...context(),
    loadPages: async () => [page(brady.path, [], { company })],
    loadPage: async () => page(brady.path, [], { company }),
  });
  await executeBlocksInPreview(body, root, ctx("Before"));
  highlightPreviewCode(root);
  assert.match(root.querySelector(".callout")!.textContent!, /Before/);
  const weather = root.querySelector("code.language-text")!;
  const weatherHtml = weather.innerHTML;
  await refreshPreviewDynamics(splitMarkdownBlocks(body), root, ctx("After"), () => true,
    async html => html.replace('class="md-block"', 'class="md-block processed"'));
  assert.match(root.querySelector(".callout")!.textContent!, /After/);
  assert.doesNotMatch(root.textContent!, /Before|error:/);
  assert.match(root.querySelector(".dv-block")!.textContent!, /After/);
  assert.equal(root.querySelector("code.language-text"), weather);
  assert.equal(weather.innerHTML, weatherHtml);
  assert.equal(weather.textContent, "│ ↑ 8 mph │\n");
  root.remove();
});


test("preview contexts share metadata and apply changed-page deltas without losing other pages", async () => {
  const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
  const row = (path: string, value: number) => ({ path, name: path, folder: "", mtime_ms: 0, properties: { value }, links: [] });
  let rows = [row("a.md", 1), row("b.md", 2)];
  const requests: Array<string[] | undefined> = [];
  mockIPC((command, payload: any) => {
    assert.equal(command, "list_pages");
    requests.push(payload.paths);
    return payload.paths ? rows.filter(r => payload.paths.includes(r.path)) : rows;
  });
  try {
    resetEnginePageCache();
    const first = makeEngineContext("a.md", "", () => {});
    const second = makeEngineContext("b.md", "", () => {});
    await Promise.all([first.loadPages(), second.loadPages()]);
    assert.equal(requests.length, 1, "switching contexts must share the initial vault fetch");
    rows = [row("a.md", 3), row("b.md", 2)];
    refreshEnginePageCache(["a.md"]);
    let pages = await second.loadPages();
    assert.deepEqual(requests[1], ["a.md"]);
    assert.equal(pages.find(p => p.path === "a.md")?.value, 3);
    assert.equal(pages.find(p => p.path === "b.md")?.value, 2);
    rows = [row("b.md", 2)];
    refreshEnginePageCache(["a.md"]);
    pages = await first.loadPages();
    assert.deepEqual(pages.map(p => p.path), ["b.md"]);
    resetEnginePageCache();
    rows = [row("other-vault.md", 4)];
    pages = await makeEngineContext("other-vault.md", "", () => {}).loadPages();
    assert.deepEqual(pages.map(p => p.path), ["other-vault.md"]);
    assert.equal(requests.filter(paths => paths === undefined).length, 2);
  } finally {
    resetEnginePageCache();
    clearMocks();
  }
});


test("large query preparation yields to pending user-input work", async () => {
  const mount = document.createElement("div");
  const many = Array.from({ length: 1024 }, (_, i) => page(`people/Person ${i}.md`, []));
  let inputHandled = false;
  const timer = setTimeout(() => { inputHandled = true; }, 0);
  await runDqlBlock('LIST\nFROM "people"\nLIMIT 1', mount, { ...context(), loadPages: async () => many });
  assert.equal(inputHandled, true, "query preparation must allow pending input to run");
  clearTimeout(timer);
  assert.match(mount.textContent ?? "", /Person 0/);
});


test("page deltas maintain backlinks across edits, deletion, duplicate names, and re-creation", async () => {
  const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
  const row = (path: string, links: string[] = []) => ({ path, name: path.split("/").pop()!, folder: "", mtime_ms: 0, properties: {}, links: links.map(target => ({ target })) });
  let rows = [row("a.md", ["Target", "Target", "folder/Target.md"]), row("folder/Target.md"), row("other/Target.md"), row("untouched.md")];
  mockIPC((_command, payload: any) => payload.paths ? rows.filter(r => payload.paths.includes(r.path)) : rows);
  try {
    resetEnginePageCache();
    const ctx = makeEngineContext("a.md", "", () => {});
    let pages = await ctx.loadPages();
    const target = (path: string) => pages.find(page => page.path === path)!;
    assert.deepEqual(target("folder/Target.md").file.inlinks, ["a"]);
    assert.deepEqual(target("other/Target.md").file.inlinks, ["a"]);
    const untouched = target("untouched.md");
    Object.defineProperty(untouched.file, "outlinks", { get() { throw new Error("unrelated page links were rescanned"); } });
    const originalInlinks = untouched.file.inlinks;
    rows[0] = row("a.md", ["folder/Target"]);
    refreshEnginePageCache(["a.md"]);
    pages = await ctx.loadPages();
    assert.deepEqual(target("other/Target.md").file.inlinks, []);
    assert.deepEqual(target("folder/Target.md").file.inlinks, ["a"]);
    assert.equal(target("untouched.md").file.inlinks, originalInlinks);
    rows = rows.filter(r => r.path !== "folder/Target.md");
    refreshEnginePageCache(["folder/Target.md"]);
    await ctx.loadPages();
    rows.push(row("folder/Target.md"));
    refreshEnginePageCache(["folder/Target.md"]);
    pages = await ctx.loadPages();
    assert.deepEqual(target("folder/Target.md").file.inlinks, ["a"]);
    rows = rows.filter(r => r.path !== "a.md");
    refreshEnginePageCache(["a.md"]);
    pages = await ctx.loadPages();
    assert.deepEqual(target("folder/Target.md").file.inlinks, []);
  } finally { resetEnginePageCache(); clearMocks(); }
});

test("initial metadata preparation services pending input before completing", async () => {
  const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
  mockIPC(() => Array.from({ length: 2048 }, (_, i) => ({ path: `${i}.md`, name: `${i}`, folder: "", mtime_ms: 0, properties: {}, links: [] })));
  let inputHandled = false;
  const timer = setTimeout(() => { inputHandled = true; }, 0);
  try {
    resetEnginePageCache();
    const pages = await makeEngineContext("0.md", "", () => {}).loadPages();
    assert.equal(pages.length, 2048);
    assert.equal(inputHandled, true);
  } finally { clearTimeout(timer); resetEnginePageCache(); clearMocks(); }
});


test("scoped scripts do not prepare unrelated page properties", async () => {
  const person = page("people/Test.md", [], { birthday: new Date(2000, 10, 4) });
  const unrelated = page("elsewhere/Other.md", []);
  Object.defineProperty(unrelated, "expensive", {enumerable: true, get() { throw new Error("unrelated page was prepared"); }});
  const mount = document.createElement("div");
  await runScriptBlock('dv.paragraph(dv.pages(\'"people"\')[0].birthday.month)', mount,
    {...context(), loadPages: async () => [person, unrelated]});
  assert.equal(mount.textContent, "11");
});


test("birthday planner preserves boolean semantics and rejects mixed fields", async () => {
  const {planBirthday, planBirthdayScript} = await import("../ui/src/birthday-plan");
  assert.deepEqual(planBirthday(["dob.month = 2 and dob.day = 29"], {}), {month:2, day:29});
  for (const expression of ["dob.month = 2 or dob.day = 29", "dob.month = 2 and birthday.day = 29", "dob.month = 13 and dob.day = 1", "!dob.month = 2 and dob.day = 29"]) assert.equal(planBirthday([expression], {}), null);
  const code = `const thisone = dv.current();
const notes = dv.pages('"people"').filter(page => page.birthday).filter(page => page.birthday.month == thisone.date.month && page.birthday.day == thisone.date.day);
if (notes.length) dv.paragraph("**Birthdays**");
if (notes.length) dv.list(notes.file.link);`;
  assert.deepEqual(planBirthdayScript(code, {date:{month:11,day:4}}), {month:11,day:4});
  assert.equal(planBirthdayScript(code + '\ndv.list(dv.pages().file.link);', {date:{month:11,day:4}}), null);
});

test("birthday DQL uses candidates then rejects false positives", async () => {
  const yes = page("people/Match.md", [], {birthday:new Date(2000,1,29)});
  const no = page("people/NotToday.md", [], {birthday:new Date(2000,2,1)});
  const mount = document.createElement("div");
  let lookup = false;
  await runDqlBlock('LIST\nFROM "people"\nWHERE birthday.month = 2 and birthday.day = 29', mount, {
    ...context(), loadPages:async()=>{throw new Error("full scan");},
    birthdayCandidates:async(month,day)=>{assert.deepEqual([month,day],[2,29]);lookup=true;return [yes.path,no.path];},
    loadPagesByPaths:async()=>[yes,no],
  });
  assert.equal(lookup,true);
  assert.match(mount.textContent!, /Match/);
  assert.doesNotMatch(mount.textContent!, /NotToday|error/i);
});


test("birthday script uses indexed candidates with unchanged results", async () => {
  const mount = document.createElement("div");
  const person = page("people/Birthday Match.md", [], {birthday:new Date(2000,10,4)});
  const wrong = page("people/Wrong Day.md", [], {birthday:new Date(2000,10,5)});
  let used = false;
  await runScriptBlock(`const thisone = dv.current();
const notes = dv.pages('"people"').filter(page => page.birthday).filter(page => page.birthday.month == thisone.date.month && page.birthday.day == thisone.date.day);
if (notes.length) dv.list(notes.file.link);`, mount, {
    ...context(), currentSource: "---\ndate: 2026-11-04\n---\n",
    loadPage:async()=>page("journal.md", [], {date:new Date(2026,10,4)}),
    loadPages:async()=>{throw new Error("full scan");},
    birthdayCandidates:async(month,day)=>{assert.deepEqual([month,day],[11,4]);used=true;return [person.path,wrong.path];},
    loadPagesByPaths:async()=>[person,wrong],
  });
  assert.equal(used,true);
  assert.match(mount.textContent!, /Birthday Match/);
  assert.doesNotMatch(mount.textContent!, /Wrong Day|error/i);
});
