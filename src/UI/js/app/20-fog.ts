// FOG Project integration — renderer.
//
// Three surfaces:
//   1. The FOG button in the bottom bar (left of Alerts), shown only while the
//      integration is enabled and reachable.
//   2. The FOG tasks tray, a view-only panel modelled on the alerts tray.
//   3. The Schedule FOG Task modal, opened from the client editor.
//
// State is push-driven like everything else in this app: the backend poller
// reconciles tasks against FOG every 30s (and immediately after one is scheduled)
// and pushes SetFogTaskList / FogStatusUpdated. Nothing here polls.
import { Safe } from './04-utils';
import { Notify, ConfirmationDialog } from './lib/toasts';
import { openModal, closeModal } from './lib/modal';
import type { FogStatusView, FogTaskView, FogTaskTypeView } from '@showtrak/protocol';

// FOG state IDs that mean the task is still running (see FOG_TASK_STATES).
const OPEN_STATE_IDS = [0, 1, 2, 3];
const STATE_IN_PROGRESS = 3;

let FogStatus: FogStatusView = {
  Enabled: false,
  Healthy: false,
  Message: null,
  LastCheckedAt: null,
};
let FogTasks: FogTaskView[] = [];
let TrayVisible = false;

// The client whose editor opened the scheduling modal.
let PendingTaskUUID: string | null = null;
let PendingTaskTypes: FogTaskTypeView[] = [];

export function IsFogAvailable(): boolean {
  return !!(FogStatus.Enabled && FogStatus.Healthy);
}

function OpenTaskCount(): number {
  return FogTasks.filter((Task) => OPEN_STATE_IDS.includes(Task.StateID)).length;
}

// Finished (terminal-state) tasks are the history the Clear button discards.
function FinishedTaskCount(): number {
  return FogTasks.filter((Task) => !OPEN_STATE_IDS.includes(Task.StateID)).length;
}

// ---- Bottom bar button -----------------------------------------------------

// The button only exists while FOG is usable. When it disappears the tray must go
// with it, otherwise the panel is left orphaned with no way to dismiss it.
function UpdateFogButton(): void {
  const Button = document.getElementById('FOG_BUTTON');
  if (!Button) return;

  const Available = IsFogAvailable();
  Button.classList.toggle('d-none', !Available);
  if (!Available && TrayVisible) ToggleFogTray(false);

  const Count = OpenTaskCount();
  const Badge = Button.querySelector('.fog-count');
  if (Badge) {
    Badge.textContent = String(Count);
    Badge.classList.toggle('d-none', Count === 0);
  }
  Button.classList.toggle('has-tasks', Count > 0);
}

// ---- Tray ------------------------------------------------------------------

function RenderFogStatus(): void {
  const Status = document.getElementById('FOG_TRAY_STATUS');
  if (!Status) return;
  if (FogStatus.Healthy) {
    Status.textContent = 'Connected';
    Status.classList.remove('is-offline');
  } else {
    Status.textContent = FogStatus.Message ? 'Disconnected' : 'Not configured';
    Status.classList.add('is-offline');
  }
  Status.setAttribute('title', FogStatus.Message || '');
}

// Nothing finished means nothing to clear, so the button stays out of the header
// rather than sitting there as a no-op.
function RenderClearButton(): void {
  const Button = document.getElementById('FOG_CLEAR_FINISHED');
  if (!Button) return;

  const Count = FinishedTaskCount();
  Button.classList.toggle('d-none', Count === 0);
  Button.setAttribute(
    'title',
    `Clear ${Count} finished task${Count === 1 ? '' : 's'} from this list`
  );
  // A re-render lands while a clear is in flight; re-enable so the button is not
  // left dead if the operation failed.
  (Button as HTMLButtonElement).disabled = false;
}

