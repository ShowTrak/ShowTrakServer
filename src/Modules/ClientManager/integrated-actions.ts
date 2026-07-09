// Integrated client action (event) normalization.
import type { IntegratedAction } from '@showtrak/protocol';

const MAX_ACTIONS = 100;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 64;
const MIN_COLOUR_INDEX = 0;
const MAX_COLOUR_INDEX = 7;

// IDs are restricted to a safe, portable character set.
const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

function NormalizeActionID(Value: unknown): string | null {
  if (typeof Value !== 'string') return null;
  const Trimmed = Value.trim();
  if (!Trimmed || Trimmed.length > MAX_ID_LENGTH) return null;
  if (!ID_PATTERN.test(Trimmed)) return null;
  return Trimmed;
}

function NormalizeLabel(Value: unknown, Fallback: string): string {
  if (typeof Value !== 'string') return Fallback;
  const Trimmed = Value.trim();
  if (!Trimmed) return Fallback;
  return Trimmed.slice(0, MAX_LABEL_LENGTH);
}

function NormalizeColourIndex(Value: unknown): number {
  const Parsed = typeof Value === 'number' ? Value : parseInt(String(Value), 10);
  if (!Number.isInteger(Parsed)) return MAX_COLOUR_INDEX; // neutral dark grey
  if (Parsed < MIN_COLOUR_INDEX) return MIN_COLOUR_INDEX;
  if (Parsed > MAX_COLOUR_INDEX) return MAX_COLOUR_INDEX;
  return Parsed;
}

// Convert an arbitrary inbound payload into a clean, deduplicated action list.
function NormalizeIntegratedActions(Raw: unknown): IntegratedAction[] {
  if (!Array.isArray(Raw)) return [];
  const Seen = new Set<string>();
  const Result: IntegratedAction[] = [];
  for (const Entry of Raw) {
    if (!Entry || typeof Entry !== 'object') continue;
    const Item = Entry as Record<string, unknown>;
    const ID = NormalizeActionID(Item.ID);
    if (!ID || Seen.has(ID)) continue;
    Seen.add(ID);
    Result.push({
      ID,
      Label: NormalizeLabel(Item.Label, ID),
      ColourIndex: NormalizeColourIndex(Item.ColourIndex),
      HasFeedback: Item.HasFeedback === true,
    });
    if (Result.length >= MAX_ACTIONS) break;
  }
  return Result;
}

export { NormalizeIntegratedActions, MAX_COLOUR_INDEX };
