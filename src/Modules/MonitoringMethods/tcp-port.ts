// TCP port monitoring. Opens a TCP socket to Target.Address on the configured
// port and reports success when the three-way handshake completes within the
// timeout. No data is sent or read, so this is safe against arbitrary services.
import net from 'net';
import { Pill, Rows, TextRow, Row, FormatLatency } from './debug';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'tcp-port';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 80,
    Min: 1,
    Max: 65535,
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
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : 80;
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? (Cfg.Timeout as number) : 3000;
  if (Port < 1 || Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Port}` };
  }

  return new Promise<MonitoringResult>((resolve) => {
    const Started = Date.now();
    let Settled = false;

    const Socket = new net.Socket();

    const Finish = (Result: MonitoringResult) => {
      if (Settled) return;
      Settled = true;
      try {
        Socket.destroy();
      } catch (_e) {
        // ignore
      }
      resolve(Result);
    };

    Socket.setTimeout(Math.max(200, TimeoutMs | 0));

    Socket.once('connect', () => {
      Finish({ Success: true, LatencyMs: Date.now() - Started });
    });

    Socket.once('timeout', () => {
      Finish({ Success: false, Error: `Connection timed out after ${TimeoutMs}ms` });
    });

    Socket.once('error', (Err: Error) => {
      const ErrMsg = Err && Err.message ? Err.message : String(Err);
      // Errors indicating the port exists but rejected connection = degraded.
      // Errors indicating no response (timeout, unreachable, DNS fail) = offline.
      const IsResponseError = ErrMsg.includes('ECONNREFUSED') || ErrMsg.includes('ECONNRESET');
      Finish({
        Success: false,
        ...(IsResponseError ? { Degraded: true } : {}),
        Error: ErrMsg,
      });
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      const ErrMsg = Err && (Err as Error).message ? (Err as Error).message : String(Err);
      const IsResponseError = ErrMsg.includes('ECONNREFUSED') || ErrMsg.includes('ECONNRESET');
      Finish({
        Success: false,
        ...(IsResponseError ? { Degraded: true } : {}),
        Error: ErrMsg,
      });
    }
  });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : 80;
  const Open = !!(Result && Result.Success);
  return Rows([
    TextRow('Host', Address || '—'),
    TextRow('Port', String(Port)),
    Row('Port state', Pill(Open ? 'success' : 'danger', Open ? 'Accepting' : 'Closed / filtered')),
    Open
      ? Row('Handshake', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Connection failed'),
  ]);
}

export const Name = 'TCP Port';
export const Description = 'Attempts a TCP handshake against the configured host and port.';
export const DefaultInterval = 30000;
export { ID, Settings, Run, Debug };
