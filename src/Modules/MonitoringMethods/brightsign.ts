// BrightSign combined player health check. Reads the useful fields from the
// Local DWS /api/v1/info endpoint in one request and reports a single healthy /
// degraded verdict. This is the "just tell me if the player is OK" method; the
// sibling brightsign-firmware / -power / -poe / -video methods isolate a single
// factor when you want to alert or threshold on just one.
//
// Factors evaluated (unreported fields are skipped, never failed):
//   - FWVersion      : must equal Expected firmware, when one is configured.
//   - power          : degraded when running on / discharging a battery.
//   - video          : optionally polled (second request), degraded when no
//                      display is detected, the signal is unstable, or the
//                      output is blanked for power save.
//
// Result semantics:
//   - No connection / auth failure / not a player -> offline  (Success: false)
//   - any factor breached                         -> degraded (combined reason)
//   - all evaluated factors within limits         -> online   (Success: true)
//
// Uptime is reported in the debug panel for context but is never alerted on:
// judging it would require comparing against the previous poll, and methods are
// deliberately stateless.
import {
  CommonBrightSignSettings,
  RunBrightSignProbe,
  ParseBrightSignConfig,
  FetchDws,
  VideoPath,
  HasVideoApi,
  ReadPower,
  ClassifyPower,
  ReadVideoState,
  EvaluateVideo,
  SubResult,
  FormatUptime,
  StatePill,
  BrightSignDebug,
  MonoRow,
  INFO_PATH,
  type VideoState,
} from './_brightsign-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'brightsign';

const Settings: MonitoringSettingField[] = [
  ...CommonBrightSignSettings,
  {
    Key: 'ExpectedFirmware',
    Label: 'Expected firmware (blank = any)',
    Type: 'string',
    Default: '',
    Advanced: true,
  },
  {
    Key: 'IncludeVideo',
    Label: 'Check video output',
    Type: 'boolean',
    Default: false,
  },
  {
    Key: 'VideoOutput',
    Label: 'Video output index (0 = primary HDMI)',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 3,
    Advanced: true,
  },
];

export interface HealthReadings {
  Firmware?: string | null;
  PowerSource?: string | null;
  Battery?: string | null;
  Video?: VideoState | null;
}

// Evaluate the readings and return the list of failing factors (empty when
// healthy). Exported for unit tests.
export function EvaluateHealth(Readings: HealthReadings, ExpectedFirmware: unknown): string[] {
  const Reasons: string[] = [];

  const Want = String(ExpectedFirmware ?? '').trim();
  if (Want && Readings.Firmware && Readings.Firmware !== Want) {
    Reasons.push(`Firmware ${Readings.Firmware} (expected ${Want})`);
  }

  const Power = ClassifyPower(Readings.PowerSource, Readings.Battery);
  if (Power.Degraded && Power.Reason) Reasons.push(Power.Reason);

  if (Readings.Video) {
    // The expected-mode assertion belongs to the dedicated video method; here we
    // only care whether the output is actually working.
    Reasons.push(...EvaluateVideo(Readings.Video, ''));
  }

  return Reasons;
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Probe = await RunBrightSignProbe(Target, INFO_PATH);
  if ('Result' in Probe) return Probe.Result;
  const { Config, Payload, LatencyMs } = Probe.Ctx;

  const Info = (Payload || {}) as Record<string, unknown>;
  const Str = (Key: string): string | null => (Info[Key] == null ? null : String(Info[Key]));
  const Power = ReadPower(Payload);
  const Poe = SubResult(Payload, 'poe');
  const PoeStatus =
    Poe.Value && typeof Poe.Value === 'object'
      ? String((Poe.Value as Record<string, unknown>).status ?? '')
      : null;

  const Cfg = (Target && Target.Settings) || {};
  const VideoSupported = HasVideoApi(Payload);
  let Video: VideoState | null = null;
  let VideoError: string | null = null;

  // Second request, only when asked for — and skipped outright on audio-only
  // players, where the video endpoints do not exist at all.
  if (Cfg.IncludeVideo && VideoSupported) {
    const VideoRes = await FetchDws(Config, VideoPath(Cfg.VideoOutput));
    if (VideoRes.Ok) Video = ReadVideoState(VideoRes.Payload);
    else VideoError = VideoRes.Error || 'Video request failed';
  }

  const Readings: HealthReadings = {
    Firmware: Str('FWVersion'),
    PowerSource: Power.Source,
    Battery: Power.Battery,
    Video,
  };

  const Reasons = EvaluateHealth(Readings, Cfg.ExpectedFirmware);
  if (VideoError) Reasons.push(`Video: ${VideoError}`);

  const Base: MonitoringResult = {
    Success: true,
    LatencyMs,
    Firmware: Readings.Firmware,
    BootVersion: Str('bootVersion'),
    Model: Str('model'),
    Serial: Str('serial'),
    Family: Str('family'),
    UptimeSeconds: Number.isFinite(Number(Info.upTimeSeconds)) ? Number(Info.upTimeSeconds) : null,
    PowerSource: Power.Source,
    Battery: Power.Battery,
    PoeStatus,
    HasVideoApi: VideoSupported,
    VideoMode: Video ? Video.ActiveMode : null,
    OutputPresent: Video ? Video.OutputPresent : null,
  };

  if (Reasons.length) {
    return { ...Base, Degraded: true, DegradedReason: Reasons.join('; ') };
  }
  return Base;
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseBrightSignConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Pill = StatePill(Result, 'Healthy');

  return BrightSignDebug(Config, Result, Pill, [
    Reachable && Result.Model ? MonoRow('Model', `${Result.Model}${Result.Family ? ` (${Result.Family})` : ''}`) : null,
    Reachable && Result.Serial ? MonoRow('Serial', Result.Serial) : null,
    Reachable && Result.Firmware ? MonoRow('Firmware', Result.Firmware) : null,
    Reachable && Result.UptimeSeconds != null
      ? MonoRow('Uptime', FormatUptime(Result.UptimeSeconds))
      : null,
    Reachable && Result.PowerSource
      ? MonoRow(
          'Power',
          `${Result.PowerSource}${Result.Battery ? ` (battery: ${Result.Battery})` : ''}`
        )
      : null,
    Reachable && Result.PoeStatus ? MonoRow('PoE', Result.PoeStatus) : null,
    Reachable && Result.VideoMode ? MonoRow('Video mode', Result.VideoMode) : null,
  ]);
}

export const Name = 'Player Health (BrightSign)';
export const Description =
  'Reads firmware, power, PoE and uptime from a BrightSign player\'s Local DWS API and reports a single healthy / degraded verdict. Can optionally also check the video output.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { EvaluateHealth };
export { ID, Settings, Run, Debug };
