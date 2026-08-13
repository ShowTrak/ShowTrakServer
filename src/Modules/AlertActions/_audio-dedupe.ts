// Audio playback de-duplication shared by the two sound-playing alert actions.
//
// A single fault often satisfies several alert rules at once (a machine going
// offline can hit a per-client rule, a group rule and a tag rule in the same
// tick), and every one of those rules firing the same sound produces a smeared,
// phasing mess rather than a clear cue. Within a short window the FIRST claim on
// a given sound wins and the rest are dropped silently.
//
// De-duplication is per sound identity, not global: two DIFFERENT sounds — the
// built-in Alert and Warning tones, or two different custom assets — still play
// together, because those genuinely carry different information.
//
// The claim is deliberately synchronous. Alert actions run via Promise.allSettled
// so several Execute() calls are in flight at once; anything awaited between the
// check and the record would let two of them both decide they were first.
import { ALERT_AUDIO_DEDUPE_DEFAULT_MS, ALERT_AUDIO_DEDUPE_MAX_MS } from '../Config/constants';

// Seeded from the compiled-in default and overridable at runtime by the
// ALERT_SOUND_DEDUPE_WINDOW_MS setting (see main/live-settings).
let WindowMs = ALERT_AUDIO_DEDUPE_DEFAULT_MS;

// Sound identity -> wall-clock time it was last allowed to play.
const LastPlayedAt = new Map<string, number>();

/** De-dupe key for one of the built-in alert sounds. */
export function SoundPlaybackKey(Sound: string): string {
  return `sound:${Sound}`;
}

/** De-dupe key for an imported custom audio asset. */
export function AssetPlaybackKey(AssetID: string): string {
  return `asset:${AssetID}`;
}

export function SetAudioDedupeWindow(Value: unknown): void {
  const n = Number(Value);
  if (!Number.isFinite(n)) return;
  WindowMs = Math.min(ALERT_AUDIO_DEDUPE_MAX_MS, Math.max(0, Math.round(n)));
}

export function GetAudioDedupeWindow(): number {
  return WindowMs;
}

// An entry is spent once its window has elapsed. `Last > Now` catches a system
// clock stepping backwards, which would otherwise mute a sound until real time
// caught up again.
function IsExpired(Last: number, Now: number): boolean {
  return Last > Now || Now - Last >= WindowMs;
}

/**
 * Ask to play `Key` now. Returns true for the one caller that owns this window
 * (which also opens the next window), false for every caller suppressed by it.
 */
export function ClaimAudioPlayback(Key: string): boolean {
  const Now = Date.now();

  // The map only ever holds one entry per distinct sound, so sweeping it on
  // every claim is cheaper than tracking expiry any other way.
  for (const [Existing, Last] of LastPlayedAt) {
    if (IsExpired(Last, Now)) LastPlayedAt.delete(Existing);
  }

  // 0 disables de-duplication entirely: every trigger plays.
  if (WindowMs <= 0) return true;

  if (LastPlayedAt.has(Key)) return false;
  LastPlayedAt.set(Key, Now);
  return true;
}

/** Test seam: forget every open window. */
export function ResetAudioDedupe(): void {
  LastPlayedAt.clear();
  WindowMs = ALERT_AUDIO_DEDUPE_DEFAULT_MS;
}
