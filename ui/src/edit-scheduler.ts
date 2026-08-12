export type TimerHandle = ReturnType<typeof setTimeout>;

type TimerApi = {
  set: (callback: () => void, delayMs: number) => TimerHandle;
  clear: (handle: TimerHandle) => void;
};

const browserTimers: TimerApi = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle),
};

/**
 * Coalesce document-derived work without serializing the document while the
 * user is typing. The reader runs once, only after the quiet period.
 */
export class DeferredDocumentWork {
  private handle: TimerHandle | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly timers: TimerApi = browserTimers,
  ) {}

  schedule(read: () => string, consume: (document: string) => void): void {
    this.cancel();
    this.handle = this.timers.set(() => {
      this.handle = null;
      consume(read());
    }, this.delayMs);
  }

  cancel(): void {
    if (this.handle == null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  get pending(): boolean {
    return this.handle != null;
  }
}
