// Projector health over PJLink: one connection reads power state, error status
// (ERST), lamp hours and active input. Reachability and protocol-level device
// failures (ERR3 busy / ERR4 failure) are always evaluated; the power-state,
// error-status, lamp-hours and input factors are opt-in via their toggles (all
// off by default), so a fresh check is a plain reachability probe until you
// enable the readings you care about. Protocol client, snapshot cache and shared
// semantics live in ./_pjlink-shared.
import {
  CommonPJLinkSettings,
  ParsePJLinkConfig,
  RunPJLinkProbe,
  SnapshotExtras,
  ErstReasons,
  PowerLabel,
  NormalizeInputCode,
  InputLabel,
  PJLinkStatePill,
  PJLinkDebugHead,
  MonoRow,
  type ErstStatus,
  type LampReading,
  type PJLinkSnapshot,
} from './_pjlink-shared';
import { Pill, Row, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'pjlink';

const Settings: MonitoringSettingField[] = [
  ...CommonPJLinkSettings,
  {
    Key: 'CheckPower',
    Label: 'Check power state',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the projector is not in the expected power state.',
  },
  {
    Key: 'ExpectedPower',
    Label: 'Expected power state',
    Type: 'select',
    Default: 'on-or-warmup',
    Options: [
      { value: 'on', label: 'On' },
      { value: 'on-or-warmup', label: 'On or warming up' },
      { value: 'any', label: 'Any (just reachable)' },
    ],
    VisibleWhen: { Key: 'CheckPower', Equals: true },
    Note: 'Standby and cooling report Degraded unless set to Any.',
  },
  {
    Key: 'CheckErrors',
    Label: 'Check error status',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded on the PJLink error status (fan, lamp, temperature, cover, filter, other).',
  },
  {
    Key: 'WarningsDegrade',
    Label: 'Treat warnings as Degraded',
    Type: 'boolean',
    Default: false,
    VisibleWhen: { Key: 'CheckErrors', Equals: true },
    Note: 'When off, only errors degrade. When on, warnings such as a dirty filter degrade too.',
  },
  {
    Key: 'CheckLamp',
    Label: 'Check lamp hours',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when a lamp reaches the warning threshold. Laser models without lamps are handled automatically.',
  },
  {
    Key: 'LampWarnHours',
    Label: 'Lamp hours warning threshold',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 100000,
    VisibleWhen: { Key: 'CheckLamp', Equals: true },
    Note: "Degraded once any lamp reaches this many hours. Set to the lamp's rated life.",
  },
  {
    Key: 'CheckInput',
    Label: 'Check active input',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the active input is not the expected one (only while the projector is on).',
  },
  {
    Key: 'ExpectedInput',
    Label: 'Expected input code',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckInput', Equals: true },
    Note: 'Two characters: source type (1 RGB, 2 Video, 3 Digital, 4 Storage, 5 Network) + input number, e.g. 31.',
  },
];

interface HealthOptions {
  CheckPower: boolean;
  ExpectedPower: 'on' | 'on-or-warmup' | 'any';
  CheckErrors: boolean;
  WarningsDegrade: boolean;
  CheckLamp: boolean;
  LampWarnHours: number;
  CheckInput: boolean;
  ExpectedInput: string;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const WarnHours = Number(Cfg.LampWarnHours);
  const ExpectedPower = String(Cfg.ExpectedPower);
  return {
    CheckPower: !!Cfg.CheckPower,
    ExpectedPower: ExpectedPower === 'on' || ExpectedPower === 'any' ? ExpectedPower : 'on-or-warmup',
    CheckErrors: !!Cfg.CheckErrors,
    WarningsDegrade: !!Cfg.WarningsDegrade,
    CheckLamp: !!Cfg.CheckLamp,
    LampWarnHours: Number.isFinite(WarnHours) ? Math.max(0, WarnHours | 0) : 0,
    CheckInput: !!Cfg.CheckInput,
    ExpectedInput: NormalizeInputCode(Cfg.ExpectedInput),
  };
}

// All the reasons a reachable projector is unhealthy. Reachability-level device
// failures are always reported; every other factor is gated by its toggle. Pure
// — exported via _internal for unit tests.
function EvaluateHealth(Snapshot: PJLinkSnapshot, Options: HealthOptions): string[] {
  const Reasons: string[] = [];

  if (Snapshot.PowerErr === 'ERR3') Reasons.push('Projector busy (ERR3)');
  // ERR4 anywhere means device failure — report it once.
  if (
    Snapshot.PowerErr === 'ERR4' ||
    Snapshot.ErstErr === 'ERR4' ||
    Snapshot.LampErr === 'ERR4' ||
    Snapshot.InputErr === 'ERR4'
  ) {
    Reasons.push('Projector failure (ERR4)');
  }

  // Power state (opt-in). 'any' means reachable is enough; 'on' accepts only On;
  // 'on-or-warmup' also accepts warm-up — so standby and cooling degrade.
  if (Options.CheckPower && Options.ExpectedPower !== 'any' && Snapshot.Power != null) {
    const Accepted = Options.ExpectedPower === 'on' ? [1] : [1, 3];
    if (!Accepted.includes(Snapshot.Power)) {
      Reasons.push(`Power: ${PowerLabel(Snapshot.Power)} (expected On)`);
    }
  }

  // ERST errors degrade; warnings only when configured. ERR1/ERR3 on ERST
  // (unsupported / busy) are ignored.
  if (Options.CheckErrors && Snapshot.Erst) {
    Reasons.push(...ErstReasons(Snapshot.Erst, Options.WarningsDegrade));
  }

  if (Options.CheckLamp && Options.LampWarnHours > 0 && Array.isArray(Snapshot.Lamps)) {
    Snapshot.Lamps.forEach((Lamp, Index) => {
      if (Lamp.Hours >= Options.LampWarnHours) {
        Reasons.push(`Lamp ${Index + 1}: ${Lamp.Hours} h ≥ ${Options.LampWarnHours} h`);
      }
    });
  }

  // Input is only meaningful while the projector is on.
  if (
    Options.CheckInput &&
    Options.ExpectedInput &&
    Snapshot.Power === 1 &&
    Snapshot.Input &&
    Snapshot.Input !== Options.ExpectedInput
  ) {
    Reasons.push(`Input ${Snapshot.Input} (expected ${Options.ExpectedInput})`);
  }

  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunPJLinkProbe(Target);
  if ('Result' in Probe) return Probe.Result;

  const { Snapshot } = Probe.Ctx;
  const Reasons = EvaluateHealth(Snapshot, ParseHealthOptions(Target));

  return {
    Success: true,
    ...(Reasons.length ? { Degraded: true, DegradedReason: Reasons.join('; ') } : {}),
    LatencyMs: Snapshot.LatencyMs,
    ...SnapshotExtras(Snapshot),
    Erst: Snapshot.Erst,
    Lamps: Snapshot.Lamps,
    Input: Snapshot.Input,
    Mute: Snapshot.Mute,
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParsePJLinkConfig(Target);
  const Options = ParseHealthOptions(Target);
  const Reachable = !!(Result && Result.Success === true);

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    ExtraRows.push(TextRow('Power', String(Result.PowerLabel || PowerLabel(null))));

    const Erst = Result.Erst && typeof Result.Erst === 'object' ? (Result.Erst as ErstStatus) : null;
    if (Erst) {
      const ErrorReasons = ErstReasons(Erst, true);
      ExtraRows.push(
        Row(
          'Error status',
          ErrorReasons.length ? Pill('warning', ErrorReasons.join(', ')) : Pill('success', 'No errors')
        )
      );
    }

    const Lamps = Array.isArray(Result.Lamps) ? (Result.Lamps as LampReading[]) : null;
    if (Lamps && Lamps.length) {
      ExtraRows.push(
        MonoRow(
          Lamps.length === 1 ? 'Lamp hours' : 'Lamp hours (per lamp)',
          Lamps.map((Lamp) => `${Lamp.Hours} h${Lamp.On ? '' : ' (off)'}`).join(' · ')
        )
      );
    } else if (Lamps) {
      ExtraRows.push(TextRow('Lamp', 'No lamp reported — laser light source?'));
    }

    if (Result.Input != null && Result.Input !== '') {
      const Wanted = Options.ExpectedInput ? ` (expected ${InputLabel(Options.ExpectedInput)})` : '';
      ExtraRows.push(TextRow('Input', `${InputLabel(Result.Input)}${Wanted}`));
    }
    if (Result.Class != null && Result.Class !== '') {
      ExtraRows.push(TextRow('PJLink class', String(Result.Class)));
    }
  }

  return PJLinkDebugHead(Config, Result, PJLinkStatePill(Result, 'Healthy'), ExtraRows);
}

export const Name = 'Projector Health (PJLink)';
export const Description =
  'Connects to the projector over PJLink (the cross-brand projector protocol, TCP 4352) and reads power state, error status, lamp hours and input in one pass, reporting a single healthy / degraded verdict. Works with Epson, NEC/Sharp, Panasonic, Christie, Sony, Barco and most other network projectors.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseHealthOptions, EvaluateHealth };
export { ID, Settings, Run, Debug };
