// Ross Video openGear frame health (OG3-FR, OGX-FR, DFR-8300 series) over SNMP,
// read from the frame controller's (MFC-OG3-N / MFC-8322-S) agent using Ross's
// published MIBs (ROSS-MIBS-20220314.zip, from rossvideo.com, "Ross Video SNMP
// MIBs"):
//
//   OPEN-GEAR-FRAME-MIB  openGearFrameMib = 1.3.6.1.4.1.27399.1.1.2
//     openGearFrameTable         .1.2.1.<col>.<frame>   product info
//       3 Name, 5 Product (controller), 8 SerialNumber, 11 FirmwareRev,
//       12 ProductName (frame)
//     openGearFrameHardwareTable .1.3.1.<col>.<frame>
//       1 Status (bitfield, 0 = all OK), 2 FanDoor (1 closed, 2 open),
//       3 FanSpeed, 5 ActiveSlots
//     openGearFramePowerTable    .1.4.1.<col>.<frame>
//       1 Power (W), 5/6 PSU1/PSU2 Temp (°C, 0 = no PSU), 7 AmbientTemp
//       (°C, 0 = fan door open), 8/9 PSU1/PSU2 Model, 16/17 PSU1/PSU2 Status
//       (bitfield)
//     openGearFrameSetupTable    .1.5.1.<col>.<frame>
//       1 ActionOnCardFault (0 ignore, 1 notify)
//   OPEN-GEAR-CARD-MIB   openGearCardMib  = 1.3.6.1.4.1.27399.1.1.3
//     openGearCardTable          .1.2.1.<col>.<frame>.<slot>
//       2 Supplier, 3 Product, 4 SoftwareRev, 5 Online (TruthValue 1/2)
//
// "The openGearFrameIndex represents the frame number ... right now it is
// always 1", so every frame instance here is .1.
//
// What the public MIBs do NOT give: a per-card OK / warning / error status. The
// generic card table has only presence (Online); a card's own health lives in
// its product-specific MIB, which differs per card model. Card faults are read
// from the frame status bitfield instead (0x0040 "error condition(s) reported by
// card(s)", 0x0800 "card warning" on OG3-FR), which names no slot. The frame
// only raises 0x0040 while openGearActionOnCardFault is "notify", its default.
//
// Why SNMP rather than the openGear Protocol (OGP, TCP 5253) DashBoard uses:
// Ross's OGP specification is partner-only, and the MFC-8322-S accepts ONE
// control connection at a time, so a poller on 5253 would lock DashBoard out of
// the frame. SNMP is a paid, field-installed option on the MFC; without the
// key the frame does not answer SNMP at all.
//
// Each probe is two short exchanges on fresh sessions (one GET of the frame
// objects, one walk of the card table), both inside one Timeout budget, so no
// session outlives a poll.
import snmp from 'net-snmp';
import { ProbeOids, type OidReading } from './snmp-oid';
import { DEFAULT_PORT, type SnmpSession } from './_snmp-ups-shared';
import {
  SNMP_VERSION_FIELDS,
  SnmpBudgetFields,
  ParseSnmpCredentials,
  SnmpConnectionError,
  CreateSnmpSessionFactory,
  SnmpIdentityLabel,
  type SnmpConnection,
} from './_snmp-shared';
import { Card, Esc, Pill, Rows, Row, TextRow, Note, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'opengear-frame';

const DEFAULT_TIMEOUT_MS = 5000;
// Frames have 20 slots; a walk that returns more rows than this is not reading
// an openGear card table, so it is cut short rather than followed forever.
const MAX_CARD_VARBINDS = 400;
const MAX_SLOT = 99;

const FRAME_MIB = '1.3.6.1.4.1.27399.1.1.2.1';
const CARD_ENTRY = '1.3.6.1.4.1.27399.1.1.3.1.2.1';
const FRAME_INDEX = 1;

const FrameOid = (Table: number, Column: number): string =>
  `${FRAME_MIB}.${Table}.1.${Column}.${FRAME_INDEX}`;

// Frame objects read on every poll, keyed by the name used in the result.
export const FRAME_OIDS: Record<string, string> = {
  FrameName: FrameOid(2, 3),
  ControllerProduct: FrameOid(2, 5),
  SerialNumber: FrameOid(2, 8),
  ControllerFirmware: FrameOid(2, 11),
  FrameProduct: FrameOid(2, 12),
  Status: FrameOid(3, 1),
  FanDoor: FrameOid(3, 2),
  FanSpeed: FrameOid(3, 3),
  ActiveSlots: FrameOid(3, 5),
  Power: FrameOid(4, 1),
  Psu1Temp: FrameOid(4, 5),
  Psu2Temp: FrameOid(4, 6),
  AmbientTemp: FrameOid(4, 7),
  Psu1Model: FrameOid(4, 8),
  Psu2Model: FrameOid(4, 9),
  Psu1Status: FrameOid(4, 16),
  Psu2Status: FrameOid(4, 17),
  ActionOnCardFault: FrameOid(5, 1),
};

// openGearFrameStatus bits (OPEN-GEAR-FRAME-MIB). 0x0008 and 0x0400 are both
// "psu is overloaded" (the second on OG3-FR), so they share a reason.
export const FRAME_STATUS_BITS: Array<{ Bit: number; Reason: string; Card?: boolean }> = [
  { Bit: 0x0001, Reason: 'Fan door open too long' },
  { Bit: 0x0002, Reason: 'PSU fuse blown' },
  { Bit: 0x0004, Reason: 'PSU fault' },
  { Bit: 0x0008, Reason: 'PSU overloaded' },
  { Bit: 0x0010, Reason: 'PSU fan stalled' },
  { Bit: 0x0020, Reason: 'Door fan stalled' },
  { Bit: 0x0040, Reason: 'A card reports an error', Card: true },
  { Bit: 0x0080, Reason: 'Reference card missing or faulty' },
  { Bit: 0x0100, Reason: 'PSU AC missing' },
  { Bit: 0x0200, Reason: 'PSU switched off' },
  { Bit: 0x0400, Reason: 'PSU overloaded' },
  { Bit: 0x0800, Reason: 'A card reports a warning', Card: true },
];

// openGearPSU1Status / openGearPSU2Status bits.
const PSU_PRESENT = 0x0001;
const PSU_NOT_PRESENT_MASKED = 0x0002;
const PSU_MISSING = 0x0004;
export const PSU_FAULT_BITS: Array<{ Bit: number; Reason: string }> = [
  { Bit: 0x0008, Reason: 'fault' },
  { Bit: 0x0010, Reason: 'fan fault' },
  { Bit: 0x0020, Reason: 'fuse blown' },
  { Bit: 0x0040, Reason: 'AC missing' },
  { Bit: 0x0080, Reason: 'switched off' },
  { Bit: 0x0200, Reason: 'incompatible with the frame' },
];

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Advanced: true,
  },
  ...SNMP_VERSION_FIELDS,
  {
    Key: 'Slots',
    Label: 'Monitored slots',
    Type: 'list',
    ItemType: 'number',
    Default: [],
    Note: 'Slot numbers as DashBoard shows them. Degraded when a listed slot holds no card or its card is offline.',
  },
  {
    Key: 'RequireBothPsus',
    Label: 'Require both power supplies',
    Type: 'boolean',
    Default: false,
    Note: 'Enable on frames fitted with two power supplies to report Degraded when either is missing.',
  },
  {
    Key: 'CheckTemperature',
    Label: 'Monitor intake temperature',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the air at the frame intake is warmer than the maximum. The frame reports no reading while the fan door is open.',
  },
  {
    Key: 'MaxAmbientTemperature',
    Label: 'Maximum intake temperature (°C)',
    Type: 'number',
    Default: 35,
    Min: 0,
    Max: 100,
    VisibleWhen: { Key: 'CheckTemperature', Equals: true },
  },
  ...SnmpBudgetFields(DEFAULT_TIMEOUT_MS),
];

