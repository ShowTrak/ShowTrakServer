// Shared beltpack model for the Clear-Com checks (Arcadia / FreeSpeak Edge and
// FreeSpeak II). Both base stations run Clear-Com's CCM software, whose web UI
// reads the same `/api/1/...` JSON resources: an endpoint list in which each
// beltpack carries a `liveStatus` object (status, batteryLevel, longevity,
// RSSI, linkQuality) and a role it is using. The two methods differ in where
// those resources live and in authentication, so each owns its transport and
// hands the raw records to the normaliser here; the conditions, the verdict
// and the debug cards are the same for both.
//
// Field names come from Bitfocus Companion's two Clear-Com modules, which read
// these resources from real base stations:
//   companion-module-clearcom-rest        (Arcadia, FreeSpeak Edge base)
//   companion-module-clearcom-freespeakii (FreeSpeak II base, FSII-BASE-II)
// Clear-Com publishes no specification for them, so every reader below is
// tolerant: a field that is missing or of the wrong type reads as unknown, and
// unknown is never treated as low or bad.
import { Card, FormatLatency, Note, Pill, Row, Rows, TextRow, HealthPill } from './debug';
import { AsList, IsObject, NumOrNull, StrOrNull } from './_videoproc-http-shared';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

// FreeSpeak II reports this as a beltpack's live role while it holds none.
export const NO_ROLE = 65535;

export const DEFAULTS = {
  LowBatteryPercent: 20,
  LowBatteryMinutes: 30,
  MinLinkQuality: 30,
};

// --- Settings ---------------------------------------------------------------

// The condition settings both methods share, placed after each method's own
// connection settings and before its Timeout.
export function BeltpackConditionSettings(): MonitoringSettingField[] {
  return [
    {
      Key: 'Beltpacks',
      Label: 'Monitored beltpacks',
      Type: 'list',
      Default: [],
      Note: 'Roles, beltpack labels or beltpack IDs that must be online, e.g. Stage Manager. Leave empty to check the battery and link of every online beltpack without requiring any.',
    },
    {
      Key: 'CheckBattery',
      Label: 'Check beltpack battery',
      Type: 'boolean',
      Default: true,
      Note: 'Report Degraded when a monitored beltpack’s battery is at or below the thresholds. Only online beltpacks are judged.',
    },
    {
      Key: 'LowBatteryPercent',
      Label: 'Low battery at (%)',
      Type: 'number',
      Default: DEFAULTS.LowBatteryPercent,
      Min: 0,
      Max: 100,
      VisibleWhen: { Key: 'CheckBattery', Equals: true },
      Note: 'Degraded at or below this charge; 0 turns the percentage check off.',
    },
    {
      Key: 'LowBatteryMinutes',
      Label: 'Low battery at (minutes left)',
      Type: 'number',
      Default: DEFAULTS.LowBatteryMinutes,
      Min: 0,
      Max: 1440,
      VisibleWhen: { Key: 'CheckBattery', Equals: true },
      Note: 'Degraded at or below this much estimated runtime; 0 turns the runtime check off. Skipped for beltpacks that do not report a runtime.',
    },
    {
      Key: 'CheckLinkQuality',
      Label: 'Check link quality',
      Type: 'boolean',
      Default: false,
      Note: 'Report Degraded when a monitored beltpack’s radio link quality is below the threshold.',
    },
    {
      Key: 'MinLinkQuality',
      Label: 'Minimum link quality',
      Type: 'number',
      Default: DEFAULTS.MinLinkQuality,
      Min: 0,
      Max: 100,
      VisibleWhen: { Key: 'CheckLinkQuality', Equals: true },
      Note: 'Compared with the link quality figure the base station reports for each beltpack (the value its web page shows).',
    },
  ];
}

export interface BeltpackOptions {
  Beltpacks: string[];
  CheckBattery: boolean;
  LowBatteryPercent: number;
  LowBatteryMinutes: number;
  CheckLinkQuality: boolean;
  MinLinkQuality: number;
}

function Clamp(Value: unknown, Min: number, Max: number, Fallback: number): number {
  const N = Number(Value);
  return Number.isFinite(N) ? Math.min(Max, Math.max(Min, Math.trunc(N))) : Fallback;
}

