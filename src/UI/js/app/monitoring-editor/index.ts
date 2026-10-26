// Monitoring target editor (renderer): the multi-check editor itself.
//
// Owns the editor's working state and the flow around it: the check list, the
// per-check edit view, the live status/debug panels, payload building and the
// debounced autosave.
//
// This file was 1581 lines. Two self-contained concerns now live alongside it:
//
//   ./method-fields       schema -> form fields, validation, the info panel
//   ./network-discovery   the "scan my network" modal
//
// Both are re-exported below so every existing `from './monitoring-editor'`
// import keeps working unchanged.
//
// The live status card and the autosave path deliberately stayed together here:
// the status card flushes a pending save before re-probing, and the commit path
// schedules a status re-run, so separating them would trade one large module for
// two that import each other.
import { closeModal, openModal } from '../lib/modal';
import { buildModalHeader } from '../lib/modal-header';
import type { MonitoringCheckDebug, MonitoringTargetView } from '@showtrak/protocol';
import type { MonitoringEditorCheck } from '../state';
import {
  MonitoringEditorState,
  MonitoringMethodsCache,
  MonitoringTargets,
  __LastGroups,
  setMonitoringEditorState,
  setMonitoringEditorTargetID,
} from '../state';
import { ErrorMessage, HandleNonFatalError, Safe } from '../utils';
import { FormatInterval, OpenMonitoringTargetHistory } from '../monitoring';
import { CloseAllModals } from '../modals';
import { ConfirmationDialog, Notify, Wait } from '../selection-init';
import { RenderTagPicker } from '../tag-picker';
import type { TagPickerMount } from '../tag-picker';
import {
  AddMonitoringListChip,
  ApplyMonitoringConditionalVisibility,
  ApplyMonitoringMethodCapabilities,
  CollectMonitoringCheckDynamicSettings,
  EnsureMonitoringMethodsLoaded,
  RenderMonitoringCheckDynamicSettings,
  RenderMonitoringCheckInfo,
  RenderMonitoringMethodOptions,
  ValidateMonitoringField,
  ValidateMonitoringRequiredFields,
  setFieldEditedHandler,
} from './method-fields';

// Re-exported so `from './monitoring-editor'` continues to resolve every symbol
// this module used to define directly.
export * from './method-fields';
export * from './network-discovery';

// --- Failure threshold ------------------------------------------------------
//
// How many failed probes in a row a check needs before it reads offline. Both
// the target and each check can override it; null means "inherit" (check ->
// target -> the server-wide MONITORING_FAILURE_THRESHOLD setting).

export const MAX_FAILURE_THRESHOLD = 10;

// Server-wide default, refreshed each time the editor opens. Falls back to 1
// (the historical behaviour) if the setting cannot be read.
let GlobalFailureThreshold = 1;

/** Refresh and return the server-wide failure threshold. */
export async function LoadGlobalFailureThreshold(): Promise<number> {
  try {
    // Imported lazily: ../settings pulls in the audio stack at module load, and
    // a static import here would drag that into every importer of the editor.
    const { GetSettingValue } = await import('../settings');
    const Value = Number(await GetSettingValue('MONITORING_FAILURE_THRESHOLD'));
    if (Number.isInteger(Value) && Value >= 1) GlobalFailureThreshold = Value;
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:LoadGlobalFailureThreshold', err);
  }
  return GlobalFailureThreshold;
}

// '' (inherit) or a whole number 1–10 from a threshold <select>.
export function ParseFailureThreshold(Raw: unknown): number | null {
  const n = parseInt(String(Raw ?? ''), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_FAILURE_THRESHOLD, Math.max(1, n));
}

export function FailureThresholdLabel(n: number): string {
  return n <= 1 ? 'First failure' : `${n} failures in a row`;
}

// Option list for a threshold <select>: an "inherit" entry naming the value it
// resolves to, then every explicit value.
export function FailureThresholdOptions(InheritPrefix: string, Inherited: number) {
  const Options = [{ value: '', label: `${InheritPrefix} (${FailureThresholdLabel(Inherited)})` }];
  for (let n = 1; n <= MAX_FAILURE_THRESHOLD; n++) {
    Options.push({ value: String(n), label: FailureThresholdLabel(n) });
  }
  return Options;
}

export function RenderFailureThresholdSelect(
  Selector: string,
  InheritPrefix: string,
  Inherited: number,
  Value: number | null
) {
  const $select = $(Selector);
  $select.empty();
  for (const Option of FailureThresholdOptions(InheritPrefix, Inherited)) {
    $select.append($('<option></option>').attr('value', Option.value).text(Option.label));
  }
  $select.val(Value == null ? '' : String(Value));
}

// "Missed 1 of 3" for a check that has failed but not yet enough times to read
// offline; empty when there is nothing pending.
export function DescribeMissedChecks(
  ConsecutiveFailures: unknown,
  Threshold: unknown,
  Online: unknown
): string {
  const Missed = Number(ConsecutiveFailures) || 0;
  const Needed = Number(Threshold) || 1;
  if (Missed <= 0 || Needed <= 1) return '';
  // Once a check is offline the run is the outage itself, not a warning.
  if (Online === false && Missed >= Needed) return '';
  return `Missed ${Math.min(Missed, Needed)} of ${Needed}`;
}

// --- Multi-check monitoring target editor ---------------------------------

// Locate the persisted target (if any) in the live cache so we can surface each
// check's current runtime status in the list view.
export function GetLiveMonitoringTarget() {
  const State = MonitoringEditorState;
  if (!State || State.TargetID == null) return null;
  return MonitoringTargets.find((t) => Number(t.TargetID) === Number(State.TargetID)) || null;
}

export function FindLiveMonitoringCheck(check: MonitoringEditorCheck) {
  const target = GetLiveMonitoringTarget();
  if (!target || !Array.isArray(target.Checks) || check.CheckID == null) return null;
  return target.Checks.find((c) => Number(c.CheckID) === Number(check.CheckID)) || null;
}

export function SetMonitoringSaveHint(text: string, cls: string | null) {
  const $h = $('#MONITORING_TARGET_SAVE_HINT');
  const value = String(text || '').trim();
  $h.text('');
  $h.removeClass('text-muted text-danger text-success');
  $h.addClass('d-none');

  // Monitoring editor feedback should use the global notification system, not
  // inline hints in the modal footer.
  const HintState = SetMonitoringSaveHint as unknown as { LastNotified?: string };
  if (!value) {
    HintState.LastNotified = '';
    return;
  }

  const type = cls === 'text-danger' ? 'error' : cls === 'text-success' ? 'success' : 'info';
  const signature = `${type}:${value}`;
  if (HintState.LastNotified === signature) return;
  HintState.LastNotified = signature;
  Notify(value, type);
}

