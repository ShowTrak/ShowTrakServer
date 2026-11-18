// Windows ping helper: one long-lived powershell.exe answering every ping.
//
// The ping method starts an OS `ping` process per probe. On Windows that is the
// expensive kind of process start (process creation, a console host, the
// anti-virus scan of each new image), and a rig of 300 checks every 3 s asks
// for 100 of them a second. Raw ICMP sockets need admin rights, so instead one
// Windows PowerShell process is kept running and asked over its stdin/stdout:
// it calls .NET's Ping.SendPingAsync (IcmpSendEcho2, no admin needed) with as
// many pings in flight as there are requests, and answers each on its own line.
//
// The helper is an optimisation, never a dependency. Any request it cannot
// answer properly (not started yet, crashed, wedged, an unexpected error) comes
// back as null and the caller runs the old per-probe `ping.exe` instead, so a
// broken helper can cost speed but can never read a device as down. A helper
// that keeps failing is left alone for a while; an idle one shuts itself down.
//
// Line protocol (UTF-8, '\n'):
//   to the helper:   <id> <timeoutMs> <address>
//   from the helper: READY 1
//                    <id> OK <roundtripMs>
//                    <id> FAIL <IPStatus>                 (no echo reply)
//                    <id> ERR <ExceptionType> <message>   (the request threw)
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { CreateLogger } from '../Logger';

const Logger = CreateLogger('PingHelper');

export interface HelperPingResult {
  Success: boolean;
  LatencyMs?: number;
  Error?: string;
}

export interface PingHelperCommand {
  File: string;
  Args: string[];
}

export interface PingHelperOptions {
  // Longest the helper may take to report READY.
  ReadyTimeoutMs?: number;
  // How long past a request's own ping timeout an answer may still arrive.
  ResponseGraceMs?: number;
  // A helper with nothing to do for this long is shut down.
  IdleShutdownMs?: number;
  // This many helper failures inside FailureWindowMs disable it for DisableMs.
  FailureLimit?: number;
  FailureWindowMs?: number;
  DisableMs?: number;
}