function RenderFogTasks(): void {
  RenderFogStatus();
  RenderClearButton();

  const List = document.getElementById('FOG_TASK_LIST');
  if (!List) return;

  if (!FogTasks.length) {
    List.innerHTML = `<div class="fog-empty">No FOG tasks have been scheduled.</div>`;
    return;
  }

  let Html = '';
  for (const Task of FogTasks) {
    const InProgress = Task.StateID === STATE_IN_PROGRESS;
    const IsOpen = OPEN_STATE_IDS.includes(Task.StateID);

    // Only Deploy/Capture stream a percentage worth bar-charting; every other type
    // flips straight from queued to complete, so a bar would just sit at 0%.
    const ShowBar = InProgress && Task.SupportsProgress;

    // FOG serialises progress as display text ("45%"). A supported task that is
    // running but has not reported a figure yet (partclone still spinning up) gets an
    // indeterminate bar so it reads as working rather than stalled at zero.
    const HasPercent = !!(Task.Percent && /\d/.test(Task.Percent));
    const PercentNumber = HasPercent ? parseInt(String(Task.Percent), 10) : 0;
    const SafePercent = Number.isFinite(PercentNumber)
      ? Math.max(0, Math.min(100, PercentNumber))
      : 0;
    const Indeterminate = ShowBar && !HasPercent;

    const StateLabel = InProgress && Task.Percent ? `${Safe(Task.Percent)}` : Safe(Task.StateName);

    Html += `<div class="fog-task-item" data-state="${Task.StateID}">
      <div class="fog-task-title">
        <span class="fog-task-name">${Safe(Task.TaskTypeName || `Task ${Task.TaskTypeID}`)}</span>
        <span class="fog-task-state">${StateLabel}</span>
      </div>
      <div class="fog-task-client">${Safe(
        Task.ClientName || Task.FogHostName || `FOG host ${Task.FogHostID}`
      )}</div>
      ${
        ShowBar
          ? `<div class="fog-task-bar${Indeterminate ? ' is-indeterminate' : ''}"><span${
              Indeterminate ? '' : ` style="width: ${SafePercent}%"`
            }></span></div>`
          : ''
      }
      ${Task.LastError ? `<div class="fog-task-client">${Safe(Task.LastError)}</div>` : ''}
      ${
        IsOpen
          ? `<div class="fog-task-actions"><button type="button" class="fog-task-cancel" data-record-id="${Task.FogTaskRecordID}">Cancel task</button></div>`
          : ''
      }
    </div>`;
  }
  List.innerHTML = Html;
}

export function ToggleFogTray(force?: boolean): void {
  const Tray = document.getElementById('FOG_TRAY');
  if (!Tray) return;

  const Next = typeof force === 'boolean' ? force : !TrayVisible;
  TrayVisible = Next;

  if (TrayVisible) {
    Tray.hidden = false;
    RenderFogTasks();
    // Namespaced so teardown cannot disturb the alerts tray's own handler.
    $(document)
      .off('mousedown.fogTray touchstart.fogTray')
      .on('mousedown.fogTray touchstart.fogTray', function (Event) {
        // The confirm dialog is appended to <body>, outside the tray — treat it as
        // "inside" so cancelling a task does not dismiss the tray behind the prompt.
        const Inside =
          $(Event.target).closest('#FOG_TRAY, #FOG_BUTTON, #SHOWTRAK_CONFIRM_TOAST').length > 0;
        if (!Inside) ToggleFogTray(false);
      });
  } else {
    Tray.hidden = true;
    $(document).off('mousedown.fogTray touchstart.fogTray');
  }
}

// ---- Scheduling modal ------------------------------------------------------

function SelectedTaskType(): FogTaskTypeView | null {
  const Selected = parseInt(String($('#FOG_TASK_TYPE').val() || ''), 10);
  if (!Number.isFinite(Selected)) return null;
  return PendingTaskTypes.find((Type) => Type.TaskTypeID === Selected) || null;
}

// Show the snapin field and the destructive-action warning for the current
// selection. Re-run on every change so the modal never shows a stale warning.
function SyncTaskTypeUI(): void {
  const Type = SelectedTaskType();

  $('#FOG_TASK_SNAPIN_WRAPPER').toggleClass('d-none', !Type || !Type.RequiresSnapinID);

  const Destructive = !!(Type && Type.Destructive);
  $('#FOG_TASK_WARNING').toggleClass('d-none', !Destructive);
  if (Destructive && Type) {
    $('#FOG_TASK_WARNING_TEXT').text(
      `"${Type.Name}" is a destructive action and may cause data loss.`
    );
  }
}

