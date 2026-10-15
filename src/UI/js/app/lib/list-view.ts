// Pure decisions behind the Grid / Compact / List view switch and the list
// view's rows. No DOM, no module state: the list view's DOM wiring lives in
// ../list-view.ts and keeps the markup; this keeps the rules.
import type {
  ClientView,
  DummyClientView,
  FreeKioskTerminalView,
  MonitoringCheckView,
  MonitoringTargetView,
  StatusHistoryOverview,
} from '@showtrak/protocol';
import type { ViewMode } from '../state/ui-drafts';
import {
  BuildOverallStatusBlocks,
  BuildStatusBlocksFromSamples,
  FreeKioskReachabilitySamples,
  type StatusBlock,
} from './status-blocks';

export const VIEW_MODE_ORDER: readonly ViewMode[] = ['grid', 'compact', 'list'];

/** A stored view mode, or null when the value is not one. */
export function ParseViewMode(Value: unknown): ViewMode | null {
  const Text = typeof Value === 'string' ? Value.trim().toLowerCase() : '';
  return (VIEW_MODE_ORDER as readonly string[]).includes(Text) ? (Text as ViewMode) : null;
}

/**
 * The view mode to start in.
 *
 * The three-way setting wins when it is set. Before it existed the only choice
 * was compact on/off, stored under its own key, so an operator who had compact
 * on keeps it the first time they open a build with List in it.
 */
export function ResolveStoredViewMode(
  StoredViewMode: unknown,
  LegacyCompactFlag: unknown
): ViewMode {
  return ParseViewMode(StoredViewMode) ?? (LegacyCompactFlag === '1' ? 'compact' : 'grid');
}

/** Ctrl/Cmd+E steps through the modes in the order the switch shows them. */
export function NextViewMode(Current: ViewMode): ViewMode {
  const Index = VIEW_MODE_ORDER.indexOf(Current);
  return VIEW_MODE_ORDER[(Index + 1) % VIEW_MODE_ORDER.length] ?? 'grid';
}

// --- Row state words --------------------------------------------------------
//
// The list view's Status column states each row's verdict in a word, beside the
// row colour that already carries it — the word is what survives a colour-blind
// operator or a washed-out projector. Each mirrors the tile's own state class
// so the word and the colour can never disagree. (A ShowTrak client's word is
// GetClientCompactStatusLabel, which already exists for the compact tile.)

/** Mirrors RenderMonitoringTargetTile's NoVerdict / Online / Degraded split. */
export function MonitorListState(T: Partial<MonitoringTargetView> | null | undefined): string {
  if (!T) return 'Offline';
  if (!T.CheckCount) return 'Idle';
  // Checks configured but none has answered yet: not yet known, not down.
  if (T.LastChecked == null) return 'Checking';
  if (T.Degraded) return 'Degraded';
  return T.Online ? 'Online' : 'Offline';
}

/** Mirrors RenderDummyClientTile's state class. */
export function DummyListState(D: Partial<DummyClientView> | null | undefined): string {
  if (!D) return 'Offline';
  if (D.Degraded) return 'Degraded';
  if (D.Online) return 'Online';
  return String(D.State || 'IDLE') === 'IDLE' ? 'Idle' : 'Offline';
}

// --- Check rows -------------------------------------------------------------
//
// In the list a monitoring target can be expanded into one row per check. A
// check row's selection id is `check:<CheckID>`, in the same prefixed
// namespace as `monitor:` / `dummy:` / `kiosk:`, so the selection, the context
// menu and the history column treat it like any other row.

export const CHECK_SELECTION_PREFIX = 'check:';

/** The selection id (and history key) of a check row. */
export function CheckRowID(CheckID: number | string): string {
  return `${CHECK_SELECTION_PREFIX}${CheckID}`;
}

/** A check that has not completed a probe yet has no verdict: not yet known, not down. */
export function MonitorCheckListState(
  Check: Partial<MonitoringCheckView> | null | undefined
): string {
  if (!Check || Check.LastChecked == null) return 'Checking';
  if (Check.Degraded) return 'Degraded';
  return Check.Online ? 'Online' : 'Offline';
}

/** The row's state class: the same classes, and so the same colours, as a tile. */
export function MonitorCheckStateClass(
  Check: Partial<MonitoringCheckView> | null | undefined
): string {
  if (!Check || Check.LastChecked == null) return 'IDLE';
  if (Check.Degraded) return 'DEGRADED';
  return Check.Online ? 'ONLINE' : '';
}

