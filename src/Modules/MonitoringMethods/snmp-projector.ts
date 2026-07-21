// Projector status over SNMP (v1 / v2c). Reads standard MIB-II identity
// (sysDescr / sysUpTime / sysName) for reachability on every SNMP-capable
// projector, then — per the selected brand profile — any corroborated
// vendor OIDs (e.g. Epson / Christie lamp hours). Up to two custom OID
// assertions are available under Advanced for model-specific values.
//
// There is no standard projector MIB, so brand OIDs are best-effort: an OID a
// device doesn't answer is shown as "not reported", never a failure. See
// ./_snmp-projector-profiles for the per-brand tables and their provenance.
import snmp from 'net-snmp';
import { Esc, Pill, Rows, Row, TextRow, Note, FormatLatency } from './debug';
import {
  IDENTITY_OIDS,
  GetProfile,
  type ProjectorProfile,
  type RawSnmpValue,
} from './_snmp-projector-profiles';
import { DEFAULT_PORT, type SnmpSession } from './_snmp-ups-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'snmp-projector';

const PROFILE_OPTIONS = [
  { value: 'generic', label: 'Generic (reachability + identity)' },
  { value: 'epson', label: 'Epson' },
  { value: 'nec', label: 'NEC / Sharp' },
  { value: 'panasonic', label: 'Panasonic' },
  { value: 'christie', label: 'Christie' },
  { value: 'sony', label: 'Sony' },
  { value: 'barco', label: 'Barco' },
];

const CUSTOM_OP_OPTIONS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not-equals', label: 'Not equals' },
  { value: 'max', label: 'Numeric ≤' },
  { value: 'min', label: 'Numeric ≥' },
];

function CustomFields(N: number): MonitoringSettingField[] {
  return [
    {
      Key: `Custom${N}Oid`,
      Label: `Custom OID ${N} (blank = off)`,
      Type: 'string',
      Default: '',
      Advanced: true,
    },
    {
      Key: `Custom${N}Op`,
      Label: `Custom OID ${N} comparison`,
      Type: 'select',
      Default: 'equals',
      Options: CUSTOM_OP_OPTIONS,
      Advanced: true,
    },
    {
      Key: `Custom${N}Value`,
      Label: `Custom OID ${N} expected value`,
      Type: 'string',
      Default: '',
      Advanced: true,
    },
  ];
}

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Community',
    Label: 'Community string',
    Type: 'string',
    Default: 'public',
    Required: true,
  },
  {
    Key: 'Profile',
    Label: 'Brand profile',
    Type: 'select',
    Default: 'generic',
    Options: PROFILE_OPTIONS,
  },
  {
    Key: 'Version',
    Label: 'SNMP version',
    Type: 'select',
    Default: '2c',
    Options: [
      { value: '2c', label: 'v2c' },
      { value: '1', label: 'v1' },
    ],
    Advanced: true,
  },
  {
    Key: 'LampWarnHours',
    Label: 'Lamp hours warning threshold (0 = off)',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 100000,
    Advanced: true,
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 4000,
    Min: 500,
    Max: 30000,
    Advanced: true,
  },
  {
    Key: 'Retries',
    Label: 'Retries',
    Type: 'number',
    Default: 1,
    Min: 0,
    Max: 5,
    Advanced: true,
  },
  ...CustomFields(1),
  ...CustomFields(2),
];

type CustomOp = 'equals' | 'not-equals' | 'max' | 'min';

interface CustomCheck {
  Oid: string;
  Op: CustomOp;
  Value: string;
}

interface SnmpProjectorConfig {
  Address: string;
  Port: number;
  Community: string;
  Version: '1' | '2c';
  Profile: string;
  LampWarnHours: number;
  TimeoutMs: number;
  Retries: number;
  Customs: CustomCheck[];
}

function ParseConfig(Target: MonitoringTargetLike): SnmpProjectorConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Num = (Value: unknown, Fallback: number): number => {
    const N = Number(Value);
    return Number.isFinite(N) ? N : Fallback;
  };
  const Str = (Value: unknown): string => (Value == null ? '' : String(Value).trim());

  const Customs: CustomCheck[] = [];
  for (const N of [1, 2]) {
    const Oid = Str(Cfg[`Custom${N}Oid`]);
    if (!Oid) continue;
    const RawOp = String(Cfg[`Custom${N}Op`]);
    const Op: CustomOp =
      RawOp === 'not-equals' || RawOp === 'max' || RawOp === 'min' ? RawOp : 'equals';
    Customs.push({ Oid, Op, Value: Str(Cfg[`Custom${N}Value`]) });
  }

  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Num(Cfg.Port, DEFAULT_PORT) | 0,
    Community: Cfg.Community == null || Cfg.Community === '' ? 'public' : String(Cfg.Community),
    Version: String(Cfg.Version) === '1' ? '1' : '2c',
    Profile: Str(Cfg.Profile) || 'generic',
    LampWarnHours: Math.max(0, Num(Cfg.LampWarnHours, 0) | 0),
    TimeoutMs: Num(Cfg.Timeout, 4000),
    Retries: Math.max(0, Num(Cfg.Retries, 1) | 0),
    Customs,
  };
}

