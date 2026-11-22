// The first checks a method's Run() makes of the address and port it parsed
// from its target, worded the same for every method.

/** Why the address or port cannot be used, or null when both can. */
export function AddressPortError(Config: { Address: string; Port: number }): string | null {
  if (!Config.Address) return 'No address configured';
  if (Config.Port < 1 || Config.Port > 65535) return `Invalid port: ${Config.Port}`;
  return null;
}
