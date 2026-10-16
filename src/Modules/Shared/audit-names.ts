// Shared pieces for recording edits in the audit log: the recording guards, and
// readable names and values looked up at the moment of an edit.
//
// The managers that record edits are also where those names live, so each is
// required lazily rather than imported (a static import would close cycles:
// GroupManager imports every entity manager). Nothing is looked up while the
// log is not recording, which keeps tests and start-up free of the extra reads.
import type { AuditChange, AuditEntityType } from '@showtrak/protocol';
import { CreateLogger } from '../Logger';
import { Manager as AuditLog } from '../AuditLog';
import { RecordEdit } from '../AuditLog/edits';
import { Line, Value } from '../AuditLog/message';
import { FormatValue } from '../AuditLog/diff';

const Logger = CreateLogger('AuditLog');

// Whether an edit made now would be recorded. Managers skip their before/after
// lookups when it would not.
export function Recording(): boolean {
  return AuditLog.IsStarted();
}

// Run one recording step after an edit has landed: skipped while the log is not
// recording, and never able to throw into the edit it describes.
export async function AuditStep(Fn: () => void | Promise<void>): Promise<void> {
  if (!Recording()) return;
  try {
    await Fn();
  } catch (Err) {
    Logger.error('Failed to record an edit in the audit log:', Err);
  }
}

// Capture what an edit is about to change, for the diff once it lands. Null
// while the log is not recording (or if the capture fails), which reads as
// nothing to report.
export async function AuditBefore<T>(Fn: () => T | Promise<T>): Promise<T | null> {
  if (!Recording()) return null;
  try {
    return await Fn();
  } catch (Err) {
    Logger.error('Failed to capture an edit for the audit log:', Err);
    return null;
  }
}

// GroupID 0 is how the editors spell "No Group".
export async function GroupTitle(GroupID: unknown): Promise<string> {
  if (GroupID === null || GroupID === undefined || GroupID === '' || Number(GroupID) === 0) {
    return 'No Group';
  }
  try {
    const { Manager: GroupManager } =
      require('../GroupManager') as typeof import('../GroupManager');
    const [Err, Group] = await GroupManager.Get(Number(GroupID));
    if (!Err && Group && Group.Title) return Group.Title;
  } catch {
    // A name is a nicety; the ID still says which group it was.
  }
  return `Group ${GroupID}`;
}

export async function ScriptName(ScriptID: unknown): Promise<string | null> {
  if (ScriptID === null || ScriptID === undefined || ScriptID === '') return null;
  const ID = String(ScriptID);
  try {
    const { Manager: ScriptManager } =
      require('../ScriptManager') as typeof import('../ScriptManager');
    const Script = await ScriptManager.Get(ID);
    if (Script && Script.Name) return Script.Name;
  } catch {
    // As above: fall back to the folder ID.
  }
  return ID;
}

export function Seconds(Value: unknown): string | null {
  if (Value === null || Value === undefined || Value === '') return null;
  const N = Number(Value);
  if (!Number.isFinite(N)) return null;
  return N === 1 ? '1 second' : `${N} seconds`;
}

// The shared colour palette (ScriptManager SCRIPT_COLOURS), by index.
const COLOUR_NAMES = [
  'Red',
  'Orange',
  'Yellow',
  'Green',
  'Blue',
  'Purple',
  'Light Grey',
  'Dark Grey',
];

export function ColourName(Index: unknown): string | null {
  if (Index === null || Index === undefined || Index === '') return null;
  return COLOUR_NAMES[Number(Index)] || String(Index);
}

// "Digit3" / "Numpad3" as the Group Manager badges them.
export function KeyBindName(Code: unknown): string | null {
  const Match = String(Code || '').match(/^(Digit|Numpad)([0-9])$/);
  if (!Match) return null;
  return `${Match[1] === 'Numpad' ? 'Numpad' : 'Key'} ${Match[2]}`;
}

// A drag into another group, for the managers that share group ordering.
// Reordering within a group is not an edit worth a line.
export function RecordGroupMove(
  Entity: { EntityType: AuditEntityType; EntityID: string | number; EntityName: string | null },
  FromGroupID: unknown,
  ToGroupID: unknown
): Promise<void> {
  const Same =
    (FromGroupID ?? null) === (ToGroupID ?? null) || Number(FromGroupID) === Number(ToGroupID);
  if (Same) return Promise.resolve();
  return AuditStep(async () => {
    RecordEdit({ ...Entity, Summary: Line('Moved to ', Value(await GroupTitle(ToGroupID))) });
  });
}

// Diff two flat settings maps (a monitoring check's or a FreeKiosk terminal's),
// key by key. A secret key is reported as changed with neither value.
export function DiffSettings(
  Before: Record<string, unknown> | null | undefined,
  After: Record<string, unknown> | null | undefined,
  Options: {
    Label: (Key: string) => string;
    Format?: (Key: string, Value: unknown) => string | null;
    Secret?: (Key: string) => boolean;
  }
): AuditChange[] {
  const From = Before || {};
  const To = After || {};
  const Format = Options.Format || ((_Key: string, Value: unknown) => FormatValue(Value));
  const Changes: AuditChange[] = [];
  for (const Key of new Set([...Object.keys(From), ...Object.keys(To)])) {
    const Old = Format(Key, From[Key]);
    const New = Format(Key, To[Key]);
    if (Old === New) continue;
    Changes.push(
      Options.Secret && Options.Secret(Key)
        ? { Field: Options.Label(Key), From: null, To: 'Changed' }
        : { Field: Options.Label(Key), From: Old, To: New }
    );
  }
  return Changes;
}