export function RenderMonitoringCheckList() {
  const $host = $('#MONITORING_TARGET_CHECK_LIST');
  $host.empty();
  const checks = (MonitoringEditorState && MonitoringEditorState.Checks) || [];
  if (!checks.length) {
    $host.append(
      '<div class="bg-ghost rounded p-3 text-muted text-center" data-type="NO_CHECKS_PLACEHOLDER">No checks yet</div>'
    );
    return;
  }
  checks.forEach((check, index) => {
    const live = FindLiveMonitoringCheck(check);
    const method = String(check.Method || '').toUpperCase();
    // Fall back to the method's friendly name when no label has been set.
    const methodMeta = MonitoringMethodsCache.find((m) => m.ID === check.Method);
    const methodName = (methodMeta && methodMeta.Name) || method || 'Unnamed check';
    const name = check.Name || methodName;
    const ip = check.Address || '';
    // Badge colour conveys the live status (online / degraded / offline); checks
    // that haven't run yet keep the neutral badge.
    let badgeClass = 'bg-ghost-light text-light';
    let badgeTitle = 'Not checked yet';
    const missed = live
      ? DescribeMissedChecks(live.ConsecutiveFailures, live.EffectiveFailureThreshold, live.Online)
      : '';
    if (live && live.LastChecked != null) {
      if (!live.Online) {
        badgeClass = 'bg-danger text-light';
        badgeTitle = 'Offline';
      } else if (live.Degraded) {
        badgeClass = 'bg-warning text-dark';
        badgeTitle = 'Degraded';
      } else {
        badgeClass = 'bg-success text-light';
        badgeTitle = 'Online';
      }
    }
    $host.append(`
      <div class="d-flex align-items-center gap-2 bg-ghost rounded p-2 monitoring-check-row" data-index="${index}" role="button">
        <div class="flex-grow-1 text-start">
          <div class="text-light" data-type="CHECK_NAME">${Safe(name)}</div>
          ${ip ? `<small class="text-muted" data-type="CHECK_IP">${Safe(ip)}</small>` : ''}
          ${missed ? `<small class="text-warning ms-2" data-type="CHECK_MISSED">${Safe(missed)}</small>` : ''}
        </div>
        <div class="d-flex align-items-center">
          <span class="badge ${badgeClass}" data-type="CHECK_METHOD" title="${Safe(badgeTitle)}">${Safe(method)}</span>
        </div>
        <i class="bi bi-chevron-right text-light MONITORING_CHECK_EDIT" data-index="${index}" role="button" aria-label="Edit Check" style="cursor: pointer;"></i>
      </div>`);
  });
}

export function ShowMonitoringListView() {
  if (!MonitoringEditorState) return;
  MonitoringEditorState.View = 'list';
  MonitoringEditorState.EditingIndex = null;
  $('#MONITORING_TARGET_CHECK_VIEW').addClass('d-none');
  $('#MONITORING_TARGET_LIST_VIEW').removeClass('d-none');
  RenderMonitoringCheckList();
}

export function CloseMonitoringCheckCollapses() {
  const IDs = ['MONITORING_CHECK_ADVANCED', 'MONITORING_CHECK_DEBUG_COLLAPSE'];
  IDs.forEach((ID) => {
    const El = document.getElementById(ID);
    if (!El) return;
    if (typeof bootstrap !== 'undefined' && bootstrap.Collapse) {
      bootstrap.Collapse.getOrCreateInstance(El, { toggle: false }).hide();
      return;
    }
    El.classList.remove('show');
  });
}

export function OpenMonitoringCheckView(index: number) {
  if (!MonitoringEditorState) return;
  const check = MonitoringEditorState.Checks[index];
  if (!check) return;
  MonitoringEditorState.EditingIndex = index;
  MonitoringEditorState.View = 'check';

  $('#MONITORING_CHECK_VIEW_TITLE').text(check.CheckID != null ? 'Edit Check' : 'New Check');
  $('#MONITORING_CHECK_NAME').val(check.Name || '');
  $('#MONITORING_CHECK_ADDRESS').val(check.Address || '');

  const $method = $('#MONITORING_CHECK_METHOD');
  $method.empty();
  RenderMonitoringMethodOptions($method);
  $method.val(check.Method || (MonitoringMethodsCache[0] && MonitoringMethodsCache[0].ID) || '');

  $('#MONITORING_CHECK_DEGRADED_THRESHOLD').val(
    Number.isFinite(Number(check.DegradedThresholdMs)) ? Number(check.DegradedThresholdMs) : 0
  );
  RenderFailureThresholdSelect(
    '#MONITORING_CHECK_FAILURE_THRESHOLD',
    'Same as target',
    MonitoringEditorState.FailureThreshold ?? GlobalFailureThreshold,
    check.FailureThreshold ?? null
  );

  RenderMonitoringCheckInfo($method.val());
  ApplyMonitoringMethodCapabilities($method.val());
  RenderMonitoringCheckDynamicSettings($method.val(), check.Settings || {});

  $('#MONITORING_TARGET_LIST_VIEW').addClass('d-none');
  $('#MONITORING_TARGET_CHECK_VIEW').removeClass('d-none');
  CloseMonitoringCheckCollapses();

  // Reset then (re)load the live "last response" debug panel for this check.
  $('#MONITORING_CHECK_DEBUG_META').text('');
  $('#MONITORING_CHECK_DEBUG_BODY').html(
    '<div class="text-muted small fst-italic">Loading latest response...</div>'
  );
  LoadMonitoringCheckDebug();
  // Populate the live status card with the current known status (no re-probe).
  $('#MONITORING_CHECK_STATUS').addClass('d-none').empty();
  RefreshMonitoringCheckStatus({ run: false });
}

