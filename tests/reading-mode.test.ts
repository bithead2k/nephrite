import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  DEFAULT_READING_PREFERENCES,
  ReadingModeController,
  classifyReadingContent,
  contentSpeedMultiplier,
  loadReadingPreferences,
  prosePixelsPerSecond,
  READING_PREFERENCES_KEY,
  READING_WPM_PRESETS,
  saveReadingPreferences,
  stepReadingWpm,
  targetVelocityForBlock,
  type ReadingWindow,
} from "../ui/src/reading-mode";
import type { ViewMode } from "../ui/src/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});

Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  Element: { configurable: true, value: dom.window.Element },
  KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
  localStorage: { configurable: true, value: dom.window.localStorage },
});

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

type Harness = ReturnType<typeof readingHarness>;

function readingHarness(preferences = DEFAULT_READING_PREFERENCES) {
  document.body.replaceChildren();
  document.documentElement.className = "";
  const host = document.createElement("div");
  host.id = "preview-host";
  const root = document.createElement("div");
  root.id = "preview";
  const prose = document.createElement("div");
  prose.className = "md-block";
  prose.innerHTML = `<p>${"word ".repeat(100)}</p>`;
  root.append(prose);
  host.append(root);
  document.body.append(host);
  Object.defineProperties(host, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2_000 },
  });
  Object.defineProperties(prose, {
    offsetHeight: { configurable: true, value: 600 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        top: -host.scrollTop,
        bottom: 600 - host.scrollTop,
        left: 0,
        right: 600,
        width: 600,
        height: 600,
        x: 0,
        y: -host.scrollTop,
        toJSON: () => ({}),
      }),
    },
  });
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 0, bottom: 500, left: 0, right: 600, width: 600, height: 500, x: 0, y: 0, toJSON: () => ({}) }),
  });

  const storage = new MemoryStorage();
  saveReadingPreferences(preferences, storage);
  let viewMode: ViewMode = "split";
  let documentId: string | null = "note.md";
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const windowCalls: string[] = [];
  const readingWindow: ReadingWindow = {
    isFullscreen: async () => false,
    setFullscreen: async (value) => { windowCalls.push(`fullscreen:${value}`); },
    isDecorated: async () => true,
    setDecorations: async (value) => { windowCalls.push(`decorated:${value}`); },
  };
  const controller = new ReadingModeController({
    previewHost: host,
    previewRoot: root,
    storage,
    readingWindow,
    getDocumentId: () => documentId,
    getViewMode: () => viewMode,
    showPreview: () => { viewMode = "preview"; },
    restoreViewMode: (mode) => { viewMode = mode; },
    requestFrame: (callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => { frames.delete(id); },
  });
  const runFrame = (time: number) => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return;
    frames.delete(entry[0]);
    entry[1](time);
  };
  return {
    controller, host, root, prose, storage, frames, runFrame, windowCalls,
    viewMode: () => viewMode,
    documentId: () => documentId,
    setDocumentId: (value: string | null) => { documentId = value; },
  };
}

async function exitHarness(harness: Harness) {
  await harness.controller.exit();
  harness.runFrame(0);
}

test("entering and exiting Reading Mode restores view, location, and window state", async () => {
  const harness = readingHarness();
  harness.host.scrollTop = 240;
  harness.host.scrollLeft = 8;
  assert.equal(await harness.controller.enter(), true);
  assert.equal(harness.controller.isActive, true);
  assert.equal(harness.viewMode(), "preview");
  assert.equal(document.documentElement.classList.contains("reading-mode-active"), true);
  assert.deepEqual(harness.windowCalls, ["decorated:false", "fullscreen:true"]);
  harness.host.scrollTop = 700;
  await exitHarness(harness);
  assert.equal(harness.viewMode(), "split");
  assert.equal(harness.host.scrollTop, 240);
  assert.equal(harness.host.scrollLeft, 8);
  assert.deepEqual(harness.windowCalls.slice(-2), ["fullscreen:false", "decorated:true"]);
});

test("Space pauses and resumes continuous scrolling", async () => {
  const harness = readingHarness();
  await harness.controller.enter();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  assert.equal(harness.controller.isPaused, true);
  const before = harness.host.scrollTop;
  harness.runFrame(100);
  harness.runFrame(200);
  assert.equal(harness.host.scrollTop, before);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  assert.equal(harness.controller.isPaused, false);
  await exitHarness(harness);
});

