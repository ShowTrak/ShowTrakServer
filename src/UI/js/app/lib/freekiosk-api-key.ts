// What a FreeKiosk save does to the terminal's API key.
//
// The desktop editor is handed the stored key, so its field is the whole truth:
// whatever is in it is what the terminal ends up with, and emptying it clears
// the key. The Web UI (and anything else not trusted with the key) is handed
// only HasApiKey, so its field starts blank even when a key is stored — and
// treating that blank as "clear" wiped the key on every save. With the key
// withheld, a blank field keeps the stored key, and removing it takes an
// explicit request.

export interface ApiKeyFieldState {
  /** What is typed in the field (untrimmed is fine). */
  Typed: string;
  /** A key is stored but this form was not given it. */
  Withheld: boolean;
  /** The operator asked to remove the withheld key. */
  ClearRequested: boolean;
}

/** The ApiKey / ClearApiKey part of the update payload; empty leaves the key alone. */
export function ApiKeyPayload(State: ApiKeyFieldState): {
  ApiKey?: string;
  ClearApiKey?: true;
} {
  const Typed = String(State.Typed || '').trim();
  if (Typed) return { ApiKey: Typed };
  if (State.Withheld && !State.ClearRequested) return {};
  return { ClearApiKey: true };
}