// Render the memory-only per-check debug payload returned by the server. The
// Html comes from the method module (which escapes any untrusted values), so it
// is safe to inject directly.
export function RenderMonitoringCheckDebug(payload: MonitoringCheckDebug | null) {
  const $body = $('#MONITORING_CHECK_DEBUG_BODY');
  const $meta = $('#MONITORING_CHECK_DEBUG_META');
  if (!$body.length) return;

  if (!payload || (payload.LastChecked == null && !payload.Html)) {
    $meta.text('');
    $body.html(
      '<div class="text-muted small fst-italic">Waiting for the first check to run...</div>'
    );
    return;
  }

  let statusText = 'Online';
  if (payload.LastChecked == null) statusText = 'Checking';
  else if (!payload.Online) statusText = 'Offline';
  else if (payload.Degraded) statusText = 'Degraded';
  const missed = DescribeMissedChecks(
    payload.ConsecutiveFailures,
    payload.EffectiveFailureThreshold,
    payload.Online
  );
  if (missed) statusText += ` · ${missed}`;

  let when = '';
  if (payload.LastChecked) {
    try {
      when = new Date(Number(payload.LastChecked)).toLocaleTimeString();
    } catch {
      when = '';
    }
  }
  $meta.text(when ? `${statusText} · ${when}` : statusText);

  if (payload.Html) {
    $body.html(payload.Html);
  } else {
    $body.html('<div class="text-muted small fst-italic">No response details available yet.</div>');
  }
}

