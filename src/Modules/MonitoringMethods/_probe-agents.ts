// Keep-alive HTTP agents scoped to ONE probe.
//
// The HTTP clients send `Connection: close`, so a method that makes several
// requests per probe (UniFi: info, sites, devices, clients; Luminex: device,
// ports, PoE) opened a fresh TCP connection, and over HTTPS a full TLS
// handshake, for each one. Requests given a ProbeAgents reuse one connection per
// protocol for the rest of the probe instead. The probe destroys its agents when
// it ends, so no connection outlives the probe: an idle device never holds a
// socket of ours between polls, and a device's own connection limit sees the
// same one-connection-per-probe it always did.
import http from 'http';
import https from 'https';

export class ProbeAgents {
  private HttpAgent: http.Agent | null = null;
  private HttpsAgent: https.Agent | null = null;
  private Destroyed = false;

  // The agent for this URL's protocol, created on first use. Undefined once the
  // probe has ended (a straggling request then gets its own connection).
  For(Url: URL): http.Agent | undefined {
    if (this.Destroyed) return undefined;
    // A stand-in http/https module (tests) may have no Agent: no reuse then.
    if (Url.protocol === 'https:') {
      if (!this.HttpsAgent && typeof https.Agent === 'function') {
        this.HttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
      }
      return this.HttpsAgent || undefined;
    }
    if (!this.HttpAgent && typeof http.Agent === 'function') {
      this.HttpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    }
    return this.HttpAgent || undefined;
  }

  Destroy(): void {
    this.Destroyed = true;
    if (this.HttpAgent) this.HttpAgent.destroy();
    if (this.HttpsAgent) this.HttpsAgent.destroy();
    this.HttpAgent = null;
    this.HttpsAgent = null;
  }
}

// Run `Fn` with agents that are destroyed when it settles, however it settles.
export async function WithProbeAgents<T>(Fn: (Agents: ProbeAgents) => Promise<T>): Promise<T> {
  const Agents = new ProbeAgents();
  try {
    return await Fn(Agents);
  } finally {
    Agents.Destroy();
  }
}
