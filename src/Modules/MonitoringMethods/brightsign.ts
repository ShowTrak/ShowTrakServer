// BrightSign player health check. Reads the useful fields from the Local DWS
// /api/v1/info endpoint (plus an optional second request for video) and reports a
// single healthy / degraded verdict. Reachability is always checked; the firmware,
// power, PoE, and video factors are opt-in via their toggles (all off by default),
// so a fresh check is a plain "can I reach the player" probe until you enable the
// readings you care about.
//
// Factors (each gated by its toggle; unreported fields are skipped, never failed):
//   - FWVersion  : must equal Expected firmware.                         [CheckFirmware]
//   - power      : degraded on/discharging a battery, or off the         [CheckPower]
//                  expected source.
//   - poe        : degraded when not supported, or not the expected      [CheckPoe]
//                  status. Enable only on PoE-capable players.
//   - video      : second request; degraded when no display is           [IncludeVideo]
//                  detected, unstable, blanked, or not the expected mode.
//
// Result semantics:
//   - No connection / auth failure / not a player -> offline  (Success: false)
//   - any enabled factor breached                 -> degraded (combined reason)
//   - all enabled factors within limits           -> online   (Success: true)
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
    Key: 'CheckFirmware',
    Label: 'Check firmware version',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the running firmware differs from the expected version.',
  },
  {
    Key: 'ExpectedFirmware',
    Label: 'Expected firmware',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckFirmware', Equals: true },
    Note: 'Enter the version as the player reports it, e.g. 8.5.33.',
  },
  {
    Key: 'CheckPower',
    Label: 'Check power source',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the player runs on or discharges a battery, or leaves the expected source.',
  },
  {
    Key: 'ExpectedSource',
    Label: 'Expected power source',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckPower', Equals: true },
    Note: 'e.g. AC. Leave blank to alert only on battery use.',
  },
  {
    Key: 'CheckPoe',
    Label: 'Check PoE status',
    Type: 'boolean',
    Default: false,
    Note: 'Enable only on PoE-capable players. Degraded when PoE is not supported or not the expected status.',
  },
  {
    Key: 'ExpectedPoeStatus',
    Label: 'Expected PoE status',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckPoe', Equals: true },
    Note: "Leave blank to accept any status other than 'not_supported'.",
  },
  {
    Key: 'IncludeVideo',
    Label: 'Check video output',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to poll an HDMI output (a second request per interval); skipped automatically on audio-only players.',
  },
  {
    Key: 'VideoOutput',
    Label: 'Video output index',
    Type: 'number',
    Default: 0,
    Min: 0,
    Max: 3,
    VisibleWhen: { Key: 'IncludeVideo', Equals: true },
    Note: '0 = primary HDMI. Dual-output players use 0 and 1.',
  },
  {
    Key: 'ExpectedMode',
    Label: 'Expected video mode',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'IncludeVideo', Equals: true },
    Note: 'e.g. 1920x1080x60p. Leave blank to report the active mode without alerting.',
  },
];

export interface HealthReadings {
  Firmware?: string | null;
  PowerSource?: string | null;
  Battery?: string | null;
  PoeStatus?: string | null;
  Video?: VideoState | null;
}

// Evaluate the readings against the per-factor toggles in Cfg and return the list
// of failing factors (empty when healthy). Each factor is only judged when its
// toggle is enabled. Exported for unit tests.
export function EvaluateHealth(Readings: HealthReadings, Cfg: Record<string, unknown>): string[] {
  const Reasons: string[] = [];

  if (Cfg.CheckFirmware) {
    const Want = String(Cfg.ExpectedFirmware ?? '').trim();
    if (Want && Readings.Firmware && Readings.Firmware !== Want) {
      Reasons.push(`Firmware ${Readings.Firmware} (expected ${Want})`);
    }
  }

  if (Cfg.CheckPower) {
    const Power = ClassifyPower(Readings.PowerSource, Readings.Battery);
    if (Power.Degraded && Power.Reason) Reasons.push(Power.Reason);
    const WantSource = String(Cfg.ExpectedSource ?? '').trim();
    if (
      WantSource &&
      Readings.PowerSource &&
      Readings.PowerSource.toLowerCase() !== WantSource.toLowerCase()
    ) {
      Reasons.push(`Source ${Readings.PowerSource} (expected ${WantSource})`);
    }
  }

  if (Cfg.CheckPoe) {
    const Status = Readings.PoeStatus;
    const WantPoe = String(Cfg.ExpectedPoeStatus ?? '').trim();
    if (!Status) {
      Reasons.push('Player did not report a PoE status');
    } else if (Status.toLowerCase() === 'not_supported') {
      Reasons.push('PoE not supported on this player');
    } else if (WantPoe && Status.toLowerCase() !== WantPoe.toLowerCase()) {
      Reasons.push(`PoE ${Status} (expected ${WantPoe})`);
    }
  }

  if (Readings.Video) {
    Reasons.push(...EvaluateVideo(Readings.Video, String(Cfg.ExpectedMode ?? '').trim()));
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
    PoeStatus,
    Video,
  };

  const Reasons = EvaluateHealth(Readings, Cfg);
  // A video request that was asked for but failed is only surfaced when the video
  // factor is actually enabled.
  if (VideoError && Cfg.IncludeVideo) Reasons.push(`Video: ${VideoError}`);

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