// --- Config ---------------------------------------------------------------------

function ParseConfig(Target: MonitoringTargetLike): SnmpConnection {
  const Cfg = (Target && Target.Settings) || {};
  const Num = (Value: unknown, Fallback: number): number => {
    const N = Number(Value);
    return Value === '' || Value == null || !Number.isFinite(N) ? Fallback : N;
  };
  return {
    ...ParseSnmpCredentials(Cfg),
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Num(Cfg.Port, DEFAULT_PORT) | 0,
    TimeoutMs: Math.max(500, Num(Cfg.Timeout, DEFAULT_TIMEOUT_MS)),
    Retries: Math.max(0, Math.min(5, Num(Cfg.Retries, 1) | 0)),
  };
}

export interface FrameConditions {
  Slots: number[];
  RequireBothPsus: boolean;
  CheckTemperature: boolean;
  MaxAmbientTemperature: number;
}

export function ParseConditions(Cfg: Record<string, unknown>): FrameConditions {
  const Raw = Array.isArray(Cfg.Slots)
    ? Cfg.Slots
    : Cfg.Slots == null || Cfg.Slots === ''
      ? []
      : [Cfg.Slots];
  const Slots: number[] = [];
  for (const Item of Raw) {
    const Text = String(Item).trim();
    if (!/^\d{1,2}$/.test(Text)) continue;
    const N = Number(Text);
    if (N <= MAX_SLOT && !Slots.includes(N)) Slots.push(N);
  }
  const Max = Number(Cfg.MaxAmbientTemperature);
  return {
    Slots,
    RequireBothPsus: Cfg.RequireBothPsus === true,
    CheckTemperature: Cfg.CheckTemperature === true,
    MaxAmbientTemperature: Cfg.MaxAmbientTemperature === '' || !Number.isFinite(Max) ? 35 : Max,
  };
}