export function ParseBeltpackOptions(Target: MonitoringTargetLike): BeltpackOptions {
  const Cfg = (Target && Target.Settings) || {};
  // De-duplicate case-insensitively, keeping the first spelling.
  const Seen = new Set<string>();
  const Beltpacks: string[] = [];
  for (const Entry of AsList(Cfg.Beltpacks)) {
    const Key = Entry.toLowerCase();
    if (Seen.has(Key)) continue;
    Seen.add(Key);
    Beltpacks.push(Entry);
  }
  return {
    Beltpacks,
    // Battery is the main reason to watch beltpacks, so an unset toggle counts as on.
    CheckBattery: Cfg.CheckBattery !== false,
    LowBatteryPercent: Clamp(Cfg.LowBatteryPercent, 0, 100, DEFAULTS.LowBatteryPercent),
    LowBatteryMinutes: Clamp(Cfg.LowBatteryMinutes, 0, 1440, DEFAULTS.LowBatteryMinutes),
    CheckLinkQuality: Cfg.CheckLinkQuality === true,
    MinLinkQuality: Clamp(Cfg.MinLinkQuality, 0, 100, DEFAULTS.MinLinkQuality),
  };
}

// --- Normalised model -------------------------------------------------------

export interface ClearComRole {
  Id: number;
  Label: string;
}

export interface ClearComEndpoint {
  Id: string;
  Label: string;
  Type: string | null;
  // 'Beltpack' is anything a person carries or uses (beltpacks, and on Arcadia
  // wired packs and panels too); 'Transceiver' is radio infrastructure.
  Kind: 'Beltpack' | 'Transceiver';
  Online: boolean;
  Role: string | null;
  BatteryPercent: number | null;
  MinutesLeft: number | null;
  BatteryType: string | null;
  Rssi: number | null;
  LinkQuality: number | null;
  Firmware: string | null;
}

// Roles list -> id -> label. CCM's role records carry `label`; Arcadia's
// rolesets carry `name` too, so either is accepted.
export function RoleMap(Records: unknown): Map<number, string> {
  const Map_ = new Map<number, string>();
  if (!Array.isArray(Records)) return Map_;
  for (const R of Records) {
    if (!IsObject(R)) continue;
    const Id = NumOrNull(R.id);
    const Label = StrOrNull(R.label) ?? StrOrNull(R.name);
    if (Id != null && Label) Map_.set(Id, Label);
  }
  return Map_;
}

function Longevity(Value: unknown): number | null {
  if (!IsObject(Value)) return null;
  const H = NumOrNull(Value.hours);
  const M = NumOrNull(Value.minutes);
  if (H == null && M == null) return null;
  const Total = (H ?? 0) * 60 + (M ?? 0);
  return Total >= 0 && Total < 100 * 60 ? Math.round(Total) : null;
}

function Percent(Value: unknown): number | null {
  const N = typeof Value === 'number' ? Value : NumOrNull(Value);
  return N != null && N >= 0 && N <= 100 ? N : null;
}

export interface NormaliseOptions {
  // How a record is recognised as radio infrastructure rather than a beltpack.
  IsTransceiver(Record: Record<string, unknown>): boolean;
  // The role this record is using, as a role id (looked up in Roles), or null.
  RoleId(Record: Record<string, unknown>, Live: Record<string, unknown>): number | null;
  Roles: Map<number, string>;
}

