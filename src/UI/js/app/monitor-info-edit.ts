// A monitor's Settings tab: its view modal doubling as its editor, the same way
// a ShowTrak Client's Info tab does (client-info-edit.ts).
//
// Show mode renders the slug, name, check interval, failures before offline,
// tags and checks read-only. Edit mode makes them editable in place, flipping
// live when the mode changes, and adds dragging checks into a new order,
// opening a check's edit view, Add Check and Delete Monitor.
//
// The save model is the monitor editor's: edits autosave half a second after
// they stop, tags apply as they are clicked. There is no Save button. A check
// itself is still edited in the monitor editor's check view, whose Back returns
// here.
import type { MonitoringCheckView, MonitoringTargetView } from '@showtrak/protocol';
import { AppMode, Capabilities, MonitoringMethodsCache, MonitoringTargets } from './state';
import { HandleNonFatalError, Safe } from './utils';
import { ConfirmationDialog, Notify } from './selection-init';
import { ClearTagPicker, RenderReadOnlyTagChips, RenderTagPicker } from './tag-picker';
import type { TagPickerMount } from './tag-picker';
import { CloseAllModals } from './modals';
import { FormatInterval } from './lib/monitor-format';
import { IsClientInfoEditable } from './lib/client-info-edit';
import {
  BuildMonitorUpdatePayload,
  CheckOrderChanged,
  ParseMonitorInterval,
  ReorderChecks,
} from './lib/monitor-settings';
import type { MonitorSettingsEdits } from './lib/monitor-settings';

type MonitoringEditorModule = typeof import('./monitoring-editor');

const MODAL_ID = 'SHOWTRAK_CLIENT_INFO';
// Shared with client-info-edit.ts: whichever entity is mounted owns it.
const EDITING_CLASS = 'is-editing';
const AUTOSAVE_DELAY_MS = 500;

const MONITOR_INFO_TAG_PICKER: TagPickerMount = {
  WrapperSelector: '#MONITOR_INFO_TAG_PICKER_WRAPPER',
  ListSelector: '#MONITOR_INFO_TAG_PICKER',
  Namespace: 'monitorInfoTags',
  // Scoped as `monitor:<TargetID>`. Settings autosave, so nothing is left unsaved.
  ReturnTo: async (ScopedID) => {
    const { OpenMonitoringTargetHistory } = await import('./monitoring-history-modal');
    await OpenMonitoringTargetHistory(Number(ScopedID.replace(/^monitor:/, '')), {
      Tab: 'settings',
    });
  },
};

interface MountedMonitor {
  TargetID: number;
  Target: MonitoringTargetView;
  /** The server-wide failure threshold a monitor with no override inherits. */
  GlobalThreshold: number;
}

let Mounted: MountedMonitor | null = null;
let Editing = false;
let Bound = false;
let MountToken = 0;
let SaveTimer: ReturnType<typeof setTimeout> | null = null;
// Saves run one after another, so a reorder can never land before (and be
// overwritten by) a field edit made just ahead of it.
let SaveChain: Promise<void> = Promise.resolve();
// The check row being dragged; live pushes leave the list alone meanwhile.
let DraggedRow: HTMLElement | null = null;
// The editor module is loaded on first use: importing it statically would pull
// the whole check editor into everything that imports the view modal.
let Editor: MonitoringEditorModule | null = null;

async function LoadEditor(): Promise<MonitoringEditorModule> {
  if (!Editor) Editor = await import('./monitoring-editor');
  return Editor;
}

function CanEdit(): boolean {
  return (
    !!Mounted &&
    IsClientInfoEditable({
      AppMode,
      CanManage: Capabilities.canManageMonitoring,
      Kind: 'target',
    })
  );
}

function LiveTarget(TargetID: number): MonitoringTargetView | null {
  return MonitoringTargets.find((Target) => Number(Target.TargetID) === Number(TargetID)) || null;
}

// --- Mounting ----------------------------------------------------------------

/** Take over the view modal's Settings tab for this monitor. */
export async function MountMonitorInfoEditor(TargetID: number): Promise<void> {
  EnsureBound();
  const Token = ++MountToken;
  const Target = LiveTarget(TargetID);
  if (!Target) return;
  const Module = await LoadEditor();
  const GlobalThreshold = await Module.LoadGlobalFailureThreshold();
  if (Token !== MountToken) return;

  Mounted = { TargetID: Number(TargetID), Target, GlobalThreshold };
  Editing = CanEdit();
  $(`#${MODAL_ID}`).toggleClass(EDITING_CLASS, Editing);
  PopulateFields();
  RenderReadOnlyFields();
  RenderTags();
  RenderCheckList();
}

