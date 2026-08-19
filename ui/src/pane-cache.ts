export type CachedPreview = {
  fragment: DocumentFragment;
  source: string;
  scrollTop: number;
  scrollLeft: number;
};

export type CachedPane<TEditor = unknown> = {
  path: string;
  content: string;
  fileKind: string;
  editor?: TEditor;
  preview?: CachedPreview;
};

/** Small disposable LRU. Markdown and the filesystem remain authoritative. */
export class PaneStateCache<TEditor = unknown> {
  private readonly entries = new Map<string, CachedPane<TEditor>>();

  constructor(private readonly capacity = 16) {}

  get(path: string): CachedPane<TEditor> | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    this.entries.delete(path);
    this.entries.set(path, entry);
    return entry;
  }

  set(entry: CachedPane<TEditor>): void {
    this.entries.delete(entry.path);
    this.entries.set(entry.path, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.entries.delete(oldest);
    }
  }

  delete(path: string): void {
    this.entries.delete(path);
  }

  invalidatePreviews(): void {
    for (const entry of this.entries.values()) entry.preview = undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
