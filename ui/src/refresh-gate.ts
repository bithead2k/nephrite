/**
 * Keep index-driven preview refreshes from invalidating work already rendering.
 * Document edits still use the normal preview revision/cancellation path.
 */
export class RefreshGate {
  private active = 0;
  private pending = false;

  begin(): void {
    this.active++;
  }

  /** Return true when one coalesced refresh should run after the active work. */
  end(): boolean {
    if (this.active > 0) this.active--;
    if (this.active === 0 && this.pending) {
      this.pending = false;
      return true;
    }
    return false;
  }

  /** Return true when the refresh may start now; otherwise remember one. */
  request(): boolean {
    if (this.active === 0) return true;
    this.pending = true;
    return false;
  }
}