/** Forget the mounted monitor, saving anything still waiting to autosave. */
export function UnmountMonitorInfoEditor(): void {
  if (!Mounted) return;
  FlushPendingSave();
  MountToken++;
  ClearTagPicker();
  Mounted = null;
  Editing = false;
  DraggedRow = null;
  $(`#${MODAL_ID}`).removeClass(EDITING_CLASS);
}

/** Re-evaluate Show/Edit on a mode change; the tab flips in place. */
export function ApplyMonitorInfoEditMode(): void {
  if (!Mounted) return;
  const Next = CanEdit();
  if (Next === Editing) return;
  // Autosave means nothing is ever discarded: whatever is waiting goes now.
  if (!Next) FlushPendingSave();
  Editing = Next;
  $(`#${MODAL_ID}`).toggleClass(EDITING_CLASS, Editing);
  PopulateFields();
  RenderReadOnlyFields();
  RenderTags();
  RenderCheckList();
}

/** A fresh copy of a monitor (live push). Never touches a field being edited. */
export function RefreshMonitorInfoEditor(Target: MonitoringTargetView): void {
  if (!Mounted || Number(Target.TargetID) !== Mounted.TargetID) return;
  Mounted.Target = Target;
  if (!Editing) PopulateFields();
  RenderReadOnlyFields();
  if (!Editing) RenderTags();
  if (!DraggedRow) RenderCheckList();
}

/** After a tag push: the read-only chips (the picker redraws itself). */
export function RefreshMonitorInfoTags(): void {
  if (Mounted && !Editing) RenderTags();
}

function EnsureBound(): void {
  if (Bound) return;
  Bound = true;
  const $Modal = $(`#${MODAL_ID}`);

  // `hide`, not `hidden`, for the reason given in client-info-edit.ts.
  $Modal.on('hide.bs.modal.monitorInfoEdit', (Event) => {
    if (Event.target === $Modal[0]) UnmountMonitorInfoEditor();
  });

  $('#MONITOR_INFO_SETTINGS_SECTION').on('input change', '.mi-draft', function () {
    if (!Editing) return;
    if (this.id === 'MONITOR_INFO_INTERVAL') {
      $('#MONITOR_INFO_INTERVAL_LABEL').text(FormatInterval(ParseMonitorInterval($(this).val())));
    }
    ScheduleSave();
  });

  const $List = $('#MONITOR_INFO_CHECK_LIST');
  $List.on('click', '.monitor-settings-check', function () {
    if (!Editing || DraggedRow) return;
    const CheckID = Number(this.getAttribute('data-checkid'));
    if (Number.isFinite(CheckID)) void OpenCheck({ CheckID });
  });
  $List.on('keydown', '.monitor-settings-check', function (Event) {
    if (!Editing || (Event.key !== 'Enter' && Event.key !== ' ')) return;
    Event.preventDefault();
    const CheckID = Number(this.getAttribute('data-checkid'));
    if (Number.isFinite(CheckID)) void OpenCheck({ CheckID });
  });
  BindCheckDragging($List);

  $('#MONITOR_INFO_ADD_CHECK').on('click', () => {
    if (Editing) void OpenCheck('new');
  });
  $('#MONITOR_INFO_DELETE').on('click', () => void DeleteMonitor());
}

// --- Fields ------------------------------------------------------------------

function PopulateFields(): void {
  if (!Mounted || !Editor) return;
  const { Target, GlobalThreshold } = Mounted;
  $('#MONITOR_INFO_SLUG').val(Target.Slug || '');
  $('#MONITOR_INFO_NICKNAME').val(Target.Nickname || '');
  $('#MONITOR_INFO_SLUG, #MONITOR_INFO_NICKNAME')
    .prop('disabled', !Editing)
    .toggleClass('disabled', !Editing);
  const Interval = ParseMonitorInterval(Target.Interval);
  $('#MONITOR_INFO_INTERVAL').val(String(Interval));
  $('#MONITOR_INFO_INTERVAL_LABEL').text(FormatInterval(Interval));
  Editor.RenderFailureThresholdSelect(
    '#MONITOR_INFO_FAILURE_THRESHOLD',
    'Default',
    GlobalThreshold,
    Target.FailureThreshold ?? null
  );
}

function RenderReadOnlyFields(): void {
  if (!Mounted || !Editor) return;
  const { Target, GlobalThreshold } = Mounted;
  $('#MONITOR_INFO_INTERVAL_VIEW').val(FormatInterval(ParseMonitorInterval(Target.Interval)));
  $('#MONITOR_INFO_FAILURE_THRESHOLD_VIEW').val(
    Target.FailureThreshold == null
      ? `Default (${Editor.FailureThresholdLabel(GlobalThreshold)})`
      : Editor.FailureThresholdLabel(Target.FailureThreshold)
  );
}

