// Combined projector health over PJLink: one connection reads power state,
// error status (ERST), lamp hours and active input, and reports a single
// healthy / degraded verdict. Protocol client, snapshot cache and shared
// semantics live in ./_pjlink-shared — this file only judges the combined
// result and renders its debug panel.
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
    Key: 'TreatStandbyAs',
    Label: 'When in standby / cooling',
    Type: 'select',
    Default: 'degraded',
    Options: [
      { value: 'degraded', label: 'Report Degraded' },
      { value: 'ok', label: 'Report Online' },
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
    Key: 'WarningsDegrade',
    Label: 'Treat warnings as Degraded',
    Type: 'boolean',
    Default: false,
    Advanced: true,
  },
  {
    Key: 'ExpectedInput',
    Label: 'Expected input code (blank = any, e.g. 31)',
    Type: 'string',
    Default: '',
    Advanced: true,
  },
];

interface HealthOptions {
  TreatStandbyAs: 'degraded' | 'ok';
  LampWarnHours: number;
  WarningsDegrade: boolean;
  ExpectedInput: string;
}

function ParseHealthOptions(Target: MonitoringTargetLike): HealthOptions {
  const Cfg = (Target && Target.Settings) || {};
  const WarnHours = Number(Cfg.LampWarnHours);
  return {
    TreatStandbyAs: String(Cfg.TreatStandbyAs) === 'ok' ? 'ok' : 'degraded',
    LampWarnHours: Number.isFinite(WarnHours) ? Math.max(0, WarnHours | 0) : 0,
    WarningsDegrade: !!Cfg.WarningsDegrade,
    ExpectedInput: NormalizeInputCode(Cfg.ExpectedInput),
  };
}

// All the reasons a reachable projector is unhealthy, per the combined-health
// semantics. Pure — exported via _internal for unit tests.
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

  if (
    Options.TreatStandbyAs === 'degraded' &&
    (Snapshot.Power === 0 || Snapshot.Power === 2)
  ) {
    Reasons.push(Snapshot.Power === 0 ? 'In standby' : 'Cooling down');
  }

  // ERST errors always degrade; warnings only when configured. ERR1/ERR3 on
  // ERST (unsupported / busy) are ignored here.
  if (Snapshot.Erst) {
    Reasons.push(...ErstReasons(Snapshot.Erst, Options.WarningsDegrade));
  }

  if (Options.LampWarnHours > 0 && Array.isArray(Snapshot.Lamps)) {
    Snapshot.Lamps.forEach((Lamp, Index) => {
      if (Lamp.Hours >= Options.LampWarnHours) {
        Reasons.push(`Lamp ${Index + 1}: ${Lamp.Hours} h ≥ ${Options.LampWarnHours} h`);
      }
    });
  }

  // Input is only meaningful while the projector is on.
  if (
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
