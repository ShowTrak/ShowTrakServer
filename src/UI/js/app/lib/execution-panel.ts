// Pure rules for the script execution panel.
//
// Extracted from client-list.ts so the decisions can be tested without a DOM:
// which visual state a row is in, and how the collapsed "completed" section at
// the top of the panel is labelled. The rendering stays in client-list.ts.
//
// Completed rows collapse into that section the moment they finish, so the
// list itself only ever shows what still needs the operator's eye: queued,
// running and failed executions.

import type { ScriptExecutionView } from '@showtrak/protocol';

/** One visual state per row: drives its fill colour, indicator and placement. */
export type ExecutionVisualState = 'pending' | 'running' | 'completed' | 'failed';

/** The subset of an execution these rules read. */
type ExecutionLike = Pick<ScriptExecutionView, 'Status' | 'Progress'>;

/** The client's reported progress, clamped to 0-100 (0 when missing or bad). */
export function GetReportedProgress(Request: ExecutionLike | null | undefined): number {
  const Progress = Request ? Request.Progress : NaN;
  return typeof Progress === 'number' && Number.isFinite(Progress)
    ? Math.max(0, Math.min(100, Progress))
    : 0;
}

/**
 * Classify an execution. Queued and running are both Status 'Pending'; once the
 * client reports the process has spawned (progress reaches the Running stage,
 * 50) the row counts as running.
 */
export function GetExecutionVisualState(
  Request: ExecutionLike | null | undefined
): ExecutionVisualState {
  if (!Request) return 'pending';
  if (Request.Status === 'Completed') return 'completed';
  if (Request.Status === 'Failed') return 'failed';
  return GetReportedProgress(Request) >= 50 ? 'running' : 'pending';
}

/** How many of these executions have completed successfully. */
export function CountCompletedExecutions(
  Executions: ReadonlyArray<ExecutionLike | null | undefined>
): number {
  let Count = 0;
  for (const Request of Executions) {
    if (GetExecutionVisualState(Request) === 'completed') Count++;
  }
  return Count;
}

/** True once nothing is queued or running (every execution has settled). */
export function AllExecutionsSettled(
  Executions: ReadonlyArray<ExecutionLike | null | undefined>
): boolean {
  return (
    Executions.length > 0 &&
    Executions.every((Request) => !!Request && Request.Status !== 'Pending')
  );
}

/**
 * Whether the panel may close itself after the dwell. Only a clean run does: if
 * anything failed, the panel stays up until the operator dismisses it, so a
 * failure is never cleared away while nobody was looking.
 */
export function ShouldAutoDismissExecutions(
  Executions: ReadonlyArray<ExecutionLike | null | undefined>
): boolean {
  return (
    AllExecutionsSettled(Executions) &&
    !Executions.some((Request) => GetExecutionVisualState(Request) === 'failed')
  );
}

/** The completed section's heading, e.g. "212 of 300 completed". */
export function GetCompletedSectionLabel(Completed: number, Total: number): string {
  const Done = Math.max(0, Math.floor(Completed));
  const All = Math.max(Done, Math.floor(Total));
  return Done === All ? `All ${All} completed` : `${Done} of ${All} completed`;
}

/**
 * Name prefix of integrated-device event executions. Mirrors the server's
 * INTEGRATED_EVENT_PREFIX (src/Modules/ScriptExecutionManager/retry.ts); a test
 * keeps the two equal.
 */
export const INTEGRATED_EVENT_PREFIX = 'Integrated Event: ';

/** The subset of an execution the retry rule reads. */
type RetryLike = Pick<ScriptExecutionView, 'Status' | 'Internal'> & {
  Script?: { ID?: string | null; Name?: string | null } | null;
};

/**
 * Whether the panel offers Retry on this execution. Mirrors the server's rule
 * (which stays the authority): a failed script that still exists in the
 * catalog, or a failed integrated-device event. Deployments, Wake on LAN and
 * bulk actions (shutdown, restart, update ...) are never offered.
 */
export function IsRetryableExecution(
  Request: RetryLike | null | undefined,
  KnownScriptIDs: ReadonlySet<string>
): boolean {
  if (!Request || Request.Status !== 'Failed' || !Request.Script) return false;
  if (!Request.Internal) {
    const ID = typeof Request.Script.ID === 'string' ? Request.Script.ID : '';
    return !!ID && KnownScriptIDs.has(ID);
  }
  const Name = typeof Request.Script.Name === 'string' ? Request.Script.Name : '';
  return Name.startsWith(INTEGRATED_EVENT_PREFIX) && Name.length > INTEGRATED_EVENT_PREFIX.length;
}

/** The label of the "retry every failure" button, e.g. "Retry 3 failed". */
export function GetRetryAllLabel(Count: number): string {
  return `Retry ${Count} failed`;
}
