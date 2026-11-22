// IPC registrar: live levels for an open monitor view, desktop side. The Web UI
// opens the same stream over its own socket events (webui-namespace.ts) because
// streaming has to target the one socket that asked, which the shared rpc bridge
// cannot see; it passes a null event.

import { RPC } from '../rpc';
import { CreateStreamTracker, StreamKeyOf, StreamSenderOf } from '../ipc/desktop-streams';
import { Manager as MonitoringTargetManager } from '../../Modules/MonitoringTargetManager';
import type { MonitorLiveLevelChange, MonitorLiveLevelResult } from '@showtrak/protocol';
import {
  CloseMonitorLiveLevels,
  CloseMonitorTileLevels,
  OpenMonitorLiveLevels,
  OpenMonitorTileLevels,
} from '../monitoring-live';

// A reload or a destroyed window never sends Close, and a held stream can keep a
// device's only control connection busy, so stop on either.
const Windows = CreateStreamTracker((Key) => {
  CloseMonitorLiveLevels(Key);
  CloseMonitorTileLevels(Key);
});

// Exactly one of a fader level (finite number, or null for −∞) or a mute.
function ParseChange(Change: unknown): MonitorLiveLevelChange | null {
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
    const Sender = StreamSenderOf(event);
    if (!Sender) return null;
    Windows.Track(Sender);
    return OpenMonitorLiveLevels(StreamKeyOf(Sender), TargetID, (Snapshot) => {
      if (Sender.isDestroyed()) throw new Error('Sender destroyed');
      Sender.send('MonitorLiveLevels:Frames', Snapshot);
    });
  });

  RPC.handle('MonitorLiveLevels:Close', async (event: unknown) => {
    const Sender = StreamSenderOf(event);
    if (Sender) CloseMonitorLiveLevels(StreamKeyOf(Sender));
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
    ): Promise<MonitorLiveLevelResult> => {
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
    const Sender = StreamSenderOf(event);
    if (!Sender) return null;
    Windows.Track(Sender);
    return OpenMonitorTileLevels(StreamKeyOf(Sender), (Snapshot) => {
      if (Sender.isDestroyed()) throw new Error('Sender destroyed');
      Sender.send('MonitorTileLevels:Frames', Snapshot);
    });
  });

  RPC.handle('MonitorTileLevels:Close', async (event: unknown) => {
    const Sender = StreamSenderOf(event);
    if (Sender) CloseMonitorTileLevels(StreamKeyOf(Sender));
    return null;
  });
}

export { register };
