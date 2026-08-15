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
 * Keep Markdown parsing off the editor's event loop.
 * The worker is reused: a superseded render is ignored, not terminated,
 * so closing a pane does not wait on a new worker boot.
 */
export class PreviewWorkerClient {
  private worker: Worker | null = null;
  private rejectPending: ((reason: Error) => void) | null = null;
  private nextId = 0;

  render(markdown: string): Promise<PreviewMarkup> {
    this.abortPending();
    if (typeof Worker === "undefined") {
      return this.renderSync(markdown);
    }

    const id = ++this.nextId;
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return this.renderSync(markdown);
    }

    return new Promise<PreviewMarkup>((resolve, reject) => {
      this.rejectPending = reject;
      const onMessage = (event: MessageEvent<PreviewResponse>) => {
        if (event.data.id !== id) return;
        worker.removeEventListener("message", onMessage);
        if (this.nextId !== id) return;
        this.rejectPending = null;
        resolve({
          html: event.data.html,
          renderMs: event.data.renderMs,
          worker: true,
        });
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ id, markdown });
    });
  }

  cancel(): void {
    this.abortPending();
    this.nextId += 1;
  }

  private renderSync(markdown: string): Promise<PreviewMarkup> {
    const started = performance.now();
    return Promise.resolve({
      html: renderPreview(markdown),
      renderMs: performance.now() - started,
      worker: false,
    });
  }

  private abortPending(): void {
    const reject = this.rejectPending;
    this.rejectPending = null;
    reject?.(new DOMException("Preview superseded", "AbortError"));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./preview-worker.ts", import.meta.url), {
      type: "module",
      name: "nephrite-preview",
    });
    worker.addEventListener("error", () => {
      if (this.worker !== worker) return;
      this.worker = null;
      worker.terminate();
      const reject = this.rejectPending;
      this.rejectPending = null;
      reject?.(new Error("Preview worker failed"));
    });
    this.worker = worker;
    return worker;
  }
}
