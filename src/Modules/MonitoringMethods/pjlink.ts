// Projector health over PJLink: one connection reads power state, error status
// (ERST), lamp hours and active input. Reachability and protocol-level device
// failures (ERR3 busy / ERR4 failure) are always evaluated; the power-state,
// error-status, lamp-hours and input factors are opt-in via their toggles (all
// off by default), so a fresh check is a plain reachability probe until you
// enable the readings you care about. Protocol client, snapshot cache and shared
// semantics live in ./_pjlink-shared.
//
// The same check also carries the projector's CONTROL surface (see Actions
// below) — power, shutter, input and the Class 2 extras — so a projector you can
// see the state of is a projector you can drive, from the same tile.
import {
  CommonPJLinkSettings,
  ParsePJLinkConfig,
  RunPJLinkProbe,
  SnapshotExtras,
  ErstReasons,
  PowerLabel,
  NormalizeInputCode,
  InputLabel,
  InvalidateProjectorSnapshot,
  SendProjectorCommand,
  PJLinkStatePill,
  PJLinkDebugHead,
  MonoRow,
  type ErstStatus,
  type LampReading,
  type PJLinkSnapshot,
} from './_pjlink-shared';
import { Pill, Row, TextRow } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

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
    ExpectedPower:
      ExpectedPower === 'on' || ExpectedPower === 'any' ? ExpectedPower : 'on-or-warmup',
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

// --- Controllable actions ----------------------------------------------------
//
// The complete set of PJLink SET commands: POWR (power), INPT (input select) and
// AVMT (the A/V mute that a projectionist calls the shutter) are Class 1 and
// every device answers them. FREZ (freeze) and SVOL (speaker volume) are Class 2
// — they are offered anyway because a Class 1 projector answers them ERR1, which
// surfaces as "the projector does not support this command", so the device's own
// refusal is the capability gate rather than a CLSS round trip before every
// press. Mic volume (MVOL) is deliberately absent: it is Class 2, vanishingly
// rare on a projector, and every extra button is one more thing to mis-click
// beside Power Off.
//
// AVMT is a two-digit code: first digit 1 video / 2 audio / 3 both, second digit
// 1 mute-on / 0 mute-off. "Shutter" is the both-channels pair, which is what an
// operator means by the word; the single-channel pairs are offered separately
// for the rig that needs one without the other.

const ACTION_COMMANDS: Record<
  string,
  { Command: string; Param: string; Class: 1 | 2; Detail: string }
> = {
  'power.on': { Command: 'POWR', Param: '1', Class: 1, Detail: 'Power on sent' },
  'power.off': { Command: 'POWR', Param: '0', Class: 1, Detail: 'Power off sent' },
  'shutter.close': { Command: 'AVMT', Param: '31', Class: 1, Detail: 'Shutter closed' },
  'shutter.open': { Command: 'AVMT', Param: '30', Class: 1, Detail: 'Shutter opened' },
  'video.mute.on': { Command: 'AVMT', Param: '11', Class: 1, Detail: 'Video muted' },
  'video.mute.off': { Command: 'AVMT', Param: '10', Class: 1, Detail: 'Video unmuted' },
  'audio.mute.on': { Command: 'AVMT', Param: '21', Class: 1, Detail: 'Audio muted' },
  'audio.mute.off': { Command: 'AVMT', Param: '20', Class: 1, Detail: 'Audio unmuted' },
  // Param is replaced with the requested code by RunAction.
  'input.set': { Command: 'INPT', Param: '', Class: 1, Detail: 'Input switched' },
  'image.freeze': { Command: 'FREZ', Param: '1', Class: 2, Detail: 'Image frozen' },
  'image.unfreeze': { Command: 'FREZ', Param: '0', Class: 2, Detail: 'Image unfrozen' },
  'volume.up': { Command: 'SVOL', Param: '1', Class: 2, Detail: 'Volume up sent' },
  'volume.down': { Command: 'SVOL', Param: '0', Class: 2, Detail: 'Volume down sent' },
};

const CLASS_2_NOTE =
  'PJLink Class 2. A Class 1 projector reports this as unsupported rather than acting on it.';

