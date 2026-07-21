// MAC address normalization and eligibility rules, shared by the ingest path
// (ClientManager), the manual-entry path (client editor) and Wake-on-LAN.
//
// Everything stored in ClientMacAddresses passes through Normalize first, so the
// (UUID, MacAddress) primary key de-duplicates an address regardless of whether
// it arrived as `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff` or `aabbccddeeff`.

/** The all-zero MAC. Interfaces without real hardware (loopback, some tunnels and
 *  virtual adapters) report this rather than omitting the field. */
const ZERO_MAC = '00:00:00:00:00:00';

/**
 * Normalize a MAC to upper-case colon-separated form, or null if it is not a
 * syntactically valid 48-bit MAC. Accepts colon-, dash- and dot-separated input
 * as well as bare hex.
 */
export function NormalizeMacAddress(Value: unknown): string | null {
  if (typeof Value !== 'string' && typeof Value !== 'number') return null;
  const Hex = String(Value)
    .trim()
    .replace(/[:\-.\s]/g, '')
    .toUpperCase();
  if (Hex.length !== 12 || /[^0-9A-F]/.test(Hex)) return null;
  return (Hex.match(/.{2}/g) as string[]).join(':');
}

/**
 * Whether a MAC belongs to a physical, externally-reachable interface — i.e. one
 * worth storing and firing a magic packet at.
 *
 * Rejects, in order:
 *  - anything that is not a valid MAC;
 *  - the all-zero MAC, which loopback and address-less interfaces report;
 *  - multicast/broadcast MACs (least-significant bit of the first octet set).
 *    These are never a NIC's own hardware address;
 *  - locally-administered MACs (second-least-significant bit of the first octet
 *    set). Real NICs ship with a globally-unique, vendor-assigned (OUI) address;
 *    the locally-administered bit marks software-assigned ones — Docker bridges,
 *    VirtualBox/VMware/Hyper-V virtual adapters, and randomized Wi-Fi privacy
 *    addresses. None of those wake a machine, and randomized addresses actively
 *    pollute the table by changing on every association.
 *
 * Note this is deliberately independent of the OS `internal` flag: that flag
 * catches loopback but not virtual adapters, and the SystemInfo payload does not
 * carry it at all. Callers that DO have the flag should still honour it — the
 * two filters are complementary.
 */
export function IsExternalMacAddress(Value: unknown): boolean {
  const Mac = NormalizeMacAddress(Value);
  if (!Mac) return false;
  if (Mac === ZERO_MAC) return false;
  const FirstOctet = parseInt(Mac.slice(0, 2), 16);
  if (!Number.isFinite(FirstOctet)) return false;
  if (FirstOctet & 0b1) return false; // multicast/broadcast
  if (FirstOctet & 0b10) return false; // locally administered (virtual/randomized)
  return true;
}
