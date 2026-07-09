// DummyClientManager
// Owns the lifecycle of virtual "Dummy" clients: persistence, ID generation,
// CRUD, heartbeat routing (by DummyID) and group ordering. Connection state is
// kept in RAM by each DummyClient instance and surfaced to the UI via the
// 'DummyClientUpdated' / 'DummyClientListChanged' broadcast events.
import { Manager as DB } from '../DB';
import { CreateDummyClientsRepository } from '../DB/repositories/dummy-clients';
import { Manager as BroadcastManager } from '../Broadcast';
import { Ok, Fail } from '../Utils';
import { createGroupOrdering } from '../Shared/group-ordering';
import type { Result } from '../../types/result';

import {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  ClampInterval,
  SanitizeDummyID,
  IsValidDummyID,
  RandomSuffix,
  NormalizeIP,
} from './normalize';
import { DummyClient } from './dummy';
import type { DummyClientSnapshot } from './dummy';

const DummiesRepo = CreateDummyClientsRepository(DB);

let DummyList: DummyClient[] = [];

function GenerateUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return require('crypto').randomUUID();
}

function IsDummyIDTaken(DummyID: string): boolean {
  return DummyList.some((D) => D.DummyID === DummyID);
}

const Manager = {
  Initialized: false,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,

  // Produce a unique "DummyClient######" identifier that is not already in use.
  GenerateUniqueDummyID(): string {
    for (let Attempt = 0; Attempt < 50; Attempt++) {
      const Candidate = `DummyClient${RandomSuffix()}`;
      if (!IsDummyIDTaken(Candidate)) return Candidate;
    }
    // Extremely unlikely fallback: append more entropy.
    return `DummyClient${RandomSuffix()}${RandomSuffix()}`;
  },

  // Defaults for a brand new dummy: matching random suffix in both ID and title.
  GenerateDefaults() {
    const DummyID = Manager.GenerateUniqueDummyID();
    const Suffix = DummyID.replace(/^DummyClient/, '');
    return {
      DummyID,
      Nickname: `Dummy ${Suffix}`,
      Interval: DEFAULT_INTERVAL_MS,
    };
  },

  async Init(): Promise<void> {
    const [Err, Rows] = await DummiesRepo.GetAll();
    if (Err) {
      Manager.Initialized = true;
      DummyList = [];
      return;
    }
    DummyList = (Rows || []).map((Row) => new DummyClient(Row));
    Manager.Initialized = true;
    BroadcastManager.emit('DummyClientListChanged');
  },

  // Rebuild runtime state from DB after external bulk changes (e.g. config import).
  async Reload(): Promise<void> {
    for (const Dummy of DummyList) Dummy.StopLoop();
    DummyList = [];
    Manager.Initialized = false;
    await Manager.Init();
  },

  async Shutdown(): Promise<void> {
    for (const Dummy of DummyList) {
      try {
        Dummy.StopLoop();
      } catch {
        /* intentional: stopping each dummy loop during shutdown is best-effort */
      }
    }
  },

  async GetAll(): Promise<Result<DummyClientSnapshot[]>> {
    if (!Manager.Initialized) await Manager.Init();
    return [null, DummyList.map((D) => D.ToJSON())];
  },

  GetAllSync() {
    return DummyList.map((D) => D.ToJSON());
  },

  async Get(UUID: string): Promise<[string | null, DummyClientSnapshot | null]> {
    const Cached = DummyList.find((D) => D.UUID === UUID);
    if (!Cached) return ['Dummy client not found', null];
    return [null, Cached.ToJSON()];
  },

  async Create(Payload: Record<string, unknown> = {}): Promise<Result<DummyClientSnapshot>> {
    if (!Manager.Initialized) await Manager.Init();
    const Now = Date.now();
    const Defaults = Manager.GenerateDefaults();

    const DummyID = Object.prototype.hasOwnProperty.call(Payload, 'DummyID')
      ? SanitizeDummyID(Payload.DummyID)
      : Defaults.DummyID;
    if (!IsValidDummyID(DummyID)) return Fail('Dummy ID must be alphanumeric with no spaces');
    if (IsDummyIDTaken(DummyID)) return Fail(`Dummy ID "${DummyID}" is already in use`);

    const Nickname =
      Object.prototype.hasOwnProperty.call(Payload, 'Nickname') && String(Payload.Nickname).trim()
        ? String(Payload.Nickname).trim()
        : Defaults.Nickname;
    const Interval = ClampInterval(
      Object.prototype.hasOwnProperty.call(Payload, 'Interval')
        ? Payload.Interval
        : Defaults.Interval
    );
    // GroupID/Weight are validated upstream by IPCValidation before reaching
    // here; GroupID is passed through unchanged (as the historical behavior did)
    // and asserted to the column type rather than re-narrowed.
    const GroupID = (Payload.GroupID == null ? null : Payload.GroupID) as number | null;
    const Weight = typeof Payload.Weight === 'number' ? Payload.Weight : 100;
    const UUID = GenerateUUID();

    const [Err] = await DummiesRepo.Insert(UUID, DummyID, Nickname, Interval, GroupID, Weight, Now);
    if (Err) return Fail('Failed to create dummy client');

    const Dummy = new DummyClient({
      UUID,
      DummyID,
      Nickname,
      Interval,
      GroupID,
      Weight,
      Timestamp: Now,
    });
    DummyList.push(Dummy);
    BroadcastManager.emit('DummyClientListChanged');
    return Ok(Dummy.ToJSON());
  },

  async Update(UUID: string, Payload: Record<string, unknown> = {}): Promise<Result<DummyClientSnapshot>> {
    const Dummy = DummyList.find((D) => D.UUID === UUID);
    if (!Dummy) return Fail('Dummy client not found');

    let NextDummyID = Dummy.DummyID;
    if (Object.prototype.hasOwnProperty.call(Payload, 'DummyID')) {
      NextDummyID = SanitizeDummyID(Payload.DummyID);
      if (!IsValidDummyID(NextDummyID)) return Fail('Dummy ID must be alphanumeric with no spaces');
      if (NextDummyID !== Dummy.DummyID && DummyList.some((D) => D.DummyID === NextDummyID)) {
        return Fail(`Dummy ID "${NextDummyID}" is already in use`);
      }
    }

    const NextNickname =
      Object.prototype.hasOwnProperty.call(Payload, 'Nickname') && String(Payload.Nickname).trim()
        ? String(Payload.Nickname).trim()
        : Dummy.Nickname;
    const NextInterval = ClampInterval(
      Object.prototype.hasOwnProperty.call(Payload, 'Interval') ? Payload.Interval : Dummy.Interval
    );
    const NextGroupID = (
      Object.prototype.hasOwnProperty.call(Payload, 'GroupID') ? Payload.GroupID : Dummy.GroupID
    ) as number | null;

    const [Err] = await DummiesRepo.UpdateDetails(
      NextDummyID,
      NextNickname,
      NextInterval,
      NextGroupID,
      UUID
    );
    if (Err) return Fail('Failed to update dummy client');

    Dummy.DummyID = NextDummyID;
    Dummy.Nickname = NextNickname;
    Dummy.GroupID = NextGroupID == null ? null : NextGroupID;
    Dummy.SetInterval(NextInterval);

    BroadcastManager.emit('DummyClientUpdated', Dummy.ToJSON());
    BroadcastManager.emit('DummyClientListChanged');
    return Ok(Dummy.ToJSON());
  },

  async Delete(UUID: string): Promise<Result<boolean>> {
    const Idx = DummyList.findIndex((D) => D.UUID === UUID);
    if (Idx === -1) return Fail('Dummy client not found');
    const Dummy = DummyList[Idx];
    Dummy.StopLoop();
    const [Err] = await DummiesRepo.Delete(UUID);
    if (Err) return Fail('Failed to delete dummy client');
    DummyList.splice(Idx, 1);
    BroadcastManager.emit('DummyClientListChanged');
    return Ok(true);
  },

  // Force a dummy back to Idle (RAM-only runtime state; no persistence needed).
  async ResetToIdle(UUID: string): Promise<Result<DummyClientSnapshot>> {
    const Dummy = DummyList.find((D) => D.UUID === UUID);
    if (!Dummy) return Fail('Dummy client not found');
    Dummy.ResetToIdle();
    return Ok(Dummy.ToJSON());
  },

  // Deliver a heartbeat addressed to a dummy by its user-facing DummyID. The
  // source IP (from the OSC packet or HTTP request) is recorded and persisted so
  // the UI can display where the dummy last reported from.
  async Heartbeat(DummyID: string, IP: string | null = null): Promise<Result<boolean>> {
    if (!Manager.Initialized) await Manager.Init();
    const Sanitized = SanitizeDummyID(DummyID);
    const Dummy = DummyList.find((D) => D.DummyID === Sanitized);
    if (!Dummy) return Fail(`Unknown Dummy ID "${DummyID}"`);
    const NormalizedIP = NormalizeIP(IP);
    const IPChanged = NormalizedIP && NormalizedIP !== Dummy.IP;
    Dummy.Heartbeat(NormalizedIP);
    if (IPChanged) {
      // Persist quietly (no dirty tracking) since the IP is auto-discovered
      // runtime data, not a user edit to the show document.
      await DummiesRepo.SetIP(NormalizedIP, Dummy.UUID);
    }
    return Ok(true);
  },

  // Move a dummy to a group with a specific weight (used by drag/drop ordering).
  SetGroupAndWeight(UUID: string, GroupID: number | null, Weight: unknown) {
    return GroupOrdering.SetGroupAndWeight(UUID, GroupID, Weight);
  },

  // Move all dummies in a specific group into the default no-group bucket (null).
  MoveGroupToNoGroup(GroupID: unknown) {
    return GroupOrdering.MoveGroupToNoGroup(GroupID);
  },

  // Ensure all dummies reference an existing group; unknown groups reset to null.
  ReconcileOrphanedGroups(ValidGroupIDs: unknown) {
    return GroupOrdering.ReconcileOrphanedGroups(ValidGroupIDs);
  },
};

// Group ordering (SetGroupAndWeight / MoveGroupToNoGroup / ReconcileOrphanedGroups)
// is shared with other list-backed managers via the group-ordering helper.
const GroupOrdering = createGroupOrdering({
  DB,
  BroadcastManager,
  table: 'DummyClients',
  keyColumn: 'UUID',
  getList: () => DummyList,
  getKey: (Dummy: DummyClient) => Dummy.UUID,
  queries: {
    SetGroupAndWeight: (GroupID, Weight, Key) =>
      DummiesRepo.SetGroupAndWeight(GroupID, Weight, String(Key)),
    ClearGroup: (Key) => DummiesRepo.ClearGroup(String(Key)),
  },
  listChangedEvent: 'DummyClientListChanged',
  ensureInitialized: async () => {
    if (!Manager.Initialized) await Manager.Init();
  },
  labels: {
    notFound: 'Dummy client not found',
    update: 'Failed to update dummy client',
    move: 'Failed to move dummy clients to no group',
    reconcile: 'Failed to reconcile orphaned dummy clients',
  },
});

export { Manager };