export async function OpenFogTaskModal(
  UUID: string,
  ClientLabel: string,
  ImageName: string | null
): Promise<void> {
  if (!IsFogAvailable()) {
    await Notify('FOG is not currently reachable.', 'error');
    return;
  }

  PendingTaskUUID = UUID;
  PendingTaskTypes = await window.API.GetFogTaskTypes();

  if (!PendingTaskTypes.length) {
    await Notify('No FOG task types are permitted. Enable some in Settings.', 'error');
    return;
  }

  $('#FOG_TASK_TARGET').text(ClientLabel);
  // Deploy fails outright if the FOG host has no image assigned, and ShowTrak
  // deliberately never assigns one — so surface what FOG already has rather than
  // letting the operator find out via a 500.
  $('#FOG_TASK_TARGET_IMAGE').text(
    ImageName ? `Assigned image: ${ImageName}` : 'No image assigned in FOG'
  );

  let Options = '';
  for (const Type of PendingTaskTypes) {
    Options += `<option value="${Type.TaskTypeID}">${Safe(Type.Name)}</option>`;
  }
  $('#FOG_TASK_TYPE').html(Options);
  $('#FOG_TASK_SNAPIN').val('');
  SyncTaskTypeUI();

  $('#FOG_TASK_TYPE').off('change').on('change', SyncTaskTypeUI);

  $('#FOG_TASK_SCHEDULE')
    .off('click')
    .on('click', async () => {
      const Type = SelectedTaskType();
      if (!Type || !PendingTaskUUID) return;

      const SnapinRaw = String($('#FOG_TASK_SNAPIN').val() || '').trim();
      const SnapinID = Type.RequiresSnapinID ? parseInt(SnapinRaw, 10) : null;
      if (
        Type.RequiresSnapinID &&
        (!Number.isFinite(SnapinID as number) || (SnapinID as number) <= 0)
      ) {
        await Notify('Enter the snapin ID to deploy.', 'error');
        return;
      }

      const Confirmed = await ConfirmationDialog(
        Type.Destructive
          ? `Schedule "${Type.Name}" on ${ClientLabel}? This is destructive and can cause data loss.`
          : `Schedule "${Type.Name}" on ${ClientLabel}?`
      );
      if (!Confirmed) return;

      const [Err] = await window.API.ScheduleFogTask(PendingTaskUUID, Type.TaskTypeID, SnapinID);
      if (Err) {
        await Notify(String(Err), 'error');
        return;
      }

      closeModal('SHOWTRAK_MODAL_FOG_TASK');
      await Notify(`Scheduled "${Type.Name}" on ${ClientLabel}.`, 'success');
      // The backend pushes the new task list; open the tray so the operator can
      // watch it progress without hunting for the button.
      ToggleFogTray(true);
    });

  // Close the client editor first so the two modals don't stack — the FOG task
  // modal is launched from inside it, and leaving it open would leave the editor
  // orphaned behind the task modal.
  closeModal('SHOWTRAK_CLIENT_EDITOR');
  openModal('SHOWTRAK_MODAL_FOG_TASK');
}

// ---- Init ------------------------------------------------------------------

export function InitFog(): void {
  const Button = document.getElementById('FOG_BUTTON');
  if (Button && !Button.dataset.bound) {
    Button.dataset.bound = '1';
    Button.addEventListener('click', () => ToggleFogTray());
  }

  // Header markup is static, so bind straight to the button. Running tasks are
  // never cleared — the backend filters by state, and the wording says so, so the
  // operator cannot mistake this for a bulk cancel.
  $('#FOG_CLEAR_FINISHED')
    .off('click.fogClear')
    .on('click.fogClear', async function () {
      const Count = FinishedTaskCount();
      if (!Count) return;

      const Confirmed = await ConfirmationDialog(
        `Clear ${Count} finished task${Count === 1 ? '' : 's'} from the list? Running tasks are not affected.`
      );
      if (!Confirmed) return;

      const $Btn = $(this);
      $Btn.prop('disabled', true);
      const [Err] = await window.API.ClearFinishedFogTasks();
      if (Err) {
        $Btn.prop('disabled', false);
        await Notify(String(Err), 'error');
        return;
      }
      // The backend pushes the trimmed task list, which re-renders the tray.
      await Notify(`Cleared ${Count} finished task${Count === 1 ? '' : 's'}.`, 'success');
    });

  // Delegated so it survives the list being re-rendered on every push.
  $('#FOG_TASK_LIST')
    .off('click.fogCancel', '.fog-task-cancel')
    .on('click.fogCancel', '.fog-task-cancel', async function () {
      const RecordID = parseInt(String($(this).data('recordId')), 10);
      if (!Number.isFinite(RecordID)) return;

      const Task = FogTasks.find((Candidate) => Candidate.FogTaskRecordID === RecordID) || null;
      const Label = Task ? Task.TaskTypeName || `Task ${Task.TaskTypeID}` : 'this task';
      const Target = Task ? Task.ClientName || Task.FogHostName || '' : '';

      const Confirmed = await ConfirmationDialog(
        `Cancel "${Label}"${Target ? ` on ${Target}` : ''}? The task will be stopped in FOG.`
      );
      if (!Confirmed) return;

      const $Btn = $(this);
      $Btn.prop('disabled', true);
      const [Err] = await window.API.CancelFogTask(RecordID);
      if (Err) {
        $Btn.prop('disabled', false);
        await Notify(String(Err), 'error');
        return;
      }
      // The backend pushes the updated task list, which re-renders this row.
      await Notify(`Cancelled "${Label}".`, 'success');
    });

  window.API.OnFogStatusUpdated((Status: FogStatusView) => {
    FogStatus = Status;
    UpdateFogButton();
    if (TrayVisible) RenderFogTasks();
  });

  window.API.OnSetFogTaskList((Tasks: FogTaskView[]) => {
    FogTasks = Array.isArray(Tasks) ? Tasks : [];
    UpdateFogButton();
    if (TrayVisible) RenderFogTasks();
  });
}
