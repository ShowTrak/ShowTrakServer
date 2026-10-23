// IPC registrar: live levels for an open monitor view, desktop side. The Web UI
// opens the same stream over its own socket events (webui-namespace.ts) because
// streaming has to target the one socket that asked, which the shared rpc bridge
// cannot see — it passes a null event.

import { RPC } from '../rpc';
import { Manager as MonitoringTargetManager } from '../../Modules/MonitoringTargetManager';
import type { LiveLevelChange } from '../../Modules/MonitoringMethods/types';
import {
  CloseMonitorLiveLevels,
  CloseMonitorTileLevels,
  OpenMonitorLiveLevels,
  OpenMonitorTileLevels,
} from '../monitoring-live';

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
    CloseMonitorTileLevels(KeyOf(Sender));
  };
  Tracked.set(Sender.id, Release);
  Sender.once('destroyed', Release);
  Sender.once('did-navigate', Release);
}

// Exactly one of a fader level (finite number, or null for −∞) or a mute.
function ParseChange(Change: unknown): LiveLevelChange | null {
  if (!Change || typeof Change !== 'object') return null;
  const C = Change as Record<string, unknown>;
  const HasFader = Object.prototype.hasOwnProperty.call(C, 'Fader');
  const HasMute = Object.prototype.hasOwnProperty.call(C, 'Muted');
  if (HasFader === HasMute) return null;
  if (HasMute) return typeof C.Muted === 'boolean' ? { Muted: C.Muted } : null;
  if (C.Fader === null) return { Fader: null };
  return typeof C.Fader === 'number' && Number.isFinite(C.Fader) ? { Fader: C.Fader } : null;
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
    if (Sender) CloseMonitorLiveLevels(KeyOf(Sender));
    return null;
  });

  // Moving a fader or mute. On the shared rpc bridge (no sender needed), so the
  // Web UI reaches it through the usual channel authorisation.
  RPC.handle(
    'MonitorLiveLevels:Set',
    async (
      _event: unknown,
      TargetID: unknown,
      CheckID: unknown,
      ChannelID: unknown,
      Change: unknown,
      Final: unknown
    ) => {
      const Change_ = ParseChange(Change);
      if (
        !Number.isInteger(Number(TargetID)) ||
        !Number.isInteger(Number(CheckID)) ||
        typeof ChannelID !== 'string' ||
        ChannelID.length > 64 ||
        !Change_
      ) {
        return { Success: false, Error: 'Invalid live control request' };
      }
      return MonitoringTargetManager.SetLiveLevel(
        Number(TargetID),
        Number(CheckID),
        ChannelID,
        Change_,
        Final === true
      );
    }
  );

  // The dashboard's tile meters. Tracked like the view, so a reload or a closed
  // window releases them too.
  RPC.handle('MonitorTileLevels:Open', async (event: unknown) => {
    const Sender = SenderOf(event);
    if (!Sender) return null;
    Track(Sender);
    return OpenMonitorTileLevels(KeyOf(Sender), (Snapshot) => {
      if (Sender.isDestroyed()) throw new Error('Sender destroyed');
      Sender.send('MonitorTileLevels:Frames', Snapshot);
    });
  });

  RPC.handle('MonitorTileLevels:Close', async (event: unknown) => {
    const Sender = SenderOf(event);
    if (Sender) CloseMonitorTileLevels(KeyOf(Sender));
    return null;
  });
}

export { register };
