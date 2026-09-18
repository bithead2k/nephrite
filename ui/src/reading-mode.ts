import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ViewMode } from "./types";

export const READING_WPM_PRESETS = [
  90, 105, 120, 130, 140, 150, 160, 170, 180, 200, 225,
  250, 275, 300, 325, 350, 375, 400, 450, 500, 600,
] as const;

export const READING_PREFERENCES_KEY = "nephrite.readingMode.v1";
export const READING_PLANE_RATIO = 0.4;

export type ReadingPreferences = {
  wpm: number;
  codeMultiplier: number;
  tableMultiplier: number;
  mirror: boolean;
  chromeFree: boolean;
};

export const DEFAULT_READING_PREFERENCES: ReadingPreferences = {
  wpm: 150,
  codeMultiplier: 0.7,
  tableMultiplier: 0.65,
  mirror: false,
  chromeFree: true,
};

export type ReadingContentType = "prose" | "code" | "table" | "embedded";

export type ReadingWindow = {
  isFullscreen(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  isDecorated(): Promise<boolean>;
  setDecorations(value: boolean): Promise<void>;
};

type ReadingModeOptions = {
  previewHost: HTMLElement;
  previewRoot: HTMLElement;
  presentationRoot?: HTMLElement;
  documentElement?: HTMLElement;
  storage?: Pick<Storage, "getItem" | "setItem">;
  readingWindow?: ReadingWindow;
  getDocumentId: () => string | null;
  getViewMode: () => ViewMode;
  showPreview: () => void;
  restoreViewMode: (mode: ViewMode) => void;
  requestFrame?: typeof requestAnimationFrame;
  cancelFrame?: typeof cancelAnimationFrame;
};

type ReadingSession = {
  documentId: string;
  viewMode: ViewMode;
  scrollTop: number;
  scrollLeft: number;
  fullscreen: boolean | null;
  decorated: boolean | null;
};

const EMBED_SELECTOR = [
  "img", "svg", "canvas", "iframe", "video", "audio", ".pdf-embed",
  ".excalidraw-embed", ".mermaid-block", ".plugin-code-block", ".note-embed",
].join(",");
const VELOCITY_TRANSITION_MS = 650;
const STATUS_DURATION_MS = 1_250;

function nearestPreset(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_READING_PREFERENCES.wpm;
  return READING_WPM_PRESETS.reduce((nearest, preset) =>
    Math.abs(preset - numeric) < Math.abs(nearest - numeric) ? preset : nearest,
  );
}

function normalizedMultiplier(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0.1, Math.min(1, value))
    : fallback;
}

export function normalizeReadingPreferences(value: unknown): ReadingPreferences {
  const stored = value && typeof value === "object"
    ? value as Partial<ReadingPreferences>
    : {};
  return {
    wpm: nearestPreset(stored.wpm),
    codeMultiplier: normalizedMultiplier(
      stored.codeMultiplier,
      DEFAULT_READING_PREFERENCES.codeMultiplier,
    ),
    tableMultiplier: normalizedMultiplier(
      stored.tableMultiplier,
      DEFAULT_READING_PREFERENCES.tableMultiplier,
    ),
    mirror: typeof stored.mirror === "boolean"
      ? stored.mirror
      : DEFAULT_READING_PREFERENCES.mirror,
    chromeFree: typeof stored.chromeFree === "boolean"
      ? stored.chromeFree
      : DEFAULT_READING_PREFERENCES.chromeFree,
  };
}

