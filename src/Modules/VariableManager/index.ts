// VariableManager
// - CRUD for Show Variables: operator-defined values that reach a client's
//   scripts as environment variables. A variable named GAME_VERSION arrives as
//   %SHOWTRAK_VAR_GAME_VERSION% in a batch file, $SHOWTRAK_VAR_GAME_VERSION in a
//   shell script, and $env:SHOWTRAK_VAR_GAME_VERSION in PowerShell.
// - Each variable carries a DefaultValue; any client may override it. Resolution
//   is a single layer deep on purpose: override, else default.
// - This module owns the two things the rest of the app must never re-derive:
//   the normalized key spelling, and the resolved per-client environment. The
//   client is sent a finished environment block and never learns about defaults,
//   overrides or IDs.
//
// Why keys are forced to upper snake case: the Windows environment is
// case-insensitive, so `Game_Version` and `GAME_VERSION` are one variable there
// and two on POSIX. Allowing both spellings to exist would make a show behave
// differently per platform for reasons invisible in the UI, so only one
// spelling is permitted to exist at all.
import { CreateLogger } from '../Logger';
import { Manager as DB } from '../DB';
import { CreateVariablesRepository } from '../DB/repositories/variables';
import { Manager as BroadcastManager } from '../Broadcast';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';
import type { ClientVariableJoinRow, VariableRow } from '../DB/rows';
import type {
  ClientVariableView,
  VariableEnvironment,
  VariablePayload,
  VariableView,
} from '@showtrak/protocol';

const Logger = CreateLogger('VariableManager');

const VariablesRepo = CreateVariablesRepository(DB);

/**
 * Prefix applied to every variable on its way into an environment block.
 *
 * The whole point of the feature's naming scheme: because every injected name
 * starts with this, a show can never shadow PATH, TEMP, COMSPEC or anything else
 * a script's tooling depends on, no matter what the operator types.
 */
export const VARIABLE_PREFIX = 'SHOWTRAK_VAR_';

/**
 * Longest permitted bare key. Windows tolerates far longer names, but a key this
 * long is unusable in a batch file and almost always a paste accident.
 */
const MAX_KEY_LENGTH = 64;

/**
 * Per-value and total caps on what one client's environment may carry.
 *
 * Windows caps a single environment variable at 32,767 characters and bounds the
 * whole block passed to CreateProcess, and a script that fails because the
 * environment overflowed gives a spectacularly unhelpful error. These limits sit
 * well under the OS ones so the failure is a clear message in the editor instead.
 */
const MAX_VALUE_LENGTH = 4096;
const MAX_TOTAL_ENVIRONMENT_LENGTH = 65536;

const DEFAULT_KEY = 'NEW_VARIABLE';

/**
 * Resolved-environment cache, keyed by client UUID.
 *
 * Every script dispatch and every client connection resolves an environment, so
 * this is a hot path that would otherwise be two queries deep. Any write to a
 * definition or an override drops the whole cache rather than trying to
 * invalidate precisely: a default change moves every client that has not
 * overridden it, so precise invalidation would have to walk the override table
 * anyway, and shows have tens of clients, not thousands.
 */
let EnvironmentCache = new Map<string, VariablePayload>();

function InvalidateCache(): void {
  EnvironmentCache = new Map();
}

/**
 * Strip what an environment block cannot carry.
 *
 * NUL terminates a C string, so it would silently truncate the value (and
 * Node throws on it outright); CR/LF break batch parsing in ways that look like
 * a corrupt script rather than a bad value. Both are removed rather than
 * rejected — an operator pasting a value with a trailing newline meant the
 * value, not the newline.
 */
function SanitizeValue(Value: unknown): string {
  const Text = String(Value == null ? '' : Value);
  // eslint-disable-next-line no-control-regex -- deliberately targeting control characters
  const Stripped = Text.replace(/[\u0000-\u001F\u007F]/g, '');
  return Stripped.length > MAX_VALUE_LENGTH ? Stripped.slice(0, MAX_VALUE_LENGTH) : Stripped;
}

