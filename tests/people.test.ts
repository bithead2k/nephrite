import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  buildAttendanceList,
  collectPeople,
  distinctCompanies,
  distinctTags,
  filterPeople,
  personFromRow,
  renderAttendancePanel,
  sortPeople,
} from "../ui/src/people";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLOptionElement: { configurable: true, value: dom.window.HTMLOptionElement },
});

function row(path: string, extra: Record<string, unknown> = {}) {
  return {
    path,
    name: path.replace(/^.*\//, ""),
    folder: path.includes("/") ? path.replace(/\/[^/]+$/, "") : "",
    size_bytes: 12,
    tags: extra.tags ?? [],
    links: [],
    properties: (extra.properties as Record<string, unknown> | undefined) ?? {},
  };
}

test("collectPeople keeps only notes under the /people folder", () => {
  const people = collectPeople([
    row("people/Ada.md", { properties: { first_name: "Ada", last_name: "Lovelace" } }),
    row("people/interns/Jane.md", { properties: { name: "Jane Doe" } }),
    row("archive/people/Old.md", { properties: { name: "Old" } }),
    row("notes/Ada.md", { properties: { first_name: "Ada" } }),
  ]);
  assert.deepEqual(
    people.map((person) => person.path),
    ["people/Ada.md", "people/interns/Jane.md"],
  );
});

test("personFromRow reads names, company, and tags", () => {
  const person = personFromRow(row("people/Ada.md", {
    tags: ["#people", "#recruiter"],
    properties: {
      first_name: "Ada",
      last_name: "Lovelace",
      company: "Analytical Engines",
    },
  }));
  assert.equal(person?.displayName, "Ada Lovelace");
  assert.equal(person?.firstName, "Ada");
  assert.equal(person?.lastName, "Lovelace");
  assert.equal(person?.company, "Analytical Engines");
  assert.deepEqual(person?.tags, ["people", "recruiter"]);
});

test("personFromRow falls back to name then filename", () => {
  const byName = personFromRow(row("people/Ada.md", { properties: { name: "Ada L." } }));
  assert.equal(byName?.displayName, "Ada L.");
  const byFile = personFromRow(row("people/Kirk.md", { properties: { company: "Acme" } }));
  assert.equal(byFile?.displayName, "Kirk");
});

test("sortPeople orders by last name then first name", () => {
  const people = [
    personFromRow(row("people/a.md", { properties: { first_name: "Zoe", last_name: "Smith" } })),
    personFromRow(row("people/b.md", { properties: { first_name: "Ada", last_name: "Lovelace" } })),
    personFromRow(row("people/c.md", { properties: { first_name: "Bob", last_name: "Smith" } })),
  ].filter((person): person is NonNullable<typeof person> => person != null);
  assert.deepEqual(
    sortPeople(people).map((person) => person.displayName),
    ["Ada Lovelace", "Bob Smith", "Zoe Smith"],
  );
});

test("sortPeople falls back to display name for people without first/last names", () => {
  const people = [
    personFromRow(row("people/a.md", { properties: { name: "Kirk Roybal" } })),
    personFromRow(row("people/b.md", { properties: { name: "Ada Lovelace" } })),
  ].filter((person): person is NonNullable<typeof person> => person != null);
  assert.deepEqual(
    sortPeople(people).map((person) => person.displayName),
    ["Ada Lovelace", "Kirk Roybal"],
  );
});

test("filterPeople matches company and/or tag", () => {
  const people = [
    personFromRow(row("people/a.md", { tags: ["recruiter"], properties: { first_name: "A", last_name: "Acme", company: "Acme" } })),
    personFromRow(row("people/b.md", { tags: ["client"], properties: { first_name: "B", last_name: "Beta", company: "Acme" } })),
    personFromRow(row("people/c.md", { tags: ["recruiter"], properties: { first_name: "C", last_name: "Gamma", company: "Zed" } })),
  ].filter((person): person is NonNullable<typeof person> => person != null);
  assert.deepEqual(filterPeople(people, { company: "Acme" }).map((person) => person.lastName), ["Acme", "Beta"]);
  assert.deepEqual(filterPeople(people, { tag: "recruiter" }).map((person) => person.lastName), ["Acme", "Gamma"]);
  assert.deepEqual(filterPeople(people, { company: "Acme", tag: "recruiter" }).map((person) => person.lastName), ["Acme"]);
});

test("buildAttendanceList renders heading and sorted task list", () => {
  const people = [
    personFromRow(row("people/a.md", { properties: { first_name: "Ada", last_name: "Lovelace" } })),
    personFromRow(row("people/b.md", { properties: { first_name: "Kirk", last_name: "Roybal" } })),
  ].filter((person): person is NonNullable<typeof person> => person != null);
  assert.equal(
    buildAttendanceList(people),
    "## Attendance\n\n- [ ] [[Ada Lovelace]]\n- [ ] [[Kirk Roybal]]\n",
  );
});

test("buildAttendanceList is empty for no people", () => {
  assert.equal(buildAttendanceList([]), "");
});

test("distinctCompanies and distinctTags dedupe and sort", () => {
  const people = [
    personFromRow(row("people/a.md", { tags: ["recruiter", "people"], properties: { company: "Zed" } })),
    personFromRow(row("people/b.md", { tags: ["recruiter"], properties: { company: "Acme" } })),
  ].filter((person): person is NonNullable<typeof person> => person != null);
  assert.deepEqual(distinctCompanies(people), ["Acme", "Zed"]);
  assert.deepEqual(distinctTags(people), ["people", "recruiter"]);
});

test("renderAttendancePanel filters and calls onInsert with the built text", () => {
  const people = [
    personFromRow(row("people/a.md", { tags: ["recruiter"], properties: { first_name: "Ada", last_name: "Lovelace", company: "Acme" } })),
    personFromRow(row("people/b.md", { tags: ["recruiter"], properties: { first_name: "Kirk", last_name: "Roybal", company: "Zed" } })),
    personFromRow(row("people/c.md", { tags: ["client"], properties: { first_name: "Zoe", last_name: "Smith", company: "Acme" } })),
  ].filter((person): person is NonNullable<typeof person> => person != null);

  let inserted = "";
  const host = document.createElement("div");
  renderAttendancePanel(host, {
    people,
    onInsert: (text) => { inserted = text; },
  });

  const company = host.querySelector<HTMLSelectElement>("select[title='Company']")!;
  const tag = host.querySelector<HTMLSelectElement>("select[title='Tag']")!;
  assert.deepEqual([...company.options].slice(1).map((option) => option.value), ["Acme", "Zed"]);
  assert.deepEqual([...tag.options].slice(1).map((option) => option.value), ["client", "recruiter"]);

  company.value = "Acme";
  company.dispatchEvent(new dom.window.Event("change"));
  assert.match(host.querySelector<HTMLPreElement>(".attendance-preview")!.textContent ?? "", /Ada Lovelace/);
  assert.match(host.querySelector<HTMLPreElement>(".attendance-preview")!.textContent ?? "", /Zoe Smith/);
  assert.doesNotMatch(host.querySelector<HTMLPreElement>(".attendance-preview")!.textContent ?? "", /Kirk Roybal/);

  tag.value = "recruiter";
  tag.dispatchEvent(new dom.window.Event("change"));
  assert.match(host.querySelector<HTMLPreElement>(".attendance-preview")!.textContent ?? "", /Ada Lovelace/);
  assert.doesNotMatch(host.querySelector<HTMLPreElement>(".attendance-preview")!.textContent ?? "", /Zoe Smith/);

  const insert = host.querySelector<HTMLButtonElement>(".attendance-footer button")!;
  assert.equal(insert.disabled, false);
  insert.click();
  assert.ok(inserted.includes("Ada Lovelace"), "insert callback should receive the built list");
});