/** Hold in-flight collaboration results until the canonical document can accept them. */
export class CollaborationPause {
  private paused = false;
  private disposed = false;
  private waiting = new Set<() => void>();
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.release();
  }
  async wait(): Promise<void> {
    while (this.paused && !this.disposed) await new Promise<void>((resolve) => this.waiting.add(resolve));
    if (this.disposed) throw new Error('Collaboration view closed.');
  }
  dispose(): void { this.disposed = true; this.release(); }
  private release(): void { for (const resolve of this.waiting) resolve(); this.waiting.clear(); }
}