/**
 * Coerce operator input into a legal, canonical variable key.
 *
 * Spaces and dashes become underscores (operators type "Game Version"), the
 * result is upper-cased, anything outside [A-Z0-9_] is dropped, and a leading
 * digit is prefixed with an underscore — `%1ABC%` is a positional parameter in a
 * batch file, not a variable reference.
 *
 * Returns null when nothing usable survives, so the caller can report a real
 * error rather than silently creating a variable named "_".
 */
export function NormalizeKey(Value: unknown): string | null {
  const Raw = String(Value == null ? '' : Value).trim();
  if (!Raw) return null;

  let Key = Raw.toUpperCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!Key) return null;
  if (/^[0-9]/.test(Key)) Key = `_${Key}`;
  if (Key.length > MAX_KEY_LENGTH) Key = Key.slice(0, MAX_KEY_LENGTH).replace(/_+$/, '');

  return Key || null;
}

/**
 * Reject keys that would collide with the reserved namespace.
 *
 * `SHOWTRAK_` (without `VAR_`) is reserved for the built-in context variables
 * injected alongside show variables, and a key already starting `SHOWTRAK_VAR_`
 * is almost certainly an operator pasting the fully-qualified name out of a
 * script, which would otherwise produce %SHOWTRAK_VAR_SHOWTRAK_VAR_X%.
 */
function DescribeReservedKey(Key: string): string | null {
  if (Key.startsWith(VARIABLE_PREFIX)) {
    return `Enter the variable name without the ${VARIABLE_PREFIX} prefix — ShowTrak adds it for you`;
  }
  if (Key.startsWith('SHOWTRAK_')) {
    return 'Names starting with SHOWTRAK_ are reserved for ShowTrak’s own variables';
  }
  return null;
}

/** Fully-qualified environment name for a bare key. */
export function ToEnvironmentKey(Key: string): string {
  return `${VARIABLE_PREFIX}${Key}`;
}

function RowToView(Row: VariableRow, OverrideCount: number): VariableView {
  return {
    VariableID: Row.VariableID,
    Key: Row.Key,
    EnvironmentKey: ToEnvironmentKey(Row.Key),
    Description: Row.Description || '',
    DefaultValue: Row.DefaultValue || '',
    ExportToSystem: !!Row.ExportToSystem,
    Weight: Number(Row.Weight) || 100,
    OverrideCount,
  };
}

function JoinRowToView(Row: ClientVariableJoinRow): ClientVariableView {
  const DefaultValue = Row.DefaultValue || '';
  // null (inherits) and '' (explicitly overridden to empty) are different
  // states and must not be collapsed: the first tracks the default forever, the
  // second deliberately pins the value to empty.
  const Value = Row.Value == null ? null : String(Row.Value);
  return {
    VariableID: Row.VariableID,
    Key: Row.Key,
    EnvironmentKey: ToEnvironmentKey(Row.Key),
    Description: Row.Description || '',
    DefaultValue,
    ExportToSystem: !!Row.ExportToSystem,
    Value,
    ResolvedValue: Value == null ? DefaultValue : Value,
  };
}

