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
  'Show Control',
  'Lighting',
  'Sound',
  'Video',
  'Power',
  'Web Services',
  'Other',
];

export const MethodGroups: Record<string, string> = {
  // Show control & messaging
  'companion-status': 'Show Control',
  'mqtt-topic': 'Show Control',
  // Lighting control (streaming DMX)
  'sacn-universe': 'Lighting',
  'sacn-universe-priority': 'Lighting',
  'artnet-universe': 'Lighting',
  // Lighting consoles (ETC Eos, MA Lighting, Avolites, ChamSys)
  eos: 'Lighting',
  ma2: 'Lighting',
  ma3: 'Lighting',
  avolites: 'Lighting',
  chamsys: 'Lighting',
  // Sound (cue playback)
  qlab5: 'Sound',
  qlab4: 'Sound',
  // Video sources & media servers
  'ndi-source': 'Video',
  'watchout-status': 'Video',
  'resolume-status': 'Video',
  'disguise-status': 'Video',
  'millumin-status': 'Video',
  // Video — digital signage players (BrightSign Local DWS)
  brightsign: 'Video',
  // Video — projectors (PJLink cross-brand protocol + brand-profile SNMP)
  pjlink: 'Video',
  'snmp-projector': 'Video',
  // Power / UPS (Network UPS Tools)
  'nut-ups': 'Power',
  // Power / UPS (direct SNMP, e.g. Eaton/MGE, Riello NetMan, APC, CyberPower)
  'snmp-ups': 'Power',
  'snmp-ups-v3': 'Power',
  // Web / network service reachability
  ping: 'Web Services',
  'tcp-port': 'Web Services',
  http: 'Web Services',
  'http-json': 'Web Services',
  dns: 'Web Services',
};
