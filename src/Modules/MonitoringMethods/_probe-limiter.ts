// Concurrency limit for monitoring probes.
//
// Every monitor polls on its own timer, so without a limit N monitors sharing an
// interval could open N sockets or start N `ping` processes in the same tick.
// A probe takes a slot from the global pool, and ping also from its own smaller
// pool, before it starts. Waiters are served first-in first-out, so a queued
// probe cannot be starved by later ones.

class Semaphore {
  private Available: number;
  private readonly Waiters: Array<() => void> = [];

  constructor(readonly Limit: number) {
    this.Available = Math.max(1, Limit | 0);
  }

  async Acquire(): Promise<void> {
    if (this.Available > 0) {
      this.Available--;
      return;
    }
    await new Promise<void>((resolve) => this.Waiters.push(resolve));
  }

  Release(): void {
    const Next = this.Waiters.shift();
    // Hand the slot straight to the next waiter rather than freeing it, so a
    // probe arriving in between cannot jump the queue.
    if (Next) Next();
    else this.Available++;
  }

  get InUse(): number {
    return this.Limit - this.Available;
  }

  get Queued(): number {
    return this.Waiters.length;
  }
}

// Longest a single probe may hold its slots. Every method bounds itself with its
// own timeout (at most 30 s), so this only ever fires for a probe that never
// settles; it then gives the slots back so one stuck probe cannot, over time,
// starve every monitor. The probe itself carries on and still reports.
const DEFAULT_MAX_HOLD_MS = 120000;

class ProbeLimiter {
  private readonly Global: Semaphore;
  private readonly PerMethod = new Map<string, Semaphore>();
  private readonly MaxHoldMs: number;

  constructor(
    GlobalLimit: number,
    PerMethodLimits: Record<string, number> = {},
    MaxHoldMs: number = DEFAULT_MAX_HOLD_MS
  ) {
    this.MaxHoldMs = MaxHoldMs;
    this.Global = new Semaphore(GlobalLimit);
    for (const [Method, Limit] of Object.entries(PerMethodLimits)) {
      this.PerMethod.set(Method, new Semaphore(Limit));
    }
  }

  // Run `Fn` once a slot is free. The method's own pool is taken first so a
  // queue of pings never holds global slots that other probes could use.
  async Run<T>(Method: string, Fn: () => Promise<T>): Promise<T> {
    const Own = this.PerMethod.get(Method);
    if (Own) await Own.Acquire();
    try {
      await this.Global.Acquire();
    } catch (Err) {
      if (Own) Own.Release();
      throw Err;
    }
    let Released = false;
    const ReleaseOnce = () => {
      if (Released) return;
      Released = true;
      clearTimeout(HoldTimer);
      this.Global.Release();
      if (Own) Own.Release();
    };
    const HoldTimer = setTimeout(ReleaseOnce, this.MaxHoldMs);
    if (typeof HoldTimer.unref === 'function') HoldTimer.unref();
    try {
      return await Fn();
    } finally {
      ReleaseOnce();
    }
  }

  Stats(): { InUse: number; Queued: number } {
    return { InUse: this.Global.InUse, Queued: this.Global.Queued };
  }
}

export { ProbeLimiter, Semaphore };