// --- Card table walk --------------------------------------------------------------

export interface CardRow {
  Slot: number;
  Supplier: string | null;
  Product: string | null;
  Software: string | null;
  // openGearCardOnline: TruthValue true(1) / false(2); null when not reported.
  Online: boolean | null;
}

// Printable text of an OctetString value; null for anything else.
function TextOf(Value: unknown): string | null {
  if (Buffer.isBuffer(Value)) {
    let End = Value.length;
    while (End > 0 && Value[End - 1] === 0) End--;
    const Text = Value.subarray(0, End)
      .toString('utf8')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, '')
      .trim();
    return Text ? Text.slice(0, 120) : null;
  }
  if (typeof Value === 'string') return Value.trim().slice(0, 120) || null;
  return null;
}

// Fold walked card-table varbinds (CARD_ENTRY.<col>.<frame>.<slot>) into one row
// per slot of frame 1. Pure; exported for tests.
export function FoldCardRows(Varbinds: Array<{ oid: string; value?: unknown }>): CardRow[] {
  const Rows = new Map<number, CardRow>();
  const Prefix = `${CARD_ENTRY}.`;
  for (const Vb of Varbinds) {
    if (!Vb || typeof Vb.oid !== 'string' || !Vb.oid.startsWith(Prefix)) continue;
    const Arcs = Vb.oid.slice(Prefix.length).split('.');
    if (Arcs.length !== 3) continue;
    const [Column, Frame, Slot] = Arcs.map(Number) as [number, number, number];
    if (Frame !== FRAME_INDEX || !Number.isInteger(Slot) || Slot < 0 || Slot > MAX_SLOT) continue;
    const Row =
      Rows.get(Slot) ||
      ({ Slot, Supplier: null, Product: null, Software: null, Online: null } as CardRow);
    Rows.set(Slot, Row);
    if (Column === 2) Row.Supplier = TextOf(Vb.value);
    else if (Column === 3) Row.Product = TextOf(Vb.value);
    else if (Column === 4) Row.Software = TextOf(Vb.value);
    else if (Column === 5) {
      const N = Number(Vb.value);
      Row.Online = N === 1 ? true : N === 2 ? false : null;
    }
  }
  return Array.from(Rows.values()).sort((A, B) => A.Slot - B.Slot);
}

interface WalkResult {
  Ok: boolean;
  Error?: string;
  Varbinds: Array<{ oid: string; value?: unknown }>;
}

// Walk the card table on its own session, inside an absolute budget. A walk
// that hits the varbind cap stops early and keeps what it has.
export function WalkCards(CreateSession: () => SnmpSession, BudgetMs: number): Promise<WalkResult> {
  return new Promise<WalkResult>((resolve) => {
    const Collected: Array<{ oid: string; value?: unknown }> = [];
    let Settled = false;
    let Session: SnmpSession | null = null;
    let Timer: ReturnType<typeof setTimeout> | null = null;
    const Finish = (Result: WalkResult) => {
      if (Settled) return;
      Settled = true;
      if (Timer) clearTimeout(Timer);
      try {
        if (Session) Session.close();
      } catch {
        // ignore
      }
      resolve(Result);
    };
    try {
      Session = CreateSession();
    } catch (Err) {
      Finish({ Ok: false, Error: Err instanceof Error ? Err.message : String(Err), Varbinds: [] });
      return;
    }
    Timer = setTimeout(
      () => Finish({ Ok: false, Error: 'Card table walk timed out', Varbinds: Collected }),
      Math.max(1, BudgetMs)
    );
    Session.on('error', (Err: Error) =>
      Finish({ Ok: false, Error: Err && Err.message ? Err.message : String(Err), Varbinds: [] })
    );
    try {
      Session.subtree(
        CARD_ENTRY,
        20,
        (Varbinds) => {
          for (const Vb of Varbinds || []) {
            if (snmp.isVarbindError(Vb)) continue;
            Collected.push({ oid: String(Vb.oid), value: Vb.value });
          }
          // Returning true stops the walk.
          return Collected.length >= MAX_CARD_VARBINDS;
        },
        (Err: Error | null) => {
          if (Err) Finish({ Ok: false, Error: Err.message || String(Err), Varbinds: Collected });
          else Finish({ Ok: true, Varbinds: Collected });
        }
      );
    } catch (Err) {
      Finish({ Ok: false, Error: Err instanceof Error ? Err.message : String(Err), Varbinds: [] });
    }
  });
}

