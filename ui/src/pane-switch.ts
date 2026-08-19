export type SwitchOutcome = "completed" | "superseded";

export function claimOneTimeBinding(
  dataset: Record<string, string | undefined>,
  key: string,
): boolean {
  if (dataset[key] === "1") return false;
  dataset[key] = "1";
  return true;
}

export function missingAncestorPaths(path: string, expanded: ReadonlySet<string>): string[] {
  const parts = path.split("/");
  const missing: string[] = [];
  let current = "";
  for (let index = 0; index < parts.length - 1; index++) {
    current = current ? `${current}/${parts[index]}` : parts[index];
    if (!expanded.has(current)) missing.push(current);
  }
  return missing;
}

type PendingSwitch<T> = {
  value: T;
  token: number;
  resolve: (outcome: SwitchOutcome) => void;
  reject: (error: unknown) => void;
};

/**
 * Runs at most one pane transition at a time while collapsing queued input to
 * the most recently requested pane. The active transition receives a liveness
 * predicate so work after an await can be discarded before it reaches the UI.
 */
export class LatestPaneSwitch<T> {
  private token = 0;
  private running = false;
  private pending: PendingSwitch<T> | null = null;

  constructor(
    private readonly run: (value: T, isCurrent: () => boolean) => Promise<void>,
  ) {}

  request(value: T): Promise<SwitchOutcome> {
    const token = ++this.token;
    if (this.pending) this.pending.resolve("superseded");
    return new Promise<SwitchOutcome>((resolve, reject) => {
      this.pending = { value, token, resolve, reject };
      void this.drain();
    });
  }

  invalidate(): void {
    this.token++;
    if (this.pending) {
      this.pending.resolve("superseded");
      this.pending = null;
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const item = this.pending;
        this.pending = null;
        try {
          await this.run(item.value, () => item.token === this.token);
          item.resolve(item.token === this.token ? "completed" : "superseded");
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
      // A request can arrive after the loop observes null but before finally.
      if (this.pending) void this.drain();
    }
  }
}
