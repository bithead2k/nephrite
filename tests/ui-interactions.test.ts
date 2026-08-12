import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderCommandBar, type AppCommand } from "../ui/src/command-bar";
import {
  showContextMenu,
  type CtxAction,
  type CtxTarget,
} from "../ui/src/context-menu";

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
  KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
  MouseEvent: { configurable: true, value: dom.window.MouseEvent },
  requestAnimationFrame: {
    configurable: true,
    value: (callback: FrameRequestCallback) => callback(0),
  },
});

dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.alert = () => {};

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
  assert.deepEqual(labels.slice(0, 4), [
    "Close tab",
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
