import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";

const WINDOW_STATE_KEY = "nephrite.windowState.v1";

export type SavedWindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
};

type WindowGeometryReader = {
  outerPosition(): Promise<{ x: number; y: number }>;
  innerSize(): Promise<{ width: number; height: number }>;
  scaleFactor(): Promise<number>;
};

export async function captureLogicalWindowGeometry(
  window: WindowGeometryReader,
): Promise<Pick<SavedWindowState, "x" | "y" | "width" | "height">> {
  // Tauri's setSize() restores the inner (client-area) size. Persist that same
  // measurement so the OS title bar and borders are not added again on every
  // restart. Position remains the outer window's desktop coordinate.
  const [position, size, scale] = await Promise.all([
    window.outerPosition(),
    window.innerSize(),
    window.scaleFactor(),
  ]);
  return {
    x: position.x / scale,
    y: position.y / scale,
    width: size.width / scale,
    height: size.height / scale,
  };
}

function validState(value: unknown): value is SavedWindowState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SavedWindowState>;
  return [state.x, state.y, state.width, state.height].every(
    (part) => typeof part === "number" && Number.isFinite(part),
  ) && typeof state.maximized === "boolean" && state.width! >= 800 && state.height! >= 500;
}

export async function installWindowStatePersistence(): Promise<void> {
  const window = getCurrentWindow();
  try {
    const saved = JSON.parse(localStorage.getItem(WINDOW_STATE_KEY) || "null");
    if (validState(saved)) {
      await window.setSize(new LogicalSize(saved.width, saved.height));
      await window.setPosition(new LogicalPosition(saved.x, saved.y));
      if (saved.maximized) await window.maximize();
    }
  } catch (error) {
    console.warn("[window state] restore failed", error);
  }

  let timer: number | null = null;
  const save = () => {
    if (timer != null) globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(async () => {
      timer = null;
      try {
        const maximized = await window.isMaximized();
        if (maximized) {
          const previous = localStorage.getItem(WINDOW_STATE_KEY);
          if (previous) {
            const state = JSON.parse(previous) as SavedWindowState;
            state.maximized = true;
            localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(state));
          }
          return;
        }
        const geometry = await captureLogicalWindowGeometry(window);
        localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify({
          ...geometry,
          maximized: false,
        } satisfies SavedWindowState));
      } catch (error) {
        console.warn("[window state] save failed", error);
      }
    }, 250) as unknown as number;
  };

  await window.onMoved(save);
  await window.onResized(save);
  save();
}
