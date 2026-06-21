// Integrated client action (event) normalization.
// Integrated clients declare a catalog of "actions" (events) over Socket.IO on
// connection. Because the payload originates from an external integration we
// must sanitize it before trusting it. The normalized shape is the contract
// shared with the ShowTrak Integration SDK:
//   { ID: string, Label: string, ColourIndex: 0-7, HasFeedback: boolean }
const MAX_ACTIONS = 100;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 64;
const MIN_COLOUR_INDEX = 0;
const MAX_COLOUR_INDEX = 7;

// IDs are restricted to a safe, portable character set so they can be embedded
// in routes/keys without escaping concerns.
const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

function NormalizeActionID(Value) {
  if (typeof Value !== 'string') return null;
  const Trimmed = Value.trim();
  if (!Trimmed || Trimmed.length > MAX_ID_LENGTH) return null;
  if (!ID_PATTERN.test(Trimmed)) return null;
  return Trimmed;
}

function NormalizeLabel(Value, Fallback) {
  if (typeof Value !== 'string') return Fallback;
  const Trimmed = Value.trim();
  if (!Trimmed) return Fallback;
  return Trimmed.slice(0, MAX_LABEL_LENGTH);
}

function NormalizeColourIndex(Value) {
  const Parsed = typeof Value === 'number' ? Value : parseInt(Value, 10);
  if (!Number.isInteger(Parsed)) return MAX_COLOUR_INDEX; // neutral dark grey
  if (Parsed < MIN_COLOUR_INDEX) return MIN_COLOUR_INDEX;
  if (Parsed > MAX_COLOUR_INDEX) return MAX_COLOUR_INDEX;
  return Parsed;
}

// Convert an arbitrary inbound payload into a clean, deduplicated action list.
// Invalid entries are skipped; the first occurrence of each ID wins.
function NormalizeIntegratedActions(Raw) {
  if (!Array.isArray(Raw)) return [];
  const Seen = new Set();
  const Result = [];
  for (const Entry of Raw) {
    if (!Entry || typeof Entry !== 'object') continue;
    const ID = NormalizeActionID(Entry.ID);
    if (!ID || Seen.has(ID)) continue;
    Seen.add(ID);
    Result.push({
      ID,
      Label: NormalizeLabel(Entry.Label, ID),
      ColourIndex: NormalizeColourIndex(Entry.ColourIndex),
      HasFeedback: Entry.HasFeedback === true,
    });
    if (Result.length >= MAX_ACTIONS) break;
  }
  return Result;
}

module.exports = {
  NormalizeIntegratedActions,
  MAX_COLOUR_INDEX,
};
