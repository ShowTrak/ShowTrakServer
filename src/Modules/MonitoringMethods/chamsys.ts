// ChamSys MagicQ console health via the built-in web server.
//
// MagicQ (MQ50/70/250M, Compact, MagicQ PC/Mac, MagicQ Go) has an optional web
// server — disabled by default, enabled in Setup → Network Settings, default TCP
// 8080 — that serves system-information pages. We issue a single read-only
// GET / and confirm the response is actually a MagicQ web server (not just any
// service on the port), reporting a single online / offline verdict and, best
// effort, the software version parsed from the page.
//
// MagicQ's OSC surface is deliberately NOT used for probing: its TX/RX ports have
// no fixed default, there is no query/echo address, and a stray OSC message can
// activate a playback — so the web server is the safe read-only channel.
import { PerformHttpRequest } from './_http-shared';
import { Pill, Rows, TextRow, Row, Note, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'chamsys';

export const DEFAULT_CHAMSYS_PORT = 8080;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Web server port',
    Type: 'number',
    Default: DEFAULT_CHAMSYS_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'CheckVersion',
    Label: 'Check software version',
    Type: 'boolean',
    Default: false,
    Note: 'Enable to report Degraded when the console reports an unexpected software version.',
  },
  {
    Key: 'ExpectedVersion',
    Label: 'Expected software version prefix',
    Type: 'string',
    Default: '',
    VisibleWhen: { Key: 'CheckVersion', Equals: true },
    Note: 'Matches on a prefix, e.g. 1.9.',
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
];

// A MagicQ web page mentions MagicQ / ChamSys in its markup; a bare open port on
// 8080 (some other web service) will not. Exported for unit tests.
export function IsMagicQBody(Body: unknown): boolean {
  const Text = String(Body == null ? '' : Body);
  return /magicq|chamsys/i.test(Text);
}

// Best-effort software version scrape, e.g. "MagicQ v1.9.4.0" → "1.9.4.0".
export function ExtractMagicQVersion(Body: unknown): string | null {
  const Text = String(Body == null ? '' : Body);
  const Match =
    Text.match(/MagicQ[^0-9]{0,20}v?\s*([0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)/i) ||
    Text.match(/version[^0-9]{0,10}([0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
  return Match && Match[1] ? Match[1] : null;
}

interface ChamsysConfig {
  Address: string;
  Port: number;
  CheckVersion: boolean;
  ExpectedVersion: string;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): ChamsysConfig {
  const Cfg = (Target && Target.Settings) || {};
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Cfg.Port as number) ? (Cfg.Port as number) | 0 : DEFAULT_CHAMSYS_PORT,
    CheckVersion: !!Cfg.CheckVersion,
    ExpectedVersion: String(Cfg.ExpectedVersion || '').trim(),
    TimeoutMs: Number.isFinite(Cfg.Timeout as number) ? (Cfg.Timeout as number) : 4000,
  };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  if (!Config.Address) return { Success: false, Error: 'No address configured' };
  if (Config.Port < 1 || Config.Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Config.Port}` };
  }

  const Res = await PerformHttpRequest(
    {
      Address: Config.Address,
      Settings: {
        Port: Config.Port,
        Path: '/',
        Method: 'GET',
        Timeout: Config.TimeoutMs,
        ExpectedStatusMin: 100,
        ExpectedStatusMax: 599,
      },
    },
    { Protocol: 'http', DefaultPort: Config.Port, CaptureBody: true }
  );

  if (!Res.Success) {
    const ErrMsg = (Res.Error as string) || 'No response from the MagicQ web server';
    const Refused = ErrMsg.includes('ECONNREFUSED') || ErrMsg.includes('ECONNRESET');
    return {
      Success: false,
      ...(Refused ? { Degraded: true } : {}),
      Error: Refused ? `${ErrMsg} — is the MagicQ web server enabled?` : ErrMsg,
    };
  }

  const Status = Number(Res.Status);
  const Body = String(Res.Body || '');
  const Version = ExtractMagicQVersion(Body);

  // Any HTTP response means something is listening; decide health from content.
  if (!(Status >= 200 && Status < 300)) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: `Web server returned HTTP ${Status}`,
      LatencyMs: Res.LatencyMs,
      Status,
      MagicQVersion: Version,
    };
  }

  if (!IsMagicQBody(Body)) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'Responded, but does not look like a MagicQ web server',
      LatencyMs: Res.LatencyMs,
      Status,
      MagicQVersion: Version,
    };
  }

  if (Config.CheckVersion && Config.ExpectedVersion && Version && !Version.startsWith(Config.ExpectedVersion)) {
    return {
      Success: true,
      Degraded: true,
      DegradedReason: `Version ${Version} (expected ${Config.ExpectedVersion}…)`,
      LatencyMs: Res.LatencyMs,
      Status,
      MagicQVersion: Version,
    };
  }

  return {
    Success: true,
    LatencyMs: Res.LatencyMs,
    Status,
    MagicQVersion: Version,
  };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  const Reachable = !!(Result && Result.Success === true);
  const Degraded = !!(Result && Result.Degraded);

  const StatusPill = !Reachable
    ? Pill('danger', 'Offline')
    : Degraded
      ? Pill('warning', (Result && (Result.DegradedReason as string)) || 'Degraded')
      : Pill('success', 'Online');

  const ExtraRows: Array<string | false | null | undefined> = [];
  if (Reachable) {
    ExtraRows.push(TextRow('Software', String(Result.MagicQVersion || 'Unknown')));
    if (Config.CheckVersion && Config.ExpectedVersion) {
      ExtraRows.push(TextRow('Expected', `${Config.ExpectedVersion}…`));
    }
  }

  const Head = Rows([
    TextRow('Host', `${Config.Address || '—'}:${Config.Port}`),
    Row('Status', StatusPill),
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && (Result.Error as string)) || 'Could not reach the web server'),
    ...ExtraRows,
  ]);
  if (!Reachable) {
    return Head + '<div class="mt-2">' + Note('Could not reach the MagicQ web server') + '</div>';
  }
  return Head;
}

export const Name = 'ChamSys MagicQ';
export const Description =
  'Connects to a ChamSys MagicQ console (MQ series, MagicQ PC/Mac, MagicQ Go) over its built-in web server (HTTP, default TCP 8080) and confirms it responds as a MagicQ system, reading the software version where the page exposes it. Requires the MagicQ web server to be enabled (Setup → Network Settings).';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { IsMagicQBody, ExtractMagicQVersion, ParseConfig };
export { ID, Settings, Run, Debug };
