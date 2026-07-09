// Shared primitive types used across ShowTrak wire payloads.

/**
 * Map of network-interface name to MAC address, as reported by the client's
 * OS module (`OS.GetMacAddresses`).
 */
export type MacAddressMap = Record<string, string>;

/**
 * Deployment fingerprint for the script catalog currently applied on a client,
 * or `null` when the client has not yet applied any deployment.
 */
export type ScriptsFingerprint = string | null;

/** A unique client/device identifier (UUID string). */
export type ClientUUID = string;
