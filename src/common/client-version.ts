// Gating a feature on the ShowTrak Client release that reported it. Both
// processes ask: the server before it sends a client a command, the renderer
// before it offers the control. Compiled into both programs: no Node and no DOM
// here.

// The first Client release with each feature both processes gate on. Each MUST
// match the Client version that ships the feature.

/** Identify (flash the client's screen on request). */
export const MINIMUM_IDENTIFY_VERSION: readonly [number, number, number] = [3, 7, 0];

/**
 * Reports audio endpoints and accepts remote level changes. Anything older has
 * no audio monitor at all: its Audio section reads as unsupported and level
 * changes are refused before anything is sent, rather than waiting out a
 * timeout.
 */
export const MINIMUM_AUDIO_MONITORING_VERSION: readonly [number, number, number] = [3, 21, 0];

/**
 * Reports battery/mains, sleep and resume, temperatures, hung applications and
 * the foreground application. Older clients read as "update the client" for
 * these rather than as unsupported hardware.
 */
export const MINIMUM_SYSTEM_HEALTH_VERSION: readonly [number, number, number] = [3, 22, 0];

/**
 * The first major.minor.patch in a reported version ("3.21.0", "v3.22.1-beta",
 * "ShowTrak 3.7.0"), or null when there is none.
 */
export function ParseVersionTuple(Value: unknown): [number, number, number] | null {
  const Match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/.exec(String(Value || '').trim());
  if (!Match) return null;
  return [Number(Match[1]), Number(Match[2]), Number(Match[3])];
}

/**
 * Whether a reported version is at least `Minimum`, compared numerically. An
 * unparseable version counts as too old: a client that cannot say what it is
 * gets no feature that depends on it, the safe reading for "send this machine a
 * command".
 */
export function IsVersionAtLeast(Value: unknown, Minimum: readonly number[]): boolean {
  const Parsed = ParseVersionTuple(Value);
  if (!Parsed) return false;
  for (let Index = 0; Index < Minimum.length; Index += 1) {
    const Current = Parsed[Index] || 0;
    const Required = Minimum[Index] || 0;
    if (Current !== Required) return Current > Required;
  }
  return true;
}
