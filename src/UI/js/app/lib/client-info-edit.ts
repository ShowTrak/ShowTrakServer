// The pure half of editing a ShowTrak Client from its view modal: when the
// modal is editable, which MACs a client could add for Wake on LAN, and how the
// edited fields become the UpdateClient payload. The DOM half lives in
// ../client-info-edit.ts.
//
// The modal is one system for viewing and editing: every field renders
// read-only in Show mode and editable in Edit mode, flipping live when the mode
// changes. Every kind of entity is edited this way; none has an editor modal of
// its own any more (the Add flows for monitors, dummies and FreeKiosk terminals
// aside, which create rather than edit).
import type { ClientInfoKind } from './client-info-tabs';

const EDITABLE_CLIENT_INFO_KINDS: readonly ClientInfoKind[] = [
  'client',
  'integrated',
  'target',
  'dummy',
  'freekiosk',
];

/** Mirrors MIN_LAUNCH_DELAY_SECONDS in the server's ClientUpdatePayload validator. */
export const MIN_LAUNCH_DELAY_SECONDS = 10;

/** Mirrors MAX_OFFLINE_GRACE_SECONDS in Modules/ClientManager/offline-grace. */
export const MAX_OFFLINE_GRACE_SECONDS = 10;

export interface ClientInfoEditContext {
  AppMode: string;
  /** Whether this surface may manage this kind of entity (a Web UI permission). */
  CanManage: boolean;
  Kind: ClientInfoKind | null;
}

/** Whether the open view modal shows its editable controls. */
export function IsClientInfoEditable(Context: ClientInfoEditContext): boolean {
  return (
    Context.AppMode === 'EDIT' &&
    Context.CanManage &&
    !!Context.Kind &&
    EDITABLE_CLIENT_INFO_KINDS.includes(Context.Kind)
  );
}

export function OfflineGraceLabel(Seconds: number): string {
  if (Seconds <= 0) return 'Offline immediately';
  return Seconds === 1 ? '1 second' : `${Seconds} seconds`;
}

/**
 * The read-only text for a client's disconnect grace; a null Value inherits.
 * Inherited is null where the Preferences value cannot be read (the Web UI).
 */
export function OfflineGraceSummary(
  Value: number | null | undefined,
  Inherited: number | null
): string {
  if (typeof Value === 'number') return OfflineGraceLabel(Value);
  return Inherited == null ? 'Use default' : `Use default (${OfflineGraceLabel(Inherited)})`;
}

// --- Wake on LAN -----------------------------------------------------------

const ZERO_MAC = '00:00:00:00:00:00';

/** Upper-case colon form, or null when not a 48-bit MAC. Mirrors Modules/MacAddress. */
export function NormalizeMac(Value: unknown): string | null {
  if (typeof Value !== 'string' && typeof Value !== 'number') return null;
  const Hex = String(Value)
    .trim()
    .replace(/[:\-.\s]/g, '')
    .toUpperCase();
  if (Hex.length !== 12 || /[^0-9A-F]/.test(Hex)) return null;
  return (Hex.match(/.{2}/g) as string[]).join(':');
}

export interface MacCandidate {
  MacAddress: string;
  InterfaceName: string | null;
}

interface ReportedInterface {
  name?: unknown;
  addresses?: Array<{ mac?: unknown; internal?: unknown }> | null;
}

/**
 * Every MAC on the client's reported interfaces that the OS does not mark
 * internal, once each.
 *
 * Wider than what the server ingests on its own: that path also drops
 * locally-administered addresses (virtual adapters, randomized Wi-Fi), which
 * this keeps — the operator pressing "Add from Client" is asking for every
 * address the machine has. The all-zero MAC is still dropped: it belongs to no
 * hardware at all.
 */
export function CollectClientMacCandidates(
  Interfaces: readonly ReportedInterface[] | null | undefined
): MacCandidate[] {
  const Seen = new Map<string, MacCandidate>();
  for (const Interface of Array.isArray(Interfaces) ? Interfaces : []) {
    if (!Interface) continue;
    const Name = Interface.name ? String(Interface.name) : null;
    for (const Address of Array.isArray(Interface.addresses) ? Interface.addresses : []) {
      if (!Address || Address.internal) continue;
      const Mac = NormalizeMac(Address.mac);
      if (!Mac || Mac === ZERO_MAC || Seen.has(Mac)) continue;
      Seen.set(Mac, { MacAddress: Mac, InterfaceName: Name });
    }
  }
  return [...Seen.values()];
}

