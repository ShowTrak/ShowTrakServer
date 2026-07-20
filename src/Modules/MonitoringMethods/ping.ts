// Ping monitoring method. Uses the OS `ping` binary so we don't need raw ICMP
// privileges. Cross-platform argument shapes are kept tiny on purpose.
import { spawn } from 'child_process';
import os from 'os';
import { Pill, Rows, TextRow, Row, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'ping';

// Settings schema is consumed by the renderer to build the dynamic config form
// inside the monitoring target editor.
const Settings: MonitoringSettingField[] = [
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 2000,
    Min: 200,
    Max: 30000,
    Advanced: true,
  },
];

function BuildArgs(Address: string, TimeoutMs: number): string[] {
  const Platform = os.platform();
  // Single ping; timeout in seconds (rounded up) for *nix, ms for Windows.
  if (Platform === 'win32') {
    return ['-n', '1', '-w', String(Math.max(100, TimeoutMs | 0)), Address];
  }
  if (Platform === 'darwin') {
    // macOS: -W is wait time per reply in milliseconds.
    return ['-c', '1', '-W', String(Math.max(100, TimeoutMs | 0)), Address];
  }
  // linux + others
  const TimeoutSec = Math.max(1, Math.ceil(TimeoutMs / 1000));
  return ['-c', '1', '-W', String(TimeoutSec), Address];
}

// Don't shell-interpret; Address is forwarded as a process argument so a value
// like "; rm -rf /" can never be parsed as a separate command.
async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? (Cfg.Timeout as number) : 2000;
  const Args = BuildArgs(Address, TimeoutMs);

  return new Promise<MonitoringResult>((resolve) => {
    let Stdout = '';
    let Settled = false;

    let Child: ReturnType<typeof spawn>;
    try {
      Child = spawn('ping', Args, { windowsHide: true });
    } catch (Err) {
      return resolve({ Success: false, Error: `Failed to spawn ping: ${(Err as Error).message}` });
    }

    // Hard kill guard; OS-level timeout flags don't always fire reliably.
    const KillTimer = setTimeout(
      () => {
        try {
          Child.kill();
        } catch (_e) {
          // ignore: process may have already exited
        }
      },
      Math.max(1000, TimeoutMs + 2000)
    );

    Child.stdout?.on('data', (Chunk: Buffer) => {
      Stdout += Chunk.toString();
    });

    Child.on('error', (Err: Error) => {
      if (Settled) return;
      Settled = true;
      clearTimeout(KillTimer);
      resolve({ Success: false, Error: Err.message });
    });

    Child.on('close', (Code: number | null) => {
      if (Settled) return;
      Settled = true;
      clearTimeout(KillTimer);

      if (Code !== 0) {
        return resolve({ Success: false, Error: 'Host unreachable' });
      }

      // A zero exit code is not on its own proof of delivery. Windows `ping`
      // exits 0 when the local stack or a router answers with an ICMP
      // "Destination host unreachable" — that counts as a received packet for
      // exit-code purposes, and happens routinely while the route/interface is
      // still coming up during server boot. Trusting the code alone reported
      // those hosts as online (with a wall-clock latency standing in for the
      // reply time) until the next interval corrected it.
      const Failure = Stdout.match(
        /destination\s+(?:host|net|network|port|protocol)\s+unreachable|transmit\s+failed|general\s+failure|ttl\s+expired|request\s+timed\s+out/i
      );
      if (Failure) {
        return resolve({ Success: false, Error: Failure[0]!.trim() });
      }

      // Require a real round-trip time. Every ping implementation prints one for
      // an actual echo reply ("time=5ms", "time<1ms", "time=1.23 ms"), so its
      // absence means nothing came back — never substitute wall-clock here.
      const Match = Stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
      if (!Match || !Match[1]) {
        return resolve({ Success: false, Error: 'No echo reply' });
      }
      resolve({ Success: true, LatencyMs: parseFloat(Match[1]) });
    });
  });
}

// Render a compact summary of the most recent probe for the check editor.
function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Reachable = !!(Result && Result.Success);
  return Rows([
    TextRow('Host', Address || '—'),
    Row('Reachable', Pill(Reachable ? 'success' : 'danger', Reachable ? 'Yes' : 'No')),
    Reachable
      ? Row('Round-trip', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Host unreachable'),
  ]);
}

export const Name = 'Ping (ICMP)';
export const Description = 'Sends a single ICMP echo request and reports round-trip latency.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
