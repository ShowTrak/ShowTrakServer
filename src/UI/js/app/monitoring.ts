import { AppMode, MonitoringMethodsCache, Selected, Tags } from './state';
import type { MonitoringCheckView, MonitoringTargetView } from '@showtrak/protocol';
import { Safe } from './utils';
import { OfflineBadgeContent } from './lib/status-badges';
import { ResolveEntityTags } from './lib/tag-badges';
import { RenderTagBadgeRow } from './lib/tag-badge-view';
import {
  CheckRowID,
  MonitorCheckDetail,
  MonitorCheckListState,
  MonitorCheckStateClass,
  MonitorListState,
} from './lib/list-view';
import {
  IsTargetExpanded,
  RenderListExpandToggle,
  RenderListRowCells,
  UpdateListRowState,
} from './list-view';
// The bucketing moved to lib/status-blocks so the list view's history column
// shares it; re-exported so every existing importer keeps working.
export {
  BuildOverallStatusBlocks,
  BuildStatusBlocksFromSamples,
  DeriveSampleState,
  FreeKioskReachabilitySamples,
  MONITOR_STATE_SEVERITY,
} from './lib/status-blocks';
export type { StatusBlock, StatusStateCounts } from './lib/status-blocks';

// Formatting and the history modal live in their own modules; re-exported here
// so every existing importer of ./monitoring keeps working.
export * from './lib/monitor-format';
export * from './monitoring-history-modal';
import {
  FormatInterval,
  FormatMonitoringAddressSub,
  FormatMonitoringMethodLabel,
  FormatMonitorStatus,
  FormatMonitorCompactStatus,
  GetMonitoringOfflineSince,
  IsMonitorAwaitingFirstCheck,
} from './lib/monitor-format';

export function RenderMonitoringTargetsSection() {
  // Deprecated: monitoring targets are now rendered inline within their group's
  // drop zone alongside clients. Kept as a no-op for backwards compatibility.
  return '';
}

export function RenderMonitoringTargetTile(T: MonitoringTargetView) {
  const Online = !!T.Online;
  const Degraded = !!T.Degraded;
  const IsIdle = !T.CheckCount;
  const AwaitingFirstCheck = IsMonitorAwaitingFirstCheck(T);
  // A target with no checks and one whose first check has not landed both hold
  // no verdict, so they share the neutral indicator; only the label differs.
  const NoVerdict = IsIdle || AwaitingFirstCheck;
  const Name = T.Nickname || T.Address || 'Unnamed';
  const Sub = FormatMonitoringAddressSub(T);
  const Status = NoVerdict
    ? IsIdle
      ? 'Idle'
      : 'Checking'
    : FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError, Degraded);
  const CompactStatus = FormatMonitorCompactStatus(
    Online,
    T.LastLatencyMs,
    Degraded,
    IsIdle,
    AwaitingFirstCheck
  );
  const OfflineSince = GetMonitoringOfflineSince(T);
  const MethodLabel = FormatMonitoringMethodLabel(T);
  const DragUUID = `monitor:${T.TargetID}`;
  // A monitoring target's scope ID is the same `monitor:<TargetID>` string used
  // as its drag key, so the drag key doubles as the scope lookup here.
  const TagBadges = RenderTagBadgeRow(
    ResolveEntityTags(Tags, { ScopedID: DragUUID, GroupID: T.GroupID ?? null })
  );
  const TileStateClass = Degraded ? 'DEGRADED' : Online ? 'ONLINE' : NoVerdict ? 'IDLE' : '';
  const TextClass = 'text-light';
  const Checks = MonitorChecksInOrder(T);
  const ExpandedClass = Checks.length && IsTargetExpanded(T.TargetID) ? ' CHECKS_EXPANDED' : '';
  return `
    <div id="MONITOR_TILE_${T.TargetID}" class="SHOWTRAK_PC MONITOR ${TileStateClass}${ExpandedClass}${
      Selected.includes(DragUUID) ? ' SELECTED' : ''
    }" data-target-id="${T.TargetID}" data-uuid="${DragUUID}" data-flip-key="${DragUUID}" draggable="${
      AppMode === 'EDIT' ? 'true' : 'false'
    }">
      <button type="button" class="CLIENT_TILE_COG MONITOR_TILE_COG" aria-label="Edit Monitor" title="Edit Monitor">
        <i class="bi bi-gear-fill"></i>
      </button>
      <label class="text-sm ${TagBadges ? 'd-none' : ''}" data-type="Method">${Safe(MethodLabel)} · ${Safe(
        FormatInterval(T.Interval)
      )}</label>
      ${TagBadges}
      <h5 class="mb-0" data-type="Name">${Safe(Name)}</h5>
      <small class="text-sm text-light" data-type="Address">${Safe(Sub)}</small>
      <div class="SHOWTRAK_PC_STATUS ${NoVerdict ? 'd-grid' : 'd-none'}" data-type="INDICATOR_IDLE">
        <h7 class="mb-0 text-light" data-type="MONITOR_IDLE_LABEL">${IsIdle ? 'Idle' : 'Checking'}</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${Online && !NoVerdict ? 'd-grid' : 'd-none'}" data-type="MONITOR_STATUS">
        <h7 class="mb-0 ${TextClass}" data-type="MONITOR_STATUS_LABEL">${Safe(Status)}</h7>
      </div>
      <div class="SHOWTRAK_PC_STATUS ${!Online && !NoVerdict ? 'd-grid' : 'd-none'}" data-type="INDICATOR_OFFLINE">
        <h7 class="mb-0" data-type="OFFLINE_SINCE" data-offlinesince="${Safe(OfflineSince)}">
          ${OfflineBadgeContent()}
        </h7>
      </div>
      <span class="MONITOR_COMPACT_LATENCY ${CompactStatus.color}" data-type="MONITOR_COMPACT_LATENCY">${Safe(CompactStatus.text)}</span>
      ${RenderListExpandToggle(T.TargetID, Checks.length)}
      ${RenderListRowCells(DragUUID, MonitorListState(T))}
    </div>${Checks.map((Check) => RenderMonitorCheckRow(T, Check)).join('')}`;
}

