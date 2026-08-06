// IPC registrar: Show Variables (create/rename/describe/default/export/delete)
// plus the per-client override read used by the client editor.
//
// Variables are operator-defined values that reach a client's scripts as
// environment variables: GAME_VERSION arrives as %SHOWTRAK_VAR_GAME_VERSION%.
// Each carries a default; any client may override it.
//
// Writing a client's overrides is deliberately NOT a channel here — it rides the
// existing UpdateClient payload as a `Variables` field, so the client editor
// saves the whole form in one round trip and one undo-able action.

import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import { Manager as VariableManager } from '../../Modules/VariableManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

function register(): void {
  // Reader: every definition with its override count. Empty list on any error.
  RPC.handle('Variables:GetAll', async (_Event: unknown) => {
    return VariableManager.GetAllViews();
  });

  // Create a variable (optional starting name; normalized and de-collided).
  // Returns the created view so the renderer can focus its name field.
  RPC.handle('Variables:Create', async (_Event: unknown, Key: unknown) => {
    const [Err, Variable] = await VariableManager.Create(typeof Key === 'string' ? Key : undefined);
    if (Err || !Variable) return [Err || 'Failed to create variable', null];
    return [null, Variable];
  });

  // Rename. The manager normalizes to upper snake case, rejects the reserved
  // SHOWTRAK_ namespace and refuses a duplicate; overrides survive because they
  // are keyed on VariableID, not on the name.
  RPC.handle(
    'Variables:SetKey',
    createTupleHandler<[number, string], unknown>(
      (VariableID: unknown, Key: unknown) => [
        IPCValidation.VariableID(VariableID),
        IPCValidation.VariableText(Key, 'Key'),
      ],
      (VariableID: number, Key: string) => VariableManager.SetKey(VariableID, Key)
    )
  );

  RPC.handle(
    'Variables:SetDescription',
    createTupleHandler<[number, string], unknown>(
      (VariableID: unknown, Description: unknown) => [
        IPCValidation.VariableID(VariableID),
        IPCValidation.VariableText(Description, 'Description'),
      ],
      (VariableID: number, Description: string) =>
        VariableManager.SetDescription(VariableID, Description)
    )
  );

  // Changing a default moves every client that has not overridden it, so the
  // manager fans the push out to all of them.
  RPC.handle(
    'Variables:SetDefault',
    createTupleHandler<[number, string], unknown>(
      (VariableID: unknown, DefaultValue: unknown) => [
        IPCValidation.VariableID(VariableID),
        IPCValidation.VariableText(DefaultValue, 'DefaultValue'),
      ],
      (VariableID: number, DefaultValue: string) =>
        VariableManager.SetDefault(VariableID, DefaultValue)
    )
  );

  // Whether the value is also mirrored into the Windows user environment so
  // applications outside ShowTrak can read it. Ignored by macOS/Linux clients.
  RPC.handle(
    'Variables:SetExport',
    createTupleHandler<[number, boolean], unknown>(
      (VariableID: unknown, ExportToSystem: unknown) => [
        IPCValidation.VariableID(VariableID),
        !!ExportToSystem,
      ],
      (VariableID: number, ExportToSystem: boolean) =>
        VariableManager.SetExport(VariableID, ExportToSystem)
    )
  );

  RPC.handle(
    'Variables:Delete',
    createTupleHandler<[number], unknown>(
      (VariableID: unknown) => IPCValidation.VariableID(VariableID),
      (VariableID: number) => VariableManager.Delete(VariableID),
      { invalidFallback: false }
    )
  );

  // Reader: definitions joined with one client's overrides, for the client
  // editor. Empty list on any error (including an unknown UUID).
  RPC.handle('Variables:GetForClient', async (_Event: unknown, UUID: unknown) => {
    if (typeof UUID !== 'string' || !UUID.trim()) return [];
    return VariableManager.GetClientViews(UUID.trim());
  });
}

export { register };
