// The Control and Workflows rows in a monitoring check's editor.
//
// Both need a saved CheckID: an unsaved check has no live probe to act on and
// nothing to scope a workflow to, so both blocks stay hidden until it exists.
//
// Which workflows appear is decided by the SERVER (Workflows:GetForContext), not
// by the renderer's scope-matching mirror. The context menu asks the same
// question the same way — if the two filtered independently they would sooner or
// later disagree about which workflows apply to a check.
import type { MonitoringMethodActionView, WorkflowView } from '@showtrak/protocol';
import { Safe } from '../utils';
import { Notify, ConfirmationDialog } from '../lib/toasts';
import { OpenWorkflowManager, RunWorkflowForEntity } from '../workflows';

// Track which check the rows are currently showing, so an async load that
// resolves after the operator has moved to another check is discarded rather
// than painting the wrong device's commands.
let RenderedCheckID: number | null = null;

export function HideCheckControl(): void {
  RenderedCheckID = null;
  $('#MONITORING_CHECK_CONTROL').addClass('d-none');
  $('#MONITORING_CHECK_WORKFLOWS_BLOCK').addClass('d-none');
}

export async function RenderCheckControl(CheckID: unknown): Promise<void> {
  const ID = Number(CheckID);
  if (!Number.isFinite(ID) || ID <= 0) {
    HideCheckControl();
    return;
  }
  RenderedCheckID = ID;

  await Promise.all([RenderCheckActions(ID), RenderCheckWorkflows(ID)]);
}

async function RenderCheckActions(CheckID: number): Promise<void> {
  const $Block = $('#MONITORING_CHECK_CONTROL');
  const $Host = $('#MONITORING_CHECK_ACTIONS');
  if (!$Host.length) return;

  let Actions: MonitoringMethodActionView[] = [];
  try {
    Actions = await window.API.GetMonitoringCheckActions(CheckID);
  } catch {
    Actions = [];
  }
  if (RenderedCheckID !== CheckID) return;

  // A read-only method has no commands; showing an empty Control box would
  // imply something is missing rather than that none exist.
  if (!Actions.length) {
    $Block.addClass('d-none');
    return;
  }

  $Host.html(
    Actions.map((Action) => {
      const Style = Action.Destructive ? 'btn-outline-danger' : 'btn-light';
      const Params = (Action.Params || []).length
        ? ' <i class="bi bi-sliders ms-1" title="Takes parameters"></i>'
        : '';
      return `<button type="button" class="btn btn-sm ${Style} monitoring-check-action"
                data-actionid="${Safe(Action.ID)}"
                data-destructive="${Action.Destructive ? '1' : '0'}"
                data-label="${Safe(Action.Label)}"
                title="${Safe(Action.Note || Action.Label)}">
                <i class="bi bi-${Safe(Action.Icon || 'lightning-charge')} me-1"></i>${Safe(
                  Action.Label
                )}${Params}
              </button>`;
    }).join('')
  );
  $Block.removeClass('d-none');

  $Host
    .find('.monitoring-check-action')
    .off('click.checkControl')
    .on('click.checkControl', async function () {
      const ActionID = String($(this).data('actionid'));
      const Label = String($(this).data('label'));
      const Action = Actions.find((A) => A.ID === ActionID);

      // Parameterised commands are not run from here. A cue number typed into a
      // one-click button is exactly the kind of thing that fires the wrong cue,
      // and the workflow editor is where a command gets its parameters checked.
      if (Action && (Action.Params || []).length) {
        void Notify(
          `"${Label}" takes parameters — add it as a workflow step so they can be set and checked.`,
          'info',
          5000
        );
        return;
      }

      if (String($(this).data('destructive')) === '1') {
        const Confirmed = await ConfirmationDialog(`${Label}? This affects the live device.`);
        if (!Confirmed) return;
      }

      const [Err, Result] = await window.API.RunMonitoringCheckAction(CheckID, ActionID, {});
      if (Err) return void Notify(String(Err), 'error', 5000);

      const Outcome = Result as { Success?: boolean; Detail?: string; Error?: string } | null;
      if (!Outcome || !Outcome.Success) {
        return void Notify(Outcome?.Error || `${Label} failed`, 'error', 6000);
      }
      // Detail already distinguishes "sent" from "acknowledged" for the
      // fire-and-forget transports, so it is reported verbatim rather than
      // flattened to a generic success message.
      void Notify(Outcome.Detail || `${Label} sent`, 'success', 3000);
    });
}

async function RenderCheckWorkflows(CheckID: number): Promise<void> {
  const $Block = $('#MONITORING_CHECK_WORKFLOWS_BLOCK');
  const $Host = $('#MONITORING_CHECK_WORKFLOWS');
  if (!$Host.length) return;

  const ScopedID = `check:${CheckID}`;
  let Workflows: WorkflowView[] = [];
  try {
    Workflows = await window.API.GetWorkflowsForContext(ScopedID);
  } catch {
    Workflows = [];
  }
  if (RenderedCheckID !== CheckID) return;

  $Host.html(
    Workflows.length
      ? Workflows.map(
          (W) => `
          <div class="d-flex align-items-center gap-2 rounded p-2 bg-body-tertiary">
            <i class="bi bi-${Safe(W.Icon || 'diagram-3')}"></i>
            <div class="flex-grow-1 text-truncate">${Safe(W.Name)}</div>
            <button type="button" class="btn btn-sm btn-primary monitoring-check-workflow-run"
                    data-workflowid="${W.WorkflowID}">Run</button>
          </div>`
        ).join('')
      : // Per-check scoping is strictly opt-in server-side (a workspace-wide
        // workflow deliberately does not fan out across every check), so an
        // empty list here means "none name this check", not "none exist".
        '<div class="text-muted small">No workflows are scoped to this check. Add this check to a workflow\'s targets to offer it here.</div>'
  );
  $Block.removeClass('d-none');

  $Host
    .find('.monitoring-check-workflow-run')
    .off('click.checkControl')
    .on('click.checkControl', async function () {
      await RunWorkflowForEntity(Number($(this).data('workflowid')), ScopedID);
    });

  $('#MONITORING_CHECK_WORKFLOWS_MANAGE')
    .off('click.checkControl')
    .on('click.checkControl', () => void OpenWorkflowManager());
}
