// Streams a desktop window opens over IPC (the log console, a monitor's live
// levels): pushed to the one window that asked, so they are keyed by it. The
// Web UI opens the same streams over its own socket events (webui-namespace.ts),
// because the shared rpc bridge cannot see which socket asked: it passes a null
// event.
//
// A reload or a destroyed window never sends Close, and a held stream can keep
// a device's only control connection busy, so a tracked window's streams are
// released on either.

export interface StreamSender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}

/** The window that sent an IPC request, when it can be streamed to. */
export function StreamSenderOf(event: unknown): StreamSender | null {
  const Sender = event ? (event as { sender?: StreamSender }).sender : undefined;
  return Sender && typeof Sender.send === 'function' ? Sender : null;
}

/** The key a desktop window's streams are held under. */
export function StreamKeyOf(Sender: StreamSender): string {
  return `desktop:${Sender.id}`;
}

export interface StreamTracker {
  /** Release the window's streams when it reloads or is destroyed. Idempotent. */
  Track(Sender: StreamSender): void;
  /** Release them now (an explicit Close), and stop tracking the window. */
  Release(Sender: StreamSender): void;
}

/** Track windows whose streams `Close` releases, by their key. */
export function CreateStreamTracker(Close: (Key: string) => void): StreamTracker {
  // Senders with teardown hooks attached, so reopening does not stack listeners.
  const Tracked = new Map<number, () => void>();
  return {
    Track(Sender) {
      if (Tracked.has(Sender.id)) return;
      // 'did-navigate' fires for main-frame navigations only, i.e. reloads.
      const Release = () => {
        Sender.removeListener('destroyed', Release);
        Sender.removeListener('did-navigate', Release);
        Tracked.delete(Sender.id);
        Close(StreamKeyOf(Sender));
      };
      Tracked.set(Sender.id, Release);
      Sender.once('destroyed', Release);
      Sender.once('did-navigate', Release);
    },
    Release(Sender) {
      const Release = Tracked.get(Sender.id);
      if (Release) Release();
      else Close(StreamKeyOf(Sender));
    },
  };
}
