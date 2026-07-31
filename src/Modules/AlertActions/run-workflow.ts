// Alert action: run a workflow.
//
// This is the bridge between the two systems. An alert rule keeps deciding WHEN
// something happened; the workflow decides what to do about it, in order, with
// conditions. It is also the migration path — if alert rules eventually become
// workflows, the rules that already delegate here need no rethinking.
//
// IMPORTANT: this must NOT import WorkflowManager.
//
// WorkflowManager imports AlertActions (a workflow step can run any alert
// action). A static import back the other way is a genuine require cycle: Node
// resolves it, but one side sees a half-initialised module at load and the
// failure is a confusing undefined rather than an error. Dispatching through the
// shared handler registry avoids the cycle entirely AND reuses the IPC
// validation and permission gating rather than re-implementing them.
import { GetHandler } from '../../main/handler-registry';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'run-workflow';

const Settings: AlertActionSettingField[] = [
  {
    Key: 'WorkflowID',
    Label: 'Workflow',
    Type: 'select',
    Default: '',
    // Populated by the renderer from the live workflow list, the same way the
    // audio-asset picker is.
    Source: 'workflows',
  },
  {
    Key: 'UseAlertContext',
    Label: 'Run against the alerting machine',
    Type: 'boolean',
    Default: true,
  },
];

function NormalizeSettings(Input: unknown): Record<string, unknown> {
  const Source = Input && typeof Input === 'object' ? (Input as Record<string, unknown>) : {};
  return {
    WorkflowID: String(Source.WorkflowID == null ? '' : Source.WorkflowID),
    UseAlertContext: Source.UseAlertContext === undefined ? true : !!Source.UseAlertContext,
  };
}

// Rebuild the ScopedID from an alert context. The context carries the parts
// rather than the composed id, and the check case has to be checked first — a
// check-scoped alert also carries a TargetID.
function ScopedIDFromContext(Context: AlertContext): string | null {
  if (Context.CheckID != null) return `check:${Context.CheckID}`;
  if (Context.EntityType === 'monitor' && Context.TargetID != null) {
    return `monitor:${Context.TargetID}`;
  }
  return Context.UUID ? String(Context.UUID) : null;
}

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const Settings0 = (Action.Settings || {}) as Record<string, unknown>;
  const WorkflowID = Number(Settings0.WorkflowID);
  if (!Number.isFinite(WorkflowID) || WorkflowID <= 0) {
    return { Success: false, Error: 'No workflow selected' };
  }

  const Handler = GetHandler('Workflows:Run');
  if (typeof Handler !== 'function') {
    return { Success: false, Error: 'Workflow handler unavailable' };
  }

  const ScopedID = Settings0.UseAlertContext ? ScopedIDFromContext(Context) : null;

  try {
    // Always 'normal' mode: an alert fires unattended, and a step-mode run would
    // pause immediately waiting for an operator who is not there.
    const Result = (await Handler(null, WorkflowID, ScopedID, 'normal')) as [
      string | null,
      unknown,
    ];
    if (Array.isArray(Result) && Result[0]) {
      return { Success: false, Error: String(Result[0]) };
    }
    Logger.info(`Started workflow ${WorkflowID}${ScopedID ? ` against ${ScopedID}` : ''}`);
    return { Success: true };
  } catch (Err) {
    return {
      Success: false,
      Error: Err && (Err as Error).message ? (Err as Error).message : String(Err),
    };
  }
}

export const Name = 'Run Workflow';
export const Description =
  'Run a workflow, optionally against the machine the alert fired for. Use this when the response needs steps, conditions or a delay rather than a single message.';
export { ID, Settings, NormalizeSettings, Execute };
