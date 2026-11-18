// Batched client push pipeline.
//
// A connected client changes every second (its heartbeat), and a connecting one
// changes about ten times in its first second (heartbeat, system info, then one
// report per telemetry domain). Pushing the whole client to every surface on
// every change made the renderer pushes the dominant cost of a large rig: the
// full process list, USB, display, audio and storage views and the network
// list, cloned to the desktop window and JSON-encoded for every Web UI and SDK
// socket, for a heartbeat whose only news was a CPU reading.
//
// Instead, a change only marks the client as dirty here. Every
// CLIENT_PUSH_INTERVAL_MS the dirty set is flushed once to each registered
// surface, which decides what to send:
//
//   - desktop window and Web UI: one batched internal message (ClientPatches)
//     carrying, per client, only the fields whose value changed since that
//     surface's last push (see DiffIntoBaseline). Both ship with the server, so
//     the message is free to change shape.
//   - SDK: the same `ClientUpdated` event with the same full ToPublicClient
//     payload as always, at most once per client per flush, with its latest
//     state. External consumers see an unchanged contract, minus the redundant
//     intermediate states of a burst.
//
// The public projection is computed at most once per client per flush and
// shared by the Web UI and SDK surfaces, and only when one of them asks.
import type { ClientView } from '@showtrak/protocol';
import { ToPublicClient } from './serializers';

export type PushClient = Parameters<typeof ToPublicClient>[0];

export interface ClientPushBatch {
  /** The clients that changed since the last flush, each at its latest state. */
  readonly Clients: readonly PushClient[];
  /** ToPublicClient of Clients[Index]; projected once per flush, then shared. */
  PublicOf(Index: number): ClientView;
}

export type ClientPushSink = (Batch: ClientPushBatch) => void;

/**
 * A patch for one client: its UUID, every field whose value changed, and the
 * names of any fields the source no longer has. Values are compared by
 * reference, which is exact for the client's fields: every view is rebuilt
 * into a new object when it changes and left alone when it does not.
 */
export interface ClientPatch {
  UUID: string;
  $Removed?: string[];
  [Field: string]: unknown;
}

/** How long a change may wait before it is pushed. */
export const CLIENT_PUSH_INTERVAL_MS = 250;

const Queued = new Map<string, PushClient>();
const Sinks = new Set<ClientPushSink>();
let Timer: ReturnType<typeof setTimeout> | null = null;

/** Mark a client as changed; it is pushed with the next flush. */
export function QueueClientPush(Client: PushClient | null | undefined): void {
  if (!Client || typeof Client.UUID !== 'string' || !Client.UUID) return;
  Queued.set(Client.UUID, Client);
  if (Timer) return;
  Timer = setTimeout(FlushClientPushes, CLIENT_PUSH_INTERVAL_MS);
  if (typeof Timer.unref === 'function') Timer.unref();
}

/**
 * Push every queued client now. Called by the timer, and directly before a
 * full client list goes out so that no queued (older) patch can land after it.
 */
export function FlushClientPushes(): void {
  if (Timer) {
    clearTimeout(Timer);
    Timer = null;
  }
  if (Queued.size === 0) return;
  const Clients = Array.from(Queued.values());
  Queued.clear();
  const Projected: Array<ClientView | undefined> = new Array(Clients.length);
  const Batch: ClientPushBatch = {
    Clients,
    PublicOf(Index: number): ClientView {
      let View = Projected[Index];
      if (!View) {
        View = ToPublicClient(Clients[Index]!);
        Projected[Index] = View;
      }
      return View;
    },
  };
  for (const Sink of Sinks) {
    try {
      Sink(Batch);
    } catch {
      // One failing surface must not cost the others their update.
    }
  }
}

/** Register a surface. Returns an unsubscribe handle. */
export function RegisterClientPushSink(Sink: ClientPushSink): () => void {
  Sinks.add(Sink);
  return () => {
    Sinks.delete(Sink);
  };
}

/** Drop anything queued without pushing it (tests, teardown). */
export function ResetClientPushes(): void {
  if (Timer) {
    clearTimeout(Timer);
    Timer = null;
  }
  Queued.clear();
}

const HasOwn = (Target: object, Key: string) => Object.prototype.hasOwnProperty.call(Target, Key);

/**
 * Bring `Baseline` (what a surface last received for one client) in line with
 * `Source`, and return what changed as a patch, or null when nothing did.
 * `Baseline` is updated in place. Fields named in `Skip` are never sent, and
 * are treated as absent.
 */
export function DiffIntoBaseline(
  UUID: string,
  Baseline: Record<string, unknown>,
  Source: object,
  Skip?: ReadonlySet<string>
): ClientPatch | null {
  let Patch: ClientPatch | null = null;
  const Fields = Source as Record<string, unknown>;
  for (const Key of Object.keys(Fields)) {
    if (Skip && Skip.has(Key)) continue;
    const Value = Fields[Key];
    if (Baseline[Key] === Value && HasOwn(Baseline, Key)) continue;
    Baseline[Key] = Value;
    if (!Patch) Patch = { UUID };
    Patch[Key] = Value;
  }
  for (const Key of Object.keys(Baseline)) {
    if (HasOwn(Fields, Key) && !(Skip && Skip.has(Key))) continue;
    delete Baseline[Key];
    if (!Patch) Patch = { UUID };
    (Patch.$Removed ??= []).push(Key);
  }
  return Patch;
}
