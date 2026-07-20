// FOG Project task type catalogue.
//
// Verified against FOG source at tag 1.5.10.1903 (`packages/web/commons/schema.php`,
// `taskTypes` seed) rather than the published docs, which disagree with the schema in
// several places. Two traps worth recording here so they are not re-litigated:
//
//   * There is no task type 9. The IDs are genuinely non-contiguous.
//   * FOG's own news post claims 12 = Single Snapin and 13 = All Snapins. The schema
//     says the opposite, and the news post's own curl example contradicts its prose.
//     The schema wins: 12 = All Snapins, 13 = Single Snapin.
//
// The `ttIsAccess` column decides whether a type may be scheduled against a host, a
// group, or both. The API does NOT enforce this — `Route::task()` only checks that the
// TaskType row exists, so posting a group-only type to a host endpoint is accepted and
// then misbehaves downstream. We only ever schedule against hosts, so group-only types
// are excluded from this table entirely.

export interface FogTaskType {
  TaskTypeID: number;
  Name: string;
  // Destructive types are defaulted off and called out in the confirmation step.
  Destructive: boolean;
  // Type 13 targets one specific snapin and needs its ID passed as `deploySnapins`.
  RequiresSnapinID?: boolean;
  // Imaging tasks (Deploy/Capture) stream a partclone percentage FOG reports as it
  // runs, so a progress bar is meaningful. Every other type is effectively opaque —
  // it flips straight from queued to complete — so the panel shows only its state.
  SupportsProgress?: boolean;
}

// Host-schedulable task types only. Type 8 (Multi-Cast) is deliberately absent: it is
// group-only in the FOG schema and cannot be scheduled against a single host.
export const FOG_TASK_TYPES: FogTaskType[] = [
  { TaskTypeID: 1, Name: 'Deploy', Destructive: true, SupportsProgress: true },
  { TaskTypeID: 2, Name: 'Capture', Destructive: true, SupportsProgress: true },
  { TaskTypeID: 3, Name: 'Debug', Destructive: false },
  { TaskTypeID: 4, Name: 'Memtest86+', Destructive: false },
  { TaskTypeID: 5, Name: 'Test Disk', Destructive: false },
  { TaskTypeID: 6, Name: 'Disk Surface Test', Destructive: false },
  { TaskTypeID: 7, Name: 'Recover', Destructive: true },
  { TaskTypeID: 10, Name: 'Hardware Inventory', Destructive: false },
  { TaskTypeID: 11, Name: 'Password Reset', Destructive: true },
  { TaskTypeID: 12, Name: 'All Snapins', Destructive: false },
  { TaskTypeID: 13, Name: 'Single Snapin', Destructive: false, RequiresSnapinID: true },
  { TaskTypeID: 14, Name: 'Wake-Up', Destructive: false },
  { TaskTypeID: 15, Name: 'Deploy - Debug', Destructive: true, SupportsProgress: true },
  { TaskTypeID: 16, Name: 'Capture - Debug', Destructive: true, SupportsProgress: true },
  { TaskTypeID: 17, Name: 'Deploy - No Snapins', Destructive: true, SupportsProgress: true },
  { TaskTypeID: 18, Name: 'Fast Wipe', Destructive: true },
  { TaskTypeID: 19, Name: 'Normal Wipe', Destructive: true },
  { TaskTypeID: 20, Name: 'Full Wipe', Destructive: true },
  { TaskTypeID: 21, Name: 'Virus Scan', Destructive: false },
  { TaskTypeID: 22, Name: 'Virus Scan - Quarantine', Destructive: false },
];

export function GetFogTaskType(TaskTypeID: number): FogTaskType | null {
  return FOG_TASK_TYPES.find((Type) => Type.TaskTypeID === TaskTypeID) || null;
}

// Whether the panel should render a progress bar for a task of this type.
export function FogTaskSupportsProgress(TaskTypeID: number): boolean {
  return !!GetFogTaskType(TaskTypeID)?.SupportsProgress;
}

// Settings key granting permission to schedule one task type. Keyed by ID rather than
// by name so the mapping survives FOG renaming a type (17 was renamed once already).
export function FogTaskPermissionKey(TaskTypeID: number): string {
  return `FOG_ALLOW_TASK_${TaskTypeID}`;
}

// FOG task state IDs, from the `taskStates` seed. `/fog/task/active` filters on
// stateID IN (0,1,2,3) — note it includes 0, which has no row in the states table.
export const FOG_TASK_STATES: Record<number, string> = {
  0: 'Pending',
  1: 'Queued',
  2: 'Checked In',
  3: 'In Progress',
  4: 'Complete',
  5: 'Cancelled',
};

export function GetFogTaskStateName(StateID: number): string {
  return FOG_TASK_STATES[StateID] || `Unknown (${StateID})`;
}

// How often the backend polls FOG for active tasks while the integration is healthy.
export const FOG_TASK_POLL_INTERVAL_MS = 30000;

// Health checks are cheap, but a dead FOG server should not be hammered every 30s.
// The poller backs off to this interval after a failure and returns to the normal
// interval on the first success.
export const FOG_UNHEALTHY_POLL_INTERVAL_MS = 120000;

// Requests are aborted at this point so a black-holed FOG host cannot wedge the poller.
export const FOG_REQUEST_TIMEOUT_MS = 10000;
