// IPC registrar: client groups (create/rename/delete/order/keybind/full-width).
// Extracted verbatim from main.ts.

import { RPC } from '../rpc';
import { createTupleHandler, validationErrorTuple } from '../ipc/create-handler';
import type { IPCValidationManager } from '../../Modules/IPCValidation';
const { Manager: GroupManager } = require('../../Modules/GroupManager');
const { Manager: MonitoringTargetManager } = require('../../Modules/MonitoringTargetManager');
const { Manager: DummyClientManager } = require('../../Modules/DummyClientManager');
const { Manager: ClientManager } = require('../../Modules/ClientManager');
const { Manager: BroadcastManager } = require('../../Modules/Broadcast');
const { Manager: IPCValidation }: { Manager: IPCValidationManager } = require('../../Modules/IPCValidation');

function register(): void {
  RPC.handle('GetAllGroups', async (_Event: unknown) => {
    const [Err, Groups] = await GroupManager.GetAll();
    if (Err) return [];
    if (!Groups) return [];
    return Groups;
  });

  RPC.handle(
    'CreateGroup',
    createTupleHandler<[string], unknown>(
      (Title: unknown) => IPCValidation.GroupTitle(Title),
      (Title: string) => GroupManager.Create(Title)
    )
  );

  RPC.handle(
    'RenameGroup',
    createTupleHandler<[number | null, string], unknown>(
      (GroupID: unknown, Title: unknown) => [IPCValidation.GroupID(GroupID), IPCValidation.GroupTitle(Title)],
      (GroupID: number | null, Title: string) => GroupManager.Rename(GroupID, Title)
    )
  );

  RPC.handle(
    'DeleteGroup',
    createTupleHandler<[number | null], unknown>(
      (GroupID: unknown) => IPCValidation.GroupID(GroupID),
      (GroupID: number | null) => GroupManager.Delete(GroupID)
    )
  );

  RPC.handle(
    'Groups:SetFullWidth',
    createTupleHandler<[number | null, boolean], unknown>(
      (GroupID: unknown, FullWidth: unknown) => [
        IPCValidation.GroupID(GroupID),
        IPCValidation.Boolean(FullWidth, 'FullWidth'),
      ],
      (GroupID: number | null, FullWidth: boolean) => GroupManager.SetFullWidth(GroupID, FullWidth)
    )
  );

  RPC.handle(
    'Groups:SetKeyBind',
    createTupleHandler<[number | null, string | null], unknown>(
      (GroupID: unknown, KeyBind: unknown) => [IPCValidation.GroupID(GroupID), IPCValidation.GroupKeyBind(KeyBind)],
      (GroupID: number | null, KeyBind: string | null) => GroupManager.SetKeyBind(GroupID, KeyBind)
    )
  );

  RPC.handle('Groups:SetOrder', async (_Event: unknown, OrderedGroupIDs: unknown) => {
    if (!Array.isArray(OrderedGroupIDs)) return ['Invalid order', null];

    let ParsedGroupIDs: (number | null)[];
    try {
      ParsedGroupIDs = OrderedGroupIDs.map((GroupID) => IPCValidation.GroupID(GroupID, 'GroupID'));
    } catch (error) {
      return validationErrorTuple(error, false);
    }

    const Result = await GroupManager.SetOrder(
      Array.from(new Set(ParsedGroupIDs.filter((GroupID) => GroupID !== null)))
    );
    if (!Result.ok) {
      return [
        Result.errors && Result.errors[0] ? Result.errors[0] : 'Failed to reorder groups',
        null,
      ];
    }
    return [null, true];
  });

  RPC.handle('SetGroupOrder', async (_Event: unknown, GroupID: unknown, OrderedUUIDs: unknown) => {
    let ParsedGroupID: number | null;
    let ParsedOrderedUUIDs: string[];
    try {
      ParsedGroupID = IPCValidation.GroupID(GroupID);
      ParsedOrderedUUIDs = IPCValidation.UUIDList(OrderedUUIDs || [], 'Ordered UUIDs');
    } catch (error) {
      return validationErrorTuple(error, false);
    }
    // Mixed list: client UUIDs, "monitor:<TargetID>" and "dummy:<UUID>" entries.
    // Walk in order assigning a single shared weight counter so visual order
    // is preserved across all entity types when rendered together.
    let Weight = 10;
    const ClientOrder = [];
    const MonitorAssignments = [];
    const DummyAssignments = [];
    for (const ID of ParsedOrderedUUIDs) {
      if (typeof ID === 'string' && ID.startsWith('monitor:')) {
        const TargetID = parseInt(ID.slice('monitor:'.length), 10);
        if (Number.isFinite(TargetID)) {
          MonitorAssignments.push({ TargetID, Weight });
        }
      } else if (typeof ID === 'string' && ID.startsWith('dummy:')) {
        const DummyUUID = ID.slice('dummy:'.length);
        if (DummyUUID) {
          DummyAssignments.push({ UUID: DummyUUID, Weight });
        }
      } else {
        ClientOrder.push({ UUID: ID, Weight });
      }
      Weight += 10;
    }
    // Apply monitor moves first (they don't emit per-change broadcasts here).
    for (const { TargetID, Weight: W } of MonitorAssignments) {
      await MonitoringTargetManager.SetGroupAndWeight(TargetID, ParsedGroupID, W);
    }
    // Apply dummy client moves (also silent until the coalesced refresh below).
    for (const { UUID, Weight: W } of DummyAssignments) {
      await DummyClientManager.SetGroupAndWeight(UUID, ParsedGroupID, W);
    }
    // Apply client ordering. ClientManager.SetGroupOrder reassigns weights
    // sequentially starting at 10, so feed it just the UUIDs in order — but
    // we want the shared weight scale, so apply directly per-client instead.
    if (ClientOrder.length) {
      await ClientManager.SetGroupOrderWithWeights(
        ParsedGroupID,
        ClientOrder.map((c) => c.UUID),
        ClientOrder.map((c) => c.Weight)
      );
    }
    if (MonitorAssignments.length) {
      // Single coalesced refresh for monitors after batch.
      BroadcastManager.emit('MonitoringTargetListChanged');
    }
    if (DummyAssignments.length) {
      BroadcastManager.emit('DummyClientListChanged');
    }
    return true;
  });
}

export { register };
