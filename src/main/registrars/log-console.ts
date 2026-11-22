// IPC registrar: the hidden log console and its Rainbow Mode toggle, desktop
// side. The Web UI opens the same console over its own socket events
// (webui-namespace.ts) because streaming has to target the one socket that
// asked, which the shared rpc bridge cannot see: it passes a null event. The
// web rpc allowlist does not include these channels.

import { RPC } from '../rpc';
import { CreateStreamTracker, StreamKeyOf, StreamSenderOf } from '../ipc/desktop-streams';
import { CloseLogConsole, OpenLogConsole } from '../log-console';
import { GetRainbowMode, SetRainbowMode } from '../rainbow-mode';

// A reload or a destroyed window never sends Close, so stop streaming to it on
// either.
const Windows = CreateStreamTracker((Key) => CloseLogConsole(Key));

function register(): void {
  RPC.handle('LogConsole:Open', async (event: unknown, Level: unknown) => {
    const Sender = StreamSenderOf(event);
    if (!Sender) return null;
    Windows.Track(Sender);
    return OpenLogConsole(StreamKeyOf(Sender), Level, (Entries) => {
      if (Sender.isDestroyed()) throw new Error('Sender destroyed');
      Sender.send('LogConsole:Entries', Entries);
    });
  });

  RPC.handle('LogConsole:Close', async (event: unknown) => {
    const Sender = StreamSenderOf(event);
    if (!Sender) return null;
    Windows.Release(Sender);
    return null;
  });

  // Rainbow Mode, the console's easter egg (see rainbow-mode.ts).
  RPC.handle('RainbowMode:Get', async () => GetRainbowMode());
  RPC.handle('RainbowMode:Set', async (_event: unknown, Enabled: unknown) =>
    SetRainbowMode(Enabled)
  );
}

export { register };
