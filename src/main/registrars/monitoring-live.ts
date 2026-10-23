// IPC registrar: live levels for an open monitor view, desktop side. The Web UI
// opens the same stream over its own socket events (webui-namespace.ts) because
// streaming has to target the one socket that asked, which the shared rpc bridge
// cannot see — it passes a null event.

import { RPC } from '../rpc';
import { CloseMonitorLiveLevels, OpenMonitorLiveLevels } from '../monitoring-live';

interface LiveSender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}

// Senders with teardown hooks attached, so reopening does not stack listeners.
const Tracked = new Map<number, () => void>();

function SenderOf(event: unknown): LiveSender | null {
  const Sender = event ? (event as { sender?: LiveSender }).sender : undefined;
  return Sender && typeof Sender.send === 'function' ? Sender : null;
}

function KeyOf(Sender: LiveSender): string {
  return `desktop:${Sender.id}`;
}

// A reload or a destroyed window never sends Close, and a held stream can keep a
// device's only control connection busy, so stop on either.
function Track(Sender: LiveSender): void {
  if (Tracked.has(Sender.id)) return;
  const Release = () => {
    Sender.removeListener('destroyed', Release);
    Sender.removeListener('did-navigate', Release);
    Tracked.delete(Sender.id);
    CloseMonitorLiveLevels(KeyOf(Sender));
  };
  Tracked.set(Sender.id, Release);
  Sender.once('destroyed', Release);
  Sender.once('did-navigate', Release);
}

function register(): void {
  RPC.handle('MonitorLiveLevels:Open', async (event: unknown, TargetID: unknown) => {
    const Sender = SenderOf(event);
    if (!Sender) return null;
    Track(Sender);
    return OpenMonitorLiveLevels(KeyOf(Sender), TargetID, (Snapshot) => {
      if (Sender.isDestroyed()) throw new Error('Sender destroyed');
      Sender.send('MonitorLiveLevels:Frames', Snapshot);
    });
  });

  RPC.handle('MonitorLiveLevels:Close', async (event: unknown) => {
    const Sender = SenderOf(event);
    if (!Sender) return null;
    const Release = Tracked.get(Sender.id);
    if (Release) Release();
    else CloseMonitorLiveLevels(KeyOf(Sender));
    return null;
  });
}

export { register };