export function loadReadingPreferences(
  storage: Pick<Storage, "getItem"> = localStorage,
): ReadingPreferences {
  try {
    return normalizeReadingPreferences(JSON.parse(storage.getItem(READING_PREFERENCES_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_READING_PREFERENCES };
  }
}

export function saveReadingPreferences(
  preferences: ReadingPreferences,
  storage: Pick<Storage, "setItem"> = localStorage,
): ReadingPreferences {
  const normalized = normalizeReadingPreferences(preferences);
  storage.setItem(READING_PREFERENCES_KEY, JSON.stringify(normalized));
  return normalized;
}

export function stepReadingWpm(wpm: number, direction: -1 | 1): number {
  const current = nearestPreset(wpm);
  const index = READING_WPM_PRESETS.indexOf(current as typeof READING_WPM_PRESETS[number]);
  return READING_WPM_PRESETS[
    Math.max(0, Math.min(READING_WPM_PRESETS.length - 1, index + direction))
  ];
}

export function countRenderedWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function classifyReadingContent(element: Element): ReadingContentType {
  if (element.matches("table") || element.querySelector("table")) return "table";
  if (element.querySelector(EMBED_SELECTOR)) return "embedded";
  if (element.matches("pre") || element.querySelector("pre > code")) return "code";
  return "prose";
}

export function contentSpeedMultiplier(
  contentType: ReadingContentType,
  preferences: ReadingPreferences,
): number {
  if (contentType === "code") return preferences.codeMultiplier;
  if (contentType === "table") return preferences.tableMultiplier;
  return 1;
}

export function prosePixelsPerSecond(
  height: number,
  wordCount: number,
  wpm: number,
  multiplier = 1,
): number | null {
  if (height <= 0 || wordCount <= 0 || wpm <= 0) return null;
  const durationSeconds = wordCount / wpm * 60;
  return height / durationSeconds * multiplier;
}

export function readingBlocks(root: HTMLElement): HTMLElement[] {
  const direct = Array.from(root.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement && !node.hidden,
  );
  return direct.filter((node) =>
    node.matches(".md-block, .props-block, .footnotes, .footnote-warnings, .preview-error, .preview-empty"),
  );
}

export function targetVelocityForBlock(
  block: HTMLElement,
  blocks: readonly HTMLElement[],
  preferences: ReadingPreferences,
  fallback = 24,
): number {
  const direct = measuredVelocity(block, preferences);
  if (direct != null) return direct;
  const index = blocks.indexOf(block);
  for (let distance = 1; distance < blocks.length; distance++) {
    const before = blocks[index - distance];
    const after = blocks[index + distance];
    const nearby = before ? measuredVelocity(before, preferences) : null;
    if (nearby != null) return nearby;
    const upcoming = after ? measuredVelocity(after, preferences) : null;
    if (upcoming != null) return upcoming;
  }
  return fallback;
}

function measuredVelocity(
  block: HTMLElement,
  preferences: ReadingPreferences,
): number | null {
  const type = classifyReadingContent(block);
  if (type === "embedded") return null;
  const height = Math.max(block.getBoundingClientRect().height, block.offsetHeight);
  const text = block.textContent || "";
  return prosePixelsPerSecond(
    height,
    countRenderedWords(text),
    preferences.wpm,
    contentSpeedMultiplier(type, preferences),
  );
}

export function tauriReadingWindow(): ReadingWindow {
  const window = getCurrentWindow();
  return {
    isFullscreen: () => window.isFullscreen(),
    setFullscreen: (value) => window.setFullscreen(value),
    isDecorated: () => window.isDecorated(),
    setDecorations: (value) => window.setDecorations(value),
  };
}

export class ReadingModeController {
  private active = false;
  private paused = false;
  private frame: number | null = null;
  private lastFrameAt: number | null = null;
  private velocity = 0;
  private statusTimer: number | null = null;
  private session: ReadingSession | null = null;
  private overlay: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private lifecycle = 0;
  private preferences: ReadingPreferences;
  private readonly presentationRoot: HTMLElement;
  private readonly documentElement: HTMLElement;
  private readonly storage: Pick<Storage, "getItem" | "setItem">;
  private readonly requestFrame: typeof requestAnimationFrame;
  private readonly cancelFrame: typeof cancelAnimationFrame;

  constructor(private readonly options: ReadingModeOptions) {
    this.presentationRoot = options.presentationRoot ?? options.previewHost;
    this.documentElement = options.documentElement ?? document.documentElement;
    this.storage = options.storage ?? localStorage;
    this.requestFrame = options.requestFrame ?? requestAnimationFrame;
    this.cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
    this.preferences = loadReadingPreferences(this.storage);
  }

  get isActive(): boolean { return this.active; }
  get isPaused(): boolean { return this.paused; }
  get currentPreferences(): ReadingPreferences { return { ...this.preferences }; }

  reloadPreferences(): ReadingPreferences {
    this.preferences = loadReadingPreferences(this.storage);
    this.applyPreferenceClasses();
    return this.currentPreferences;
  }

  async enter(): Promise<boolean> {
    if (this.active) return true;
    const documentId = this.options.getDocumentId();
    if (!documentId) return false;
    const lifecycle = ++this.lifecycle;
    this.preferences = loadReadingPreferences(this.storage);
    this.session = {
      documentId,
      viewMode: this.options.getViewMode(),
      scrollTop: this.options.previewHost.scrollTop,
      scrollLeft: this.options.previewHost.scrollLeft,
      fullscreen: null,
      decorated: null,
    };
    this.active = true;
    this.paused = false;
    this.lastFrameAt = null;
    this.velocity = 0;
    this.mountOverlay();
    this.applyPreferenceClasses();
    this.documentElement.classList.add("reading-mode-active");
    document.addEventListener("keydown", this.onKeyDown, true);
    this.options.showPreview();
    this.showStatus(`${this.preferences.wpm} WPM`);
    this.frame = this.requestFrame(this.tick);

    const readingWindow = this.options.readingWindow;
    if (readingWindow) {
      const [fullscreen, decorated] = await Promise.all([
        readingWindow.isFullscreen().catch(() => null),
        readingWindow.isDecorated().catch(() => null),
      ]);
      if (!this.active || lifecycle !== this.lifecycle || !this.session) return false;
      this.session.fullscreen = fullscreen;
      this.session.decorated = decorated;
      if (this.preferences.chromeFree && decorated) {
        await readingWindow.setDecorations(false).catch(() => undefined);
        if (!this.active || lifecycle !== this.lifecycle) {
          await restoreReadingWindow(readingWindow, fullscreen, decorated);
          return false;
        }
      }
      await readingWindow.setFullscreen(true).catch(() => undefined);
      if (!this.active || lifecycle !== this.lifecycle) {
        await restoreReadingWindow(readingWindow, fullscreen, decorated);
        return false;
      }
    }
    return this.active;
  }

  async exit(): Promise<void> {
    if (!this.active) return;
    ++this.lifecycle;
    const session = this.session;
    this.active = false;
    this.paused = false;
    if (this.frame != null) this.cancelFrame(this.frame);
    this.frame = null;
    this.lastFrameAt = null;
    if (this.statusTimer != null) window.clearTimeout(this.statusTimer);
    this.statusTimer = null;
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.documentElement.classList.remove("reading-mode-active", "reading-mode-chrome-free");
    this.presentationRoot.classList.remove("reading-mode-mirror");
    this.overlay?.remove();
    this.overlay = null;
    this.status = null;
    this.session = null;

    if (session) {
      this.options.restoreViewMode(session.viewMode);
      this.requestFrame(() => {
        this.options.previewHost.scrollTop = session.scrollTop;
        this.options.previewHost.scrollLeft = session.scrollLeft;
      });
      const readingWindow = this.options.readingWindow;
      if (readingWindow) {
        if (session.fullscreen != null) {
          await readingWindow.setFullscreen(session.fullscreen).catch(() => undefined);
        }
        if (session.decorated != null) {
          await readingWindow.setDecorations(session.decorated).catch(() => undefined);
        }
      }
    }
  }

  togglePause(): void {
    if (!this.active) return;
    this.paused = !this.paused;
    this.lastFrameAt = null;
    this.showStatus(this.paused ? "Paused" : `${this.preferences.wpm} WPM`);
  }

  stepSpeed(direction: -1 | 1): number {
    this.preferences.wpm = stepReadingWpm(this.preferences.wpm, direction);
    this.preferences = saveReadingPreferences(this.preferences, this.storage);
    this.showStatus(`${this.preferences.wpm} WPM`);
    return this.preferences.wpm;
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return;
    if (event.key === "Escape") void this.exit();
    else if (event.key === " ") this.togglePause();
    else if (event.key === "ArrowUp") this.stepSpeed(1);
    else if (event.key === "ArrowDown") this.stepSpeed(-1);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly tick = (timestamp: number) => {
    if (!this.active || !this.session) return;
    if (this.options.getDocumentId() !== this.session.documentId) {
      void this.exit();
      return;
    }
    const elapsed = this.lastFrameAt == null
      ? 0
      : Math.min(100, Math.max(0, timestamp - this.lastFrameAt));
    this.lastFrameAt = timestamp;
    this.overlay?.style.setProperty(
      "--reading-plane-y",
      `${this.options.previewHost.clientHeight * READING_PLANE_RATIO}px`,
    );
    if (!this.paused && elapsed > 0) {
      const blocks = readingBlocks(this.options.previewRoot);
      const active = blockAtReadingPlane(blocks, this.options.previewHost, READING_PLANE_RATIO);
      if (active) {
        const target = targetVelocityForBlock(active, blocks, this.preferences);
        const smoothing = 1 - Math.exp(-elapsed / VELOCITY_TRANSITION_MS);
        this.velocity += (target - this.velocity) * smoothing;
        const maximum = Math.max(
          0,
          this.options.previewHost.scrollHeight - this.options.previewHost.clientHeight,
        );
        this.options.previewHost.scrollTop = Math.min(
          maximum,
          this.options.previewHost.scrollTop + this.velocity * elapsed / 1_000,
        );
        if (maximum > 0 && this.options.previewHost.scrollTop >= maximum - 0.5) {
          this.paused = true;
          this.showStatus("End");
        }
      }
    }
    this.frame = this.requestFrame(this.tick);
  };

  private mountOverlay(): void {
    const overlay = document.createElement("div");
    overlay.className = "reading-mode-overlay";
    overlay.style.setProperty(
      "--reading-plane-y",
      `${this.options.previewHost.clientHeight * READING_PLANE_RATIO}px`,
    );
    overlay.setAttribute("aria-hidden", "true");
    const left = document.createElement("span");
    left.className = "reading-index reading-index-left";
    left.textContent = "▶";
    const right = document.createElement("span");
    right.className = "reading-index reading-index-right";
    right.textContent = "◀";
    const status = document.createElement("output");
    status.className = "reading-mode-status";
    overlay.append(left, right, status);
    this.options.previewHost.prepend(overlay);
    this.overlay = overlay;
    this.status = status;
  }

  private applyPreferenceClasses(): void {
    this.documentElement.classList.toggle(
      "reading-mode-chrome-free",
      this.active && this.preferences.chromeFree,
    );
    this.presentationRoot.classList.toggle(
      "reading-mode-mirror",
      this.active && this.preferences.mirror,
    );
  }

  private showStatus(message: string): void {
    if (!this.status) return;
    this.status.textContent = message;
    this.status.classList.add("visible");
    if (this.statusTimer != null) window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      this.status?.classList.remove("visible");
      this.statusTimer = null;
    }, STATUS_DURATION_MS);
  }
}

async function restoreReadingWindow(
  readingWindow: ReadingWindow,
  fullscreen: boolean | null,
  decorated: boolean | null,
): Promise<void> {
  if (fullscreen != null) {
    await readingWindow.setFullscreen(fullscreen).catch(() => undefined);
  }
  if (decorated != null) {
    await readingWindow.setDecorations(decorated).catch(() => undefined);
  }
}

function blockAtReadingPlane(
  blocks: readonly HTMLElement[],
  host: HTMLElement,
  ratio: number,
): HTMLElement | null {
  const hostRect = host.getBoundingClientRect();
  const readingY = hostRect.top + host.clientHeight * ratio;
  let closest: HTMLElement | null = null;
  for (const block of blocks) {
    const rect = block.getBoundingClientRect();
    if (rect.top <= readingY && rect.bottom >= readingY) return block;
    if (rect.bottom < readingY) closest = block;
    else if (!closest) return block;
  }
  return closest;
}
