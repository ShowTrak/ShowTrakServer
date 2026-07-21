// QLab 4 workspace monitoring. QLab 4 is end-of-life, so this is deliberately a
// minimal, per-tick probe rather than the persistent, deep-inspection QLab 5 check:
// it opens a short-lived OSC/TCP connection, asks QLab for its open workspaces
// (`/workspaces` — supported since QLab 3), and confirms a workspace is open — a
// named one, or any open workspace when the field is blank. It intentionally does
// no /updates subscription, mode/cue/override inspection, or persistent connection;
// use the QLab 5 check for that. Reuses the shared OSC codec (SLIP framing) and the
// QLab reply/workspace helpers.
import net from 'net';
import { EncodeOscTcp, DecodeOscStream } from './_osc-shared';
import { ParseQLabReply, WorkspaceMatches, DEFAULT_OSC_PORT, IsValidPort } from './_qlab-shared';
import { Esc, Pill, Rows, TextRow, Row, Note, Card, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'qlab4';

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'OSC Port',
    Type: 'number',
    Default: DEFAULT_OSC_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  {
    Key: 'Workspace',
    Label: 'Workspace name / filename or unique ID (optional)',
    Type: 'string',
    Default: '',
    Note: 'Confirm this workspace is open, matched by name, filename, or unique ID. Leave blank to accept any open workspace.',
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

interface WorkspaceInfo {
  uniqueID?: unknown;
  displayName?: unknown;
  hasPasscode?: unknown;
  hasPasscodeSet?: unknown;
}

function ErrText(Err: unknown): string {
  return Err && (Err as Error).message ? (Err as Error).message : String(Err);
}

// Open a short-lived TCP connection, send `/workspaces`, and resolve with the
// reported workspace list (or a failure).
function QueryWorkspaces(
  Address: string,
  Port: number,
  TimeoutMs: number
): Promise<MonitoringResult> {
  return new Promise<MonitoringResult>((resolve) => {
    const Started = Date.now();
    let Settled = false;
    let Buf = Buffer.alloc(0);
    const Socket = new net.Socket();

    const Finish = (Result: MonitoringResult) => {
      if (Settled) return;
      Settled = true;
      try {
        Socket.destroy();
      } catch {
        // ignore
      }
      resolve(Result);
    };

    const Extract = (): boolean => {
      const { Messages, Rest } = DecodeOscStream(Buf, 'slip');
      Buf = Rest;
      for (const M of Messages) {
        const Reply = ParseQLabReply(M);
        if (Reply && Reply.Address.endsWith('/workspaces') && Array.isArray(Reply.Data)) {
          Finish({ Success: true, LatencyMs: Date.now() - Started, Workspaces: Reply.Data });
          return true;
        }
      }
      return false;
    };

    Socket.setTimeout(Math.max(200, TimeoutMs | 0));

    Socket.once('connect', () => {
      try {
        Socket.write(EncodeOscTcp('/workspaces', [], 'slip'));
      } catch (Err) {
        Finish({ Success: false, Error: ErrText(Err) });
      }
    });

    Socket.on('data', (Chunk: Buffer) => {
      Buf = Buffer.concat([Buf, Chunk]);
      if (Buf.length > 1_000_000) {
        Finish({ Success: false, Error: 'Reply too large' });
        return;
      }
      Extract();
    });

    Socket.once('timeout', () =>
      Finish({ Success: false, Error: `No reply from QLab after ${TimeoutMs}ms` })
    );
    Socket.once('error', (Err: Error) => Finish({ Success: false, Error: ErrText(Err) }));
    Socket.once('close', () => {
      if (!Settled && !Extract()) Finish({ Success: false, Error: 'No reply from QLab' });
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Finish({ Success: false, Error: ErrText(Err) });
    }
  });
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_OSC_PORT;
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? (Cfg.Timeout as number) : 3000;
  const Wanted = Cfg.Workspace == null ? '' : String(Cfg.Workspace).trim();
  if (!IsValidPort(Port)) return { Success: false, Error: `Invalid port: ${Port}` };

  const Query = await QueryWorkspaces(Address, Port, TimeoutMs);
  if (!Query.Success)
    return { Success: false, Error: (Query.Error as string) || 'No reply from QLab' };

  const Workspaces = Array.isArray(Query.Workspaces) ? Query.Workspaces : [];

  // No workspace named: any open workspace is a pass.
  if (!Wanted) {
    if (Workspaces.length) {
      return { Success: true, LatencyMs: Query.LatencyMs, Workspaces, Matched: true };
    }
    return {
      Success: true,
      Degraded: true,
      DegradedReason: 'No workspaces open',
      LatencyMs: Query.LatencyMs,
      Workspaces,
      Matched: false,
    };
  }

  const Matched = Workspaces.some((W) => WorkspaceMatches(W, Wanted));
  if (Matched) {
    return { Success: true, LatencyMs: Query.LatencyMs, Workspaces, Wanted, Matched: true };
  }
  return {
    Success: true,
    Degraded: true,
    DegradedReason: 'Incorrect Workspace',
    LatencyMs: Query.LatencyMs,
    Workspaces,
    Wanted,
    Matched: false,
  };
}

// One card per reported workspace (name, unique ID, passcode state), highlighting
// the one we are matching on.
function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_OSC_PORT;
  const Wanted =
    (Result && (Result.Wanted as string)) ||
    (Cfg.Workspace == null ? '' : String(Cfg.Workspace).trim());
  const Reachable = !!(
    Result &&
    (Result.Success || Result.Degraded) &&
    Array.isArray(Result.Workspaces)
  );

  let StatusPill: string;
  if (!Reachable) StatusPill = Pill('danger', 'No reply');
  else if (Result && Result.Matched) StatusPill = Pill('success', 'Workspace open');
  else StatusPill = Pill('warning', Wanted ? 'Not found' : 'No workspaces');

  const Head = Rows([
    TextRow('Host', `${Address || '—'}:${Port}`),
    Row('Status', StatusPill),
    Wanted ? TextRow('Looking for', Wanted) : null,
    Reachable
      ? Row('Reply time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && (Result.Error as string)) || 'No reply from QLab'),
  ]);

  const Workspaces: unknown[] = Array.isArray(Result && Result.Workspaces)
    ? (Result.Workspaces as unknown[])
    : [];
  if (!Reachable || !Workspaces.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(Reachable ? 'QLab reported no open workspaces' : 'Could not reach QLab') +
      '</div>'
    );
  }

  const List = Workspaces.map((W) => {
    const Ws = W as WorkspaceInfo;
    const Name = Ws.displayName != null ? String(Ws.displayName) : '(unnamed)';
    const UniqueID = Ws.uniqueID != null ? String(Ws.uniqueID) : '';
    const HasPasscode = !!(Ws.hasPasscode || Ws.hasPasscodeSet);
    return Card({
      Title: Name,
      Badge: HasPasscode ? Pill('warning', 'Passcode') : Pill('muted', 'No passcode'),
      Highlight: WorkspaceMatches(W, Wanted),
      BodyHtml: UniqueID
        ? `<div class="text-muted font-monospace" style="font-size: 0.7rem;">${Esc(UniqueID)}</div>`
        : '',
    });
  }).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">Open workspaces (${Workspaces.length})</div>` +
    `<div class="d-grid gap-1">${List}</div>`
  );
}

export const Name = 'QLab 4';
export const Description =
  'Connects to a QLab 4 machine over OSC (default TCP 53000) and confirms a workspace is open — a specific one by name, filename, or unique ID, or any open workspace when left blank. A lightweight liveness/workspace check for legacy QLab 4 (end-of-life); use the QLab 5 check for mode, cue, and override inspection.';
export const Group = 'Sound';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export { ID, Settings, Run, Debug };
