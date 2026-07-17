// IPC registrar: alert rules + global alert-action toggle. Extracted verbatim
// from main.ts.

import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import type { IPCValidationManager } from '../../Modules/IPCValidation';
const { Manager: AlertsManager } = require('../../Modules/AlertsManager') as typeof import('../../Modules/AlertsManager');
const { Manager: IPCValidation }: { Manager: IPCValidationManager } = require('../../Modules/IPCValidation');

function register(): void {
  RPC.handle('GetAlertTriggers', async () => {
    return AlertsManager.GetTriggers();
  });

  RPC.handle('GetAlertActionTypes', async () => {
    return AlertsManager.GetActionTypes();
  });

  RPC.handle('GetAllAlertRules', async () => {
    const [Err, Rules] = await AlertsManager.GetAll();
    if (Err) return [];
    return Rules || [];
  });

  RPC.handle('GetAlertRule', async (_Event: unknown, RuleID: unknown) => {
    try {
      RuleID = IPCValidation.AlertRuleID(RuleID);
    } catch {
      return null;
    }
    const [Err, Rule] = await AlertsManager.Get(RuleID);
    if (Err) return null;
    return Rule;
  });

  RPC.handle(
    'CreateAlertRule',
    createTupleHandler<[Record<string, unknown>], unknown>(
      (Payload: unknown) => IPCValidation.AlertRuleCreatePayload(Payload),
      // The IPC validator has already normalized this into a valid create payload
      // (runtime-checked shape the type system can't see across the boundary).
      (Payload: Record<string, unknown>) =>
        AlertsManager.Create(Payload as unknown as Parameters<typeof AlertsManager.Create>[0])
    )
  );

  RPC.handle(
    'UpdateAlertRule',
    createTupleHandler<[number, Record<string, unknown>], unknown>(
      (RuleID: unknown, Payload: unknown) => [
        IPCValidation.AlertRuleID(RuleID),
        IPCValidation.AlertRuleUpdatePayload(Payload),
      ],
      (RuleID: number, Payload: Record<string, unknown>) => AlertsManager.Update(RuleID, Payload)
    )
  );

  RPC.handle(
    'DeleteAlertRule',
    createTupleHandler<[number], unknown>(
      (RuleID: unknown) => IPCValidation.AlertRuleID(RuleID),
      (RuleID: number) => AlertsManager.Delete(RuleID),
      { invalidFallback: false }
    )
  );

  RPC.handle(
    'SetAlertRuleEnabled',
    createTupleHandler<[number, boolean], unknown>(
      (RuleID: unknown, Enabled: unknown) => [IPCValidation.AlertRuleID(RuleID), !!Enabled],
      (RuleID: number, Enabled: boolean) => AlertsManager.SetEnabled(RuleID, Enabled)
    )
  );

  RPC.handle('AlertActionsEnabled:Get', async () => {
    return AlertsManager.GetActionsEnabled();
  });

  RPC.handle('AlertActionsEnabled:Set', async (_Event: unknown, Enabled: unknown) => {
    return AlertsManager.SetActionsEnabled(!!Enabled);
  });
}

export { register };
