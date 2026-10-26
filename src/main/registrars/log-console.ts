// IPC registrar: the hidden log console and its Rainbow Mode toggle, desktop
// side. The Web UI opens the same console over its own socket events
// (webui-namespace.ts) because streaming has to target the one socket that
// asked, which the shared rpc bridge cannot see: it passes a null event. The
// web rpc allowlist does not include these channels.

import { RPC } from '../rpc';
import { CloseLogConsole, OpenLogConsole } from '../log-console';
import { GetRainbowMode, SetRainbowMode } from '../rainbow-mode';

interface ConsoleSender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}

// Senders with teardown hooks attached, so reopening does not stack listeners.
const Tracked = new Map<number, () => void>();

function SenderOf(event: unknown): ConsoleSender | null {
  const Sender = event ? (event as { sender?: ConsoleSender }).sender : undefined;
  return Sender && typeof Sender.send === 'function' ? Sender : null;
}

function KeyOf(Sender: ConsoleSender): string {
  return `desktop:${Sender.id}`;
}

// A reload or a destroyed window never sends Close, so stop streaming to it on
// either. 'did-navigate' fires for main-frame navigations only, i.e. reloads.
function Track(Sender: ConsoleSender): void {
  if (Tracked.has(Sender.id)) return;
  const Release = () => {
    Sender.removeListener('destroyed', Release);
    Sender.removeListener('did-navigate', Release);
    Tracked.delete(Sender.id);
    CloseLogConsole(KeyOf(Sender));
  };
  Tracked.set(Sender.id, Release);
  Sender.once('destroyed', Release);
  Sender.once('did-navigate', Release);
}

function register(): void {
  RPC.handle('LogConsole:Open', async (event: unknown, Level: unknown) => {
    const Sender = SenderOf(event);
    if (!Sender) return null;
    Track(Sender);
    return OpenLogConsole(KeyOf(Sender), Level, (Entries) => {
      if (Sender.isDestroyed()) throw new Error('Sender destroyed');
      Sender.send('LogConsole:Entries', Entries);
    });
  });

  RPC.handle('LogConsole:Close', async (event: unknown) => {
    const Sender = SenderOf(event);
    if (!Sender) return null;
    const Release = Tracked.get(Sender.id);
    if (Release) Release();
    else CloseLogConsole(KeyOf(Sender));
    return null;
  });

  // Rainbow Mode, the console's easter egg (see rainbow-mode.ts).
  RPC.handle('RainbowMode:Get', async () => GetRainbowMode());
  RPC.handle('RainbowMode:Set', async (_event: unknown, Enabled: unknown) =>
    SetRainbowMode(Enabled)
  );
}

export { register };
