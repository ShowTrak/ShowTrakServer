// Type-to-search in a menu: typing jumps to the next item whose title matches.
// Pure functions over the buffer state and the item titles, so the rules can be
// tested without a DOM.

/** Keys typed within this long of each other extend the search; a longer pause starts a new one. */
export const TYPEAHEAD_PAUSE_MS = 700;
const MAX_BUFFER = 64;

/**
 * The search text after a key press. Repeating a single letter keeps it as that
 * one letter, so pressing "s" again moves on to the next item starting with "s"
 * rather than searching for "ss".
 */
export function NextTypeaheadBuffer(
  Previous: string,
  PreviousAt: number,
  Key: string,
  Now: number
): string {
  const Lower = Key.toLowerCase();
  if (Now - PreviousAt > TYPEAHEAD_PAUSE_MS) return Lower;
  if (Previous.length === 1 && Previous === Lower) return Lower;
  return (Previous + Lower).slice(0, MAX_BUFFER);
}

/**
 * The index of the item to focus, searching onward from the one after `Current`
 * and wrapping: an item whose title starts with the search text first, else one
 * that contains it. -1 when none matches. Titles are compared lower-cased.
 */
export function FindTypeaheadMatch(Titles: string[], Search: string, Current: number): number {
  if (!Titles.length) return -1;
  const Start = (Current >= 0 ? Current + 1 : 0) % Titles.length;
  for (const Matches of [
    (Title: string) => Title.startsWith(Search),
    (Title: string) => Title.includes(Search),
  ]) {
    for (let Step = 0; Step < Titles.length; Step++) {
      const Index = (Start + Step) % Titles.length;
      if (Matches(Titles[Index]!)) return Index;
    }
  }
  return -1;
}
