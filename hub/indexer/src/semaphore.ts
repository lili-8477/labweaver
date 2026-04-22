export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error("Semaphore permits must be >= 1");
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    // Queue; the permit is handed off directly by release(), no decrement here.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand off the permit directly to the next waiter without bouncing
      // through `permits`. Otherwise a synchronous release-then-acquire
      // pair can steal the waiter's permit and over-admit.
      next();
    } else {
      this.permits++;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