function CollectEdits(): MonitorSettingsEdits {
  return {
    Nickname: String($('#MONITOR_INFO_NICKNAME').val() || ''),
    Slug: String($('#MONITOR_INFO_SLUG').val() || ''),
    Interval: ParseMonitorInterval($('#MONITOR_INFO_INTERVAL').val()),
    FailureThreshold: Editor
      ? Editor.ParseFailureThreshold($('#MONITOR_INFO_FAILURE_THRESHOLD').val())
      : null,
  };
}

// --- Saving ------------------------------------------------------------------

function ScheduleSave(): void {
  if (SaveTimer) clearTimeout(SaveTimer);
  SaveTimer = setTimeout(() => {
    SaveTimer = null;
    QueueSave(null);
  }, AUTOSAVE_DELAY_MS);
}

function FlushPendingSave(): void {
  if (!SaveTimer) return;
  clearTimeout(SaveTimer);
  SaveTimer = null;
  QueueSave(null);
}

/**
 * Save the fields as they stand (read now, not when the save runs) with every
 * check, in `Order` if given. Returns once this save has settled.
 */
function QueueSave(Order: number[] | null): Promise<void> {
  if (!Mounted || !Editing) return SaveChain;
  const TargetID = Mounted.TargetID;
  const Edits = CollectEdits();
  SaveChain = SaveChain.then(() => SaveNow(TargetID, Edits, Order)).catch((err) =>
    HandleNonFatalError('MonitorInfoEdit:Save', err)
  );
  return SaveChain;
}

async function SaveNow(
  TargetID: number,
  Edits: MonitorSettingsEdits,
  Order: number[] | null
): Promise<void> {
  // The full monitor, not the cached list entry: every check must travel, with
  // all of its settings, or the save would delete or blank it.
  const Full = await window.API.GetMonitoringTarget(String(TargetID));
  if (!Full) return;
  const Payload = BuildMonitorUpdatePayload(Full, Edits, Order);
  if (!Payload) {
    await Notify('Enter a name to save this monitor.', 'info');
    return;
  }
  const [Err] = await window.API.UpdateMonitoringTarget(TargetID, Payload);
  if (Err) await Notify(String(Err), 'error');
}

// --- Tags ----------------------------------------------------------------------

function RenderTags(): void {
  if (!Mounted) return;
  const Entity = {
    ScopedID: `monitor:${Mounted.TargetID}`,
    GroupID: Mounted.Target.GroupID ?? null,
  };
  if (Editing) {
    RenderTagPicker(MONITOR_INFO_TAG_PICKER, Entity);
    return;
  }
  ClearTagPicker();
  const Chips = RenderReadOnlyTagChips(Entity);
  $('#MONITOR_INFO_TAGS_SECTION').toggleClass('d-none', Chips.Count === 0);
  $('#MONITOR_INFO_TAGS').html(Chips.Html);
}

// --- Checks --------------------------------------------------------------------

function CheckBadge(Check: MonitoringCheckView): { Class: string; Title: string } {
  if (Check.LastChecked == null)
    return { Class: 'bg-ghost-light text-light', Title: 'Not checked yet' };
  if (!Check.Online) return { Class: 'bg-danger text-light', Title: 'Offline' };
  if (Check.Degraded) return { Class: 'bg-warning text-dark', Title: 'Degraded' };
  return { Class: 'bg-success text-light', Title: 'Online' };
}

function RenderCheckList(): void {
  if (!Mounted) return;
  const Checks = Array.isArray(Mounted.Target.Checks) ? Mounted.Target.Checks : [];
  const $List = $('#MONITOR_INFO_CHECK_LIST');
  if (!Checks.length) {
    $List.html('<div class="mac-address-empty">This monitor has no checks yet.</div>');
    return;
  }
  $List.html(
    Checks.map((Check) => {
      const Method = String(Check.Method || '').toUpperCase();
      const Meta = MonitoringMethodsCache.find((Entry) => Entry.ID === Check.Method);
      const Name = Check.Name || (Meta && Meta.Name) || Method || 'Unnamed check';
      const Badge = CheckBadge(Check);
      const Interactive = Editing
        ? `draggable="true" role="button" tabindex="0" aria-label="Edit ${Safe(Name)}"`
        : '';
      return `
        <div class="monitor-settings-check ${Editing ? 'is-editable' : ''}" data-checkid="${Safe(Check.CheckID)}" ${Interactive}>
          ${Editing ? '<i class="bi bi-grip-vertical monitor-settings-check-grip" aria-hidden="true"></i>' : ''}
          <div class="monitor-settings-check-body">
            <div class="text-light">${Safe(Name)}</div>
            ${Check.Address ? `<small class="text-muted">${Safe(Check.Address)}</small>` : ''}
          </div>
          <span class="badge ${Badge.Class}" title="${Safe(Badge.Title)}">${Safe(Method)}</span>
          ${Editing ? '<i class="bi bi-chevron-right text-light" aria-hidden="true"></i>' : ''}
        </div>`;
    }).join('')
  );
}

