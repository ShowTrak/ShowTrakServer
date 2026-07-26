// Pure layout and status decisions for the client list.
//
// Extracted from client-list.ts so the rules that decide what the operator
// sees can be tested without a DOM. Everything here takes plain data and
// returns plain data — no jQuery, no `document`, no module state. The rendering
// functions in client-list.ts keep the HTML; these keep the decisions.
//
// The point is not coverage for its own sake. These are the rules that decide
// what colour a tile is mid-show, which clients a group-title click selects,
// and what order tiles appear in after a drag — and every one of them fails
// silently when it is wrong.

import type {
  ClientView,
  DummyClientView,
  GroupView,
  MonitoringTargetView,
} from '@showtrak/protocol';

/** A single tile in a group's merged (clients + monitors + dummies) order. */
export type MergedTileEntry =
  | { kind: 'client'; weight: number; data: ClientView }
  | { kind: 'monitor'; weight: number; data: MonitoringTargetView }
  | { kind: 'dummy'; weight: number; data: DummyClientView };

/** The subset of a settings row this module reads. */
interface SettingRow {
  Key?: string | null;
  Value?: unknown;
}

// --- Status -----------------------------------------------------------------

/**
 * The status word shown in the client-info modal.
 *
 * Identifying wins over everything: the operator has physically asked "which
 * machine is this?" and is looking at the screen for the answer.
 */
export function GetClientStatusDisplayText(Client: Partial<ClientView> | null | undefined): string {
  if (Client && Client.Identifying) return 'Identifying';
  if (Client && Client.Online) return Client.Degraded ? 'Degraded' : 'Online';
  return 'Offline';
}

/**
 * The status word shown on the tile itself.
 *
 * Differs from the above only by knowing about unassigned slots — and the
 * ordering matters: Unassigned is checked AFTER Online, so a slot that somehow
 * has a device reporting in shows its real state rather than a stale
 * reservation label.
 */
export function GetClientCompactStatusLabel(
  Client: Partial<ClientView> | null | undefined
): string {
  if (Client && Client.Identifying) return 'Identifying';
  if (Client && Client.Online) return Client.Degraded ? 'Degraded' : 'Online';
  if (Client && Client.Unassigned) return 'Unassigned';
  return 'Offline';
}

/**
 * The CSS state class for a client tile.
 *
 * A reserved (unassigned) slot has never had a device, so a red "offline" tile
 * would read as a fault for something that is working exactly as intended — it
 * greys out like an idle monitor instead.
 */
export function GetClientTileStateClass(Client: Partial<ClientView> | null | undefined): string {
  if (!Client) return '';
  if (Client.Degraded) return 'DEGRADED';
  if (Client.Online) return 'ONLINE';
  if (Client.Unassigned) return 'IDLE';
  return '';
}

/**
 * The warning line shown on a degraded tile.
 *
 * Only the first warning fits; the rest are in the client-info modal. The
 * fallback exists because a client can be marked degraded by a rule that did
 * not populate a message, and an empty warning band is worse than a generic one.
 */
export function GetTileWarningText(
  Client: Partial<ClientView> | null | undefined,
  Fallback = 'Missing USB Device'
): string {
  const Warnings = Client && Client.DegradedWarnings;
  if (Array.isArray(Warnings) && Warnings.length && Warnings[0] != null) {
    const First = String(Warnings[0]).trim();
    if (First) return First;
  }
  return Fallback;
}

// --- Group layout -----------------------------------------------------------

export const DEFAULT_GROUP_COLUMN_COUNT = 2;
export const MIN_GROUP_COLUMN_COUNT = 2;
export const MAX_GROUP_COLUMN_COUNT = 6;

/**
 * Read the configured group column count, clamped to a layout that works.
 *
 * Fails to the default on anything unparseable: the value comes from a settings
 * row, and a bad one must not be able to produce a zero-column or
 * thousand-column grid.
 */
export function ParseGroupColumnCount(
  Settings: SettingRow[] | null | undefined,
  Key = 'UI_GROUP_COLUMN_COUNT'
): number {
  if (!Array.isArray(Settings)) return DEFAULT_GROUP_COLUMN_COUNT;
  const Row = Settings.find((S) => S && S.Key === Key);
  if (!Row) return DEFAULT_GROUP_COLUMN_COUNT;

  const Count = parseInt(String(Row.Value), 10);
  if (!Number.isFinite(Count)) return DEFAULT_GROUP_COLUMN_COUNT;
  return Math.min(MAX_GROUP_COLUMN_COUNT, Math.max(MIN_GROUP_COLUMN_COUNT, Count));
}

