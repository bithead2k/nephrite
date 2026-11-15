export type InterfaceDirection = "auto" | "ltr" | "rtl";

export type DisplayPreferences = {
  baseFontSize: number;
  direction: InterfaceDirection;
};

export const DISPLAY_PREFERENCES_KEY = "nephrite.displayPreferences.v1";
export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  baseFontSize: 16,
  direction: "auto",
};

const RTL_LANGUAGES = new Set(["ar", "dv", "fa", "he", "ku", "ps", "ur", "yi"]);

export function normalizeDisplayPreferences(value: unknown): DisplayPreferences {
  const source = value && typeof value === "object" ? value as Partial<DisplayPreferences> : {};
  const numericSize = Number(source.baseFontSize);
  const direction = source.direction === "ltr" || source.direction === "rtl" ? source.direction : "auto";
  return {
    baseFontSize: Number.isFinite(numericSize) ? Math.min(24, Math.max(12, Math.round(numericSize))) : 16,
    direction,
  };
}

export function loadDisplayPreferences(storage: Pick<Storage, "getItem"> = localStorage): DisplayPreferences {
  try {
    return normalizeDisplayPreferences(JSON.parse(storage.getItem(DISPLAY_PREFERENCES_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_DISPLAY_PREFERENCES };
  }
}

export function resolvedDirection(direction: InterfaceDirection, language = navigator.language): "ltr" | "rtl" {
  if (direction !== "auto") return direction;
  return RTL_LANGUAGES.has(language.toLowerCase().split("-")[0]) ? "rtl" : "ltr";
}

export function applyDisplayPreferences(
  preferences: DisplayPreferences,
  systemTextScale = 1,
  root: HTMLElement = document.documentElement,
  language = navigator.language,
): void {
  const normalized = normalizeDisplayPreferences(preferences);
  const scale = Number.isFinite(systemTextScale) ? Math.min(2.5, Math.max(0.75, systemTextScale)) : 1;
  root.style.setProperty("--base-font-size", `${normalized.baseFontSize}px`);
  root.style.setProperty("--system-text-scale", String(scale));
  root.dir = resolvedDirection(normalized.direction, language);
  root.dataset.directionPreference = normalized.direction;
}

export function horizontalCellDelta(key: string, rtl: boolean): number {
  if (key === "ArrowRight") return rtl ? -1 : 1;
  if (key === "ArrowLeft") return rtl ? 1 : -1;
  return 0;
}

export function systemTextScaleForSize(pixelSize: number, baseline = 17): number {
  if (!Number.isFinite(pixelSize) || pixelSize <= 0 || !Number.isFinite(baseline) || baseline <= 0) return 1;
  return Math.min(2.5, Math.max(0.75, pixelSize / baseline));
}

/** Measure iOS Dynamic Type through WebKit's system-body font. */
export function measureAppleSystemTextScale(doc: Document = document): number {
  const probe = doc.createElement("span");
  probe.textContent = "M";
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;font:-apple-system-body";
  doc.body.appendChild(probe);
  const size = Number.parseFloat(doc.defaultView?.getComputedStyle(probe).fontSize || "");
  probe.remove();
  return systemTextScaleForSize(size);
}