// Coerce a single varbind to a display/compare-friendly value: Buffers become
// UTF-8 strings (preserving sysDescr etc.), integers stay numbers, absent
// objects and varbind errors become null. Unlike the UPS helper's number-only
// coercion, this keeps strings intact.
function CoerceVarbind(Varbind: unknown): RawSnmpValue {
  if (!Varbind || snmp.isVarbindError(Varbind as never)) return null;
  const Value = (Varbind as { value: unknown }).value;
  if (Value == null) return null;
  if (Buffer.isBuffer(Value)) return Value.toString('utf8');
  if (typeof Value === 'number') return Number.isFinite(Value) ? Value : null;
  if (typeof Value === 'bigint') return Number(Value);
  return String(Value);
}

// GET a single OID over an existing session. Resolves to null on any per-OID
// failure (missing object, varbind error). Rejects only on a transport-level
// error so the caller can treat that as "unreachable".
function GetOneVar(Session: SnmpSession, Oid: string): Promise<RawSnmpValue> {
  return new Promise<RawSnmpValue>((resolve, reject) => {
    try {
      Session.get([Oid], (Err: Error | null, Varbinds) => {
        if (Err) {
          reject(Err);
          return;
        }
        resolve(CoerceVarbind((Varbinds || [])[0]));
      });
    } catch (Err) {
      reject(Err instanceof Error ? Err : new Error(String(Err)));
    }
  });
}

export interface ProjectorReadings {
  SysDescr: RawSnmpValue;
  SysUpTime: RawSnmpValue;
  SysName: RawSnmpValue;
  LampHours: RawSnmpValue;
  // Present flag distinguishes "OID absent" from "value is null".
  Customs: Array<{ Check: CustomCheck; Value: RawSnmpValue }>;
}

// Apply the profile + threshold + custom-OID rules to a set of readings and
// return the degraded reasons (empty when healthy). Pure — exported via
// _internal for unit tests. Brand OIDs that returned no data never contribute
// a reason.
export function EvaluateProjector(
  Readings: ProjectorReadings,
  Profile: ProjectorProfile,
  Config: SnmpProjectorConfig
): string[] {
  const Reasons: string[] = [];

  if (Config.LampWarnHours > 0 && Readings.LampHours != null) {
    const Hours = Number(Readings.LampHours);
    if (Number.isFinite(Hours) && Hours >= Config.LampWarnHours) {
      Reasons.push(`Lamp ${Hours} h ≥ ${Config.LampWarnHours} h`);
    }
  }

  Readings.Customs.forEach(({ Check, Value }, Index) => {
    const N = Index + 1;
    if (Value == null) {
      Reasons.push(`Custom OID ${N} not present`);
      return;
    }
    const Got = String(Value).trim();
    const Want = Check.Value.trim();
    if (Check.Op === 'equals' && Got !== Want) {
      Reasons.push(`Custom OID ${N}: ${Got} (expected = ${Want})`);
    } else if (Check.Op === 'not-equals' && Got === Want) {
      Reasons.push(`Custom OID ${N}: ${Got} (expected ≠ ${Want})`);
    } else if (Check.Op === 'max' || Check.Op === 'min') {
      const GotN = Number(Got);
      const WantN = Number(Want);
      if (!Number.isFinite(GotN) || !Number.isFinite(WantN)) {
        Reasons.push(`Custom OID ${N} is not numeric`);
      } else if (Check.Op === 'max' && GotN > WantN) {
        Reasons.push(`Custom OID ${N}: ${Got} (expected ≤ ${Want})`);
      } else if (Check.Op === 'min' && GotN < WantN) {
        Reasons.push(`Custom OID ${N}: ${Got} (expected ≥ ${Want})`);
      }
    }
  });

  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }
  const Profile = GetProfile(Config.Profile);

  let Session: SnmpSession;
  try {
    Session = snmp.createSession(Config.Address, Config.Community, {
      port: Config.Port,
      version: Config.Version === '1' ? snmp.Version1 : snmp.Version2c,
      timeout: Math.max(500, Config.TimeoutMs),
      retries: Config.Retries,
    });
  } catch (Err) {
    return { Success: false, Error: Err instanceof Error ? Err.message : String(Err) };
  }

  const Started = Date.now();
  try {
    // Identity first — MIB-II is mandatory, so a transport failure here means
    // the device is unreachable. SNMPv1 fails an entire PDU when any single OID
    // is absent, and brand/custom OIDs are exactly the ones likely to be
    // missing, so every OID is fetched with its own single-OID GET.
    const [SysDescr, SysUpTime, SysName] = await Promise.all([
      GetOneVar(Session, IDENTITY_OIDS.SysDescr),
      GetOneVar(Session, IDENTITY_OIDS.SysUpTime),
      GetOneVar(Session, IDENTITY_OIDS.SysName),
    ]);

    let LampHours: RawSnmpValue = null;
    if (Profile.LampHoursOid) {
      LampHours = await GetOneVar(Session, Profile.LampHoursOid).catch(() => null);
    }

    const Customs: ProjectorReadings['Customs'] = [];
    for (const Check of Config.Customs) {
      const Value = await GetOneVar(Session, Check.Oid).catch(() => null);
      Customs.push({ Check, Value });
    }

    const Readings: ProjectorReadings = {
      SysDescr,
      SysUpTime,
      SysName,
      LampHours,
      Customs,
    };
    const Reasons = EvaluateProjector(Readings, Profile, Config);
    const ProfileMissing = !!Profile.LampHoursOid && LampHours == null;

    return {
      Success: true,
      ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
      LatencyMs: Date.now() - Started,
      Profile: Profile.ID,
      ProfileVerified: Profile.Verified,
      ProfileNote: Profile.Note || null,
      ProfileMissing,
      SysDescr,
      SysUpTime,
      SysName,
      LampHours,
      Customs: Customs.map((C) => ({ Oid: C.Check.Oid, Value: C.Value })),
    };
  } catch (Err) {
    return { Success: false, Error: Err instanceof Error ? Err.message : String(Err) };
  } finally {
    try {
      Session.close();
    } catch {
      // ignore
    }
  }
}

