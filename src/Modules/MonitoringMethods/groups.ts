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
  // Show control: Art-Net timecode is running
  'artnet-timecode': 'Show Control',
  // Lighting control (streaming DMX)
  'sacn-universe': 'Lighting',
  'sacn-universe-priority': 'Lighting',
  'artnet-universe': 'Lighting',
  // Lighting: Art-Net node health (ArtPoll / ArtPollReply)
  'artnet-node': 'Lighting',
  // Lighting consoles (ETC Eos, MA Lighting, Avolites, ChamSys)
  eos: 'Lighting',
  ma2: 'Lighting',
  ma3: 'Lighting',
  avolites: 'Lighting',
  chamsys: 'Lighting',
  // Sound (cue playback)
  qlab5: 'Sound',
  qlab4: 'Sound',
  // Sound (audio-over-IP device presence)
  'dante-device': 'Sound',
  // Sound: wireless microphones (battery, RF, transmitter presence)
  'shure-wireless': 'Sound',
  'sennheiser-wireless': 'Sound',
  // Sound: mixing consoles and DSP
  'x32-console': 'Sound',
  'yamaha-console': 'Sound',
  'qsys-core': 'Sound',
  'biamp-tesira': 'Sound',
  'symetrix-dsp': 'Sound',
  'tascam-mx8a': 'Sound',
  'allen-heath-console': 'Sound',
  'digico-console': 'Sound',
  // Sound: amplifiers
  'dbaudio-amp': 'Sound',
  'powersoft-amp': 'Sound',
  // Video sources & media servers
  'ndi-source': 'Video',
  'watchout-status': 'Video',
  'resolume-status': 'Video',
  'disguise-status': 'Video',
  'millumin-status': 'Video',
  pixera: 'Video',
  '7thsense-delta': 'Video',
  // Video: Blackmagic Design switchers, recorders and routers
  atem: 'Video',
  hyperdeck: 'Video',
  videohub: 'Video',
  // Video: LED and presentation processors
  'brompton-tessera': 'Video',
  'barco-eventmaster': 'Video',
  'analogway-livepremier': 'Video',
  // Video: AJA recorders, converters and frame syncs; PTZ cameras
  // Video: Datapath Fx4 display controllers
  'datapath-fx4': 'Video',
  'aja-device': 'Video',
  'ptz-camera': 'Video',
  // Video: streaming and recording software
  'obs-studio': 'Video',
  // Video: motion capture (OptiTrack NatNet)
  motive: 'Video',
  // Video: digital signage players (BrightSign Local DWS)
  brightsign: 'Video',
  // Video: projectors (PJLink cross-brand protocol + brand-profile SNMP)
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
  // Generic SNMP GET against any agent
  'snmp-oid': 'Web Services',
};
