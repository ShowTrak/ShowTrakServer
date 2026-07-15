// Shared status-badge HTML fragments for the renderer tiles.
//
// The "Offline HH:MM:SS" label is rendered identically on the client, dummy and
// monitor tiles (with a 00:00:00 placeholder) and by the per-second offline
// counter that ticks it live. Keeping the markup in one place stops the four
// copies drifting apart. The time is a pre-formatted string; callers that show
// the placeholder can omit it.
export function OfflineBadgeContent(time = '00:00:00'): string {
  return `Offline <span class="badge bg-ghost">${time}</span>`;
}

// Shown in place of the offline counter on a reserved slot. Counting how long
// an empty slot has been "down" would be meaningless — it has never had a
// device — so it states what the tile is instead.
export function UnassignedBadgeContent(): string {
  return `Unassigned <span class="badge bg-ghost">No Device</span>`;
}