// --- Evaluation ------------------------------------------------------------------

export interface FrameReadings {
  Status: number | null;
  FanDoor: number | null;
  AmbientTemp: number | null;
  Psu1Status: number | null;
  Psu2Status: number | null;
  ActionOnCardFault: number | null;
  Cards: CardRow[] | null;
}

// The faults a PSU status word reports, e.g. ['AC missing', 'fan fault'].
export function PsuFaults(Status: number | null): string[] {
  if (Status == null) return [];
  return PSU_FAULT_BITS.filter((F) => (Status & F.Bit) !== 0).map((F) => F.Reason);
}

export function PsuState(Status: number | null): 'present' | 'absent' | 'unknown' {
  if (Status == null) return 'unknown';
  if (Status & PSU_PRESENT) return 'present';
  if (Status & (PSU_MISSING | PSU_NOT_PRESENT_MASKED)) return 'absent';
  return 'unknown';
}

// Judge the readings; returns the failing reasons (empty when healthy).
export function EvaluateFrame(R: FrameReadings, C: FrameConditions): string[] {
  const Reasons: string[] = [];

  if (R.Status != null && R.Status !== 0) {
    for (const Entry of FRAME_STATUS_BITS) {
      if ((R.Status & Entry.Bit) !== 0 && !Reasons.includes(Entry.Reason)) {
        Reasons.push(Entry.Reason);
      }
    }
  }

  const Psus: Array<[number, number | null]> = [
    [1, R.Psu1Status],
    [2, R.Psu2Status],
  ];
  for (const [N, Status] of Psus) {
    const Faults = PsuFaults(Status);
    if (Faults.length) Reasons.push(`PSU ${N}: ${Faults.join(', ')}`);
    else if (C.RequireBothPsus && PsuState(Status) === 'absent') Reasons.push(`PSU ${N} missing`);
  }

  if (C.CheckTemperature && R.AmbientTemp != null && R.AmbientTemp !== 0) {
    if (R.AmbientTemp > C.MaxAmbientTemperature) {
      Reasons.push(`Intake ${R.AmbientTemp}°C (max ${C.MaxAmbientTemperature}°C)`);
    }
  }

  if (C.Slots.length) {
    if (R.Cards == null) {
      Reasons.push('Card table not readable');
    } else {
      const BySlot = new Map(R.Cards.map((Row) => [Row.Slot, Row]));
      for (const Slot of C.Slots) {
        const Row = BySlot.get(Slot);
        if (!Row || (!Row.Product && Row.Online == null)) Reasons.push(`Slot ${Slot} empty`);
        else if (Row.Online === false) {
          Reasons.push(`Slot ${Slot} ${Row.Product ? `${Row.Product} ` : ''}offline`);
        }
      }
    }
  }
  return Reasons;
}

// --- Run --------------------------------------------------------------------------

function NumberOf(Reading: OidReading | undefined): number | null {
  if (!Reading || Reading.Exception || Reading.Hex || Reading.Value == null) return null;
  const N = Number(Reading.Value);
  return Number.isFinite(N) ? N : null;
}