// One raw endpoint record -> the normalised model, or null for junk.
export function NormaliseEndpoint(
  Record: unknown,
  Options: NormaliseOptions
): ClearComEndpoint | null {
  if (!IsObject(Record)) return null;
  const IdRaw = Record.id;
  const Id = typeof IdRaw === 'number' && Number.isFinite(IdRaw) ? String(IdRaw) : StrOrNull(IdRaw);
  if (!Id) return null;
  const Live = IsObject(Record.liveStatus) ? Record.liveStatus : {};
  const Online = String(Live.status ?? '').toLowerCase() === 'online';
  const RoleId = Options.RoleId(Record, Live);
  const RoleRecord = IsObject(Record.role) ? Record.role : null;
  const Role =
    (RoleId != null ? Options.Roles.get(RoleId) : undefined) ??
    (RoleRecord ? StrOrNull(RoleRecord.label) : null) ??
    null;
  return {
    Id,
    Label: StrOrNull(Record.label) ?? `Endpoint ${Id}`,
    Type: StrOrNull(Record.type),
    Kind: Options.IsTransceiver(Record) ? 'Transceiver' : 'Beltpack',
    Online,
    Role,
    // Battery, runtime and radio readings only mean something while online.
    BatteryPercent: Online ? Percent(Live.batteryLevel) : null,
    MinutesLeft: Online ? Longevity(Live.longevity) : null,
    BatteryType: Online ? StrOrNull(Live.batteryType) : null,
    Rssi: Online ? NumOrNull(Live.RSSI ?? Live.rssi) : null,
    LinkQuality: Online ? NumOrNull(Live.linkQuality) : null,
    Firmware: StrOrNull(Record.versionSW),
  };
}

export function NormaliseEndpoints(
  Records: unknown,
  Options: NormaliseOptions
): ClearComEndpoint[] {
  if (!Array.isArray(Records)) return [];
  const Out: ClearComEndpoint[] = [];
  for (const R of Records) {
    const E = NormaliseEndpoint(R, Options);
    if (E) Out.push(E);
  }
  return Out;
}

// --- Evaluation -------------------------------------------------------------

export function PackName(E: ClearComEndpoint): string {
  return E.Role && E.Role !== E.Label ? `${E.Role} (${E.Label})` : E.Role || E.Label;
}

function Matches(E: ClearComEndpoint, Entry: string): boolean {
  const Want = Entry.trim().toLowerCase();
  return (
    (E.Role != null && E.Role.toLowerCase() === Want) ||
    E.Label.toLowerCase() === Want ||
    E.Id.toLowerCase() === Want
  );
}

// Issues for one online beltpack, per the enabled options. Pure.
export function PackIssues(E: ClearComEndpoint, Options: BeltpackOptions): string[] {
  const Issues: string[] = [];
  if (!E.Online) return Issues;
  if (Options.CheckBattery) {
    const Parts: string[] = [];
    if (
      Options.LowBatteryPercent > 0 &&
      E.BatteryPercent != null &&
      E.BatteryPercent <= Options.LowBatteryPercent
    ) {
      Parts.push(`${E.BatteryPercent}%`);
    }
    if (
      Options.LowBatteryMinutes > 0 &&
      E.MinutesLeft != null &&
      E.MinutesLeft <= Options.LowBatteryMinutes
    ) {
      Parts.push(`${E.MinutesLeft} min left`);
    }
    if (Parts.length) Issues.push(`battery ${Parts.join(', ')}`);
  }
  if (Options.CheckLinkQuality && E.LinkQuality != null && E.LinkQuality < Options.MinLinkQuality) {
    Issues.push(`link quality ${E.LinkQuality}`);
  }
  return Issues;
}

export interface BeltpackEvaluation {
  Reasons: string[];
  // Endpoint id -> issues, for every monitored beltpack.
  Issues: Record<string, string[]>;
  Monitored: string[];
  // Listed entries with no online beltpack, and why.
  Missing: Array<{ Entry: string; Reason: string }>;
}