const Manager = {
  /** Every definition, with its override count, ordered for the manager UI. */
  async GetAllViews(): Promise<VariableView[]> {
    const [Err, Rows] = await VariablesRepo.GetAll();
    if (Err) {
      Logger.error('Failed to load variables:', Err);
      return [];
    }
    const [CountErr, Counts] = await VariablesRepo.CountOverrides();
    if (CountErr) Logger.warn('Failed to count variable overrides; reporting zero');
    const CountByID = new Map<number, number>();
    for (const Row of Counts || []) CountByID.set(Row.VariableID, Number(Row.Overrides) || 0);
    return (Rows || []).map((Row) => RowToView(Row, CountByID.get(Row.VariableID) || 0));
  },

  async Get(VariableID: number): Promise<Result<VariableRow>> {
    if (!VariableID) return Fail('VariableID is required');
    const [Err, Row] = await VariablesRepo.GetByID(VariableID);
    if (Err) return Fail('Failed to load variable');
    if (!Row) return Fail('Variable not found');
    return Ok(Row);
  },

  async Create(Key: unknown = DEFAULT_KEY): Promise<Result<VariableView>> {
    const Normalized = NormalizeKey(Key) || DEFAULT_KEY;
    const Reserved = DescribeReservedKey(Normalized);
    if (Reserved) return Fail(Reserved);

    // De-collide rather than refuse: creation is a button press with no name
    // typed yet, so the operator gets NEW_VARIABLE_2 and renames it, exactly as
    // a new tag or group behaves.
    const Unique = await Manager.DeriveUniqueKey(Normalized, null);
    const [Err] = await VariablesRepo.Insert(Unique, '', '', 1, 100, Date.now());
    if (Err) {
      Logger.error('Failed to create variable:', Err);
      return Fail('Failed to create variable');
    }

    InvalidateCache();
    BroadcastManager.emit('VariableListChanged');

    const [LoadErr, Row] = await VariablesRepo.GetByKey(Unique);
    if (LoadErr || !Row) return Fail('Variable created but could not be reloaded');
    Logger.success(`Created variable ${Unique}`);
    return Ok(RowToView(Row, 0));
  },

  /**
   * Append a numeric suffix until the key is free. `IgnoreVariableID` lets a
   * rename keep its own key without colliding with itself.
   */
  async DeriveUniqueKey(Key: string, IgnoreVariableID: number | null): Promise<string> {
    let Candidate = Key;
    let Suffix = 2;
    for (;;) {
      const [Err, Row] = await VariablesRepo.GetByKey(Candidate);
      if (Err) return Candidate;
      if (!Row || (IgnoreVariableID != null && Row.VariableID === IgnoreVariableID)) {
        return Candidate;
      }
      const Trimmed = Key.slice(0, MAX_KEY_LENGTH - String(Suffix).length - 1);
      Candidate = `${Trimmed}_${Suffix}`;
      Suffix += 1;
    }
  },

  /**
   * Rename a variable. Overrides are keyed on VariableID, so every client's
   * value survives — a rename is a display change, not a data migration.
   */
  async SetKey(VariableID: number, Key: unknown): Promise<Result<boolean>> {
    const [GetErr, Row] = await Manager.Get(VariableID);
    if (GetErr || !Row) return Fail(GetErr || 'Variable not found');

    const Normalized = NormalizeKey(Key);
    if (!Normalized) return Fail('Variable name must contain at least one letter or number');
    const Reserved = DescribeReservedKey(Normalized);
    if (Reserved) return Fail(Reserved);
    if (Normalized === Row.Key) return Ok(true);

    const [ExistingErr, Existing] = await VariablesRepo.GetByKey(Normalized);
    if (ExistingErr) return Fail('Failed to check variable name');
    if (Existing && Existing.VariableID !== VariableID) {
      return Fail(`A variable named ${Normalized} already exists`);
    }

    const [Err] = await VariablesRepo.UpdateKey(VariableID, Normalized);
    if (Err) return Fail('Failed to rename variable');

    InvalidateCache();
    BroadcastManager.emit('VariableListChanged');
    // A rename changes the environment key every client sees, so it is a
    // definition change and fans out to all of them.
    BroadcastManager.emit('ClientVariablesChanged', null);
    Logger.log(`Variable ${VariableID} renamed to ${Normalized}`);
    return Ok(true);
  },

  async SetDescription(VariableID: number, Description: unknown): Promise<Result<boolean>> {
    const [GetErr] = await Manager.Get(VariableID);
    if (GetErr) return Fail(GetErr);
    const Text = String(Description == null ? '' : Description)
      .trim()
      .slice(0, 255);
    const [Err] = await VariablesRepo.UpdateDescription(VariableID, Text);
    if (Err) return Fail('Failed to update variable description');
    // Description is documentation only — it never reaches a client, so no push.
    BroadcastManager.emit('VariableListChanged');
    return Ok(true);
  },

  async SetDefault(VariableID: number, DefaultValue: unknown): Promise<Result<boolean>> {
    const [GetErr] = await Manager.Get(VariableID);
    if (GetErr) return Fail(GetErr);
    const Value = SanitizeValue(DefaultValue);
    const [Err] = await VariablesRepo.UpdateDefault(VariableID, Value);
    if (Err) return Fail('Failed to update variable default');

    InvalidateCache();
    BroadcastManager.emit('VariableListChanged');
    // Every client that has not overridden this variable just changed value.
    BroadcastManager.emit('ClientVariablesChanged', null);
    return Ok(true);
  },

  async SetExport(VariableID: number, ExportToSystem: unknown): Promise<Result<boolean>> {
    const [GetErr] = await Manager.Get(VariableID);
    if (GetErr) return Fail(GetErr);
    const Next = ExportToSystem ? 1 : 0;
    const [Err] = await VariablesRepo.UpdateExport(VariableID, Next);
    if (Err) return Fail('Failed to update variable export setting');

    InvalidateCache();
    BroadcastManager.emit('VariableListChanged');
    // Turning the export OFF matters as much as turning it on: the client has to
    // be told so it can remove the value it already wrote to the registry.
    BroadcastManager.emit('ClientVariablesChanged', null);
    return Ok(true);
  },

  async Delete(VariableID: number): Promise<Result<boolean>> {
    const [GetErr, Row] = await Manager.Get(VariableID);
    if (GetErr || !Row) return Fail(GetErr || 'Variable not found');

    const [Err] = await VariablesRepo.Delete(VariableID);
    if (Err) {
      Logger.error('Failed to delete variable:', Err);
      return Fail('Failed to delete variable');
    }

    InvalidateCache();
    BroadcastManager.emit('VariableListChanged');
    // Clients must hear about a deletion so any exported registry value is
    // cleaned up rather than left behind for the life of the machine.
    BroadcastManager.emit('ClientVariablesChanged', null);
    Logger.log(`Deleted variable ${Row.Key}`);
    return Ok(true);
  },

  /** Definitions joined with one client's overrides, for the client editor. */
  async GetClientViews(UUID: string): Promise<ClientVariableView[]> {
    if (!UUID) return [];
    const [Err, Rows] = await VariablesRepo.GetForClient(String(UUID));
    if (Err) {
      Logger.error('Failed to load client variables:', Err);
      return [];
    }
    return (Rows || []).map(JoinRowToView);
  },

  /**
   * Apply a client's overrides from the client editor.
   *
   * `Values` maps VariableID -> value, where null means "clear the override and
   * go back to inheriting". Unknown VariableIDs are skipped rather than failing
   * the whole save, so an editor left open while a variable was deleted
   * elsewhere still saves the rest.
   */
  async SetClientValues(
    UUID: string,
    Values: Record<string, unknown> | null | undefined
  ): Promise<Result<boolean>> {
    const ClientUUID = String(UUID || '').trim();
    if (!ClientUUID) return Fail('UUID is required');
    if (!Values || typeof Values !== 'object') return Ok(true);

    const [ListErr, Rows] = await VariablesRepo.GetAll();
    if (ListErr) return Fail('Failed to load variables');
    const Known = new Set((Rows || []).map((Row) => Row.VariableID));

    let Changed = false;
    for (const [RawID, RawValue] of Object.entries(Values)) {
      const VariableID = Number(RawID);
      if (!Number.isFinite(VariableID) || !Known.has(VariableID)) continue;

      if (RawValue == null) {
        const [Err] = await VariablesRepo.ClearClientValue(ClientUUID, VariableID);
        if (Err) return Fail('Failed to clear variable value');
      } else {
        const [Err] = await VariablesRepo.SetClientValue(
          ClientUUID,
          VariableID,
          SanitizeValue(RawValue),
          Date.now()
        );
        if (Err) return Fail('Failed to save variable value');
      }
      Changed = true;
    }

    if (Changed) {
      InvalidateCache();
      BroadcastManager.emit('VariableListChanged');
      // Only this client's environment moved, so only this client is re-pushed.
      BroadcastManager.emit('ClientVariablesChanged', ClientUUID);
    }
    return Ok(true);
  },

  /**
   * Build the finished payload for one client: every defined variable, resolved
   * and prefixed, plus which of them should also be exported to the Windows
   * user environment.
   *
   * Every variable is always present, even when empty. Omitting an unset one
   * would leave `%SHOWTRAK_VAR_X%` in a batch file as the literal text
   * `%SHOWTRAK_VAR_X%` rather than as nothing — the single most confusing
   * failure mode this feature has.
   */
  async GetPayload(UUID: string): Promise<VariablePayload> {
    const ClientUUID = String(UUID || '').trim();
    if (!ClientUUID) return { Environment: {}, Exported: [] };

    const Cached = EnvironmentCache.get(ClientUUID);
    if (Cached) return Cached;

    const [Err, Rows] = await VariablesRepo.GetForClient(ClientUUID);
    if (Err) {
      Logger.error('Failed to resolve variables for client; sending an empty set:', Err);
      return { Environment: {}, Exported: [] };
    }

    const Environment: VariableEnvironment = {};
    const Exported: string[] = [];
    let TotalLength = 0;
    let Dropped = 0;

    for (const Row of Rows || []) {
      const EnvironmentKey = ToEnvironmentKey(Row.Key);
      const Value = SanitizeValue(Row.Value == null ? Row.DefaultValue : Row.Value);

      // Stop before the block gets big enough for CreateProcess to reject it.
      // Dropping the tail is worse than dropping nothing, so it is logged loudly
      // — silent truncation here would look like a variable that "just doesn't
      // work" on one machine.
      const Cost = EnvironmentKey.length + Value.length + 2;
      if (TotalLength + Cost > MAX_TOTAL_ENVIRONMENT_LENGTH) {
        Dropped += 1;
        continue;
      }
      TotalLength += Cost;

      Environment[EnvironmentKey] = Value;
      if (Row.ExportToSystem) Exported.push(EnvironmentKey);
    }

    if (Dropped > 0) {
      Logger.warn(
        `Variable environment for ${ClientUUID} exceeded ${MAX_TOTAL_ENVIRONMENT_LENGTH} characters; ${Dropped} variable(s) omitted`
      );
    }

    const Payload: VariablePayload = { Environment, Exported };
    EnvironmentCache.set(ClientUUID, Payload);
    return Payload;
  },

  /** Just the environment block, for the ExecuteScript dispatch payload. */
  async GetEnvironment(UUID: string): Promise<VariableEnvironment> {
    const Payload = await Manager.GetPayload(UUID);
    return Payload.Environment;
  },

  /**
   * Drop overrides belonging to clients that no longer exist. Show files carry
   * variables (which is the point — GAME_VERSION belongs to the show), but
   * overrides are keyed by client UUID, so a show opened on a different rig
   * arrives with rows that can never be reached from any UI.
   */
  async PruneOrphans(): Promise<void> {
    const [Err] = await VariablesRepo.DeleteOrphaned();
    if (Err) {
      Logger.warn('Failed to prune orphaned variable overrides');
      return;
    }
    InvalidateCache();
  },

  /** Drop the resolved-environment cache. Called when the whole DB is swapped. */
  Reset(): void {
    InvalidateCache();
  },
};

export { Manager };
export const _internal = { SanitizeValue, DescribeReservedKey, MAX_VALUE_LENGTH };