test("WPM preset stepping is permanent and respects lower and upper bounds", async () => {
  assert.equal(stepReadingWpm(150, 1), 160);
  assert.equal(stepReadingWpm(150, -1), 140);
  assert.equal(stepReadingWpm(READING_WPM_PRESETS[0], -1), 90);
  assert.equal(stepReadingWpm(READING_WPM_PRESETS.at(-1)!, 1), 600);
  const harness = readingHarness();
  await harness.controller.enter();
  assert.equal(harness.controller.stepSpeed(1), 160);
  assert.equal(loadReadingPreferences(harness.storage).wpm, 160);
  await exitHarness(harness);
});

test("prose uses 100%, code uses 70%, and tables use 65% velocity", () => {
  const preferences = { ...DEFAULT_READING_PREFERENCES, wpm: 150 };
  assert.equal(contentSpeedMultiplier("prose", preferences), 1);
  assert.equal(contentSpeedMultiplier("code", preferences), 0.7);
  assert.equal(contentSpeedMultiplier("table", preferences), 0.65);
  assert.equal(prosePixelsPerSecond(600, 150, 150, 1), 10);
  assert.equal(prosePixelsPerSecond(600, 150, 150, 0.7), 7);
  assert.equal(prosePixelsPerSecond(600, 150, 150, 0.65), 6.5);
  const code = document.createElement("div");
  code.innerHTML = "<pre><code>const answer = 42;</code></pre>";
  const table = document.createElement("div");
  table.innerHTML = "<table><tr><td>answer</td></tr></table>";
  assert.equal(classifyReadingContent(code), "code");
  assert.equal(classifyReadingContent(table), "table");
});

test("embedded content inherits surrounding velocity without a special pause", () => {
  const prose = document.createElement("div");
  prose.className = "md-block";
  prose.innerHTML = `<p>${"word ".repeat(30)}</p>`;
  Object.defineProperties(prose, {
    offsetHeight: { configurable: true, value: 120 },
    getBoundingClientRect: { configurable: true, value: () => ({ height: 120 }) },
  });
  const embed = document.createElement("div");
  embed.className = "md-block";
  embed.innerHTML = '<div class="pdf-embed"><canvas></canvas></div>';
  Object.defineProperties(embed, {
    offsetHeight: { configurable: true, value: 800 },
    getBoundingClientRect: { configurable: true, value: () => ({ height: 800 }) },
  });
  assert.equal(classifyReadingContent(embed), "embedded");
  assert.equal(
    targetVelocityForBlock(embed, [prose, embed], DEFAULT_READING_PREFERENCES),
    targetVelocityForBlock(prose, [prose, embed], DEFAULT_READING_PREFERENCES),
  );
});

test("mirror preference flips the complete presentation root", async () => {
  const harness = readingHarness({ ...DEFAULT_READING_PREFERENCES, mirror: true });
  await harness.controller.enter();
  assert.equal(harness.host.classList.contains("reading-mode-mirror"), true);
  assert.ok(harness.host.querySelector(".reading-mode-overlay"));
  await exitHarness(harness);
  assert.equal(harness.host.classList.contains("reading-mode-mirror"), false);
});

test("Reading Mode consumes normal editor input and becomes read-only", async () => {
  const harness = readingHarness();
  await harness.controller.enter();
  let reachedNormalCommands = false;
  document.addEventListener("keydown", () => { reachedNormalCommands = true; }, { once: true });
  const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(reachedNormalCommands, false);
  await exitHarness(harness);
});

test("exit cancels animation, timers, listeners, classes, and overlay", async () => {
  const harness = readingHarness();
  await harness.controller.enter();
  assert.ok(harness.frames.size > 0);
  await exitHarness(harness);
  assert.equal(harness.frames.size, 0);
  assert.equal(document.querySelector(".reading-mode-overlay"), null);
  assert.equal(document.documentElement.classList.contains("reading-mode-active"), false);
  const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});

test("an unexpected document change exits safely", async () => {
  const harness = readingHarness();
  await harness.controller.enter();
  harness.setDocumentId("other.md");
  harness.runFrame(16);
  await Promise.resolve();
  assert.equal(harness.controller.isActive, false);
});

test("malformed preferences fall back and normalized preferences persist", () => {
  const storage = new MemoryStorage();
  storage.setItem(READING_PREFERENCES_KEY, "not json");
  assert.deepEqual(loadReadingPreferences(storage), DEFAULT_READING_PREFERENCES);
  const saved = saveReadingPreferences({
    wpm: 149,
    codeMultiplier: 5,
    tableMultiplier: 0,
    mirror: true,
    chromeFree: false,
  }, storage);
  assert.deepEqual(saved, {
    wpm: 150,
    codeMultiplier: 1,
    tableMultiplier: 0.1,
    mirror: true,
    chromeFree: false,
  });
});