function StatePill(Result: MonitoringResult): string {
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  if (Reachable && !Degraded) return Pill('success', 'Online');
  if (Reachable) return Pill('warning', (Result && Result.DegradedReason) || 'Degraded');
  return Pill('danger', 'Offline');
}

function FormatUptime(Ticks: unknown): string {
  const N = Number(Ticks);
  if (!Number.isFinite(N)) return '—';
  const Seconds = Math.floor(N / 100);
  const Days = Math.floor(Seconds / 86400);
  const Hours = Math.floor((Seconds % 86400) / 3600);
  const Minutes = Math.floor((Seconds % 3600) / 60);
  return `${Days}d ${Hours}h ${Minutes}m`;
}

function MonoRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Profile = GetProfile(Config.Profile);
  const Reachable = !!(Result && Result.Success === true);

  const ProfileValue = Profile.Verified
    ? Esc(Profile.Label)
    : `${Esc(Profile.Label)} ${Pill('muted', 'Unverified OIDs')}`;

  const CustomRows: string[] = [];
  if (Reachable && Array.isArray(Result.Customs)) {
    (Result.Customs as Array<{ Oid: string; Value: RawSnmpValue }>).forEach((C, Index) => {
      CustomRows.push(
        MonoRow(`Custom OID ${Index + 1}`, C.Value == null ? 'not reported' : String(C.Value))
      );
    });
  }

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    IdentityRow('SNMP', `v${Config.Version} · ${Config.Community}`),
    Row('Profile', ProfileValue),
    Row('Status', StatePill(Result)),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'No SNMP reply'),
    Reachable && Result.SysName != null && String(Result.SysName) !== ''
      ? TextRow('Name', String(Result.SysName))
      : null,
    Reachable && Result.SysDescr != null && String(Result.SysDescr) !== ''
      ? TextRow('Description', String(Result.SysDescr).slice(0, 120))
      : null,
    Reachable && Result.SysUpTime != null
      ? MonoRow('Uptime', FormatUptime(Result.SysUpTime))
      : null,
    Reachable && Result.LampHours != null ? MonoRow('Lamp hours', `${Result.LampHours} h`) : null,
    ...CustomRows,
  ]);

  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Could not reach the projector over SNMP') + '</div>';
  }
  const Notes: string[] = [];
  if (Result.ProfileMissing) {
    Notes.push(
      '<div class="mt-2">' +
        Note('Brand profile returned no data — wrong profile, or SNMP status not exposed?') +
        '</div>'
    );
  }
  if (Profile.Note) {
    Notes.push('<div class="mt-2">' + Note(Profile.Note) + '</div>');
  }
  return Head + Notes.join('');
}

function IdentityRow(Label: string, Value: unknown): string {
  return Row(Label, `<span class="font-monospace">${Esc(String(Value))}</span>`);
}

export const Name = 'Projector Status (SNMP)';
export const Description =
  'Reads projector status over SNMP (v1/v2c) using a brand profile — Epson and Christie expose lamp hours; other brands fall back to generic SNMP reachability and device identity. Up to two custom OID checks are available under Advanced. Prefer PJLink where available; SNMP support varies by brand and model.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseConfig, EvaluateProjector, GetOneVar, CoerceVarbind };
export { ID, Settings, Run, Debug };
