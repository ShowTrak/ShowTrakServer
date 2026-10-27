// Pure check suggestions for a device found by LAN discovery.
//
// The scan reports evidence (open TCP ports, mDNS services, a PJLink reply);
// each monitoring method declares what its devices look like on the wire
// (MonitoringMethodView.Discovery). This matches one against the other and
// ranks the result, so the wizard can offer the most likely check first and
// pre-fill the settings it learned. No DOM, so it is tested directly.

import type { MonitoringMethodView } from '@showtrak/protocol';

/** What a scan learned about one address, merged across sources. */
export interface DeviceEvidence {
  OpenPorts?: number[];
  Services?: Array<{ type: string; port: number | null; name?: string | null }>;
  // Answered PJLink's UDP search.
  PJLink?: boolean;
}

export interface CheckSuggestion {
  Method: string;
  Name: string;
  Confidence: 'high' | 'medium' | 'low';
  // Why it was suggested, e.g. 'Port 9993 open'.
  Reason: string;
  // Settings learned from the evidence (the port it was found on, the device's
  // advertised name).
  Settings: Record<string, unknown>;
  // A required setting is still empty, so the check will not run until it is
  // filled in.
  NeedsSetup: boolean;
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

// The suggestion every live host gets, ranked last.
export const FALLBACK_METHOD = 'ping';

function NormaliseServiceType(Value: unknown): string {
  return String(Value || '')
    .trim()
    .toLowerCase();
}

function MissingRequiredSetting(
  Method: MonitoringMethodView,
  Settings: Record<string, unknown>
): boolean {
  return (Method.Settings || []).some((Field) => {
    if (!Field.Required) return false;
    const Value = Field.Key in Settings ? Settings[Field.Key] : Field.Default;
    return Value == null || (typeof Value === 'string' && !Value.trim());
  });
}

function MatchMethod(
  Method: MonitoringMethodView,
  Evidence: DeviceEvidence
): CheckSuggestion | null {
  const Discovery = Method.Discovery;
  if (!Discovery) return null;

  const Reasons: string[] = [];
  let Port: number | null = null;
  let ServiceName: string | null = null;
  let ServiceType: string | null = null;

  if (Discovery.PJLink && Evidence.PJLink) Reasons.push('Answered PJLink search');

  const WantedTypes = Discovery.ServiceTypes || [];
  for (const Service of Evidence.Services || []) {
    const Wanted = WantedTypes.find(
      (Type) => NormaliseServiceType(Type) === NormaliseServiceType(Service.type)
    );
    if (!Wanted) continue;
    Reasons.push(`Advertises ${Service.type}`);
    ServiceType = Wanted;
    if (Service.port) Port = Service.port;
    if (Service.name) ServiceName = Service.name;
    break;
  }

  const OpenPorts = Evidence.OpenPorts || [];
  const OpenMatch = (Discovery.TcpPorts || []).find((Candidate) => OpenPorts.includes(Candidate));
  if (OpenMatch != null) {
    Reasons.push(`Port ${OpenMatch} open`);
    // A probed port is what the check will connect to, so it beats an
    // advertised one when both exist.
    Port = OpenMatch;
  }

  if (!Reasons.length) return null;

  const Settings: Record<string, unknown> = {
    ...(ServiceType && Discovery.ServiceSettings?.[ServiceType]),
    // The port is what the check connects to, so its implications win.
    ...(Port != null && Discovery.PortSettings?.[String(Port)]),
  };
  if (Discovery.PortSetting && Port != null) {
    const Field = (Method.Settings || []).find((F) => F.Key === Discovery.PortSetting);
    if (Field && Field.Default !== Port) Settings[Discovery.PortSetting] = Port;
  }
  if (Discovery.NameSetting && ServiceName) Settings[Discovery.NameSetting] = ServiceName;

  return {
    Method: Method.ID,
    Name: Method.Name,
    Confidence: Discovery.Confidence,
    Reason: Reasons.join(' · '),
    Settings,
    NeedsSetup: MissingRequiredSetting(Method, Settings),
  };
}

/**
 * Every check that matches the evidence, most likely first, ending with Ping
 * (when installed) so a live host always has something to add.
 *
 * Ranked by declared confidence, then by how many independent signals agreed
 * (an advertised service AND an open port beats either alone), then by the
 * catalogue's own order so ties are stable.
 */
export function SuggestChecks(
  Evidence: DeviceEvidence,
  Methods: readonly MonitoringMethodView[]
): CheckSuggestion[] {
  const Matches = Methods.map((Method, Index) => ({ Index, Match: MatchMethod(Method, Evidence) }))
    .filter((Entry): Entry is { Index: number; Match: CheckSuggestion } => Entry.Match != null)
    .filter((Entry) => Entry.Match.Method !== FALLBACK_METHOD);

  Matches.sort((A, B) => {
    const ByConfidence = CONFIDENCE_RANK[B.Match.Confidence] - CONFIDENCE_RANK[A.Match.Confidence];
    if (ByConfidence) return ByConfidence;
    const BySignals = B.Match.Reason.split(' · ').length - A.Match.Reason.split(' · ').length;
    if (BySignals) return BySignals;
    return A.Index - B.Index;
  });

  const Out = Matches.map((Entry) => Entry.Match);
  const Fallback = Methods.find((Method) => Method.ID === FALLBACK_METHOD);
  if (Fallback) {
    Out.push({
      Method: Fallback.ID,
      Name: Fallback.Name,
      Confidence: 'low',
      Reason: 'Reachability only',
      Settings: {},
      NeedsSetup: false,
    });
  }
  return Out;
}
