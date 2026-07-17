// Brand profiles for the snmp-projector monitoring method: pure data, no I/O.
//
// There is no standard projector MIB — SNMP support is brand-specific private
// MIBs, and for several major brands the honest finding is "no useful GET
// OIDs" (their projectors are monitored via PJLink instead). Each profile
// therefore carries only what has been corroborated from real MIBs, vendor
// docs or established monitoring-tool configs (LibreNMS / Checkmk / AMX /
// cinema-nmap-scripts):
//
//   - Epson:    enterprise 1248. Lamp/light-source hours VERIFIED across
//               LibreNMS (incl. an EB-4770W walk capture), Checkmk and AMX RMS.
//   - Christie: enterprise 25766. Lamp hours VERIFIED via LibreNMS on the CP
//               (Solaria) cinema platform; Boxer/Crimson expose SNMP + traps
//               but their GET OIDs are unconfirmed.
//   - NEC:      enterprise 119. Cinema (NC) series exposes identity OIDs; no
//               lamp-hour OID is corroborated. Office/install lines: PJLink.
//   - Sony:     enterprise 122. SNMP settings exist (community/traps) but no
//               MIB or OIDs are published — MIB-II identity only.
//   - Barco:    BCI enterprise 12612. DP cinema has a (licensed) SNMP agent;
//               Pulse platform has none. MIB-II identity only here.
//   - Panasonic: PT projectors do not expose SNMP status at all — PJLink only.
//
// Profiles without a LampHoursOid behave exactly like the generic profile
// (MIB-II reachability + identity) plus an advisory note in the debug panel.
// An unanswered profile OID must NEVER degrade a check — a wrong preset on a
// reachable device is a configuration nuance, not an outage.

export type RawSnmpValue = number | string | null;

export interface ProjectorProfile {
  ID: string;
  Label: string;
  // True when every OID in the profile is corroborated by an actual MIB, walk
  // capture, or multiple independent monitoring-tool configs.
  Verified: boolean;
  // Advisory shown in the debug panel (e.g. brands that are PJLink-only).
  Note?: string;
  // Cumulative lamp / light-source hours (Integer). Absent when the brand has
  // no corroborated OID.
  LampHoursOid?: string;
}

// Standard MIB-II identity scalars — mandatory on every SNMP agent, used by
// all profiles for reachability and device identity.
export const IDENTITY_OIDS = {
  SysDescr: '1.3.6.1.2.1.1.1.0',
  SysUpTime: '1.3.6.1.2.1.1.3.0',
  SysName: '1.3.6.1.2.1.1.5.0',
};

export const DEFAULT_PROFILE = 'generic';

export const PROFILES: Record<string, ProjectorProfile> = {
  generic: {
    ID: 'generic',
    Label: 'Generic (reachability + identity)',
    Verified: true,
  },
  epson: {
    ID: 'epson',
    Label: 'Epson',
    Verified: true,
    LampHoursOid: '1.3.6.1.4.1.1248.4.1.1.1.1.0',
  },
  christie: {
    ID: 'christie',
    Label: 'Christie (CP / cinema)',
    Verified: true,
    LampHoursOid: '1.3.6.1.4.1.25766.1.12.1.1.3.5.1.6.1',
    Note: 'Verified on the CP (Solaria) cinema platform. Boxer/Crimson expose SNMP but their status OIDs are not public — pair with a PJLink check where supported.',
  },
  nec: {
    ID: 'nec',
    Label: 'NEC / Sharp',
    Verified: false,
    Note: 'NEC projectors publish no corroborated lamp-hour OID — this profile reports SNMP reachability and identity only. Use a PJLink check for status and lamp hours.',
  },
  sony: {
    ID: 'sony',
    Label: 'Sony',
    Verified: false,
    Note: 'Sony publishes no projector MIB — this profile reports SNMP reachability and identity only. Use a PJLink check for status and lamp hours.',
  },
  barco: {
    ID: 'barco',
    Label: 'Barco',
    Verified: false,
    Note: 'Barco DP cinema projectors need the licensed SNMP option; the Pulse platform has no SNMP. This profile reports reachability and identity only — use a PJLink check where supported.',
  },
  panasonic: {
    ID: 'panasonic',
    Label: 'Panasonic',
    Verified: false,
    Note: 'Panasonic PT projectors do not expose SNMP status — monitor them with a PJLink check instead. This profile reports SNMP reachability and identity only.',
  },
};

export function GetProfile(ID: unknown): ProjectorProfile {
  const Key = String(ID == null ? '' : ID).trim().toLowerCase();
  return PROFILES[Key] || PROFILES[DEFAULT_PROFILE]!;
}
