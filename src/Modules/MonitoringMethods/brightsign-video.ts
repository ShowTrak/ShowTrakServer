// BrightSign video output check. Reads a single HDMI output from the Local DWS
// /api/v1/video/hdmi/output/{device} endpoint and reports:
//   - the active resolution (e.g. "1920x1080x60p"), optionally asserted against
//     an expected mode;
//   - whether a display is actually detected;
//   - whether the video signal is unstable;
//   - whether the output is blanked for power save.
//
// `device` is 0-indexed, so dual-output players (HD/XT/XD) are outputs 0 and 1 —
// add one check per output. The connector is always hdmi; the player rejects
// anything else with a 400.
//
// Audio-only players have no video API at all and answer 404 here, which is
// surfaced as degraded (the check is misapplied) rather than offline.
import {
  CommonBrightSignSettings,
  RunBrightSignProbe,
  ParseBrightSignConfig,
  ReadVideoState,
  EvaluateVideo,
  SubResult,
  StatePill,
  BrightSignDebug,
  MonoRow,
  VideoPath,
} from './_brightsign-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'brightsign-video';

const Settings: MonitoringSettingField[] = [
  ...CommonBrightSignSettings,
  {
    Key: 'ExpectedMode',
    Label: 'Expected mode (e.g. 1920x1080x60p, blank = report only)',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'VideoOutput',
    Label: 'Video output index (0 = primary HDMI)',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 3,
  },
];

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Cfg = (Target && Target.Settings) || {};
  const Output = Cfg.VideoOutput;

  const Probe = await RunBrightSignProbe(Target, VideoPath(Output), {
    NotFoundResult: {
      Success: true,
      Degraded: true,
      DegradedReason: 'Player does not support the video API (audio-only, or no such output)',
    },
  });
  if ('Result' in Probe) return Probe.Result;
  const { Payload, LatencyMs } = Probe.Ctx;

  const State = ReadVideoState(Payload);
  const Best = SubResult(Payload, 'bestMode');
  const Expected = String(Cfg.ExpectedMode ?? '').trim();

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs,
    VideoOutput: Number.isFinite(Number(Output)) ? Number(Output) | 0 : 0,
    ActiveMode: State.ActiveMode,
    BestMode: Best.Value == null ? null : String(Best.Value),
    OutputPresent: State.OutputPresent,
    Unstable: State.Unstable,
    PowerSave: State.PowerSave,
    Expected: Expected || null,
  };

  const Reasons = EvaluateVideo(State, Expected);
  // Sub-objects can independently fail while the endpoint still returns 200.
  // Surface that rather than silently reporting a healthy output.
  if (!State.ActiveMode && State.Errors.length) {
    Reasons.push(`Video not reported: ${State.Errors[0]}`);
  }

  if (Reasons.length) {
    return { ...Base, Degraded: true, DegradedReason: Reasons.join('; ') };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseBrightSignConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Pill = StatePill(Result, 'Output OK');

  const YesNo = (Value: unknown): string => (Value == null ? '—' : Value ? 'Yes' : 'No');

  return BrightSignDebug(Config, Result, Pill, [
    Reachable ? MonoRow('Output', `hdmi:${Result.VideoOutput ?? 0}`) : null,
    Reachable ? MonoRow('Active mode', Result.ActiveMode || '—') : null,
    Reachable && Result.Expected ? MonoRow('Expected mode', Result.Expected) : null,
    Reachable && Result.BestMode ? MonoRow('Display best mode', Result.BestMode) : null,
    Reachable ? MonoRow('Display detected', YesNo(Result.OutputPresent)) : null,
    Reachable && Result.Unstable != null ? MonoRow('Signal unstable', YesNo(Result.Unstable)) : null,
    Reachable && Result.PowerSave != null ? MonoRow('Power save', YesNo(Result.PowerSave)) : null,
  ]);
}

export const Name = 'Player Video Output (BrightSign)';
export const Description =
  "Reads an HDMI output from a BrightSign player's Local DWS API and reports the active resolution, whether a display is detected, and whether the signal is stable.";
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