function RenderedCheckOrder(): number[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('#MONITOR_INFO_CHECK_LIST .monitor-settings-check')
  )
    .map((Row) => Number(Row.getAttribute('data-checkid')))
    .filter((ID) => Number.isFinite(ID));
}

// Drag a row up or down the list: the rows move live under the pointer, and the
// new order saves on drop. Edit mode only; rows are not draggable otherwise.
function BindCheckDragging($List: JQuery<HTMLElement>): void {
  $List.on('dragstart', '.monitor-settings-check', function (Event) {
    if (!Editing) return;
    DraggedRow = this;
    const Transfer = (Event.originalEvent as DragEvent).dataTransfer;
    if (Transfer) {
      Transfer.effectAllowed = 'move';
      Transfer.setData('text/plain', String(this.getAttribute('data-checkid') || ''));
    }
    // Deferred so the browser captures the drag image before the row dims.
    const Row = this;
    requestAnimationFrame(() => Row.classList.add('is-dragging'));
  });

  $List.on('dragover', (Event) => {
    if (!DraggedRow) return;
    Event.preventDefault();
    const Pointer = Event.originalEvent as DragEvent;
    const Rows = Array.from(
      $List[0]!.querySelectorAll<HTMLElement>('.monitor-settings-check')
    ).filter((Row) => Row !== DraggedRow);
    // Before the first row whose midpoint is below the pointer, else last.
    const Below = Rows.find((Row) => {
      const Rect = Row.getBoundingClientRect();
      return Pointer.clientY < Rect.top + Rect.height / 2;
    });
    if (Below) {
      if (DraggedRow.nextElementSibling !== Below) $List[0]!.insertBefore(DraggedRow, Below);
    } else if ($List[0]!.lastElementChild !== DraggedRow) {
      $List[0]!.appendChild(DraggedRow);
    }
  });

  $List.on('drop', (Event) => {
    if (DraggedRow) Event.preventDefault();
  });

  $List.on('dragend', '.monitor-settings-check', function () {
    this.classList.remove('is-dragging');
    if (!DraggedRow || !Mounted) {
      DraggedRow = null;
      return;
    }
    const Before = (Mounted.Target.Checks || []).map((Check) => Number(Check.CheckID));
    const After = RenderedCheckOrder();
    // Cleared after a tick, so the click the browser may fire on release is not
    // taken as "open this check".
    setTimeout(() => {
      DraggedRow = null;
    }, 0);
    if (!CheckOrderChanged(Before, After)) return;
    // Show the new order straight away; the push that follows the save confirms it.
    Mounted.Target = {
      ...Mounted.Target,
      Checks: ReorderChecks(Mounted.Target.Checks || [], After),
    };
    if (SaveTimer) {
      clearTimeout(SaveTimer);
      SaveTimer = null;
    }
    void QueueSave(After);
  });
}

// Into the monitor editor's check view (or a new check); its Back returns here.
async function OpenCheck(Check: { CheckID: number } | 'new'): Promise<void> {
  if (!Mounted || !Editing) return;
  const TargetID = Mounted.TargetID;
  FlushPendingSave();
  // The editor loads the monitor fresh, so it must see what was just typed.
  await SaveChain;
  const Module = await LoadEditor();
  await Module.OpenMonitoringTargetEditor(TargetID, null, { Check });
}

async function DeleteMonitor(): Promise<void> {
  if (!Mounted || !Editing) return;
  const TargetID = Mounted.TargetID;
  const Confirmed = await ConfirmationDialog('Delete this monitor? This cannot be undone.', {
    ConfirmLabel: 'Delete Monitor',
  });
  if (!Confirmed) return;
  // Nothing may autosave a monitor that is about to stop existing.
  if (SaveTimer) {
    clearTimeout(SaveTimer);
    SaveTimer = null;
  }
  await SaveChain;
  const [Err] = await window.API.DeleteMonitoringTarget(TargetID);
  if (Err) return Notify(Err, 'error');
  await CloseAllModals();
  await Notify('Monitor deleted.', 'success');
}