/** Shorten a group title for the vertical group tab. */
export function TruncateGroupLabel(value: string, maxLen = 16): string {
  const text = value == null ? '' : String(value).trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.substring(0, Math.max(1, maxLen - 3))}...`;
}

/**
 * The render order for groups, with the synthetic "No Group" bucket appended
 * and pinned to the bottom.
 *
 * Pinning is by the null GroupID rather than by the weight, so a real group
 * given a very high weight can never sort below the ungrouped bucket and hide
 * itself under it.
 */
export function BuildGroupRenderOrder(
  Groups: GroupView[] | null | undefined,
  Title = 'No Group'
): GroupView[] {
  const Ordered = (Array.isArray(Groups) ? Groups.slice() : []).concat([
    {
      GroupID: null as unknown as number,
      Title,
      Weight: 100000,
      isFullWidth: true,
    } as GroupView,
  ]);

  return Ordered.sort((a, b) => {
    const ADefault = a && a.GroupID == null;
    const BDefault = b && b.GroupID == null;
    if (ADefault !== BDefault) return ADefault ? 1 : -1;
    return (a.Weight || 0) - (b.Weight || 0);
  });
}

/** How many grid columns a group spans. Only narrow groups take a single one. */
export function GetGroupSpan(
  Group: Partial<GroupView> | null | undefined,
  ColumnCount: number
): number {
  return Group && Group.isFullWidth === false ? 1 : ColumnCount;
}

// --- Group membership -------------------------------------------------------

export interface GroupMembers {
  Clients: ClientView[];
  Monitors: MonitoringTargetView[];
  Dummies: DummyClientView[];
}

/**
 * Everything that belongs to one group.
 *
 * Monitors and dummies normalise a falsy GroupID to null before comparing,
 * because a 0 from the database would otherwise never match the ungrouped
 * bucket and the entity would vanish from the layout entirely.
 */
export function SelectGroupMembers(
  GroupID: number | null,
  Clients: ClientView[] | null | undefined,
  Monitors: MonitoringTargetView[] | null | undefined,
  Dummies: DummyClientView[] | null | undefined
): GroupMembers {
  return {
    Clients: (Array.isArray(Clients) ? Clients : [])
      .filter((C) => C && C.GroupID === GroupID)
      .sort((a, b) => (a.Weight || 0) - (b.Weight || 0)),
    Monitors: (Array.isArray(Monitors) ? Monitors : []).filter(
      (M) => M && (M.GroupID || null) === GroupID
    ),
    Dummies: (Array.isArray(Dummies) ? Dummies : []).filter(
      (D) => D && (D.GroupID || null) === GroupID
    ),
  };
}

/**
 * The scoped ids a group-title click should select.
 *
 * These must mirror the tile `data-uuid` values exactly, including the
 * `monitor:` / `dummy:` prefixes from the shared slug-namespace convention —
 * otherwise "select the whole group" quietly selects only the ShowTrak clients
 * and an action the operator believed was group-wide skips everything else.
 */
export function BuildGroupSelectableIDs(Members: GroupMembers): string[] {
  return [
    ...Members.Clients.map((C) => C.UUID),
    ...Members.Monitors.map((M) => `monitor:${M.TargetID}`),
    ...Members.Dummies.map((D) => `dummy:${D.UUID}`),
  ];
}

/**
 * Merge a group's three entity types into one weight-ordered tile list, so a
 * unified order set by drag/drop survives across the types.
 */
export function BuildMergedTiles(Members: GroupMembers): MergedTileEntry[] {
  return ([] as MergedTileEntry[])
    .concat(
      Members.Clients.map((c) => ({ kind: 'client' as const, weight: c.Weight || 0, data: c })),
      Members.Monitors.map((m) => ({ kind: 'monitor' as const, weight: m.Weight || 0, data: m })),
      Members.Dummies.map((d) => ({ kind: 'dummy' as const, weight: d.Weight || 0, data: d }))
    )
    .sort((a, b) => a.weight - b.weight);
}

/**
 * Whether a group should be rendered at all.
 *
 * Only the synthetic ungrouped bucket is hidden when empty — a real group the
 * operator created stays visible so they can drag clients into it.
 */
export function ShouldRenderGroup(GroupID: number | null, Members: GroupMembers): boolean {
  if (GroupID != null) return true;
  return Members.Clients.length > 0 || Members.Monitors.length > 0 || Members.Dummies.length > 0;
}

/**
 * Whether to show the first-run welcome panel: no real groups and nothing of
 * any kind to display. (One group means only the synthetic bucket exists.)
 */
export function ShouldShowWelcomePanel(
  GroupCount: number,
  Clients: unknown[] | null | undefined,
  Monitors: unknown[] | null | undefined,
  Dummies: unknown[] | null | undefined
): boolean {
  return (
    GroupCount === 1 &&
    (Clients || []).length === 0 &&
    (Monitors || []).length === 0 &&
    (Dummies || []).length === 0
  );
}
