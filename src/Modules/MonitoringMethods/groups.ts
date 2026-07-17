// Grouping for the editor's monitoring-method picker. Keyed by method ID so all
// grouping decisions live in one reviewable place (same discipline as ./info).
// The registry attaches the matching group to each method's public shape; the
// editor renders one <optgroup> per group.
//
// When adding a new monitoring method, add it to a group here too. The intended
// display order of the groups is GroupOrder; the editor honours it and appends
// any unlisted groups at the end.

export const DEFAULT_GROUP = 'Other';

// Display order for the groups in the method picker.
export const GroupOrder: string[] = [
  'General',
  'Lighting (DMX)',
  'Video',
  'Media Servers',
  'Control & Messaging',
  'Digital Signage',
  'Projectors',
  'Power (UPS)',
];

export const MethodGroups: Record<string, string> = {
  // General reachability / web
  ping: 'General',
  'tcp-port': 'General',
  http: 'General',
  'http-json': 'General',
  dns: 'General',
  // Lighting control (streaming DMX)
  'sacn-universe': 'Lighting (DMX)',
  'sacn-universe-priority': 'Lighting (DMX)',
  'artnet-universe': 'Lighting (DMX)',
  // Video
  'ndi-source': 'Video',
  // Media / playback servers
  'qlab-workspace': 'Media Servers',
  'watchout-status': 'Media Servers',
  'resolume-status': 'Media Servers',
  'disguise-status': 'Media Servers',
  'millumin-status': 'Media Servers',
  // Show control & messaging
  'companion-status': 'Control & Messaging',
  'mqtt-topic': 'Control & Messaging',
  // Digital signage players (BrightSign Local DWS)
  brightsign: 'Digital Signage',
  'brightsign-firmware': 'Digital Signage',
  'brightsign-power': 'Digital Signage',
  'brightsign-poe': 'Digital Signage',
  'brightsign-video': 'Digital Signage',
  // Projectors (PJLink cross-brand protocol + brand-profile SNMP)
  pjlink: 'Projectors',
  'pjlink-power': 'Projectors',
  'pjlink-lamp': 'Projectors',
  'pjlink-errors': 'Projectors',
  'pjlink-input': 'Projectors',
  'snmp-projector': 'Projectors',
  // Power / UPS (Network UPS Tools)
  'nut-ups': 'Power (UPS)',
  'nut-ups-status': 'Power (UPS)',
  'nut-ups-charge': 'Power (UPS)',
  'nut-ups-load': 'Power (UPS)',
  'nut-ups-temperature': 'Power (UPS)',
  'nut-ups-voltage': 'Power (UPS)',
  // Power / UPS (direct SNMP, e.g. Eaton/MGE, Riello NetMan, APC, CyberPower)
  'snmp-ups': 'Power (UPS)',
  'snmp-ups-v3': 'Power (UPS)',
};
