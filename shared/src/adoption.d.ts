// Adoption handshake + lifecycle payloads.

/** Query string a client sends in its Socket.IO handshake. */
export interface ClientHandshakeQuery {
  UUID: string;
  /** Sent as the string `'true'`/`'false'` over the wire. */
  Adopted: boolean | 'true' | 'false';
  ExpectedServerIdentity?: string;
}

/** Payload of the 10s `AdoptionHeartbeat` event from unadopted clients. */
export interface AdoptionHeartbeatPayload {
  BootTime: number;
  Hostname: string;
  OperatingSystem: string;
  Version: string;
  ServerIdentity?: string;
}

/** Server -> client `Unadopt` payload. */
export interface UnadoptPayload {
  Reason: string | null;
  ServerIdentity: string | null;
}

/** Server -> client `Identify` payload. */
export interface IdentifyPayload {
  Nickname?: string | null;
}