function StringOf(Reading: OidReading | undefined): string | null {
  if (!Reading || Reading.Exception || Reading.Value == null || Reading.Hex) return null;
  const Text = String(Reading.Value).trim();
  return Text ? Text.slice(0, 120) : null;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const ConnectionError = SnmpConnectionError(Config);
  if (ConnectionError) return { Success: false, Error: ConnectionError };

  const Started = Date.now();
  const Deadline = Started + Config.TimeoutMs;
  const Keys = Object.keys(FRAME_OIDS);
  const Probe = await ProbeOids(
    CreateSnmpSessionFactory(Config, Config.TimeoutMs),
    Keys.map((Key) => FRAME_OIDS[Key] as string),
    Config.TimeoutMs
  );
  if (!Probe.Reachable) return { Success: false, Error: Probe.Error || 'No SNMP reply' };
  const LatencyMs = Probe.LatencyMs;

  const Read = (Key: string) => Probe.Reads.get(FRAME_OIDS[Key] as string)?.Reading;
  const Status = NumberOf(Read('Status'));
  // An agent with none of the frame hardware objects is not an openGear frame
  // controller (or its SNMP option is not enabled).
  if (Status == null && NumberOf(Read('Psu1Status')) == null && !StringOf(Read('FrameProduct'))) {
    return {
      Success: false,
      Error: 'The SNMP agent does not report the openGear frame MIB. Is this a frame controller?',
    };
  }

  const Conditions = ParseConditions((Target && Target.Settings) || {});
  const Remaining = Math.max(0, Deadline - Date.now());
  let Cards: CardRow[] | null = null;
  let CardError: string | null = null;
  if (Remaining > 0) {
    const Walk = await WalkCards(CreateSnmpSessionFactory(Config, Remaining), Remaining);
    if (Walk.Ok) Cards = FoldCardRows(Walk.Varbinds);
    else CardError = Walk.Error || 'Card table walk failed';
  } else {
    CardError = 'No time left to read the card table';
  }

  const Readings: FrameReadings = {
    Status,
    FanDoor: NumberOf(Read('FanDoor')),
    AmbientTemp: NumberOf(Read('AmbientTemp')),
    Psu1Status: NumberOf(Read('Psu1Status')),
    Psu2Status: NumberOf(Read('Psu2Status')),
    ActionOnCardFault: NumberOf(Read('ActionOnCardFault')),
    Cards,
  };
  const Reasons = EvaluateFrame(Readings, Conditions);
  if (CardError && Conditions.Slots.length) Reasons.push(`Cards: ${CardError}`);

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs,
    Version: Config.Version,
    FrameName: StringOf(Read('FrameName')),
    FrameProduct: StringOf(Read('FrameProduct')),
    ControllerProduct: StringOf(Read('ControllerProduct')),
    ControllerFirmware: StringOf(Read('ControllerFirmware')),
    SerialNumber: StringOf(Read('SerialNumber')),
    FrameStatus: Readings.Status,
    FanDoor: Readings.FanDoor,
    FanSpeed: NumberOf(Read('FanSpeed')),
    ActiveSlots: NumberOf(Read('ActiveSlots')),
    PowerW: NumberOf(Read('Power')),
    AmbientTemp: Readings.AmbientTemp,
    Psu1Status: Readings.Psu1Status,
    Psu2Status: Readings.Psu2Status,
    Psu1Temp: NumberOf(Read('Psu1Temp')),
    Psu2Temp: NumberOf(Read('Psu2Temp')),
    Psu1Model: StringOf(Read('Psu1Model')),
    Psu2Model: StringOf(Read('Psu2Model')),
    ActionOnCardFault: Readings.ActionOnCardFault,
    Cards,
    CardError,
  };
  if (Reasons.length) return { ...Base, Degraded: true, DegradedReason: Reasons.join('; ') };
  return Base;
}

// --- Debug ------------------------------------------------------------------------

function Mono(Value: unknown): string {
  return `<span class="font-monospace">${Esc(String(Value))}</span>`;
}