// Turn the endpoint list into reasons. A listed entry is satisfied by any
// online beltpack whose role, label or id matches it; battery and link are
// judged on the beltpacks the list selects, or on every beltpack when the list
// is empty. Pure.
export function EvaluateBeltpacks(
  Endpoints: ClearComEndpoint[],
  Roles: Map<number, string>,
  Options: BeltpackOptions
): BeltpackEvaluation {
  const Packs = Endpoints.filter((E) => E.Kind === 'Beltpack');
  const Reasons: string[] = [];
  const Missing: BeltpackEvaluation['Missing'] = [];
  const MonitoredSet = new Set<string>();
  const RoleNames = new Set([...Roles.values()].map((L) => L.toLowerCase()));

  if (!Options.Beltpacks.length) {
    for (const E of Packs) MonitoredSet.add(E.Id);
  }
  for (const Entry of Options.Beltpacks) {
    const Found = Packs.filter((E) => Matches(E, Entry));
    for (const E of Found) MonitoredSet.add(E.Id);
    if (Found.some((E) => E.Online)) continue;
    let Reason: string;
    if (Found.length) Reason = 'offline';
    else if (RoleNames.has(Entry.toLowerCase())) Reason = 'no beltpack online with this role';
    else Reason = 'not found on this base station';
    Missing.push({ Entry, Reason });
    Reasons.push(`${Entry}: ${Reason}`);
  }

  const Issues: Record<string, string[]> = {};
  for (const E of Packs) {
    if (!MonitoredSet.has(E.Id)) continue;
    const List = PackIssues(E, Options);
    Issues[E.Id] = List;
    if (List.length) Reasons.push(`${PackName(E)}: ${List.join(', ')}`);
  }
  return { Reasons, Issues, Monitored: [...MonitoredSet], Missing };
}

export interface ClearComPackResult extends ClearComEndpoint {
  Monitored: boolean;
  Issues: string[];
}

// The beltpack part of a result: the annotated endpoint list plus a verdict.
export function BeltpackResult(
  Endpoints: ClearComEndpoint[],
  Roles: Map<number, string>,
  Options: BeltpackOptions
): Partial<MonitoringResult> {
  const Eval = EvaluateBeltpacks(Endpoints, Roles, Options);
  const MonitoredSet = new Set(Eval.Monitored);
  const Annotated: ClearComPackResult[] = Endpoints.map((E) => ({
    ...E,
    Monitored: MonitoredSet.has(E.Id),
    Issues: Eval.Issues[E.Id] ?? [],
  }));
  // Online beltpacks first, then by name, so the debug panel reads top-down.
  Annotated.sort(
    (A, B) =>
      Number(B.Kind === 'Beltpack') - Number(A.Kind === 'Beltpack') ||
      Number(B.Online) - Number(A.Online) ||
      PackName(A).localeCompare(PackName(B))
  );
  const Packs = Annotated.filter((E) => E.Kind === 'Beltpack');
  return {
    Endpoints: Annotated,
    BeltpacksOnline: Packs.filter((E) => E.Online).length,
    BeltpacksTotal: Packs.length,
    MissingBeltpacks: Eval.Missing,
    ...(Eval.Reasons.length ? { Degraded: true, DegradedReason: Eval.Reasons.join('; ') } : {}),
  };
}

// --- Debug ------------------------------------------------------------------

export function FormatUptime(Seconds: unknown): string {
  const N = Number(Seconds);
  if (!Number.isFinite(N) || N < 0) return '-';
  const D = Math.floor(N / 86400);
  const H = Math.floor((N % 86400) / 3600);
  const M = Math.floor((N % 3600) / 60);
  return D > 0 ? `${D}d ${H}h ${M}m` : H > 0 ? `${H}h ${M}m` : `${M}m`;
}

function FormatMinutes(Minutes: number): string {
  return `${Math.floor(Minutes / 60)}:${String(Minutes % 60).padStart(2, '0')} left`;
}

function PackBadge(E: ClearComPackResult): string {
  if (!E.Online) return E.Monitored ? Pill('danger', 'Offline') : Pill('muted', 'Offline');
  if (!E.Monitored) return Pill('muted', 'Not monitored');
  if (E.Issues.length) return Pill('warning', E.Issues[0] ?? 'Issue');
  return Pill('success', 'OK');
}

