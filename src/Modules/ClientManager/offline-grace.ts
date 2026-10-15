// Disconnect grace period: how long a ShowTrak client may stay disconnected
// before it is marked offline.
//
// Wi-Fi roaming, a switch renegotiating, or a busy machine missing a ping can
// drop a client's websocket for a second or two; the client reconnects on its
// own and nothing was ever wrong. Without a grace period each of those blips is
// an offline alert. The grace is server-wide (CLIENT_OFFLINE_GRACE_SECONDS,
// applied by main/live-settings) and overridable per client (the
// OfflineGraceSeconds column; null = inherit). 0 is the historical behaviour:
// offline the moment the socket closes.
//
// Pending timers live here, keyed by UUID, rather than on the Client: a Client
// is broadcast raw over IPC and stringified into alert history, and a Node timer
// handle survives neither (see StartupGraceTimers in ./client).

export const MIN_OFFLINE_GRACE_SECONDS = 0;
export const MAX_OFFLINE_GRACE_SECONDS = 10;

// Whole seconds in range, or null for anything that is not a number.
export function ClampOfflineGraceSeconds(Value: unknown): number | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const n = Number(Value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_OFFLINE_GRACE_SECONDS, Math.max(MIN_OFFLINE_GRACE_SECONDS, Math.round(n)));
}

let DefaultOfflineGraceSeconds = 0;

export function SetDefaultOfflineGraceSeconds(Value: unknown): void {
  const n = ClampOfflineGraceSeconds(Value);
  if (n !== null) DefaultOfflineGraceSeconds = n;
}

export function GetDefaultOfflineGraceSeconds(): number {
  return DefaultOfflineGraceSeconds;
}

// A client's own override wins; null inherits the server-wide default.
export function ResolveOfflineGraceSeconds(Override: number | null | undefined): number {
  const Own = ClampOfflineGraceSeconds(Override);
  return Own === null ? DefaultOfflineGraceSeconds : Own;
}

const PendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

// Run `Expire` after `Seconds`, unless cancelled first. A client already waiting
// out its grace keeps its original deadline: a connection that flaps without
// ever heartbeating must not be able to push its offline mark back forever.
export function SchedulePendingTimeout(UUID: string, Seconds: number, Expire: () => void): void {
  if (PendingTimeouts.has(UUID)) return;
  const Timer = setTimeout(() => {
    PendingTimeouts.delete(UUID);
    Expire();
  }, Seconds * 1000);
  // Never hold the process open at shutdown for a client that is going away.
  if (typeof Timer.unref === 'function') Timer.unref();
  PendingTimeouts.set(UUID, Timer);
}

// Returns true when a pending timeout was cancelled.
export function CancelPendingTimeout(UUID: string): boolean {
  const Timer = PendingTimeouts.get(UUID);
  if (!Timer) return false;
  clearTimeout(Timer);
  PendingTimeouts.delete(UUID);
  return true;
}

export function HasPendingTimeout(UUID: string): boolean {
  return PendingTimeouts.has(UUID);
}
