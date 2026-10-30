// Shared push fan-out for the Web UI (`/ui`) and SDK (`/sdk`) renderer sinks.
//
// `socket.emit` encodes the packet separately for every socket, so a client
// heartbeat pushed to M sockets was JSON-encoded M times. A namespace broadcast
// encodes once and writes the same bytes to each socket. Socket.IO puts every
// socket in a room named after its own id, so broadcasting to the chosen ids
// keeps the exact per-socket selection (e.g. authed only) with no room
// bookkeeping. The wire format is unchanged: receivers cannot tell the two
// apart, so older SDK and Companion consumers are unaffected.

interface FanoutSocket {
  id?: string;
  emit(channel: string, ...args: unknown[]): unknown;
}

interface FanoutNamespace {
  to?: (rooms: string | string[]) => { emit(channel: string, ...args: unknown[]): unknown };
}

function EmitToSockets(
  ns: FanoutNamespace,
  sockets: FanoutSocket[],
  channel: string,
  payload: unknown[]
): void {
  if (sockets.length === 0) return;
  const Ids = sockets.map((s) => s.id);
  const CanBroadcast =
    sockets.length > 1 &&
    typeof ns.to === 'function' &&
    Ids.every((Id): Id is string => typeof Id === 'string' && Id.length > 0);
  if (CanBroadcast) {
    try {
      ns.to!(Ids as string[]).emit(channel, ...payload);
    } catch {
      // Best-effort like the per-socket path: a failed push is dropped, never
      // retried per socket (which could deliver it twice).
    }
    return;
  }
  for (const Socket of sockets) {
    try {
      Socket.emit(channel, ...payload);
    } catch {
      /* one dead/closing socket must not block the push to the rest */
    }
  }
}

export { EmitToSockets };
export type { FanoutSocket, FanoutNamespace };
