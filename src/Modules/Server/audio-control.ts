// Remote audio level/mute control: the server half of `SetAudioLevel`.
//
// Kept apart from Server/index.ts (which binds a port at load) so it can be
// exercised with a fake Socket.IO server. Every refusal the server can work out
// for itself is made HERE, before anything is sent: an outdated client, an
// offline one, an endpoint it never reported, or a control its platform does not
// offer. The client re-checks all of it — it is the authority on its own
// hardware — but an operator should hear "macOS can only change the default
// output" at once, not after a round trip.
import type { AudioLevelResult, AudioLevelRequest } from '@showtrak/protocol';
import { AUDIO_LEVEL_TIMEOUT_MS, MINIMUM_AUDIO_MONITORING_VERSION } from '../Config/constants';
import {
  AudioPlatformLabel,
  IsClientVersionAtLeast,
  audioControlRefusal,
  type ObservedAudio,
} from '../ClientManager/audio';
import { Ok, Fail } from '../Utils';
import type { Result } from '../../types/result';

/** The parts of a Client this needs. */
export interface AudioControlClient {
  UUID: string;
  Online: boolean;
  Integrated: boolean;
  Version: string | null;
  ObservedAudio: ObservedAudio;
}

/**
 * The room broadcast with an acknowledgement timeout, as Socket.IO v4 exposes it:
 * the callback gets an error if any socket in the room failed to answer in time,
 * and the list of answers it did get.
 */
export interface AudioControlIO {
  to(room: string): {
    timeout(ms: number): {
      emit(
        event: 'SetAudioLevel',
        request: AudioLevelRequest,
        callback: (error: unknown, responses: AudioLevelResult[]) => void
      ): unknown;
    };
  };
}

export interface AudioControlDeps {
  io: AudioControlIO;
  GetClient(UUID: string): Promise<Result<AudioControlClient>>;
  TimeoutMs?: number;
}

export const MINIMUM_AUDIO_VERSION_LABEL = MINIMUM_AUDIO_MONITORING_VERSION.join('.');

export async function SendAudioLevel(
  Deps: AudioControlDeps,
  UUID: string,
  Request: AudioLevelRequest
): Promise<Result<boolean>> {
  const [Err, Client] = await Deps.GetClient(UUID);
  if (Err || !Client) return Fail(Err ? String(Err) : 'Client not found');
  if (Client.Integrated) return Fail('Audio control is not available for SDK clients');
  if (!IsClientVersionAtLeast(Client.Version, MINIMUM_AUDIO_MONITORING_VERSION)) {
    return Fail(
      `Audio control needs ShowTrak Client ${MINIMUM_AUDIO_VERSION_LABEL} or later` +
        (Client.Version ? ` (this client runs ${Client.Version})` : '')
    );
  }
  if (!Client.Online) return Fail('Client is not online');

  const Audio = Client.ObservedAudio;
  const Endpoint = Audio.Endpoints.find((Entry) => Entry.EndpointID === Request.EndpointID);
  if (!Endpoint) return Fail('That audio device is not connected to this client');
  const Refusal = audioControlRefusal(
    Endpoint,
    Audio.Capabilities,
    Request,
    AudioPlatformLabel(Audio.Status.Platform)
  );
  if (Refusal) return Fail(Refusal);

  const Responses = await new Promise<AudioLevelResult[] | null>((resolve) => {
    try {
      Deps.io
        .to(UUID)
        .timeout(Deps.TimeoutMs ?? AUDIO_LEVEL_TIMEOUT_MS)
        .emit('SetAudioLevel', Request, (Error_, Replies) => {
          resolve(Error_ ? null : Array.isArray(Replies) ? Replies : []);
        });
    } catch {
      resolve(null);
    }
  });
  if (!Responses || !Responses.length) {
    return Fail('The client did not confirm the change in time');
  }
  // One machine can briefly hold two sockets across a reconnect; any one that
  // applied the change means it was applied.
  const Applied = Responses.find((Reply) => Reply && Reply.Success === true);
  if (Applied) return Ok(true);
  const First = Responses.find((Reply) => Reply && typeof Reply.Error === 'string');
  return Fail((First && First.Error) || 'The client could not change the audio level');
}