/**
 * The Details cell: latency while it answers, the reason while it is degraded
 * or down. Nothing while the first probe is outstanding — the State column
 * already says "Checking".
 */
export function MonitorCheckDetail(Check: Partial<MonitoringCheckView> | null | undefined): string {
  if (!Check || Check.LastChecked == null) return '';
  const Reason = typeof Check.LastError === 'string' ? Check.LastError.trim() : '';
  if (Check.Degraded || !Check.Online) return Reason;
  const Latency = Number(Check.LastLatencyMs);
  if (Check.LastLatencyMs == null || !Number.isFinite(Latency)) return '';
  return Latency < 1 ? '<1ms' : `${Math.round(Latency)}ms`;
}

/** Mirrors the FreeKiosk tile's state class. */
export function FreeKioskListState(K: Partial<FreeKioskTerminalView> | null | undefined): string {
  const State = String((K && K.State) || 'IDLE');
  if (State === 'ONLINE') return 'Online';
  if (State === 'DEGRADED') return 'Degraded';
  if (State === 'OFFLINE') return 'Offline';
  return 'Idle';
}

// --- History column ---------------------------------------------------------

export interface ListHistoryEntities {
  Clients: Pick<ClientView, 'UUID'>[];
  Monitors: Pick<MonitoringTargetView, 'TargetID' | 'Checks'>[];
  Dummies: Pick<DummyClientView, 'UUID'>[];
  Kiosks: Pick<FreeKioskTerminalView, 'UUID'>[];
}

/**
 * One overall-status timeline per row, keyed by the row's data-uuid (the same
 * client UUID / `monitor:` / `dummy:` / `kiosk:` ids the tiles carry), built
 * exactly as the view modal's Status tab builds it:
 *
 *   - a client or dummy client: its own status series;
 *   - a monitoring target: its checks combined (BuildOverallStatusBlocks), so
 *     the row reads the target's verdict rather than any one check's — and
 *     each check its own series, under `check:<CheckID>`, for its own row;
 *   - a FreeKiosk terminal: its reachability (poll latency) series.
 *
 * Every entity gets a timeline, even with no samples (an all-grey one), so a
 * row never shows an empty cell once history has loaded.
 */
export function BuildListHistoryBlocks(
  Overview: Partial<StatusHistoryOverview> | null | undefined,
  Entities: ListHistoryEntities,
  Now: number
): Map<string, StatusBlock[]> {
  const Clients = (Overview && Overview.Clients) || {};
  const Dummies = (Overview && Overview.Dummies) || {};
  const Checks = (Overview && Overview.Checks) || {};
  const Kiosks = (Overview && Overview.Kiosks) || {};
  const Out = new Map<string, StatusBlock[]>();

  for (const C of Entities.Clients || []) {
    if (!C || !C.UUID) continue;
    Out.set(String(C.UUID), BuildStatusBlocksFromSamples(Clients[C.UUID] || [], Now));
  }
  for (const D of Entities.Dummies || []) {
    if (!D || !D.UUID) continue;
    Out.set(`dummy:${D.UUID}`, BuildStatusBlocksFromSamples(Dummies[D.UUID] || [], Now));
  }
  for (const T of Entities.Monitors || []) {
    if (!T || T.TargetID == null) continue;
    const PerCheck = (Array.isArray(T.Checks) ? T.Checks : [])
      .filter((Check) => Check && Check.CheckID != null)
      .map((Check) => {
        const Blocks = BuildStatusBlocksFromSamples(Checks[String(Check.CheckID)] || [], Now);
        // Each check's own row, when the target is expanded.
        Out.set(CheckRowID(Check.CheckID), Blocks);
        return Blocks;
      });
    Out.set(
      `monitor:${T.TargetID}`,
      PerCheck.length
        ? BuildOverallStatusBlocks(PerCheck, Now)
        : BuildStatusBlocksFromSamples([], Now)
    );
  }
  for (const K of Entities.Kiosks || []) {
    if (!K || !K.UUID) continue;
    Out.set(
      `kiosk:${K.UUID}`,
      BuildStatusBlocksFromSamples(FreeKioskReachabilitySamples(Kiosks[K.UUID] || [], Now), Now)
    );
  }
  return Out;
}
