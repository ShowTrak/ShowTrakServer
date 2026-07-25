// Pure rules for creating unassigned (reserved) client slots.
//
// Extracted from 17-unassigned-clients.ts, which was otherwise entirely DOM
// and event wiring.
//
// An unassigned client is a placeholder row standing in for hardware that has
// not arrived yet. Two gates matter, and NEITHER is the security boundary --
// the main process re-reads the setting and re-validates the payload, and is
// the actual authority (see main-registrar-unassigned-clients.test.js). These
// exist so the operator gets a useful message instead of a rejected round trip,
// and so a disabled feature is not advertised in the menu.

export const MAX_UNASSIGNED_CLIENTS_PER_REQUEST = 64;
export const MAX_UNASSIGNED_CLIENT_NAME_LENGTH = 64;

export interface UnassignedClientRequest {
  Name: string;
  Count: number;
}

export type UnassignedClientValidation =
  { ok: true; payload: UnassignedClientRequest } | { ok: false; error: string };

/**
 * Validate a create-slots request from the modal.
 *
 * The cap exists because the count comes from a free-text number input: a
 * mistyped 1000 would flood the client list with rows the operator then has to
 * delete one at a time.
 */
export function ValidateUnassignedClientRequest(
  RawName: unknown,
  RawCount: unknown
): UnassignedClientValidation {
  const Name = String(RawName ?? '').trim();
  if (!Name) return { ok: false, error: 'Please enter a name' };
  if (Name.length > MAX_UNASSIGNED_CLIENT_NAME_LENGTH) {
    return {
      ok: false,
      error: `Name must be ${MAX_UNASSIGNED_CLIENT_NAME_LENGTH} characters or less`,
    };
  }

  const Count = Number(RawCount);
  if (!Number.isInteger(Count) || Count < 1) {
    return { ok: false, error: 'How many must be a whole number of at least 1' };
  }
  if (Count > MAX_UNASSIGNED_CLIENTS_PER_REQUEST) {
    return {
      ok: false,
      error: `You can create at most ${MAX_UNASSIGNED_CLIENTS_PER_REQUEST} at once`,
    };
  }

  return { ok: true, payload: { Name, Count } };
}

/**
 * Whether the "Create Unassigned Client" entry should appear.
 *
 * The two surfaces learn the answer differently: the desktop reads the setting,
 * while the browser cannot read settings at all and relies on the capability
 * hint the server sends at connect (which already folds in both the system and
 * the Web UI flags).
 *
 * Fails CLOSED on anything unreadable — an entry point that is offered and then
 * refused by the server is worse than one that is simply absent.
 */
export function ResolveUnassignedClientsEnabled(
  Capabilities: { isWeb?: boolean; allowUnassignedClients?: boolean } | null | undefined,
  SettingValue: unknown
): boolean {
  if (Capabilities && Capabilities.isWeb) {
    return !!Capabilities.allowUnassignedClients;
  }
  return !!SettingValue;
}

/** The message shown after a successful create, pluralised. */
export function FormatUnassignedClientsCreated(Count: unknown): string {
  const Created = Number(Count);
  const Safe = Number.isFinite(Created) ? Created : 0;
  return `Created ${Safe} unassigned client${Safe === 1 ? '' : 's'}`;
}