function MonitorChecksInOrder(T: MonitoringTargetView): MonitoringCheckView[] {
  return (Array.isArray(T.Checks) ? T.Checks : [])
    .filter((Check) => Check && Check.CheckID != null)
    .slice()
    .sort((a, b) => (a.Weight || 0) - (b.Weight || 0));
}

function MonitorCheckName(Check: MonitoringCheckView): string {
  const MethodMeta = MonitoringMethodsCache.find((m) => m.ID === Check.Method);
  return Check.Name || (MethodMeta && MethodMeta.Name) || String(Check.Method || '').toUpperCase();
}

/**
 * One check of a target, as a row of the list view. A sibling of the target's
 * tile rather than a child, so the target row keeps its own height and colour;
 * hidden outside the list and while the target is collapsed. Selectable as
 * `check:<CheckID>`. Never draggable: a check moves with its target.
 */
function RenderMonitorCheckRow(T: MonitoringTargetView, Check: MonitoringCheckView): string {
  const ID = CheckRowID(Check.CheckID);
  const Collapsed = IsTargetExpanded(T.TargetID) ? '' : ' is-collapsed';
  const SelectedClass = Selected.includes(ID) ? ' SELECTED' : '';
  // Shown as selected while its target is (see MarkCheckRowsOf in selection.ts).
  const ParentClass = Selected.includes(`monitor:${T.TargetID}`) ? ' PARENT_SELECTED' : '';
  return `
    <div id="MONITOR_CHECK_${Check.CheckID}" class="SHOWTRAK_PC MONITOR_CHECK ${MonitorCheckStateClass(
      Check
    )}${SelectedClass}${ParentClass}${Collapsed}" data-uuid="${ID}" data-check-id="${Check.CheckID}" data-target-id="${
      T.TargetID
    }" data-flip-key="${ID}" draggable="false">
      <h5 class="mb-0" data-type="Name">${Safe(MonitorCheckName(Check))}</h5>
      <label class="text-sm" data-type="Method">${Safe(String(Check.Method || '').toUpperCase())} · ${Safe(
        FormatInterval(T.Interval)
      )}</label>
      <small class="text-sm text-light" data-type="Address">${Safe(Check.Address || '')}</small>
      <div class="SHOWTRAK_PC_STATUS d-grid" data-type="CHECK_DETAIL">
        <h7 class="mb-0 text-light" data-type="CHECK_DETAIL_TEXT">${Safe(MonitorCheckDetail(Check))}</h7>
      </div>
      ${RenderListRowCells(ID, MonitorCheckListState(Check))}
    </div>`;
}

