// The pure half of a monitor's Settings tab (../monitor-info-edit.ts): the
// UpdateMonitoringTarget payload it autosaves, and reordering its checks.
//
// The server reconciles a monitor's checks against the list it is sent: checks
// keep their CheckID, take their order (Weight) from their position, and any
// check left out is DELETED. So every save sends every check, and a reorder is
// nothing more than sending them in the new order.

export interface MonitorSettingsEdits {
  Nickname: string;
  Slug: string;
  Interval: number;
  /** null inherits the server-wide default. */
  FailureThreshold: number | null;
}

interface CheckLike {
  CheckID: number;
  Name?: string | null;
  Address?: string | null;
  Method: string;
  Settings?: Record<string, unknown> | null;
  DegradedThresholdMs?: number | null;
  FailureThreshold?: number | null;
}

interface TargetLike {
  GroupID: number | null;
  Slug: string | null;
  Checks?: CheckLike[] | null;
}

export interface MonitorUpdatePayload {
  Nickname: string;
  Interval: number;
  GroupID: number | null;
  FailureThreshold: number | null;
  Slug?: string;
  Checks: Array<{
    CheckID: number;
    Name: string;
    Address: string;
    Method: string;
    Settings: Record<string, unknown>;
    DegradedThresholdMs: number;
    FailureThreshold: number | null;
  }>;
}

export const DEFAULT_MONITOR_INTERVAL_MS = 30000;

/** The interval slider's value, or the default when unreadable. */
export function ParseMonitorInterval(Raw: unknown): number {
  const Value = parseInt(String(Raw ?? ''), 10);
  return Number.isFinite(Value) && Value > 0 ? Value : DEFAULT_MONITOR_INTERVAL_MS;
}

/**
 * Checks in the given CheckID order. Anything the order does not mention keeps
 * its place after the ones it does; a check added elsewhere mid-drag must not
 * be dropped, since leaving it out of a save deletes it.
 */
export function ReorderChecks<T extends { CheckID: number }>(
  Checks: readonly T[],
  Order: readonly number[] | null | undefined
): T[] {
  if (!Order || !Order.length) return Checks.slice();
  const ById = new Map(Checks.map((Check) => [Number(Check.CheckID), Check]));
  const Result: T[] = [];
  for (const ID of Order) {
    const Check = ById.get(Number(ID));
    if (!Check) continue;
    Result.push(Check);
    ById.delete(Number(ID));
  }
  for (const Check of Checks) {
    if (ById.has(Number(Check.CheckID))) Result.push(Check);
  }
  return Result;
}

/** Whether two CheckID orders differ. */
export function CheckOrderChanged(Before: readonly number[], After: readonly number[]): boolean {
  if (Before.length !== After.length) return true;
  return Before.some((ID, Index) => Number(ID) !== Number(After[Index]));
}

/**
 * The payload for the monitor's settings plus every one of its checks, in
 * `Order` if given. Null when it cannot be saved: a monitor needs a name.
 *
 * The slug travels only when changed and non-empty (a slug never auto-changes),
 * and the group is carried through untouched; it is set by dragging the tile.
 */
export function BuildMonitorUpdatePayload(
  Target: TargetLike,
  Edits: MonitorSettingsEdits,
  Order: readonly number[] | null = null
): MonitorUpdatePayload | null {
  const Nickname = String(Edits.Nickname || '').trim();
  if (!Nickname) return null;

  const Payload: MonitorUpdatePayload = {
    Nickname,
    Interval: ParseMonitorInterval(Edits.Interval),
    GroupID: Target.GroupID == null ? null : Target.GroupID,
    FailureThreshold: Edits.FailureThreshold ?? null,
    Checks: ReorderChecks(Array.isArray(Target.Checks) ? Target.Checks : [], Order).map(
      (Check) => ({
        CheckID: Check.CheckID,
        Name: Check.Name || '',
        Address: String(Check.Address || '').trim(),
        Method: Check.Method,
        Settings: Check.Settings || {},
        DegradedThresholdMs: Math.max(0, Number(Check.DegradedThresholdMs) || 0),
        FailureThreshold: Check.FailureThreshold ?? null,
      })
    ),
  };

  const Slug = String(Edits.Slug || '').trim();
  if (Slug && Slug !== (Target.Slug || '')) Payload.Slug = Slug;
  return Payload;
}