function PackCard(E: ClearComPackResult): string {
  const Battery: string[] = [];
  if (E.BatteryPercent != null) Battery.push(`${E.BatteryPercent}%`);
  if (E.MinutesLeft != null) Battery.push(FormatMinutes(E.MinutesLeft));
  if (E.BatteryType) Battery.push(E.BatteryType);
  const Radio: string[] = [];
  if (E.LinkQuality != null) Radio.push(`link ${E.LinkQuality}`);
  if (E.Rssi != null) Radio.push(`RSSI ${E.Rssi}`);
  const Body = Rows([
    TextRow(
      E.Kind === 'Transceiver' ? 'Transceiver' : 'Beltpack',
      [E.Label, E.Type, `ID ${E.Id}`].filter(Boolean).join(' · ')
    ),
    E.Online && Battery.length ? TextRow('Battery', Battery.join(' · ')) : null,
    E.Online && Radio.length ? TextRow('Radio', Radio.join(' · ')) : null,
    E.Firmware ? TextRow('Firmware', E.Firmware) : null,
    E.Issues.length > 1 ? TextRow('Issues', E.Issues.join(', ')) : null,
  ]);
  return Card({
    Title: E.Kind === 'Transceiver' ? E.Label : E.Role || E.Label,
    Badge:
      E.Kind === 'Transceiver'
        ? Pill(E.Online ? 'success' : 'muted', E.Online ? 'Online' : 'Not online')
        : PackBadge(E),
    BodyHtml: `<div class="mt-1">${Body}</div>`,
  });
}

export interface HeadOptions {
  Host: string;
  DeviceLabel: string;
  OfflineText: string;
}

// The whole debug panel: a header, then beltpack and transceiver cards. Every
// network-derived value goes through TextRow / Pill / Card / Note, which escape.
export function ClearComDebug(Result: MonitoringResult, Head: HeadOptions): string {
  const Online = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatusPill = HealthPill(Result, 'Healthy', false);
  const Str = (Value: unknown): string => (Value == null || Value === '' ? '' : String(Value));

  const Header = Rows([
    TextRow('Host', Head.Host || '-'),
    Row('Status', StatusPill),
    Online && Str(Result.Label || Result.Model)
      ? TextRow(
          Head.DeviceLabel,
          [Str(Result.Label), Str(Result.Model)].filter(Boolean).join(' · ')
        )
      : null,
    Online && Str(Result.Firmware) ? TextRow('Firmware', Str(Result.Firmware)) : null,
    Online && Result.Uptime != null ? TextRow('Uptime', FormatUptime(Result.Uptime)) : null,
    Online && Str(Result.State) ? TextRow('State', Str(Result.State)) : null,
    Online && Result.BeltpacksTotal != null
      ? TextRow(
          'Beltpacks online',
          `${Number(Result.BeltpacksOnline) || 0} of ${Number(Result.BeltpacksTotal) || 0}`
        )
      : null,
    Online && Result.LatencyMs != null
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : null,
    Online && Degraded && Result.DegradedReason
      ? TextRow('Reason', Str(Result.DegradedReason))
      : null,
    !Online ? TextRow('Error', Str(Result && Result.Error) || Head.OfflineText) : null,
  ]);
  if (!Online) return Header;

  const All = Array.isArray(Result.Endpoints) ? (Result.Endpoints as ClearComPackResult[]) : [];
  const Packs = All.filter((E) => E && E.Kind === 'Beltpack');
  const Transceivers = All.filter((E) => E && E.Kind === 'Transceiver');
  const Missing = Array.isArray(Result.MissingBeltpacks)
    ? (Result.MissingBeltpacks as Array<{ Entry: string; Reason: string }>)
    : [];

  let Html = Header;
  if (Missing.length) {
    Html +=
      '<div class="mt-2">' +
      Note(`Not online: ${Missing.map((M) => `${M.Entry} (${M.Reason})`).join(', ')}`) +
      '</div>';
  }
  if (!Packs.length) {
    Html += '<div class="mt-2">' + Note('No beltpacks reported') + '</div>';
  } else {
    Html +=
      `<div class="text-muted small mt-2 mb-1">Beltpacks (${Packs.length})</div>` +
      `<div class="d-grid gap-1">${Packs.map(PackCard).join('')}</div>`;
  }
  if (Transceivers.length) {
    Html +=
      `<div class="text-muted small mt-2 mb-1">Transceivers (${Transceivers.length})</div>` +
      `<div class="d-grid gap-1">${Transceivers.map(PackCard).join('')}</div>`;
  }
  return Html;
}

export const _internal = {
  RoleMap,
  NormaliseEndpoint,
  NormaliseEndpoints,
  ParseBeltpackOptions,
  PackIssues,
  EvaluateBeltpacks,
  BeltpackResult,
  FormatUptime,
};
