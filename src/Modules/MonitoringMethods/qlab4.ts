// QLab 4 workspace monitoring. QLab 4 is end-of-life, so this is deliberately a
// minimal, per-tick probe rather than the persistent, deep-inspection QLab 5 check:
// it opens a short-lived OSC/TCP connection, asks QLab for its open workspaces
// (`/workspaces` — supported since QLab 3), and confirms a workspace is open — a
// named one, or any open workspace when the field is blank. It intentionally does
// no /updates subscription, mode/cue/override inspection, or persistent connection;
// use the QLab 5 check for that. Reuses the shared OSC codec (SLIP framing) and the
// QLab reply/workspace helpers.
//
// The playback and mode actions are shared with QLab 5 (see _qlab-shared). Each
// press opens its own short-lived connection, in keeping with the probe: resolve
// the workspace, send the passcode if one is set, send the command, and read
// QLab's acknowledgement before closing.
import net from 'net';
import { EncodeOscTcp, DecodeOscStream, type OscArg } from './_osc-shared';
import {
  ParseQLabReply,
  WorkspaceMatches,
  DEFAULT_OSC_PORT,
  IsValidPort,
  ReplyKey,
  DescribeRefusal,
  TRANSPORT_ACTIONS,
  MODE_ACTIONS,
  BuildQLabCommand,
  DescribeQLabAction,
  type QLabCommand,
  type QLabReply,
} from './_qlab-shared';
import { Esc, Pill, Rows, TextRow, Row, Note, Card, FormatLatency } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type {
  MonitoringActionDef,
  MonitoringActionResult,
  MonitoringResult,
  MonitoringSettingField,
  MonitoringTargetLike,
} from './types';

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
  {
    Key: 'Passcode',
    Label: 'OSC passcode',
    Type: 'string',
    Default: '',
    Advanced: true,
    Note: 'Only used by actions, for a workspace that requires an OSC passcode. The check itself never needs one.',
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

// --- Actions ----------------------------------------------------------------

const Actions: MonitoringActionDef[] = [...TRANSPORT_ACTIONS, ...MODE_ACTIONS];

interface WorkspaceRef {
  uniqueID?: unknown;
}

// Open a short-lived connection, resolve the workspace the check watches, and
// send one command to it, resolving with QLab's verdict on that command.
function SendCommand(
  Address: string,
  Port: number,
  TimeoutMs: number,
  Wanted: string,
  Passcode: string,
  Command: QLabCommand
): Promise<MonitoringActionResult> {
  return new Promise<MonitoringActionResult>((resolve) => {
    const BudgetMs = Math.max(200, TimeoutMs | 0);
    let Settled = false;
    let Buf = Buffer.alloc(0);
    let Pending: { Key: string; Resolve: (Reply: QLabReply) => void } | null = null;
    const Socket = new net.Socket();

    // One absolute budget for the whole exchange (workspaces, passcode,
    // command), so three sequential round trips cannot each take the full
    // timeout.
    const Deadline = setTimeout(
      () => Finish({ Success: false, Error: `No reply from QLab after ${BudgetMs}ms` }),
      BudgetMs
    );

    function Finish(Result: MonitoringActionResult): void {
      if (Settled) return;
      Settled = true;
      clearTimeout(Deadline);
      try {
        Socket.destroy();
      } catch {
        // ignore
      }
      resolve(Result);
    }

    const Write = (Addr: string, Args: OscArg[]) => {
      try {
        Socket.write(EncodeOscTcp(Addr, Args, 'slip'));
      } catch (Err) {
        Finish({ Success: false, Error: ErrText(Err) });
      }
    };

    const Request = (Addr: string, Args: OscArg[]): Promise<QLabReply> =>
      new Promise<QLabReply>((Res) => {
        Pending = { Key: ReplyKey(Addr), Resolve: Res };
        Write(Addr, Args);
      });

    Socket.on('data', (Chunk: Buffer) => {
      Buf = Buffer.concat([Buf, Chunk]);
      if (Buf.length > 1_000_000) {
        Finish({ Success: false, Error: 'Reply too large' });
        return;
      }
      const { Messages, Rest } = DecodeOscStream(Buf, 'slip');
      Buf = Rest;
      for (const Message of Messages) {
        const Reply = ParseQLabReply(Message);
        if (!Reply || !Pending || ReplyKey(Reply.Address) !== Pending.Key) continue;
        const Current = Pending;
        Pending = null;
        Current.Resolve(Reply);
      }
    });

    Socket.once('error', (Err: Error) => Finish({ Success: false, Error: ErrText(Err) }));
    Socket.once('close', () => Finish({ Success: false, Error: 'QLab closed the connection' }));

    Socket.once('connect', () => {
      void (async () => {
        // Without this QLab 4 stays silent after most commands, leaving nothing
        // to tell an accepted GO from a refused one.
        Write('/alwaysReply', [{ Int: 1 }]);

        const List = await Request('/workspaces', []);
        const Workspaces = Array.isArray(List.Data) ? (List.Data as WorkspaceRef[]) : [];
        const Match = Wanted
          ? Workspaces.find((W) => WorkspaceMatches(W, Wanted))
          : Workspaces.find((W) => W && typeof W === 'object' && W.uniqueID != null);
        if (!Match || Match.uniqueID == null) {
          Finish({
            Success: false,
            Error: Wanted ? 'Workspace not open in QLab' : 'No workspaces open in QLab',
          });
          return;
        }
        const Prefix = `/workspace/${String(Match.uniqueID)}`;

        if (Passcode) {
          const Connected = await Request(`${Prefix}/connect`, [Passcode]);
          // QLab answers a wrong passcode in the reply's data, not its status.
          if (Connected.Status !== 'ok' || Connected.Data === 'badpass') {
            Finish({
              Success: false,
              Error: DescribeRefusal(Connected.Data === 'badpass' ? 'badpass' : Connected.Status),
            });
            return;
          }
        }

        const Reply = await Request(`${Prefix}${Command.Address}`, Command.Args);
        Finish(
          Reply.Status === 'ok'
            ? { Success: true, Detail: Command.Detail }
            : { Success: false, Error: DescribeRefusal(Reply.Status) }
        );
      })();
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Finish({ Success: false, Error: ErrText(Err) });
    }
  });
}

async function RunAction(
  Target: MonitoringTargetLike,
  ActionID: string,
  Params: Record<string, unknown>
): Promise<MonitoringActionResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_OSC_PORT;
  if (!IsValidPort(Port)) return { Success: false, Error: `Invalid port: ${Port}` };
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? (Cfg.Timeout as number) : 3000;
  const Wanted = Cfg.Workspace == null ? '' : String(Cfg.Workspace).trim();
  const Passcode = Cfg.Passcode == null ? '' : String(Cfg.Passcode);

  const Command = BuildQLabCommand(ActionID, Params, 4);
  if ('Error' in Command) return { Success: false, Error: Command.Error };
  return SendCommand(Address, Port, TimeoutMs, Wanted, Passcode, Command);
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
      Note(Reachable ? 'QLab reported no open workspaces' : 'Failed to reach QLab') +
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
export const DescribeAction = DescribeQLabAction;
export { ID, Settings, Actions, Run, RunAction, Debug };
