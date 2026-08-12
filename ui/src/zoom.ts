const ZOOM_KEY = "nephrite.uiZoom";
const MIN = 0.75;
const MAX = 2.5;
const STEP = 0.1;

let zoom = load();

function load(): number {
  const n = Number(localStorage.getItem(ZOOM_KEY));
  if (Number.isFinite(n) && n >= MIN && n <= MAX) return n;
  return 1;
}

export function getZoom(): number {
  return zoom;
}

export function applyZoom(z?: number) {
  if (z != null) zoom = Math.min(MAX, Math.max(MIN, z));
  document.documentElement.style.setProperty("--ui-zoom", String(zoom));
  // CodeMirror uses font-size on .cm-editor; scale root + editor host
  document.documentElement.style.fontSize = `${zoom * 100}%`;
  localStorage.setItem(ZOOM_KEY, String(zoom));
  window.dispatchEvent(new CustomEvent("nephrite-zoom", { detail: zoom }));
}

export function zoomIn() {
  applyZoom(zoom + STEP);
}

export function zoomOut() {
  applyZoom(zoom - STEP);
}

export function zoomReset() {
  applyZoom(1);
}

/** Bind Ctrl/Cmd + / - / 0 (and numpad). */
export function installZoomKeys() {
  applyZoom(zoom);
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key;
      // + can be "=" with shift, or NumpadAdd
      if (k === "+" || k === "=" || k === "Add") {
        e.preventDefault();
        zoomIn();
      } else if (k === "-" || k === "_" || k === "Subtract") {
        e.preventDefault();
        zoomOut();
      } else if (k === "0" || k === "Digit0" || k === "Numpad0") {
        // allow Ctrl+0 reset; some browsers use it for full page zoom
        e.preventDefault();
        zoomReset();
      }
    },
    { capture: true },
  );
}
