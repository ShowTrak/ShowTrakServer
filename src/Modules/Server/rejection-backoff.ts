// Backoff for repeated adoption rejections of the same client.
//
// A client adopted by a different server (a reinstalled server with a new
// identity, or another ShowTrak server reusing this address) is told
// `Unadopt: server_identity_mismatch`. Clients up to at least 3.28 answer by
// restarting their connection straight back to the same address, so without a
// delay one such client reconnected ~80 times a second, forever, each time
// costing a handshake and several log lines here.
//
// The first rejection is sent at once, so a client that is genuinely recovering
// gets its answer straight away. Repeats within RESET_MS are held back for an
// exponentially growing delay; the socket simply waits, unanswered, until then.
// This works with every client version: an old client just sees a slower
// rejection, never a different one.

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
// A client quiet for this long starts again from an immediate rejection.
const RESET_MS = 5 * 60 * 1000;
// Bound on tracked clients; stale entries are swept when it is reached.
const MAX_TRACKED = 1000;

interface RejectionRecord {
  Count: number;
  Last: number;
}

class RejectionBackoff {
  private readonly Records = new Map<string, RejectionRecord>();

  // Record a rejection of `Key` at `Now` and return how long to hold it back.
  // 0 for the first in a while; then 1 s, 2 s, 4 s ... up to 30 s.
  NextDelayMs(Key: string, Now: number = Date.now()): number {
    const Rec = this.Records.get(Key);
    if (!Rec || Now - Rec.Last > RESET_MS) {
      if (!Rec && this.Records.size >= MAX_TRACKED) this.Sweep(Now);
      this.Records.set(Key, { Count: 1, Last: Now });
      return 0;
    }
    Rec.Count++;
    Rec.Last = Now;
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(Rec.Count - 2, 15));
  }

  // How many rejections `Key` has had in its current run (0 if none).
  Count(Key: string): number {
    return this.Records.get(Key)?.Count ?? 0;
  }

  private Sweep(Now: number): void {
    for (const [Key, Rec] of this.Records) {
      if (Now - Rec.Last > RESET_MS) this.Records.delete(Key);
    }
    // Every entry still fresh (an unlikely flood of distinct ids): drop the
    // oldest so the map stays bounded. Map iteration is insertion order.
    while (this.Records.size >= MAX_TRACKED) {
      const Oldest = this.Records.keys().next().value;
      if (Oldest === undefined) break;
      this.Records.delete(Oldest);
    }
  }
}

export { RejectionBackoff, BASE_DELAY_MS, MAX_DELAY_MS, RESET_MS, MAX_TRACKED };
