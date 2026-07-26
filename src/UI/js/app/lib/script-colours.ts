// The shared colour palette used by anything the operator colour-codes:
// scripts, tags, and the tile badges derived from them.
//
// Extracted from script-manager.ts (a large DOM-bound module) so leaf modules —
// notably the tile tag badges, which run inside the client-list render — can
// resolve a colour without pulling the Script Manager UI in behind it.
// script-manager.ts re-exports both names, so its public surface is unchanged.

// Order matches SCRIPT_COLOURS in Modules/ScriptManager/schema.
// 0-5 rainbow, 6-7 greys.
export const SCRIPT_COLOURS = [
  { hex: '#e74c3c', label: 'Red' },
  { hex: '#e67e22', label: 'Orange' },
  { hex: '#f1c40f', label: 'Yellow' },
  { hex: '#2ecc71', label: 'Green' },
  { hex: '#3498db', label: 'Blue' },
  { hex: '#9b59b6', label: 'Purple' },
  { hex: '#bdc3c7', label: 'Light grey' },
  { hex: '#7f8c8d', label: 'Dark grey' },
];

/** Palette hex for an index, falling back to the neutral grey the backend defaults to. */
export function ScriptColourHex(Index: number | undefined) {
  const entry = Index === undefined ? undefined : SCRIPT_COLOURS[Index];
  return entry ? entry.hex : SCRIPT_COLOURS[6]!.hex; // index 6 always present (grey fallback)
}