const Actions: MonitoringActionDef[] = [
  {
    ID: 'power.on',
    Label: 'Power On',
    Icon: 'power',
    Group: 'Power',
    Note: 'A projector already warming up or cooling down refuses this until it settles.',
  },
  {
    ID: 'power.off',
    Label: 'Power Off',
    Icon: 'power',
    Group: 'Power',
    Destructive: true,
    Note: 'Starts the cool-down cycle. Most projectors refuse to power on again until it finishes.',
  },
  {
    ID: 'shutter.close',
    Label: 'Close Shutter',
    Icon: 'eye-slash-fill',
    Group: 'Shutter',
    Note: 'A/V mute on — blanks picture and sound without powering down.',
  },
  {
    ID: 'shutter.open',
    Label: 'Open Shutter',
    Icon: 'eye-fill',
    Group: 'Shutter',
    Note: 'A/V mute off.',
  },
  {
    ID: 'video.mute.on',
    Label: 'Blank Picture',
    Icon: 'camera-video-off',
    Group: 'Shutter',
    Note: 'Mutes video only, leaving audio running.',
  },
  {
    ID: 'video.mute.off',
    Label: 'Restore Picture',
    Icon: 'camera-video',
    Group: 'Shutter',
  },
  {
    ID: 'input.set',
    Label: 'Set Input',
    Icon: 'box-arrow-in-right',
    Group: 'Input',
    Params: [
      {
        Key: 'Input',
        Label: 'Input',
        Type: 'string',
        Default: '',
        Required: true,
        Note: 'Two characters: source type (1 RGB, 2 Video, 3 Digital, 4 Storage, 5 Network, 6 Internal) + input number, e.g. 31 for Digital 1. The check lists the inputs this projector reports.',
      },
    ],
  },
  {
    ID: 'audio.mute.on',
    Label: 'Mute Audio',
    Icon: 'volume-mute',
    Group: 'Audio',
  },
  {
    ID: 'audio.mute.off',
    Label: 'Unmute Audio',
    Icon: 'volume-up',
    Group: 'Audio',
  },
  {
    ID: 'volume.up',
    Label: 'Volume Up',
    Icon: 'volume-up-fill',
    Group: 'Audio',
    Note: `One step per press. ${CLASS_2_NOTE}`,
  },
  {
    ID: 'volume.down',
    Label: 'Volume Down',
    Icon: 'volume-down-fill',
    Group: 'Audio',
    Note: `One step per press. ${CLASS_2_NOTE}`,
  },
  {
    ID: 'image.freeze',
    Label: 'Freeze Image',
    Icon: 'pause-circle',
    Group: 'Image',
    Note: CLASS_2_NOTE,
  },
  {
    ID: 'image.unfreeze',
    Label: 'Unfreeze Image',
    Icon: 'play-circle',
    Group: 'Image',
    Note: CLASS_2_NOTE,
  },
];

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Config = ParsePJLinkConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }

  const Spec = ACTION_COMMANDS[ActionID];
  if (!Spec) return { Success: false, Error: `Unknown PJLink action "${ActionID}"` };

  let Param = Spec.Param;
  let Detail = Spec.Detail;
  if (ActionID === 'input.set') {
    // Validate here rather than trusting the schema: INPT is the one action
    // whose parameter comes from the operator, and a malformed code would
    // otherwise reach the projector as a bare ERR2 with nothing to explain it.
    // Source type 1-6 then the switch number. Class 2 allows an alphabetic
    // switch (1-9, A-Z), so only the FIRST character is constrained to the
    // defined source types — which is what rules out junk like "ZZ".
    const Code = NormalizeInputCode(Params.Input);
    if (!/^[1-6][0-9A-Z]$/.test(Code)) {
      return {
        Success: false,
        Error: 'Input must be a PJLink code: source type 1-6 then the input number, e.g. 31',
      };
    }
    Param = Code;
    Detail = `Input set to ${InputLabel(Code)}`;
  }

  const Outcome = await SendProjectorCommand(
    Config.Address,
    Config.Port,
    Config.Password,
    Config.TimeoutMs,
    Spec.Command,
    Param,
    Spec.Class
  );
  if (!Outcome.Success) {
    return { Success: false, Error: Outcome.Error || 'The projector did not accept the command' };
  }
  return { Success: true, Detail };
}

// Offer the input sources the projector itself listed (INST) as the choices for
// Set Input, so the operator picks "Digital 1" from this device's own menu
// instead of looking a two-character code up in the manual.
function GetActionOptions(Result: MonitoringResult): MonitoringActionOptions {
  const Inputs = Array.isArray(Result && Result.Inputs) ? (Result.Inputs as string[]) : null;
  if (!Inputs || !Inputs.length) return {};
  return {
    Input: Inputs.map((Code) => ({ value: Code, label: `${InputLabel(Code)} (${Code})` })),
  };
}

// Bind an action's parameters into its label so a starred "Set Input" says which
// input it will select. Everything else has no parameters, so its plain label
// already says all there is to say.
function DescribeAction(ActionID: string, Params: Record<string, unknown>): string | null {
  if (ActionID !== 'input.set') return null;
  const Code = NormalizeInputCode(Params.Input);
  if (!Code) return null;
  return `Set Input — ${InputLabel(Code)} (${Code})`;
}

// A control command has just changed the projector's power/input/mute state, so
// the cached snapshot — up to 1.5s old — now describes the state it replaced.
function InvalidateCaches(Target: MonitoringTargetLike): void {
  InvalidateProjectorSnapshot(ParsePJLinkConfig(Target));
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
    Inputs: Snapshot.Inputs,
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

    const Erst =
      Result.Erst && typeof Result.Erst === 'object' ? (Result.Erst as ErstStatus) : null;
    if (Erst) {
      const ErrorReasons = ErstReasons(Erst, true);
      ExtraRows.push(
        Row(
          'Error status',
          ErrorReasons.length
            ? Pill('warning', ErrorReasons.join(', '))
            : Pill('success', 'No errors')
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
      const Wanted = Options.ExpectedInput
        ? ` (expected ${InputLabel(Options.ExpectedInput)})`
        : '';
      ExtraRows.push(TextRow('Input', `${InputLabel(Result.Input)}${Wanted}`));
    }
    const Inputs = Array.isArray(Result.Inputs) ? (Result.Inputs as string[]) : null;
    if (Inputs && Inputs.length) {
      ExtraRows.push(
        MonoRow(
          'Available inputs',
          Inputs.map((Code) => `${InputLabel(Code)} (${Code})`).join(' · ')
        )
      );
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
export const _internal = { ParseHealthOptions, EvaluateHealth, ACTION_COMMANDS };
export {
  ID,
  Settings,
  Actions,
  Run,
  RunAction,
  GetActionOptions,
  DescribeAction,
  InvalidateCaches,
  Debug,
};
