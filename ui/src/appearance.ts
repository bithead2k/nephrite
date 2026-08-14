export type AppearanceFonts = {
  ui: string;
  editor: string;
  preview: string;
  powerline: string;
};

export const APPEARANCE_FONTS_KEY = "nephrite.appearanceFonts.v1";
export const DEFAULT_APPEARANCE_FONTS: AppearanceFonts = {
  ui: "",
  editor: "",
  preview: "",
  powerline: "",
};

function safeFontStack(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 240);
  return /[;{}\r\n]/.test(trimmed) ? "" : trimmed;
}

export function normalizeAppearanceFonts(value: unknown): AppearanceFonts {
  const source = value && typeof value === "object" ? value as Partial<AppearanceFonts> : {};
  return {
    ui: safeFontStack(source.ui),
    editor: safeFontStack(source.editor),
    preview: safeFontStack(source.preview),
    powerline: safeFontStack(source.powerline),
  };
}

export function loadAppearanceFonts(storage: Pick<Storage, "getItem"> = localStorage): AppearanceFonts {
  try {
    return normalizeAppearanceFonts(JSON.parse(storage.getItem(APPEARANCE_FONTS_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_APPEARANCE_FONTS };
  }
}

export function applyAppearanceFonts(
  fonts: AppearanceFonts,
  root: HTMLElement = document.documentElement,
) {
  const properties: Array<[keyof AppearanceFonts, string]> = [
    ["ui", "--font"],
    ["editor", "--editor-font"],
    ["preview", "--preview-font"],
    ["powerline", "--powerline-font"],
  ];
  for (const [key, property] of properties) {
    if (fonts[key]) root.style.setProperty(property, fonts[key]);
    else root.style.removeProperty(property);
  }
}
