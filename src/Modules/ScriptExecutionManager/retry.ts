// Which failed executions can be retried, and how.
//
// Only actions whose execution row records everything needed to run them again
// are retryable:
//   - scripts: the row carries the script ID; re-run through ExecuteScripts, so
//     the whitelist and per-client queue apply exactly as on the first run;
//   - integrated-device events: the row's name carries the event ID; re-sent
//     through TriggerIntegratedEvent.
// Everything else is left alone: deployments retry themselves whenever a client
// reports an out-of-date fingerprint, Wake on LAN has its own permission on the
// Web UI, and bulk actions (shutdown, restart, update ...) do not record the
// command they sent on the row.
//
// Pure: plain data in, plain data out. The renderer mirrors the same rule
// (src/UI/js/app/lib/execution-panel.ts) to decide where to show the button;
// this one is the authority.

/** Prefix of the execution name used for integrated-device events. */
export const INTEGRATED_EVENT_PREFIX = 'Integrated Event: ';

export type RetryKind = 'script' | 'event';

/** The subset of an execution these rules read. */
export interface RetryCandidate {
  RequestID: string;
  Internal: boolean;
  Status: string;
  Client?: { UUID?: string | null } | null;
  Script?: { ID?: string | null; Name?: string | null } | null;
}

/** How a failed execution would be retried, or null when it cannot be. */
export function GetRetryTarget(
  Execution: RetryCandidate | null | undefined
): { Kind: RetryKind; ID: string } | null {
  if (!Execution || Execution.Status !== 'Failed') return null;
  if (!Execution.Client || !Execution.Client.UUID || !Execution.Script) return null;
  if (!Execution.Internal) {
    const ID = typeof Execution.Script.ID === 'string' ? Execution.Script.ID : '';
    return ID ? { Kind: 'script', ID } : null;
  }
  const Name = typeof Execution.Script.Name === 'string' ? Execution.Script.Name : '';
  if (Name.startsWith(INTEGRATED_EVENT_PREFIX)) {
    const ID = Name.slice(INTEGRATED_EVENT_PREFIX.length);
    return ID ? { Kind: 'event', ID } : null;
  }
  return null;
}

/** One re-dispatch: an action, the clients to run it on, and the rows it replaces. */
export interface RetryGroup {
  Kind: RetryKind;
  ID: string;
  Targets: string[];
  RequestIDs: string[];
}

/**
 * Group the retryable executions by action, so each script or event is
 * re-dispatched once for all of its clients. A client appears at most once per
 * action, however many of its rows failed. Unretryable executions are skipped.
 */
export function PlanRetries(
  Executions: ReadonlyArray<RetryCandidate | null | undefined>
): RetryGroup[] {
  const Groups = new Map<string, RetryGroup>();
  for (const Execution of Executions) {
    const Target = GetRetryTarget(Execution);
    if (!Target || !Execution) continue;
    const Key = `${Target.Kind}:${Target.ID}`;
    let Group = Groups.get(Key);
    if (!Group) {
      Group = { Kind: Target.Kind, ID: Target.ID, Targets: [], RequestIDs: [] };
      Groups.set(Key, Group);
    }
    const UUID = String(Execution.Client!.UUID);
    if (!Group.Targets.includes(UUID)) Group.Targets.push(UUID);
    Group.RequestIDs.push(Execution.RequestID);
  }
  return Array.from(Groups.values());
}