// Fetch the latest debug snapshot for the check currently open in the editor.
export async function LoadMonitoringCheckDebug() {
  const $body = $('#MONITORING_CHECK_DEBUG_BODY');
  if (!$body.length) return;
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const index = MonitoringEditorState.EditingIndex;
  const check = index == null ? null : MonitoringEditorState.Checks[index];
  if (!check) return;

  if (check.CheckID == null) {
    $('#MONITORING_CHECK_DEBUG_META').text('');
    $body.html(
      '<div class="text-muted small fst-italic">Save this check to see its latest response.</div>'
    );
    return;
  }

  const requestedCheckID = check.CheckID;
  let payload = null;
  try {
    payload = await window.API.GetMonitoringCheckDebug(requestedCheckID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:LoadMonitoringCheckDebug', err);
    return;
  }

  // The user may have navigated away or switched checks while we awaited.
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const curIndex = MonitoringEditorState.EditingIndex;
  const curCheck = curIndex == null ? null : MonitoringEditorState.Checks[curIndex];
  if (!curCheck || Number(curCheck.CheckID) !== Number(requestedCheckID)) return;

  RenderMonitoringCheckDebug(payload);
}

// Called from the live MonitoringTargetUpdated feed so the open check editor's
// debug panel refreshes as new probe results arrive.
export function RefreshMonitoringCheckDebugIfOpen(TargetID: number) {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  if (MonitoringEditorState.TargetID == null) return;
  if (Number(MonitoringEditorState.TargetID) !== Number(TargetID)) return;
  LoadMonitoringCheckDebug();
  // Reflect the fresh live status in the status card too (without re-probing).
  RefreshMonitoringCheckStatus({ run: false });
}

// --- Live status card (below the info panel) --------------------------------
// A compact card that shows the open check's current status. It re-runs the check
// on a 500ms debounce after each edit (see CommitMonitoringCheckView) IF the
// settings are valid; when they're invalid it lists which fields need fixing
// instead of running.

let MonitoringStatusRunTimer: ReturnType<typeof setTimeout> | null = null;

// Set when the check editor was opened from a monitor's Settings tab: Back (and
// deleting the check) then return there instead of to this modal's list view.
let ReturnToMonitorView = false;

// Status kinds map to the client-status background tints (see monitoring.css).
const MON_STATUS_KINDS = ['online', 'degraded', 'offline', 'idle'] as const;

// Schedule a debounced (500ms) live re-run of the open check's status card.
export function ScheduleMonitoringCheckStatusRun() {
  if (MonitoringStatusRunTimer) clearTimeout(MonitoringStatusRunTimer);
  MonitoringStatusRunTimer = setTimeout(() => {
    MonitoringStatusRunTimer = null;
    RefreshMonitoringCheckStatus({ run: true });
  }, 500);
}

// Paint the status card: the card's background carries the status colour
// (online / degraded / offline / idle) and the text is centred.
function SetMonitoringCheckStatusCard(TitleText: string, Kind: string, DetailHtml: string) {
  const $host = $('#MONITORING_CHECK_STATUS');
  if (!$host.length) return;
  for (const K of MON_STATUS_KINDS) $host.removeClass(`monitoring-check-status--${K}`);
  $host
    .removeClass('d-none')
    .addClass(`monitoring-check-status--${Kind}`)
    .html(
      `<div class="text-light fw-semibold">${Safe(TitleText)}</div>` +
        (DetailHtml ? `<div class="text-light small mt-1">${DetailHtml}</div>` : '')
    );
}

// Collect human-readable reasons the open check's settings are invalid (so it
// cannot be run). Empty array => settings are valid. Mirrors the server-side
// requirements: an address (for methods that use one) and every visible required
// setting must be filled.
function CollectMonitoringCheckValidationErrors(): string[] {
  const errors: string[] = [];
  const methodID = String($('#MONITORING_CHECK_METHOD').val() || '');
  const method = MonitoringMethodsCache.find((m) => m.ID === methodID);
  if (!method) {
    errors.push('Select a monitoring method.');
    return errors;
  }
  const usesAddress = method.UsesAddress !== false;
  if (usesAddress && String($('#MONITORING_CHECK_ADDRESS').val() || '').trim() === '') {
    errors.push('Address is required.');
  }
  const labelByKey = new Map<string, string>();
  for (const f of method.Settings || []) labelByKey.set(f.Key, f.Label || f.Key);
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .find('[data-required]')
    .each(function () {
      const $el = $(this);
      // A conditionally-hidden field is not in play, so it can't be "missing".
      if ($el.closest('.monitoring-field-wrap').hasClass('d-none')) return;
      if (String($el.val() ?? '').trim() !== '') return;
      const key = $el.attr('data-key') || '';
      errors.push(`${labelByKey.get(key) || key} is required.`);
    });
  return errors;
}

function RenderMonitoringCheckStatusFromPayload(payload: MonitoringCheckDebug | null) {
  if (!payload || (payload.LastChecked == null && !payload.Html)) {
    SetMonitoringCheckStatusCard('Checking', 'idle', 'Waiting for the first check to run...');
    return;
  }
  let title = 'Online';
  let kind = 'online';
  if (payload.LastChecked == null) {
    // Probes have run but none has produced a verdict yet: still inside the
    // failure threshold on first contact.
    title = 'Checking';
    kind = 'idle';
  } else if (!payload.Online) {
    title = 'Offline';
    kind = 'offline';
  } else if (payload.Degraded) {
    title = 'Degraded';
    kind = 'degraded';
  }
  const parts: string[] = [];
  const missed = DescribeMissedChecks(
    payload.ConsecutiveFailures,
    payload.EffectiveFailureThreshold,
    payload.Online
  );
  if (missed) {
    parts.push(
      `<div>${Safe(missed)} checks; not marked offline until ${Safe(String(payload.EffectiveFailureThreshold))} in a row fail.</div>`
    );
  }
  if (payload.LastError) {
    parts.push(`<div class="text-break">${Safe(payload.LastError)}</div>`);
  } else if (payload.Online && !payload.Degraded) {
    parts.push('<div>All checks healthy.</div>');
  }
  const latency = Number(payload.LastLatencyMs);
  if (payload.LastLatencyMs != null && Number.isFinite(latency)) {
    parts.push(`<div>Latency ${Math.round(latency)} ms</div>`);
  }
  SetMonitoringCheckStatusCard(title, kind, parts.join(''));
}

// Persist the working state and wait for the save (and any chained pending save)
// to fully settle, so a subsequent run probes the just-saved configuration.
async function FlushMonitoringCheckSave() {
  if (!MonitoringEditorState) return;
  if (MonitoringEditorState.saveTimer) {
    clearTimeout(MonitoringEditorState.saveTimer);
    MonitoringEditorState.saveTimer = null;
  }
  let guard = 0;
  while (MonitoringEditorState.saving && guard++ < 100) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await PerformMonitoringAutoSave();
  guard = 0;
  while ((MonitoringEditorState.saving || MonitoringEditorState.pendingSave) && guard++ < 100) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Render the status card for the open check. With { run: true } the check is
// (re-)probed after flushing a save; otherwise the latest known response is shown.
// Invalid settings short-circuit to an "Invalid Settings" card listing the fixes.
export async function RefreshMonitoringCheckStatus(opts: { run?: boolean } = {}) {
  const $host = $('#MONITORING_CHECK_STATUS');
  if (!$host.length) return;
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const index = MonitoringEditorState.EditingIndex;
  const check = index == null ? null : MonitoringEditorState.Checks[index];
  if (!check) {
    $host.addClass('d-none').empty();
    return;
  }

  const errors = CollectMonitoringCheckValidationErrors();
  if (errors.length) {
    const list = errors.map((e) => `<li>${Safe(e)}</li>`).join('');
    SetMonitoringCheckStatusCard(
      'Invalid Settings',
      'offline',
      `<ul class="list-unstyled mb-0 d-grid gap-1">${list}</ul>`
    );
    return;
  }

  if (opts.run) {
    SetMonitoringCheckStatusCard('Checking...', 'idle', '');
    await FlushMonitoringCheckSave();
    if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  }

  const curIndex = MonitoringEditorState.EditingIndex;
  const cur = curIndex == null ? null : MonitoringEditorState.Checks[curIndex];
  if (!cur) return;
  if (cur.CheckID == null) {
    SetMonitoringCheckStatusCard(
      'Not saved',
      'idle',
      'Give the target a name to save and run this check.'
    );
    return;
  }

  const requestedCheckID = cur.CheckID;
  let payload: MonitoringCheckDebug | null = null;
  try {
    payload = opts.run
      ? await window.API.RunMonitoringCheckNow(requestedCheckID)
      : await window.API.GetMonitoringCheckDebug(requestedCheckID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:RefreshMonitoringCheckStatus', err);
    SetMonitoringCheckStatusCard('Error', 'offline', '');
    return;
  }

  // The user may have navigated away or switched checks while we awaited.
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const stillIndex = MonitoringEditorState.EditingIndex;
  const still = stillIndex == null ? null : MonitoringEditorState.Checks[stillIndex];
  if (!still || Number(still.CheckID) !== Number(requestedCheckID)) return;

  RenderMonitoringCheckStatusFromPayload(payload);
  // Keep the collapsible "Last Response" panel in sync on a fresh probe.
  if (opts.run) RenderMonitoringCheckDebug(payload);
}

// Manually run the check currently open in the editor and refresh its debug
// panel with the fresh response. Flushes any pending auto-save first so the
// server probes the check's current configuration.
export async function RunMonitoringCheckNow() {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const index = MonitoringEditorState.EditingIndex;
  const check = index == null ? null : MonitoringEditorState.Checks[index];
  if (!check) return;

  // Commit + flush the debounced save so the persisted check reflects the UI.
  CommitMonitoringCheckView();
  if (MonitoringEditorState.saveTimer) {
    clearTimeout(MonitoringEditorState.saveTimer);
    MonitoringEditorState.saveTimer = null;
  }
  await PerformMonitoringAutoSave();

  const curIndex = MonitoringEditorState.EditingIndex;
  const curCheck = curIndex == null ? null : MonitoringEditorState.Checks[curIndex];
  if (!curCheck || curCheck.CheckID == null) {
    $('#MONITORING_CHECK_DEBUG_META').text('');
    $('#MONITORING_CHECK_DEBUG_BODY').html(
      '<div class="text-muted small fst-italic">Give this check a valid address to run it.</div>'
    );
    return;
  }

  const requestedCheckID = curCheck.CheckID;
  const $btn = $('#MONITORING_CHECK_RUN_NOW');
  const $icon = $btn.find('.bi');
  $btn.prop('disabled', true);
  $icon.addClass('monitoring-spin');
  $('#MONITORING_CHECK_DEBUG_BODY').html(
    '<div class="text-muted small fst-italic">Running check...</div>'
  );

  let payload = null;
  try {
    payload = await window.API.RunMonitoringCheckNow(requestedCheckID);
  } catch (err) {
    HandleNonFatalError('MonitoringEditor:RunMonitoringCheckNow', err);
  } finally {
    $btn.prop('disabled', false);
    $icon.removeClass('monitoring-spin');
  }

  // Only paint if the user is still on the same check.
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'check') return;
  const stillIndex = MonitoringEditorState.EditingIndex;
  const stillCheck = stillIndex == null ? null : MonitoringEditorState.Checks[stillIndex];
  if (!stillCheck || Number(stillCheck.CheckID) !== Number(requestedCheckID)) return;
  RenderMonitoringCheckDebug(payload);
  RenderMonitoringCheckStatusFromPayload(payload);
}

// Pull the check-edit view fields back into the working state + schedule a save.
export function CommitMonitoringCheckView() {
  if (!MonitoringEditorState) return;
  const index = MonitoringEditorState.EditingIndex;
  if (index == null) return;
  const check = MonitoringEditorState.Checks[index];
  if (!check) return;
  check.Name = String($('#MONITORING_CHECK_NAME').val() || '').trim();
  check.Address = String($('#MONITORING_CHECK_ADDRESS').val() || '').trim();
  check.Method = String($('#MONITORING_CHECK_METHOD').val() || '');
  check.DegradedThresholdMs = Math.max(
    0,
    parseInt(String($('#MONITORING_CHECK_DEGRADED_THRESHOLD').val() || ''), 10) || 0
  );
  check.FailureThreshold = ParseFailureThreshold($('#MONITORING_CHECK_FAILURE_THRESHOLD').val());
  check.Settings = CollectMonitoringCheckDynamicSettings();
  ScheduleMonitoringAutoSave();
  // Every edit also debounce-refreshes the live status card (re-runs the check
  // when valid, or shows which settings are invalid).
  ScheduleMonitoringCheckStatusRun();
}

export function BuildMonitoringPayload() {
  const s = MonitoringEditorState!;
  const payload: {
    Nickname: string;
    Interval: number;
    GroupID: number | null;
    FailureThreshold: number | null;
    Slug?: string;
    Checks: Array<{
      Name: string;
      Address: string;
      Method: string;
      Settings: Record<string, unknown>;
      DegradedThresholdMs: number;
      FailureThreshold: number | null;
      CheckID?: number | null;
    }>;
  } = {
    Nickname: (s.Nickname || '').trim(),
    Interval: s.Interval,
    GroupID: s.GroupID == null ? null : s.GroupID,
    FailureThreshold: s.FailureThreshold ?? null,
    Checks: s.Checks.map((c) => {
      const out: {
        Name: string;
        Address: string;
        Method: string;
        Settings: Record<string, unknown>;
        DegradedThresholdMs: number;
        FailureThreshold: number | null;
        CheckID?: number | null;
      } = {
        Name: c.Name || '',
        Address: (c.Address || '').trim(),
        Method: c.Method,
        Settings: c.Settings || {},
        DegradedThresholdMs: Math.max(0, Number(c.DegradedThresholdMs) || 0),
        FailureThreshold: c.FailureThreshold ?? null,
      };
      if (c.CheckID != null) out.CheckID = c.CheckID;
      return out;
    }),
  };
  // Only send Slug when it was actually changed from the loaded value (a slug
  // never auto-changes) and is non-empty.
  const NextSlug = (s.Slug || '').trim();
  if (NextSlug && NextSlug !== (s.OriginalSlug || '')) {
    payload.Slug = NextSlug;
  }
  return payload;
}

export function MonitoringPayloadIsValid(payload: ReturnType<typeof BuildMonitoringPayload>) {
  if (!payload.Nickname) return false;
  // A target may legitimately have zero checks (it renders as degraded). Any
  // checks that do exist must be fully configured before we save. Methods that
  // don't use the Address field (e.g. network-wide NDI discovery) are exempt from
  // the address requirement.
  for (const c of payload.Checks) {
    if (!c.Method) return false;
    const method = MonitoringMethodsCache.find((m) => m.ID === c.Method);
    const usesAddress = !method || method.UsesAddress !== false;
    if (usesAddress && !c.Address) return false;
  }
  return true;
}

export function SyncAddCheckButtonState() {
  const enabled = !!(MonitoringEditorState && MonitoringEditorState.TargetID != null);
  $('#MONITORING_TARGET_ADD_CHECK').prop('disabled', !enabled);
}

export function ScheduleMonitoringAutoSave() {
  if (!MonitoringEditorState) return;
  if (MonitoringEditorState.saveTimer) clearTimeout(MonitoringEditorState.saveTimer);
  MonitoringEditorState.saveTimer = setTimeout(() => {
    PerformMonitoringAutoSave();
  }, 500);
}

export async function PerformMonitoringAutoSave() {
  if (!MonitoringEditorState) return;
  const payload = BuildMonitoringPayload();
  if (!MonitoringPayloadIsValid(payload)) {
    SetMonitoringSaveHint('Enter a name and give every check an address to save.', 'text-muted');
    return;
  }
  if (MonitoringEditorState.saving) {
    MonitoringEditorState.pendingSave = true;
    return;
  }
  MonitoringEditorState.saving = true;
  SetMonitoringSaveHint('', null);
  try {
    if (MonitoringEditorState.TargetID == null) {
      const [Err, Created] = await window.API.CreateMonitoringTarget(payload);
      if (Err || !Created) return SetMonitoringSaveHint(Err || 'Failed to save', 'text-danger');
      MonitoringEditorState.TargetID = Created.TargetID;
      setMonitoringEditorTargetID(Created.TargetID);
      if (Array.isArray(Created.Checks)) {
        Created.Checks.forEach((cr, i) => {
          if (MonitoringEditorState!.Checks[i])
            MonitoringEditorState!.Checks[i].CheckID = cr.CheckID;
        });
      }
      $('#MONITORING_TARGET_MODAL_TITLE').text('Edit Monitor');
      $('#MONITORING_TARGET_DANGER_ZONE').removeClass('d-none');
      SyncAddCheckButtonState();
    } else {
      const [Err, Updated] = await window.API.UpdateMonitoringTarget(
        MonitoringEditorState.TargetID,
        payload
      );
      if (Err) return SetMonitoringSaveHint(Err, 'text-danger');
      // Reconciliation returns checks in the same order we sent them, so we can
      // map freshly-inserted CheckIDs back onto the working state by index.
      if (Updated && Array.isArray(Updated.Checks)) {
        Updated.Checks.forEach((cr, i) => {
          if (MonitoringEditorState!.Checks[i])
            MonitoringEditorState!.Checks[i].CheckID = cr.CheckID;
        });
      }
    }
    SetMonitoringSaveHint('', null);
  } catch (e) {
    SetMonitoringSaveHint(ErrorMessage(e, 'Failed to save'), 'text-danger');
  } finally {
    MonitoringEditorState.saving = false;
    if (MonitoringEditorState.pendingSave) {
      MonitoringEditorState.pendingSave = false;
      ScheduleMonitoringAutoSave();
    }
    if (MonitoringEditorState.View === 'list') RenderMonitoringCheckList();
  }
}

// Called from the live MonitoringTargetUpdated feed so the open editor's check
// list reflects fresh status without a manual refresh.
export function RefreshMonitoringEditorIfOpen(TargetID: number) {
  if (!MonitoringEditorState || MonitoringEditorState.View !== 'list') return;
  if (MonitoringEditorState.TargetID == null) return;
  if (Number(MonitoringEditorState.TargetID) !== Number(TargetID)) return;
  RenderMonitoringCheckList();
}

// Leave the check editor for the monitor's view modal, on its Settings tab.
//
// The check is saved first. A check that cannot be saved yet (a required
// setting is empty) would otherwise vanish silently, so the operator is asked
// before it is dropped.
async function LeaveCheckViewForMonitorView(Options: { Save: boolean }): Promise<void> {
  const State = MonitoringEditorState;
  if (!State) return;
  if (Options.Save) {
    CommitMonitoringCheckView();
    if (!MonitoringPayloadIsValid(BuildMonitoringPayload())) {
      const Discard = await ConfirmationDialog(
        'This check is missing required settings, so it has not been saved. Discard your changes to it?',
        { ConfirmLabel: 'Discard Changes' }
      );
      if (!Discard) return;
    } else {
      await FlushMonitoringCheckSave();
    }
  } else {
    await FlushMonitoringCheckSave();
  }
  // Nothing further may fire from the editor: no autosave of a discarded check,
  // no status re-probe of a view that is no longer open.
  if (State.saveTimer) clearTimeout(State.saveTimer);
  State.saveTimer = null;
  State.pendingSave = false;
  if (MonitoringStatusRunTimer) clearTimeout(MonitoringStatusRunTimer);
  MonitoringStatusRunTimer = null;
  State.View = 'list';
  State.EditingIndex = null;
  ReturnToMonitorView = false;
  if (State.TargetID != null) {
    await OpenMonitoringTargetHistory(Number(State.TargetID), { Tab: 'settings' });
  }
}

// --- Move a check to another monitor ----------------------------------------
//
// The picker hides the check editor and Back restores it untouched. Moving
// re-parents the saved check on the server, so it keeps its CheckID and its
// status history; the check is then dropped from this editor's working state
// so no later autosave of this monitor puts it back.

const MOVE_CHECK_MODAL = 'SHOWTRAK_MODAL_MONITORING_CHECK_MOVE';
const MONITORING_TARGET_MODAL = 'SHOWTRAK_MODAL_MONITORING_TARGET';

function MoveCheckCandidates(SourceTargetID: number) {
  const GroupTitles = new Map(__LastGroups.map((Group) => [Group.GroupID, Group.Title || '']));
  return MonitoringTargets.filter((Target) => Number(Target.TargetID) !== SourceTargetID)
    .map((Target) => ({
      TargetID: Number(Target.TargetID),
      Name: Target.Nickname || Target.Address || `Monitor ${Target.TargetID}`,
      Group: Target.GroupID == null ? 'No Group' : GroupTitles.get(Target.GroupID) || '',
      CheckCount: Array.isArray(Target.Checks) ? Target.Checks.length : 0,
    }))
    .sort((A, B) => A.Name.localeCompare(B.Name, undefined, { numeric: true }));
}

async function ReturnFromMoveCheckPicker() {
  closeModal(MOVE_CHECK_MODAL);
  await Wait(300);
  openModal(MONITORING_TARGET_MODAL);
}

async function OpenMoveCheckPicker() {
  const State = MonitoringEditorState;
  if (!State || State.View !== 'check' || State.TargetID == null) return;
  const SourceTargetID = Number(State.TargetID);

  // Only a saved check can move: the server re-parents its row.
  CommitMonitoringCheckView();
  if (!MonitoringPayloadIsValid(BuildMonitoringPayload())) {
    Notify('Fill in the required settings before moving this check.', 'error');
    return;
  }
  await FlushMonitoringCheckSave();
  const Index = State.EditingIndex;
  const Check = Index == null ? null : State.Checks[Index];
  if (!Check || Check.CheckID == null) {
    Notify('This check could not be saved, so it cannot be moved yet.', 'error');
    return;
  }
  const CheckID = Number(Check.CheckID);

  $('#MONITORING_CHECK_MOVE_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Move Check',
        titleId: 'MONITORING_CHECK_MOVE_TITLE',
        onBack: () => void ReturnFromMoveCheckPicker(),
        onClose: () => closeModal(MOVE_CHECK_MODAL),
      }).$el
    );

  const Candidates = MoveCheckCandidates(SourceTargetID);
  const $List = $('#MONITORING_CHECK_MOVE_LIST').empty();
  if (!Candidates.length) {
    $List.append(
      '<div class="bg-ghost rounded p-3 text-muted text-center">There are no other monitors to move this check to.</div>'
    );
  }
  for (const Candidate of Candidates) {
    const Detail = [
      Candidate.Group,
      `${Candidate.CheckCount} ${Candidate.CheckCount === 1 ? 'check' : 'checks'}`,
    ]
      .filter(Boolean)
      .join(' · ');
    $List.append(`
      <div class="d-flex align-items-center gap-2 bg-ghost rounded p-2">
        <div class="flex-grow-1 text-start">
          <div class="text-light">${Safe(Candidate.Name)}</div>
          <small class="text-muted">${Safe(Detail)}</small>
        </div>
        <button type="button" class="btn btn-light btn-sm MONITORING_CHECK_MOVE_TO" data-target-id="${Candidate.TargetID}">
          Move
        </button>
      </div>`);
  }

  $List.off('click.move').on('click.move', '.MONITORING_CHECK_MOVE_TO', async function () {
    const ToTargetID = parseInt($(this).attr('data-target-id') || '', 10);
    if (!Number.isFinite(ToTargetID)) return;
    const Destination = Candidates.find((Candidate) => Candidate.TargetID === ToTargetID);
    $List.find('.MONITORING_CHECK_MOVE_TO').prop('disabled', true);
    let Err: string | null = null;
    try {
      [Err] = await window.API.MoveMonitoringCheck(CheckID, ToTargetID);
    } catch (e) {
      Err = ErrorMessage(e, 'Failed to move check');
    }
    if (Err) {
      $List.find('.MONITORING_CHECK_MOVE_TO').prop('disabled', false);
      Notify(Err, 'error');
      return;
    }

    // The server no longer has this check on the monitor; make sure nothing
    // here re-saves it (an autosave would insert it again as a new check).
    if (State.saveTimer) clearTimeout(State.saveTimer);
    State.saveTimer = null;
    State.pendingSave = false;
    if (MonitoringStatusRunTimer) clearTimeout(MonitoringStatusRunTimer);
    MonitoringStatusRunTimer = null;
    State.Checks = State.Checks.filter((Entry) => Number(Entry.CheckID) !== CheckID);
    State.View = 'list';
    State.EditingIndex = null;

    closeModal(MOVE_CHECK_MODAL);
    Notify(`Check moved to ${Destination ? Destination.Name : 'another monitor'}.`, 'success');
    await Wait(300);
    if (ReturnToMonitorView) {
      ReturnToMonitorView = false;
      await OpenMonitoringTargetHistory(SourceTargetID, { Tab: 'settings' });
      return;
    }
    ShowMonitoringListView();
    openModal(MONITORING_TARGET_MODAL);
  });

  closeModal(MONITORING_TARGET_MODAL);
  await Wait(300);
  openModal(MOVE_CHECK_MODAL);
}

