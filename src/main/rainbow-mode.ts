// Rainbow Mode: an undocumented easter egg toggled from the hidden log console.
//
// One flag for the whole server, shared by the desktop window and every open
// Web UI. It lives in memory only (not a setting, not in the show file), so
// every boot starts with it off. Changes ride the renderer bus; the Web UI push
// allowlist carries the channel, the SDK's deliberately does not.

import { PushToRenderers } from './renderer-bus';

let Enabled = false;

export function GetRainbowMode(): boolean {
  return Enabled;
}

/** Set the flag and tell every surface. Returns the new state. */
export function SetRainbowMode(Value: unknown): boolean {
  const Next = Value === true;
  if (Next !== Enabled) {
    Enabled = Next;
    PushToRenderers('RainbowModeUpdated', Enabled);
  }
  return Enabled;
}
