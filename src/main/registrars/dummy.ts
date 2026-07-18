// IPC registrar: dummy (placeholder) clients. Extracted verbatim from main.ts.

import { RPC } from '../rpc';
import { createTupleHandler } from '../ipc/create-handler';
import { Manager as DummyClientManager } from '../../Modules/DummyClientManager';
import { Manager as IPCValidation } from '../../Modules/IPCValidation';

function register(): void {
  RPC.handle('GetAllDummyClients', async () => {
    const [Err, List] = await DummyClientManager.GetAll();
    if (Err) return [];
    return List || [];
  });

  RPC.handle('GetDummyClient', async (_Event: unknown, UUID: unknown) => {
    let ValidUUID;
    try {
      ValidUUID = IPCValidation.DummyClientUUID(UUID);
    } catch {
      return null;
    }
    const [Err, Dummy] = await DummyClientManager.Get(ValidUUID);
    if (Err) return null;
    return Dummy;
  });

  RPC.handle('GenerateDummyClientDefaults', async () => {
    return await DummyClientManager.GenerateDefaults();
  });

  RPC.handle(
    'CreateDummyClient',
    createTupleHandler<[Record<string, unknown>], unknown>(
      (Payload: unknown) => IPCValidation.DummyClientCreatePayload(Payload),
      (Payload: Record<string, unknown>) => DummyClientManager.Create(Payload)
    )
  );

  RPC.handle(
    'UpdateDummyClient',
    createTupleHandler<[string, Record<string, unknown>], unknown>(
      (UUID: unknown, Payload: unknown) => [
        IPCValidation.DummyClientUUID(UUID),
        IPCValidation.DummyClientUpdatePayload(Payload),
      ],
      (UUID: string, Payload: Record<string, unknown>) => DummyClientManager.Update(UUID, Payload)
    )
  );

  RPC.handle(
    'DeleteDummyClient',
    createTupleHandler<[string], unknown>(
      (UUID: unknown) => IPCValidation.DummyClientUUID(UUID),
      (UUID: string) => DummyClientManager.Delete(UUID)
    )
  );

  RPC.handle(
    'ResetDummyClientToIdle',
    createTupleHandler<[string], unknown>(
      (UUID: unknown) => IPCValidation.DummyClientUUID(UUID),
      (UUID: string) => DummyClientManager.ResetToIdle(UUID)
    )
  );
}

export { register };