const MONITORING_TARGET_TAG_PICKER: TagPickerMount = {
  WrapperSelector: '#MONITORING_TARGET_TAGS_WRAPPER',
  ListSelector: '#MONITORING_TARGET_TAGS',
  Namespace: 'monitorEditorTags',
};

/**
 * The monitor editor. An existing monitor's settings now live on the Settings
 * tab of its view modal, so with a TargetID and no `Check` this opens that tab
 * instead. `Check` opens straight into one check's edit view (by CheckID, or
 * 'new' for a blank one), and Back returns to the Settings tab. With no
 * TargetID it is the Add Monitor flow.
 */
export async function OpenMonitoringTargetEditor(
  TargetID: number | null,
  Prefill: { Nickname?: string; Address?: string; Method?: string | null } | null = null,
  Options: { Check?: { CheckID: number } | 'new' } = {}
) {
  if (TargetID && Options.Check == null) {
    return OpenMonitoringTargetHistory(Number(TargetID), { Tab: 'settings' });
  }
  ReturnToMonitorView = Options.Check != null;
  await CloseAllModals();
  await EnsureMonitoringMethodsLoaded();
  await LoadGlobalFailureThreshold();

  const DefaultMethod = MonitoringMethodsCache[0] && MonitoringMethodsCache[0].ID;

  let Existing: MonitoringTargetView | null = null;
  if (TargetID) Existing = await window.API.GetMonitoringTarget(String(TargetID));

  if (Existing) {
    setMonitoringEditorState({
      TargetID: Existing.TargetID,
      Nickname: Existing.Nickname || '',
      Interval: Number(Existing.Interval) || 30000,
      GroupID: Existing.GroupID == null ? null : Existing.GroupID,
      FailureThreshold: Existing.FailureThreshold ?? null,
      Slug: Existing.Slug || '',
      OriginalSlug: Existing.Slug || '',
      Checks: (Existing.Checks || []).map((c) => ({
        CheckID: c.CheckID,
        Name: c.Name || '',
        Address: c.Address || '',
        Method: c.Method || DefaultMethod || '',
        Settings: c.Settings || {},
        DegradedThresholdMs: Number(c.DegradedThresholdMs) || 0,
        FailureThreshold: c.FailureThreshold ?? null,
      })),
      View: 'list',
      EditingIndex: null,
      saveTimer: null,
      saving: false,
      pendingSave: false,
    });
  } else {
    setMonitoringEditorState({
      TargetID: null,
      Nickname: (Prefill && Prefill.Nickname) || '',
      Interval: 30000,
      GroupID: null,
      FailureThreshold: null,
      Slug: '',
      OriginalSlug: '',
      Checks: [],
      View: 'list',
      EditingIndex: null,
      saveTimer: null,
      saving: false,
      pendingSave: false,
    });
  }
  setMonitoringEditorTargetID(MonitoringEditorState!.TargetID);

  // The list view is the modal's top level (title + close). The per-check view
  // adds a Back that commits the check and returns to the list. Title elements
  // keep their ids so the text is still updated below and on autosave.
  $('#MONITORING_TARGET_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Add Monitor',
        titleId: 'MONITORING_TARGET_MODAL_TITLE',
        onClose: () => closeModal('SHOWTRAK_MODAL_MONITORING_TARGET'),
      }).$el
    );
  $('#MONITORING_CHECK_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Edit Check',
        titleId: 'MONITORING_CHECK_VIEW_TITLE',
        onBack: () => {
          if (ReturnToMonitorView) {
            void LeaveCheckViewForMonitorView({ Save: true });
            return;
          }
          CommitMonitoringCheckView();
          ShowMonitoringListView();
        },
        onClose: () => closeModal('SHOWTRAK_MODAL_MONITORING_TARGET'),
      }).$el
    );

  $('#MONITORING_TARGET_MODAL_TITLE').text(Existing ? 'Edit Monitor' : 'Add Monitor');
  $('#MONITORING_TARGET_DANGER_ZONE').toggleClass('d-none', !Existing);
  // Slug is only shown for an existing target; a new target's slug is generated
  // server-side on create, then editable on the next open.
  $('#MONITORING_TARGET_SLUG_WRAPPER').toggleClass('d-none', !Existing);
  // Same rule as the slug above: a target that does not exist yet has no
  // `monitor:<TargetID>` for a tag scope to reference.
  RenderTagPicker(
    MONITORING_TARGET_TAG_PICKER,
    Existing
      ? { ScopedID: `monitor:${Existing.TargetID}`, GroupID: Existing.GroupID ?? null }
      : null
  );
  $('#MONITORING_TARGET_SLUG').val(MonitoringEditorState!.Slug);
  $('#MONITORING_TARGET_NICKNAME').val(MonitoringEditorState!.Nickname);
  $('#MONITORING_TARGET_INTERVAL').val(MonitoringEditorState!.Interval);
  $('#MONITORING_TARGET_INTERVAL_LABEL').text(FormatInterval(MonitoringEditorState!.Interval));
  RenderFailureThresholdSelect(
    '#MONITORING_TARGET_FAILURE_THRESHOLD',
    'Default',
    GlobalFailureThreshold,
    MonitoringEditorState!.FailureThreshold
  );
  SetMonitoringSaveHint('', null);

  // Global (target-level) inputs
  $('#MONITORING_TARGET_NICKNAME')
    .off('input.mon')
    .on('input.mon', function () {
      MonitoringEditorState!.Nickname = String($(this).val() || '');
      ScheduleMonitoringAutoSave();
    });
  $('#MONITORING_TARGET_SLUG')
    .off('input.mon')
    .on('input.mon', function () {
      MonitoringEditorState!.Slug = String($(this).val() || '');
      ScheduleMonitoringAutoSave();
    });
  $('#MONITORING_TARGET_INTERVAL')
    .off('input.mon')
    .on('input.mon', function () {
      MonitoringEditorState!.Interval = parseInt(String($(this).val() || ''), 10) || 30000;
      $('#MONITORING_TARGET_INTERVAL_LABEL').text(FormatInterval(MonitoringEditorState!.Interval));
      ScheduleMonitoringAutoSave();
    });
  $('#MONITORING_TARGET_FAILURE_THRESHOLD')
    .off('change.mon')
    .on('change.mon', function () {
      MonitoringEditorState!.FailureThreshold = ParseFailureThreshold($(this).val());
      ScheduleMonitoringAutoSave();
    });

  SyncAddCheckButtonState();

  // Add a new (blank) check and drop straight into its edit view.
  $('#MONITORING_TARGET_ADD_CHECK')
    .off('click.mon')
    .on('click.mon', function () {
      if (!MonitoringEditorState || MonitoringEditorState.TargetID == null) return;
      MonitoringEditorState.Checks.push({
        Name: '',
        Address: '',
        Method: DefaultMethod || '',
        Settings: {},
        DegradedThresholdMs: 0,
        FailureThreshold: null,
      });
      OpenMonitoringCheckView(MonitoringEditorState.Checks.length - 1);
    });

  // Check rows open the per-check edit view.
  $('#MONITORING_TARGET_CHECK_LIST')
    .off('click.mon')
    .on('click.mon', '.monitoring-check-row, .MONITORING_CHECK_EDIT', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const index = parseInt($(this).attr('data-index') || '', 10);
      if (Number.isFinite(index)) OpenMonitoringCheckView(index);
    });

  // Check edit view field bindings (auto-save on change).
  $('#MONITORING_CHECK_NAME, #MONITORING_CHECK_ADDRESS, #MONITORING_CHECK_DEGRADED_THRESHOLD')
    .off('input.moncheck')
    .on('input.moncheck', function () {
      CommitMonitoringCheckView();
    });
  $('#MONITORING_CHECK_FAILURE_THRESHOLD')
    .off('change.moncheck')
    .on('change.moncheck', function () {
      CommitMonitoringCheckView();
    });
  $('#MONITORING_CHECK_METHOD')
    .off('change.moncheck')
    .on('change.moncheck', function () {
      CloseMonitoringCheckCollapses();
      RenderMonitoringCheckInfo($(this).val());
      ApplyMonitoringMethodCapabilities($(this).val());
      RenderMonitoringCheckDynamicSettings($(this).val(), CollectMonitoringCheckDynamicSettings());
      CommitMonitoringCheckView();
    });
  $('#MONITORING_CHECK_DYNAMIC_SETTINGS, #MONITORING_CHECK_ADVANCED_SETTINGS')
    .off('input.moncheck change.moncheck focusout.moncheck')
    .on('input.moncheck change.moncheck', '[data-key]', function () {
      // Editing a field counts as touching it, so required validation can engage.
      if ($(this).attr('data-required') != null) $(this).addClass('mon-touched');
      // Re-evaluate conditional fields first so a toggle change reveals/hides its
      // dependent inputs before we snapshot the settings.
      ApplyMonitoringConditionalVisibility();
      ValidateMonitoringRequiredFields();
      CommitMonitoringCheckView();
    })
    // Leaving a required field marks it touched so tabbing past an empty required
    // input reveals the red outline, matching common form behaviour.
    .on('focusout.moncheck', '[data-required]', function () {
      $(this).addClass('mon-touched');
      ValidateMonitoringField(this);
    })
    // 'list' field chip interactions: Add button, Enter to add, click × to remove.
    .on('click.moncheck', '.monitoring-list-add-btn', function () {
      AddMonitoringListChip($(this).closest('.monitoring-list'));
    })
    .on('keydown.moncheck', '.monitoring-list-input', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      AddMonitoringListChip($(this).closest('.monitoring-list'));
    })
    .on('click.moncheck', '.monitoring-list-chip-remove', function () {
      $(this).closest('.monitoring-list-chip').remove();
      ApplyMonitoringConditionalVisibility();
      ValidateMonitoringRequiredFields();
      CommitMonitoringCheckView();
    });

  // Info-panel documentation links open in the default browser.
  $('#MONITORING_CHECK_INFO')
    .off('click.moninfo')
    .on('click.moninfo', '.MONITORING_INFO_LINK', function () {
      const Url = $(this).attr('data-url');
      if (Url) window.API.OpenExternalUrl(Url);
    });

  $('#MONITORING_CHECK_RUN_NOW')
    .off('click.moncheck')
    .on('click.moncheck', function () {
      RunMonitoringCheckNow();
    });

  $('#MONITORING_CHECK_MOVE')
    .off('click.moncheck')
    .on('click.moncheck', function () {
      void OpenMoveCheckPicker();
    });

  $('#MONITORING_CHECK_DELETE')
    .off('click.moncheck')
    .on('click.moncheck', function () {
      const index = MonitoringEditorState!.EditingIndex;
      if (index == null) return;
      MonitoringEditorState!.Checks.splice(index, 1);
      if (ReturnToMonitorView) {
        MonitoringEditorState!.EditingIndex = null;
        void LeaveCheckViewForMonitorView({ Save: false });
        return;
      }
      ShowMonitoringListView();
      ScheduleMonitoringAutoSave();
    });

  $('#MONITORING_TARGET_DELETE')
    .off('click.mon')
    .on('click.mon', async () => {
      if (MonitoringEditorState!.TargetID == null) return;
      const Confirmation = await ConfirmationDialog('Delete this monitor? This cannot be undone.', {
        ConfirmLabel: 'Delete Monitor',
      });
      if (!Confirmation) return;
      const [Err] = await window.API.DeleteMonitoringTarget(MonitoringEditorState!.TargetID);
      if (Err) return Notify(Err, 'error');
      await Notify('Monitor deleted.', 'success');
      await CloseAllModals();
    });

  ShowMonitoringListView();
  if (Options.Check != null && MonitoringEditorState!.TargetID != null) {
    if (Options.Check === 'new') {
      MonitoringEditorState!.Checks.push({
        Name: '',
        Address: '',
        Method: DefaultMethod || '',
        Settings: {},
        DegradedThresholdMs: 0,
        FailureThreshold: null,
      });
      OpenMonitoringCheckView(MonitoringEditorState!.Checks.length - 1);
    } else {
      const CheckID = Options.Check.CheckID;
      const Index = MonitoringEditorState!.Checks.findIndex(
        (Check) => Number(Check.CheckID) === Number(CheckID)
      );
      if (Index !== -1) OpenMonitoringCheckView(Index);
    }
  }
  openModal('SHOWTRAK_MODAL_MONITORING_TARGET');

  // Prefilled discovery adds already have a name+address, so try an initial save.
  // Opening on a check saves nothing until that check is edited.
  if (Options.Check == null) ScheduleMonitoringAutoSave();
}

// A list-chip edit inside ./method-fields has to land in the working state
// above. Registering the committer here (rather than method-fields importing
// it) is what keeps that module free of a back-import into this one.
setFieldEditedHandler(CommitMonitoringCheckView);
