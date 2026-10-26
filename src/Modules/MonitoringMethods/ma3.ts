// MA Lighting grandMA3 console liveness.
//
// grandMA3 deliberately exposes almost no read-only network status: it removed
// the grandMA2 telnet command server entirely, its OSC surface is control-in
// only (no query/echo, and a stray message can drive the command line), and
// establishing a full Web Remote session has been field-reported to crash the
// master console session and consumes one of only two remote slots. The one
// safe, non-intrusive signal is therefore a bare TCP handshake against the Web
// Remote port (default 8080; HTTP is also on 80): we connect and immediately
// close, sending no HTTP request and no OSC. Online when the handshake completes.
//
// This is liveness only: MA3 has no documented, safe read-only API for show
// name, version or session member count over the network.
import { ProbeTcpConnect } from './_tcp-session';
import { Pill, Rows, TextRow, Row, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'ma3';

export const DEFAULT_MA3_PORT = 8080;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Web Remote port',
    Type: 'number',
    Default: DEFAULT_MA3_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
    Note: '8080 by default; 80 on some builds.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 3000,
    Min: 200,
    Max: 30000,
    Advanced: true,
  },
];

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_MA3_PORT;
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? (Cfg.Timeout as number) : 3000;
  if (Port < 1 || Port > 65535) return { Success: false, Error: `Invalid port: ${Port}` };

  // Connect and close without sending anything: never open a real Web Remote
  // session against a live console.
  return ProbeTcpConnect(Address, Port, TimeoutMs);
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_MA3_PORT;
  const Open = !!(Result && Result.Success);
  return Rows([
    TextRow('Host', `${Address || '-'}:${Port}`),
    Row('Web Remote', Pill(Open ? 'success' : 'danger', Open ? 'Reachable' : 'Closed / filtered')),
    Open
      ? Row('Handshake', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Connection failed'),
  ]);
}

export const Name = 'grandMA3';
export const Description =
  'Confirms a grandMA3 console (or onPC) is reachable by opening a TCP connection to its Web Remote port (default 8080) and closing it immediately; no data is sent, so it is safe against a live console. grandMA3 exposes no safe read-only status API over the network, so this is a liveness check only. The Web Remote must be enabled on the console.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