// Windows PowerShell 5.1 (.NET Framework 4.5+). Deliberately never names the
// automatic variable for pipeline input: a command that uses it makes the host
// read stdin itself, which would steal the requests.
export const HELPER_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Requests = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $Utf8)
$Out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $Utf8)
$Out.AutoFlush = $true
$Out.NewLine = "\`n"
$Payload = [System.Text.Encoding]::ASCII.GetBytes('abcdefghijklmnopqrstuvwabcdefghi')
$Options = New-Object System.Net.NetworkInformation.PingOptions(128, $false)
$Pending = New-Object System.Collections.ArrayList
function Reply([string]$Line) { $Out.WriteLine(($Line -replace '[^\\x20-\\x7E]', '?')) }
function Fault($Err) {
  $E = $Err
  while ($null -ne $E.InnerException) { $E = $E.InnerException }
  return ($E.GetType().FullName + ' ' + ($E.Message -replace '\\s+', ' '))
}
$Read = $Requests.ReadLineAsync()
Reply 'READY 1'
while ($true) {
  $Tasks = New-Object 'System.Threading.Tasks.Task[]' ($Pending.Count + 1)
  $Tasks[0] = $Read
  for ($I = 0; $I -lt $Pending.Count; $I++) { $Tasks[$I + 1] = $Pending[$I][1] }
  $Done = [System.Threading.Tasks.Task]::WaitAny($Tasks, 1000)
  if ($Done -lt 0) { continue }
  if ($Done -eq 0) {
    if ($Read.IsFaulted -or $Read.IsCanceled) { break }
    $Line = $Read.Result
    if ($null -eq $Line) { break }
    $Read = $Requests.ReadLineAsync()
    $Parts = $Line.Trim().Split([char[]]@(' '), 3)
    if ($Parts.Length -ne 3) { continue }
    $Id = $Parts[0]
    try {
      $Ping = New-Object System.Net.NetworkInformation.Ping
      $Task = $Ping.SendPingAsync($Parts[2], [int]$Parts[1], $Payload, $Options)
      [void]$Pending.Add(@($Id, $Task, $Ping))
    } catch {
      Reply ($Id + ' ERR ' + (Fault $_.Exception))
    }
    continue
  }
  $Job = $Pending[$Done - 1]
  $Pending.RemoveAt($Done - 1)
  $Task = $Job[1]
  if ($Task.IsFaulted) { Reply ($Job[0] + ' ERR ' + (Fault $Task.Exception)) }
  elseif ($Task.IsCanceled) { Reply ($Job[0] + ' ERR System.OperationCanceledException cancelled') }
  else {
    $R = $Task.Result
    if ($R.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) {
      Reply ($Job[0] + ' OK ' + $R.RoundtripTime)
    } else {
      Reply ($Job[0] + ' FAIL ' + $R.Status)
    }
  }
  $Job[2].Dispose()
}
`;

// The errors ping.exe's output yields for the same outcomes (see ping.ts), so a
// check reads the same whichever path answered it.
const FAIL_ERRORS: Record<string, string> = {
  DestinationHostUnreachable: 'Destination host unreachable',
  DestinationNetworkUnreachable: 'Destination net unreachable',
  DestinationProtocolUnreachable: 'Destination protocol unreachable',
  DestinationPortUnreachable: 'Destination port unreachable',
  TtlExpired: 'TTL expired',
  TimeExceeded: 'TTL expired',
  TtlReassemblyTimeExceeded: 'TTL expired',
  HardwareError: 'General failure',
};

// The stock Windows PowerShell, by full path so PATH cannot substitute another.
export function DefaultHelperCommand(): PingHelperCommand {
  const Root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return {
    File: path.win32.join(Root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    Args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64'),
    ],
  };
}

// Read one helper answer. Null when it must not be trusted (the caller then
// pings the old way); undefined for a line that is not an answer at all.
export function ParseHelperAnswer(Kind: string, Rest: string): HelperPingResult | null | undefined {
  if (Kind === 'OK') {
    const Ms = Number(Rest);
    if (!Number.isFinite(Ms) || Ms < 0) return null;
    // ping.exe prints "time<1ms" for a sub-millisecond reply, which ping.ts
    // reads as 1; IcmpSendEcho reports it as 0. Keep the readings identical.
    return { Success: true, LatencyMs: Ms < 1 ? 1 : Ms };
  }
  if (Kind === 'FAIL') {
    return { Success: false, Error: FAIL_ERRORS[Rest.trim()] || 'Host unreachable' };
  }
  if (Kind === 'ERR') {
    // A name that does not resolve is an answer (ping.exe fails it too). Any
    // other exception is the helper's problem, not the device's.
    return /^System\.Net\.Sockets\.SocketException\b/.test(Rest)
      ? { Success: false, Error: 'Host unreachable' }
      : null;
  }
  return undefined;
}

interface PendingPing {
  Resolve: (Result: HelperPingResult | null) => void;
  Timer: ReturnType<typeof setTimeout>;
}

// What a request may carry as its address: one token of printable ASCII (an IP
// or a host name). Anything else goes to ping.exe as before.
const ADDRESS_PATTERN = /^[\x21-\x7e]{1,253}$/;

function Unref(Handle: { unref?: () => unknown } | null | undefined): void {
  if (Handle && typeof Handle.unref === 'function') Handle.unref();
}

export class PingHelperClient {
  private readonly Command: PingHelperCommand;
  private readonly ReadyTimeoutMs: number;
  private readonly ResponseGraceMs: number;
  private readonly IdleShutdownMs: number;
  private readonly FailureLimit: number;
  private readonly FailureWindowMs: number;
  private readonly DisableMs: number;

  private Child: ChildProcess | null = null;
  private Ready = false;
  private ReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private IdleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly Pending = new Map<number, PendingPing>();
  private NextID = 1;
  private Partial = '';
  private Stderr = '';
  private Failures: number[] = [];
  private DisabledUntil = 0;

  constructor(Command: PingHelperCommand, Options: PingHelperOptions = {}) {
    this.Command = Command;
    this.ReadyTimeoutMs = Options.ReadyTimeoutMs ?? 15000;
    this.ResponseGraceMs = Options.ResponseGraceMs ?? 2000;
    this.IdleShutdownMs = Options.IdleShutdownMs ?? 60000;
    this.FailureLimit = Options.FailureLimit ?? 3;
    this.FailureWindowMs = Options.FailureWindowMs ?? 60000;
    this.DisableMs = Options.DisableMs ?? 10 * 60000;
  }

  // Whether a request is worth sending (false while disabled after failures).
  Available(): boolean {
    return Date.now() >= this.DisabledUntil;
  }

  // Ping once. Null means "no trustworthy answer": ping the old way instead.
  Ping(Address: string, TimeoutMs: number): Promise<HelperPingResult | null> {
    if (!this.Available() || !ADDRESS_PATTERN.test(Address)) return Promise.resolve(null);
    const Child = this.EnsureStarted();
    if (!Child || !Child.stdin) return Promise.resolve(null);
    const ID = this.NextID;
    this.NextID = this.NextID >= 0x7fffffff ? 1 : this.NextID + 1;
    const Timeout = Math.max(1, Math.round(TimeoutMs));
    return new Promise<HelperPingResult | null>((Resolve) => {
      // A helper still starting gets its start-up allowance on top.
      const Deadline = Timeout + this.ResponseGraceMs + (this.Ready ? 0 : this.ReadyTimeoutMs);
      const Timer = setTimeout(() => this.OnStalled(ID), Deadline);
      Unref(Timer);
      this.Pending.set(ID, { Resolve, Timer });
      if (this.IdleTimer) {
        clearTimeout(this.IdleTimer);
        this.IdleTimer = null;
      }
      try {
        Child.stdin!.write(`${ID} ${Timeout} ${Address}\n`);
      } catch {
        this.Retire('write failed', true);
      }
    });
  }

  // Stop the helper now and answer everything outstanding with null.
  Shutdown(): void {
    this.Retire('shutdown', false);
  }

  get Running(): boolean {
    return !!this.Child;
  }

  private EnsureStarted(): ChildProcess | null {
    if (this.Child) return this.Child;
    let Child: ChildProcess;
    try {
      Child = spawn(this.Command.File, this.Command.Args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (Err) {
      this.NoteFailure(`could not start: ${(Err as Error).message}`);
      return null;
    }
    this.Child = Child;
    this.Ready = false;
    this.Partial = '';
    this.Stderr = '';
    try {
      this.Attach(Child);
    } catch (Err) {
      this.Retire(`could not start: ${(Err as Error).message}`, true);
      return null;
    }
    return Child;
  }

  private Attach(Child: ChildProcess): void {
    // Never what keeps the app (or a test run) alive.
    Unref(Child);
    Unref(Child.stdin as unknown as { unref?: () => unknown });
    Unref(Child.stdout as unknown as { unref?: () => unknown });
    Unref(Child.stderr as unknown as { unref?: () => unknown });
    Child.stdin?.on('error', () => {
      // EPIPE once the helper has gone; its exit is handled below.
    });
    Child.stdout?.setEncoding('utf8');
    Child.stdout?.on('data', (Chunk: string) => {
      if (this.Child === Child) this.OnData(Chunk);
    });
    Child.stderr?.setEncoding('utf8');
    Child.stderr?.on('data', (Chunk: string) => {
      if (this.Stderr.length < 4096) this.Stderr += Chunk;
    });
    Child.on('error', (Err: Error) => {
      if (this.Child === Child) this.Retire(`error: ${Err.message}`, true);
    });
    Child.on('exit', (Code: number | null) => {
      if (this.Child === Child) this.Retire(`exited (${Code})`, true);
    });
    this.ReadyTimer = setTimeout(() => {
      if (this.Child === Child && !this.Ready) this.Retire('did not start in time', true);
    }, this.ReadyTimeoutMs);
    Unref(this.ReadyTimer);
  }

  private OnData(Chunk: string): void {
    this.Partial += Chunk;
    let Newline = this.Partial.indexOf('\n');
    while (Newline !== -1) {
      const Line = this.Partial.slice(0, Newline).replace(/\r$/, '');
      this.Partial = this.Partial.slice(Newline + 1);
      this.OnLine(Line);
      Newline = this.Partial.indexOf('\n');
    }
    // A runaway line is not the protocol; drop it rather than buffer it.
    if (this.Partial.length > 65536) this.Partial = '';
  }

  private OnLine(Line: string): void {
    if (Line.startsWith('READY')) {
      this.Ready = true;
      if (this.ReadyTimer) clearTimeout(this.ReadyTimer);
      this.ReadyTimer = null;
      return;
    }
    const First = Line.indexOf(' ');
    const Second = First === -1 ? -1 : Line.indexOf(' ', First + 1);
    if (Second === -1) return;
    const ID = Number(Line.slice(0, First));
    const Result = ParseHelperAnswer(Line.slice(First + 1, Second), Line.slice(Second + 1));
    if (!Number.isInteger(ID) || Result === undefined) return;
    // A real answer: the helper works, so earlier failures are forgiven.
    if (Result) this.Failures = [];
    this.Settle(ID, Result);
  }

  private Settle(ID: number, Result: HelperPingResult | null): void {
    const Entry = this.Pending.get(ID);
    if (!Entry) return;
    this.Pending.delete(ID);
    clearTimeout(Entry.Timer);
    Entry.Resolve(Result);
    if (!this.Pending.size) this.ArmIdle();
  }

  // An answer that never came: the helper is wedged (IcmpSendEcho2 keeps its
  // own timeout), so it is replaced and this request falls back.
  private OnStalled(ID: number): void {
    if (!this.Pending.has(ID)) return;
    this.Settle(ID, null);
    this.Retire('stopped answering', true);
  }

  private ArmIdle(): void {
    if (this.IdleTimer || !this.Child) return;
    this.IdleTimer = setTimeout(() => {
      this.IdleTimer = null;
      if (!this.Pending.size) this.Retire('idle', false);
    }, this.IdleShutdownMs);
    Unref(this.IdleTimer);
  }

  // Let the current helper go: answer what it still owes with null (those
  // requests fall back), close its stdin so it exits, and kill it if it lingers.
  private Retire(Reason: string, Failed: boolean): void {
    const Child = this.Child;
    this.Child = null;
    this.Ready = false;
    if (this.ReadyTimer) clearTimeout(this.ReadyTimer);
    this.ReadyTimer = null;
    if (this.IdleTimer) clearTimeout(this.IdleTimer);
    this.IdleTimer = null;
    const Owed = Array.from(this.Pending.keys());
    for (const ID of Owed) {
      const Entry = this.Pending.get(ID)!;
      this.Pending.delete(ID);
      clearTimeout(Entry.Timer);
      Entry.Resolve(null);
    }
    if (Child) {
      try {
        Child.stdin?.end();
      } catch {
        // already closed
      }
      if (Child.exitCode == null && Child.signalCode == null) {
        const Kill = setTimeout(
          () => {
            try {
              Child.kill();
            } catch {
              // already gone
            }
          },
          Failed ? 0 : 3000
        );
        Unref(Kill);
      }
    }
    if (Failed) this.NoteFailure(Reason);
  }

  private NoteFailure(Reason: string): void {
    const Now = Date.now();
    this.Failures = this.Failures.filter((At) => Now - At < this.FailureWindowMs);
    this.Failures.push(Now);
    const Detail = this.Stderr.trim().slice(0, 500);
    if (this.Failures.length >= this.FailureLimit) {
      this.Failures = [];
      this.DisabledUntil = Now + this.DisableMs;
      Logger.warn(
        `Ping helper ${Reason}; using ping.exe for ${Math.round(this.DisableMs / 60000)} min${Detail ? `: ${Detail}` : ''}`
      );
    } else {
      Logger.warn(
        `Ping helper ${Reason}; restarting on the next ping${Detail ? `: ${Detail}` : ''}`
      );
    }
  }
}