/** The candidates not already on the client's Wake-on-LAN list. */
export function MissingMacAddresses(
  Candidates: readonly string[],
  Existing: ReadonlyArray<{ MacAddress?: unknown }> | null | undefined
): string[] {
  const OnFile = new Set(
    (Array.isArray(Existing) ? Existing : [])
      .map((Entry) => NormalizeMac(Entry && Entry.MacAddress))
      .filter((Mac): Mac is string => !!Mac)
  );
  const Missing: string[] = [];
  for (const Candidate of Candidates) {
    const Mac = NormalizeMac(Candidate);
    if (!Mac || OnFile.has(Mac)) continue;
    OnFile.add(Mac);
    Missing.push(Mac);
  }
  return Missing;
}

// --- Saving ----------------------------------------------------------------

/** The editable fields exactly as the form holds them. */
export interface ClientSettingsDraft {
  Slug: string;
  Nickname: string;
  /** The group <select> value: a GroupID, or '' / 'null' for No Group. */
  GroupID: string;
  /** '' inherits the Preferences value. */
  OfflineGraceSeconds: string;
  /** '' is no script. */
  RunOnLaunchScriptID: string;
  RunOnLaunchDelaySeconds: string;
  /** VariableID -> typed value; '' inherits. Null when no rows are shown. */
  Variables: Record<string, string> | null;
}

export interface ClientSettingsOriginal {
  Slug?: string | null;
  Hostname?: string | null;
  Integrated: boolean;
}

/** Whether the form differs from what it was populated with. */
export function ClientSettingsDraftChanged(
  Baseline: ClientSettingsDraft | null,
  Current: ClientSettingsDraft | null
): boolean {
  if (!Baseline || !Current) return false;
  return JSON.stringify(Baseline) !== JSON.stringify(Current);
}

/**
 * The UpdateClient payload for a draft — the same shape the client editor has
 * always sent.
 *
 * - An empty nickname falls back to the hostname.
 * - The slug travels only when changed, and an emptied slug field leaves the
 *   existing slug standing (a slug never auto-changes once set).
 * - Launch fields and variables never travel for an SDK client, which the
 *   server rejects them for.
 * - An emptied variable is null ("inherit the default"), never '' — which would
 *   pin the client to an empty value and stop it tracking the default.
 */
export function BuildClientUpdatePayload(
  Draft: ClientSettingsDraft,
  Original: ClientSettingsOriginal
): Record<string, unknown> {
  const GroupRaw = String(Draft.GroupID ?? '').trim();
  const GroupID = GroupRaw === '' || GroupRaw === 'null' ? null : parseInt(GroupRaw, 10);
  const Grace = parseInt(String(Draft.OfflineGraceSeconds ?? ''), 10);

  const Payload: Record<string, unknown> = {
    Nickname: Draft.Nickname || Original.Hostname || '',
    GroupID: Number.isFinite(GroupID as number) ? GroupID : null,
    OfflineGraceSeconds: Number.isFinite(Grace) ? Grace : null,
  };

  const Slug = String(Draft.Slug || '').trim();
  if (Slug && Slug !== (Original.Slug || '')) Payload.Slug = Slug;

  if (!Original.Integrated) {
    const ScriptID = String(Draft.RunOnLaunchScriptID || '') || null;
    let Delay: number | null = null;
    if (ScriptID) {
      const Parsed = parseInt(String(Draft.RunOnLaunchDelaySeconds ?? ''), 10);
      Delay = Math.max(
        MIN_LAUNCH_DELAY_SECONDS,
        Number.isFinite(Parsed) ? Parsed : MIN_LAUNCH_DELAY_SECONDS
      );
    }
    Payload.RunOnLaunchScriptID = ScriptID;
    Payload.RunOnLaunchDelaySeconds = Delay;

    if (Draft.Variables) {
      const Variables: Record<string, string | null> = {};
      for (const [VariableID, Value] of Object.entries(Draft.Variables)) {
        Variables[VariableID] = Value === '' ? null : Value;
      }
      Payload.Variables = Variables;
    }
  }

  return Payload;
}
