import { renderPreview } from "./preview";

export type PreviewMarkup = {
  html: string;
  renderMs: number;
  worker: boolean;
};

type PreviewResponse = {
  id: number;
  html: string;
  renderMs: number;
};

/**
 * Keep Markdown parsing off the editor's event loop. Terminating the worker is
 * intentional: a superseded large render must not sit ahead of the latest
 * document in the worker queue.
 */
export class PreviewWorkerClient {
  private worker: Worker | null = null;
  private rejectPending: ((reason: Error) => void) | null = null;
  private nextId = 0;

  render(markdown: string): Promise<PreviewMarkup> {
    this.cancel();
    if (typeof Worker === "undefined") {
      const started = performance.now();
      return Promise.resolve({
        html: renderPreview(markdown),
        renderMs: performance.now() - started,
        worker: false,
      });
    }

    const id = ++this.nextId;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./preview-worker.ts", import.meta.url), {
        type: "module",
        name: "nephrite-preview",
      });
    } catch {
      const started = performance.now();
      return Promise.resolve({
        html: renderPreview(markdown),
        renderMs: performance.now() - started,
        worker: false,
      });
    }
    this.worker = worker;

    return new Promise<PreviewMarkup>((resolve, reject) => {
      this.rejectPending = reject;
      worker.addEventListener("message", (event: MessageEvent<PreviewResponse>) => {
        if (worker !== this.worker || event.data.id !== id) return;
        this.finish(worker);
        resolve({ html: event.data.html, renderMs: event.data.renderMs, worker: true });
      });
      worker.addEventListener("error", (event) => {
        if (worker !== this.worker) return;
        this.finish(worker);
        reject(new Error(event.message || "Preview worker failed"));
      });
      worker.postMessage({ id, markdown });
    });
  }

  cancel(): void {
    const worker = this.worker;
    if (!worker) return;
    const reject = this.rejectPending;
    this.worker = null;
    this.rejectPending = null;
    worker.terminate();
    reject?.(new DOMException("Preview superseded", "AbortError"));
  }

  private finish(worker: Worker): void {
    if (worker !== this.worker) return;
    this.worker = null;
    this.rejectPending = null;
    worker.terminate();
  }
}
