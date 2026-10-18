// The pure half of a dummy client's settings: turning the form into the
// Create/UpdateDummyClient payload, shared by the Add Dummy Client modal and
// the Settings tab of a dummy's view modal (../dummy-info-edit.ts).

/** The fields exactly as the form holds them. */
export interface DummySettingsDraft {
  /** Doubles as the dummy's slug (its API / OSC address). */
  DummyID: string;
  Nickname: string;
  /** The group <select> value: a GroupID, or '' / 'null' for No Group. */
  GroupID: string;
  /** The heartbeat interval slider, in milliseconds. */
  Interval: string;
}

export interface DummyPayload {
  DummyID: string;
  Nickname: string;
  Interval: number;
  GroupID: number | null;
}

const DUMMY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The payload for a draft, or the reason it cannot be saved.
 *
 * An empty title falls back to "Dummy <n>" from the ID, as it always has.
 */
export function BuildDummyPayload(
  Draft: DummySettingsDraft
): { Payload: DummyPayload; Error: null } | { Payload: null; Error: string } {
  const DummyID = String(Draft.DummyID || '').trim();
  if (!DummyID) return { Payload: null, Error: 'Please enter an ID.' };
  // The ID is the dummy's slug: letters, digits, - and _; no spaces.
  if (!DUMMY_ID_PATTERN.test(DummyID)) {
    return {
      Payload: null,
      Error: 'ID may only contain letters, numbers, hyphens and underscores.',
    };
  }
  const GroupRaw = String(Draft.GroupID ?? '').trim();
  const GroupID = GroupRaw === '' || GroupRaw === 'null' ? null : parseInt(GroupRaw, 10);
  return {
    Payload: {
      DummyID,
      Nickname:
        String(Draft.Nickname || '').trim() || `Dummy ${DummyID.replace(/^DummyClient/, '')}`,
      Interval: parseInt(String(Draft.Interval ?? ''), 10),
      GroupID: Number.isFinite(GroupID as number) ? GroupID : null,
    },
    Error: null,
  };
}

/** Whether the form differs from what it was populated with. */
export function DummySettingsDraftChanged(
  Baseline: DummySettingsDraft | null,
  Current: DummySettingsDraft | null
): boolean {
  if (!Baseline || !Current) return false;
  return JSON.stringify(Baseline) !== JSON.stringify(Current);
}
