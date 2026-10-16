// Shared plumbing for the monitoring methods that talk to a device over a
// short-lived TCP connection.
//
// Every such probe needs the same skeleton, and each copy of it was a place for
// one of its rules to be forgotten: settle exactly once; bound the session with
// an IDLE timeout (which resets on every byte) AND, for multi-round-trip
// conversations, an absolute deadline (a slow-but-trickling device can otherwise
// keep an idle timeout alive forever); clear that deadline and destroy the socket
// the moment the session settles (many projectors and consoles accept only one
// session at a time); and turn a synchronous connect() throw into a result, not
// an exception. RunTcpSession owns all of that. A method supplies only what is
// specific to its protocol: what to send, how to read replies, and what each way
// of ending means for its result.
import net from 'net';
import type { MonitoringResult } from './types';

export function ErrorMessage(Err: unknown): string {
  return Err && (Err as Error).message ? (Err as Error).message : String(Err);
}

export interface TcpSession<R> {
  readonly Socket: net.Socket;
  /** Date.now() when the session began, for latency. */
  readonly StartedAt: number;
  readonly Settled: boolean;
  /** Settle with Result. The first call wins; later calls are ignored. */
  Finish(Result: R): void;
}

export interface TcpSessionSpec<R> {
  Address: string;
  Port: number;
  /** Socket idle timeout in ms; it resets on every data event. */
  IdleMs: number;
  /** Absolute cap on the whole session in ms. Omit for a single-exchange probe. */
  DeadlineMs?: number;
  /** Disable Nagle, for request/reply protocols that send small writes. */
  NoDelay?: boolean;
  OnConnect?(Session: TcpSession<R>): void;
  OnData?(Chunk: Buffer, Session: TcpSession<R>): void;
  /** The idle timeout fired, or the absolute deadline passed, before settling. */
  OnTimeout(Session: TcpSession<R>, Kind: 'idle' | 'deadline'): R;
  /** A socket error, including a connect() that throws synchronously. */
  OnError(Message: string, Session: TcpSession<R>): R;
  /** The peer closed before the session settled. Without it, a close is left to the error/timeout paths. */
  OnClose?(Session: TcpSession<R>): R;
  /**
   * Runs once when the session settles, by any path, before the socket is
   * destroyed. For releasing state that is waiting on a reply (see ReplyQueue).
   */
  OnSettle?(): void;
}

export function RunTcpSession<R>(Spec: TcpSessionSpec<R>): Promise<R> {
  return new Promise<R>((resolve) => {
    const Socket = new net.Socket();
    let Settled = false;
    let Deadline: ReturnType<typeof setTimeout> | null = null;

    const Session: TcpSession<R> = {
      Socket,
      StartedAt: Date.now(),
      get Settled() {
        return Settled;
      },
      Finish(Result: R) {
        if (Settled) return;
        Settled = true;
        if (Deadline) {
          clearTimeout(Deadline);
          Deadline = null;
        }
        if (Spec.OnSettle) {
          try {
            Spec.OnSettle();
          } catch {
            // A cleanup hook must not stop the socket being released.
          }
        }
        try {
          Socket.destroy();
        } catch {
          // ignore
        }
        resolve(Result);
      },
    };

    if (Spec.NoDelay) Socket.setNoDelay(true);
    Socket.setTimeout(Spec.IdleMs);
    if (Spec.DeadlineMs != null) {
      Deadline = setTimeout(
        () => Session.Finish(Spec.OnTimeout(Session, 'deadline')),
        Spec.DeadlineMs
      );
    }

    if (Spec.OnConnect) {
      const OnConnect = Spec.OnConnect;
      Socket.once('connect', () => OnConnect(Session));
    }
    if (Spec.OnData) {
      const OnData = Spec.OnData;
      Socket.on('data', (Chunk: Buffer) => {
        if (!Settled) OnData(Chunk, Session);
      });
    }
    Socket.once('timeout', () => Session.Finish(Spec.OnTimeout(Session, 'idle')));
    Socket.once('error', (Err: Error) => Session.Finish(Spec.OnError(ErrorMessage(Err), Session)));
    if (Spec.OnClose) {
      const OnClose = Spec.OnClose;
      Socket.once('close', () => {
        if (!Settled) Session.Finish(OnClose(Session));
      });
    }

    try {
      Socket.connect(Spec.Port, Spec.Address);
    } catch (Err) {
      Session.Finish(Spec.OnError(ErrorMessage(Err), Session));
    }
  });
}

/**
 * One request in flight at a time over a text protocol: received text is
 * buffered, and the pending request resolves as soon as its predicate recognises
 * a complete reply at the front of the buffer.
 */
export class ReplyQueue {
  private Text = '';
  private Waiter: {
    Predicate: (Buffered: string) => number | null;
    Resolve: (Reply: string) => void;
    Reject: (Err: Error) => void;
  } | null = null;

  /** @param MaxChars Buffered text beyond which Feed reports an oversized reply. */
  constructor(private readonly MaxChars: number) {}

  /** Append received text and settle the pending request if it is now answered. False when the buffer is over MaxChars. */
  Feed(Received: string): boolean {
    this.Text += Received;
    if (this.Text.length > this.MaxChars) return false;
    this.Pump();
    return true;
  }

  /**
   * Await the next reply. Predicate returns how many leading characters form a
   * complete reply, or null while it is still arriving.
   */
  Next(Predicate: (Buffered: string) => number | null): Promise<string> {
    return new Promise<string>((Resolve, Reject) => {
      this.Waiter = { Predicate, Resolve, Reject };
      this.Pump();
    });
  }

  /** Reject the pending request, if any. */
  FailPending(Err: Error): void {
    const Current = this.Waiter;
    this.Waiter = null;
    if (Current) Current.Reject(Err);
  }

  private Pump(): void {
    if (!this.Waiter) return;
    const Consumed = this.Waiter.Predicate(this.Text);
    if (Consumed == null) return;
    const Reply = this.Text.slice(0, Consumed);
    this.Text = this.Text.slice(Consumed);
    const Current = this.Waiter;
    this.Waiter = null;
    Current.Resolve(Reply);
  }
}

/**
 * Liveness by TCP handshake alone: connect, then close without sending a byte.
 * A refused or reset connection means the host answered but nothing is
 * listening, so it reads degraded rather than offline.
 */
export function ProbeTcpConnect(
  Address: string,
  Port: number,
  TimeoutMs: number
): Promise<MonitoringResult> {
  const ErrorResult = (Message: string): MonitoringResult => {
    const IsResponseError = Message.includes('ECONNREFUSED') || Message.includes('ECONNRESET');
    return { Success: false, ...(IsResponseError ? { Degraded: true } : {}), Error: Message };
  };
  return RunTcpSession<MonitoringResult>({
    Address,
    Port,
    IdleMs: Math.max(200, TimeoutMs | 0),
    OnConnect: (Session) =>
      Session.Finish({ Success: true, LatencyMs: Date.now() - Session.StartedAt }),
    OnTimeout: () => ({ Success: false, Error: `Connection timed out after ${TimeoutMs}ms` }),
    OnError: (Message) => ErrorResult(Message),
  });
}
