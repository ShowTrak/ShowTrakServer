// IPC registrar: workflows, plus the control actions a monitoring check can
// perform.
//
// Readers return raw values with []/null fallbacks; mutations go through
// createTupleHandler. Both conventions are documented in ../ipc/create-handler.

import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import { Manager as WorkflowManager } from '../../Modules/WorkflowManager';
import { Manager as MonitoringTargetManager } from '../../Modules/MonitoringTargetManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';
import { WORKFLOW_STEP_KINDS } from '../../Modules/WorkflowManager/steps';

function register(): void {
  // --- Readers ---------------------------------------------------------------

  RPC.handle('Workflows:GetAll', async () => {
    const [Err, List] = await WorkflowManager.GetAll();
    if (Err) return [];
    return List || [];
  });

  RPC.handle('Workflows:Get', async (_Event: unknown, WorkflowID: unknown) => {
    try {
      WorkflowID = IPCValidation.WorkflowID(WorkflowID);
    } catch {
      return null;
    }
    const [Err, Workflow] = await WorkflowManager.Get(WorkflowID);
    if (Err) return null;
    return Workflow;
  });

  // Which workflows are offered for one entity. Filtering happens HERE, not in
  // the renderer: the renderer has a mirror of ScopeMatching, but workflow
  // visibility must be one decision made in one place, or the context menu and
  // the check row will eventually disagree.
  RPC.handle('Workflows:GetForContext', async (_Event: unknown, ScopedID: unknown) => {
    try {
      ScopedID = IPCValidation.WorkflowScopedID(ScopedID);
    } catch {
      return [];
    }
    const [Err, List] = await WorkflowManager.GetForContext(ScopedID);
    if (Err) return [];
    return List || [];
  });

  RPC.handle('Workflows:GetStepKinds', async () => WORKFLOW_STEP_KINDS);

  RPC.handle('Workflows:GetTriggerTypes', async () => WorkflowManager.GetTriggerTypes());

  RPC.handle('Workflows:GetHistory', async (_Event: unknown, WorkflowID: unknown) => {
    try {
      WorkflowID = IPCValidation.WorkflowID(WorkflowID);
    } catch {
      return [];
    }
    const [Err, Rows] = await WorkflowManager.GetHistory(WorkflowID);
    if (Err) return [];
    return Rows || [];
  });

  RPC.handle('Monitoring:GetCheckActions', async (_Event: unknown, CheckID: unknown) => {
    try {
      CheckID = IPCValidation.MonitoringTargetID(CheckID, 'CheckID');
    } catch {
      return [];
    }
    const [Err, Actions] = MonitoringTargetManager.GetCheckActions(CheckID);
    if (Err) return [];
    return Actions || [];
  });

  // --- Mutations -------------------------------------------------------------

  RPC.handle(
    'Workflows:Create',
    createTupleHandler<[Record<string, unknown>], unknown>(
      (Payload: unknown) => IPCValidation.WorkflowCreatePayload(Payload),
      (Payload: Record<string, unknown>) =>
        WorkflowManager.Create(Payload as unknown as Parameters<typeof WorkflowManager.Create>[0])
    )
  );

  RPC.handle(
    'Workflows:Update',
    createTupleHandler<[number, Record<string, unknown>], unknown>(
      (WorkflowID: unknown, Payload: unknown) => [
        IPCValidation.WorkflowID(WorkflowID),
        IPCValidation.WorkflowUpdatePayload(Payload),
      ],
      (WorkflowID: number, Payload: Record<string, unknown>) =>
        WorkflowManager.Update(WorkflowID, Payload)
    )
  );

  RPC.handle(
    'Workflows:Delete',
    createTupleHandler<[number], unknown>(
      (WorkflowID: unknown) => IPCValidation.WorkflowID(WorkflowID),
      (WorkflowID: number) => WorkflowManager.Delete(WorkflowID),
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'Workflows:SetEnabled',
    createTupleHandler<[number, boolean], unknown>(
      (WorkflowID: unknown, Enabled: unknown) => [IPCValidation.WorkflowID(WorkflowID), !!Enabled],
      (WorkflowID: number, Enabled: boolean) => WorkflowManager.SetEnabled(WorkflowID, Enabled)
    )
  );

  RPC.handle(
    'Workflows:SetOrder',
    createTupleHandler<[number[]], unknown>(
      (OrderedIDs: unknown) => IPCValidation.WorkflowOrderList(OrderedIDs),
      (OrderedIDs: number[]) => WorkflowManager.SetOrder(Array.from(new Set(OrderedIDs))),
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'Workflows:SetSlug',
    createTupleHandler<[number, unknown], unknown>(
      (WorkflowID: unknown, Slug: unknown) => [IPCValidation.WorkflowID(WorkflowID), Slug],
      (WorkflowID: number, Slug: unknown) => WorkflowManager.SetSlug(WorkflowID, Slug),
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'Workflows:Run',
    createTupleHandler<[number, string | null, string], unknown>(
      (WorkflowID: unknown, ScopedID: unknown, Mode: unknown) => [
        IPCValidation.WorkflowID(WorkflowID),
        ScopedID == null || ScopedID === '' ? null : IPCValidation.WorkflowScopedID(ScopedID),
        IPCValidation.WorkflowRunMode(Mode),
      ],
      (WorkflowID: number, ScopedID: string | null, Mode: string) =>
        WorkflowManager.Run(
          WorkflowID,
          { ScopedID },
          'manual',
          Mode as Parameters<typeof WorkflowManager.Run>[3]
        )
    )
  );

  RPC.handle(
    'Workflows:Abort',
    createTupleHandler<[string], unknown>(
      (RunKey: unknown) => IPCValidation.WorkflowRunKey(RunKey),
      (RunKey: string) => WorkflowManager.Abort(RunKey),
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'Workflows:Step',
    createTupleHandler<[string], unknown>(
      (RunKey: unknown) => IPCValidation.WorkflowRunKey(RunKey),
      (RunKey: string) => WorkflowManager.Step(RunKey),
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'Workflows:Continue',
    createTupleHandler<[string], unknown>(
      (RunKey: unknown) => IPCValidation.WorkflowRunKey(RunKey),
      (RunKey: string) => WorkflowManager.Continue(RunKey),
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'Workflows:AnswerPrompt',
    createTupleHandler<[{ RunKey: string; StepID: string; Value: string }], unknown>(
      (Answer: unknown) => IPCValidation.WorkflowPromptAnswer(Answer),
      (Answer: { RunKey: string; StepID: string; Value: string }) =>
        WorkflowManager.AnswerPrompt(Answer.RunKey, Answer.StepID, Answer.Value),
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'Monitoring:RunCheckAction',
    createTupleHandler<[number, string, Record<string, unknown>], unknown>(
      (CheckID: unknown, ActionID: unknown, Params: unknown) => [
        IPCValidation.MonitoringTargetID(CheckID, 'CheckID'),
        IPCValidation.MonitoringCheckActionID(ActionID),
        IPCValidation.WorkflowParams(Params),
      ],
      (CheckID: number, ActionID: string, Params: Record<string, unknown>) =>
        MonitoringTargetManager.RunCheckAction(CheckID, ActionID, Params)
    )
  );
}

export { register };
