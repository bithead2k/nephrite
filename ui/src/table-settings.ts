export type TableSettings = {
  liveFormatting: boolean;
  padding: number;
  tabNavigation: boolean;
  wrapSource: boolean;
  previewWidth: number;
};
export const TABLE_SETTINGS_KEY = "nephrite.tables.v1";
export const DEFAULT_TABLE_SETTINGS: TableSettings = {
  liveFormatting: true, padding: 1, tabNavigation: true, wrapSource: false, previewWidth: 0,
};
export function normalizeTableSettings(value: unknown): TableSettings {
  const v = value && typeof value === "object" ? value as Partial<TableSettings> : {};
  const integer = (x: unknown, fallback: number, min: number, max: number) =>
    typeof x === "number" && Number.isFinite(x) ? Math.max(min, Math.min(max, Math.round(x))) : fallback;
  return {
    liveFormatting: typeof v.liveFormatting === "boolean" ? v.liveFormatting : true,
    padding: integer(v.padding, 1, 1, 4),
    tabNavigation: typeof v.tabNavigation === "boolean" ? v.tabNavigation : true,
    wrapSource: v.wrapSource === true,
    previewWidth: integer(v.previewWidth, 0, 0, 120),
  };
}
export function loadTableSettings(storage: Pick<Storage, "getItem"> = localStorage): TableSettings {
  try { return normalizeTableSettings(JSON.parse(storage.getItem(TABLE_SETTINGS_KEY) || "{}")); }
  catch { return { ...DEFAULT_TABLE_SETTINGS }; }
}
export function applyTablePreviewSettings(settings: TableSettings, root = document.documentElement) {
  root.style.setProperty("--table-column-width", settings.previewWidth ? `${settings.previewWidth}ch` : "none");
}

export function renderTableSettings(root: HTMLElement, settings: TableSettings, save: (settings: TableSettings) => void) {
  root.innerHTML = `<strong>Editor → Tables</strong>
    <form class="table-settings-form">
      <label><input name="liveFormatting" type="checkbox"> Live table formatting</label>
      <label><input name="tabNavigation" type="checkbox"> Tab moves between table cells</label>
      <label><input name="wrapSource" type="checkbox"> Visually wrap source lines (including table rows)</label>
      <label>Cell padding <input name="padding" type="number" min="1" max="4" step="1"></label>
      <label>Preview column width (characters; 0 = automatic) <input name="previewWidth" type="number" min="0" max="120" step="1"></label>
      <small>Wrapping changes the display only. Formatting keeps the column alignment markers already in your Markdown.</small>
      <button type="submit">Save table settings</button>
    </form>`;
  const form = root.querySelector("form")!;
  for (const key of ["liveFormatting", "tabNavigation", "wrapSource"] as const) {
    (form.elements.namedItem(key) as HTMLInputElement).checked = settings[key];
  }
  for (const key of ["padding", "previewWidth"] as const) {
    (form.elements.namedItem(key) as HTMLInputElement).value = String(settings[key]);
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    const checked = (key: string) => (form.elements.namedItem(key) as HTMLInputElement).checked;
    const number = (key: string) => (form.elements.namedItem(key) as HTMLInputElement).valueAsNumber;
    save(normalizeTableSettings({ liveFormatting: checked("liveFormatting"), tabNavigation: checked("tabNavigation"),
      wrapSource: checked("wrapSource"), padding: number("padding"), previewWidth: number("previewWidth") }));
  });
}
