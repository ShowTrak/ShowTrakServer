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

function RenderFogTasks(): void {
  RenderFogStatus();

  const List = document.getElementById('FOG_TASK_LIST');
  if (!List) return;

  if (!FogTasks.length) {
    List.innerHTML = `<div class="fog-empty">No FOG tasks have been scheduled.</div>`;
    return;
  }

  let Html = '';
  for (const Task of FogTasks) {
    // Percent is only meaningful once FOG reports the task as in progress; before
    // that FOG's value is stale or zero and a progress bar would be misleading.
    const InProgress = Task.StateID === STATE_IN_PROGRESS;
    const PercentNumber = InProgress ? parseInt(String(Task.Percent || '0'), 10) : 0;
    const SafePercent = Number.isFinite(PercentNumber)
      ? Math.max(0, Math.min(100, PercentNumber))
      : 0;

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
        InProgress
          ? `<div class="fog-task-bar"><span style="width: ${SafePercent}%"></span></div>`
          : ''
      }
      ${Task.LastError ? `<div class="fog-task-client">${Safe(Task.LastError)}</div>` : ''}
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
        const Inside = $(Event.target).closest('#FOG_TRAY, #FOG_BUTTON').length > 0;
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
      `"${Type.Name}" is destructive and can cause data loss on the target machine.`
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
      if (Type.RequiresSnapinID && (!Number.isFinite(SnapinID as number) || (SnapinID as number) <= 0)) {
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

  openModal('SHOWTRAK_MODAL_FOG_TASK');
}

// ---- Init ------------------------------------------------------------------

export function InitFog(): void {
  const Button = document.getElementById('FOG_BUTTON');
  if (Button && !Button.dataset.bound) {
    Button.dataset.bound = '1';
    Button.addEventListener('click', () => ToggleFogTray());
  }

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