function PsuSummary(N: number, Status: unknown, Model: unknown, Temp: unknown): string | null {
  const S = typeof Status === 'number' ? Status : null;
  if (S == null) return null;
  const Faults = PsuFaults(S);
  const State = PsuState(S);
  const Kind = Faults.length ? 'danger' : State === 'present' ? 'success' : 'muted';
  const Text = Faults.length
    ? Faults.join(', ')
    : State === 'present'
      ? 'OK'
      : State === 'absent'
        ? 'Not fitted'
        : `Status ${S}`;
  const Details = [
    typeof Model === 'string' && Model ? Model : null,
    typeof Temp === 'number' && Temp !== 0 ? `${Temp}°C` : null,
  ].filter(Boolean);
  return Card({
    Title: `PSU ${N}`,
    Badge: Pill(Kind, Text),
    BodyHtml: Details.length
      ? `<div class="text-muted small font-monospace">${Esc(Details.join(' · '))}</div>`
      : '',
  });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);
  const StatePill = !Reachable
    ? Pill('danger', 'Offline')
    : Degraded
      ? Pill('warning', 'Degraded')
      : Pill('success', 'Healthy');
  const Identity = SnmpIdentityLabel(Config);

  const Head = Rows([
    TextRow('Host', `${Config.Address || '-'}:${Config.Port}`),
    Row('SNMP', Mono(Identity)),
    Row('Status', StatePill),
    Reachable
      ? Row('Reply time', Mono(FormatLatency(Result.LatencyMs)))
      : TextRow('Error', (Result && Result.Error) || 'No SNMP reply'),
    Reachable && Result.DegradedReason ? TextRow('Reason', String(Result.DegradedReason)) : null,
    Reachable && Result.FrameName ? TextRow('Frame name', String(Result.FrameName)) : null,
    Reachable && Result.FrameProduct ? Row('Frame', Mono(Result.FrameProduct)) : null,
    Reachable && (Result.ControllerProduct || Result.ControllerFirmware)
      ? Row(
          'Controller',
          Mono([Result.ControllerProduct, Result.ControllerFirmware].filter(Boolean).join(' · '))
        )
      : null,
    Reachable && Result.SerialNumber ? Row('Serial', Mono(Result.SerialNumber)) : null,
    Reachable && Result.FanDoor != null
      ? Row(
          'Fan door',
          Mono(
            `${Result.FanDoor === 2 ? 'Open' : Result.FanDoor === 1 ? 'Closed' : String(Result.FanDoor)}${
              Result.FanSpeed != null ? ` · speed ${Result.FanSpeed}` : ''
            }`
          )
        )
      : null,
    Reachable && Result.AmbientTemp != null && Result.AmbientTemp !== 0
      ? Row('Intake', Mono(`${Result.AmbientTemp}°C`))
      : null,
    Reachable && Result.PowerW != null ? Row('Power', Mono(`${Result.PowerW} W`)) : null,
    Reachable && Result.ActionOnCardFault === 0
      ? Row('Card faults', Pill('warning', 'Ignored by the frame'))
      : null,
  ]);
  if (!Reachable) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(
        'Failed to read the frame over SNMP. SNMP is a licensed option on the frame controller and must be enabled in DashBoard.'
      ) +
      '</div>'
    );
  }

  const Blocks: string[] = [];
  const Psu1 = PsuSummary(1, Result.Psu1Status, Result.Psu1Model, Result.Psu1Temp);
  const Psu2 = PsuSummary(2, Result.Psu2Status, Result.Psu2Model, Result.Psu2Temp);
  if (Psu1) Blocks.push(Psu1);
  if (Psu2) Blocks.push(Psu2);

  const Monitored = new Set(ParseConditions((Target && Target.Settings) || {}).Slots);
  const Cards = Array.isArray(Result.Cards) ? (Result.Cards as CardRow[]) : null;
  if (Cards) {
    for (const Row of Cards) {
      const Badge =
        Row.Online === true
          ? Pill('success', 'Online')
          : Row.Online === false
            ? Pill('danger', 'Offline')
            : Pill('muted', 'Unknown');
      const Details = [Row.Supplier, Row.Software].filter(Boolean);
      Blocks.push(
        Card({
          Title: `Slot ${Row.Slot}: ${Row.Product || 'Unnamed card'}`,
          Badge,
          Highlight: Monitored.has(Row.Slot),
          BodyHtml: Details.length
            ? `<div class="text-muted small font-monospace">${Esc(Details.join(' · '))}</div>`
            : '',
        })
      );
    }
  }
  let Html = Head;
  if (Blocks.length) Html += `<div class="d-grid gap-1 mt-2">${Blocks.join('')}</div>`;
  if (Cards && !Cards.length)
    Html += `<div class="mt-2">${Note('The frame reports no cards.')}</div>`;
  if (Result.CardError) {
    Html += `<div class="mt-2">${Note(`Failed to read the card table: ${String(Result.CardError)}`)}</div>`;
  }
  return Html;
}

export const Name = 'openGear Frame (Ross)';
export const Description =
  'Reads a Ross openGear frame (OG3-FR, OGX-FR) over SNMP from its frame controller: frame and power supply faults, fans, intake temperature and the card in each slot.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = {
  ParseConfig,
  ParseConditions,
  FoldCardRows,
  EvaluateFrame,
  PsuFaults,
  PsuState,
  FRAME_OIDS,
};
export { ID, Settings, Run, Debug };
