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

/**
 * Coalesce work that must never run while the editor is dirty. Unlike a
 * debounce, repeated requests do not cancel/recreate a browser timer on every
 * keystroke. One cheap flag/timer stays armed until the document is clean.
 */
export class DirtyGatedWork {
  private handle: TimerHandle | null = null;
  private dirty: (() => boolean) | null = null;
  private work: (() => void) | null = null;

  constructor(
    private readonly pollMs = 50,
    private readonly timers: TimerApi = browserTimers,
  ) {}

  request(isDirty: () => boolean, work: () => void): void {
    this.dirty = isDirty;
    this.work = work;
    if (this.handle == null) this.arm();
  }

  cancel(): void {
    if (this.handle != null) this.timers.clear(this.handle);
    this.handle = null;
    this.dirty = null;
    this.work = null;
  }

  get pending(): boolean {
    return this.handle != null;
  }

  private arm(): void {
    this.handle = this.timers.set(() => {
      this.handle = null;
      if (!this.dirty || !this.work) return;
      if (this.dirty()) {
        this.arm();
        return;
      }
      const work = this.work;
      this.dirty = null;
      this.work = null;
      work();
    }, this.pollMs);
  }
}
