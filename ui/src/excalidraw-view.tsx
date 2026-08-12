import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { createRoot, type Root } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";

type SceneFile = ExcalidrawInitialDataState & {
  type?: string;
  version?: number;
  source?: string;
};

function parseScene(content: string): SceneFile {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The drawing is not an Excalidraw JSON object");
  }
  const scene = parsed as SceneFile;
  if (scene.elements != null && !Array.isArray(scene.elements)) {
    throw new Error("The drawing has an invalid elements array");
  }
  return scene;
}

export class ExcalidrawView {
  private root: Root;
  private generation = 0;

  constructor(private host: HTMLElement) {
    this.root = createRoot(host);
  }

  open(path: string, content: string, onChange: (content: string) => void) {
    const scene = parseScene(content);
    const generation = ++this.generation;
    let armed = false;
    let last = serializeAsJSON(
      (scene.elements ?? []) as readonly OrderedExcalidrawElement[],
      (scene.appState ?? {}) as Partial<AppState>,
      (scene.files ?? {}) as BinaryFiles,
      "local",
    );
    const theme = scene.appState?.theme === "light" ? "light" : "dark";
    window.setTimeout(() => {
      if (generation === this.generation) armed = true;
    }, 0);

    const changed = (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      if (!armed || generation !== this.generation) return;
      const serialized = serializeAsJSON(elements, appState, files, "local");
      if (serialized === last) return;
      last = serialized;
      onChange(serialized.endsWith("\n") ? serialized : `${serialized}\n`);
    };

    this.host.dataset.drawingPath = path;
    this.root.render(
      <Excalidraw
        key={`${path}:${generation}`}
        initialData={{
          elements: scene.elements ?? [],
          appState: scene.appState ?? {},
          files: scene.files ?? {},
        }}
        onChange={changed}
        theme={theme}
        name={path.replace(/^.*\//, "").replace(/\.excalidraw$/i, "")}
        UIOptions={{ canvasActions: { loadScene: false } }}
      />,
    );
  }

  clear() {
    this.generation++;
    delete this.host.dataset.drawingPath;
    this.root.render(null);
  }
}
