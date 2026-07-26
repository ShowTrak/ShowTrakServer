// Pure client-labelling helpers (integrated-entity detection, version/hostname
// label formatting). No mutable state; shared by the client list, tiles, and
// info modal. Extracted from the old monolithic state.ts.

/** Minimal structural view of the client-like objects these label helpers accept. */
type ClientLike =
  | {
      Integrated?: boolean;
      OperatingSystem?: string | null;
      Version?: string | null;
      Nickname?: string | null;
      Hostname?: string | null;
    }
  | null
  | undefined;

export function IsIntegratedClientEntity(Client: ClientLike) {
  if (!Client) return false;
  if (Client.Integrated === true) return true;
  const OperatingSystem = String(Client.OperatingSystem || '')
    .trim()
    .toLowerCase();
  return OperatingSystem === 'integrated';
}

export function FormatClientVersionLabel(Client: ClientLike) {
  const RawVersion = String((Client && Client.Version) || '')
    .trim()
    .replace(/^v\s*/i, '');
  const Version = RawVersion.length > 0 ? RawVersion : 'Unknown';
  return `${IsIntegratedClientEntity(Client) ? 'SDK v' : 'v'}${Version}`;
}

export function FormatClientHostnameVersionLabel(Client: ClientLike) {
  const HasNickname = !!(
    Client &&
    typeof Client.Nickname === 'string' &&
    Client.Nickname.trim().length > 0
  );
  const Hostname = String((Client && Client.Hostname) || '').trim();
  const VersionLabel = FormatClientVersionLabel(Client);
  return HasNickname && Hostname.length > 0 ? `${Hostname} - ${VersionLabel}` : VersionLabel;
}