/** Patch a target's check rows in place from a live update. */
function UpdateMonitorCheckRows(T: MonitoringTargetView): void {
  for (const Check of MonitorChecksInOrder(T)) {
    const $row = $(`#MONITOR_CHECK_${Check.CheckID}`);
    if (!$row.length) continue;
    const StateClass = MonitorCheckStateClass(Check);
    $row
      .toggleClass('ONLINE', StateClass === 'ONLINE')
      .toggleClass('DEGRADED', StateClass === 'DEGRADED')
      .toggleClass('IDLE', StateClass === 'IDLE');
    $row.children('[data-type="Name"]').text(MonitorCheckName(Check));
    $row.children('[data-type="Address"]').text(Check.Address || '');
    $row.find('[data-type="CHECK_DETAIL_TEXT"]').text(MonitorCheckDetail(Check));
    UpdateListRowState($row, MonitorCheckListState(Check));
  }
}

export function UpdateMonitoringTargetTile(T: MonitoringTargetView) {
  const $tile = $(`#MONITOR_TILE_${T.TargetID}`);
  if (!$tile.length) return;
  const Online = !!T.Online;
  const Degraded = !!T.Degraded;
  const IsIdle = !T.CheckCount;
  const AwaitingFirstCheck = IsMonitorAwaitingFirstCheck(T);
  const NoVerdict = IsIdle || AwaitingFirstCheck;
  $tile.toggleClass('ONLINE', Online && !Degraded);
  $tile.toggleClass('DEGRADED', Degraded);
  $tile.toggleClass('IDLE', NoVerdict);
  const Name = T.Nickname || T.Address || 'Unnamed';
  $tile.find('[data-type="Name"]').text(Name);
  $tile.find('[data-type="Address"]').text(FormatMonitoringAddressSub(T));
  $tile
    .find('[data-type="Method"]')
    .text(`${FormatMonitoringMethodLabel(T)} · ${FormatInterval(T.Interval)}`);
  $tile.find('[data-type="MONITOR_IDLE_LABEL"]').text(IsIdle ? 'Idle' : 'Checking');
  const Status = FormatMonitorStatus(Online, T.LastLatencyMs, T.LastError, Degraded);
  const CompactStatus = FormatMonitorCompactStatus(
    Online,
    T.LastLatencyMs,
    Degraded,
    IsIdle,
    AwaitingFirstCheck
  );
  const $label = $tile.find('[data-type="MONITOR_STATUS_LABEL"]');
  $label.text(Status);
  $label.removeClass('text-success text-warning').addClass('text-light');
  const $compact = $tile.find('[data-type="MONITOR_COMPACT_LATENCY"]');
  $compact.text(CompactStatus.text);
  $compact.removeClass('text-light text-success text-warning').addClass(CompactStatus.color);
  const ToggleIndicator = (Type: string, Show: boolean) => {
    $tile
      .find(`.SHOWTRAK_PC_STATUS[data-type="${Type}"]`)
      .toggleClass('d-grid', Show)
      .toggleClass('d-none', !Show);
  };
  ToggleIndicator('INDICATOR_IDLE', NoVerdict);
  ToggleIndicator('MONITOR_STATUS', Online && !NoVerdict);
  ToggleIndicator('INDICATOR_OFFLINE', !Online && !NoVerdict);
  $tile.find('[data-type="OFFLINE_SINCE"]').attr('data-offlinesince', GetMonitoringOfflineSince(T));
  UpdateListRowState($tile, MonitorListState(T));
  UpdateMonitorCheckRows(T);
}
