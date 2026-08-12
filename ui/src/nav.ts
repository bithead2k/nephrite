/** File navigation history (browser-style back / forward). */

export class NavHistory {
  private stack: string[] = [];
  private index = -1;

  /** Record navigation to path (truncates forward branch). */
  push(path: string) {
    if (!path) return;
    if (this.index >= 0 && this.stack[this.index] === path) return;
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(path);
    this.index = this.stack.length - 1;
    // cap memory
    if (this.stack.length > 200) {
      const drop = this.stack.length - 200;
      this.stack = this.stack.slice(drop);
      this.index -= drop;
    }
  }

  canBack(): boolean {
    return this.index > 0;
  }

  canForward(): boolean {
    return this.index >= 0 && this.index < this.stack.length - 1;
  }

  back(): string | null {
    if (!this.canBack()) return null;
    this.index -= 1;
    return this.stack[this.index] ?? null;
  }

  forward(): string | null {
    if (!this.canForward()) return null;
    this.index += 1;
    return this.stack[this.index] ?? null;
  }

  /** Replace current without growing stack (e.g. after rename). */
  replace(path: string) {
    if (this.index < 0) {
      this.push(path);
      return;
    }
    this.stack[this.index] = path;
  }
}
