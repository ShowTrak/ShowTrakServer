// LAN discovery signatures for the monitoring methods. Keyed by method ID so all
// "what does this device look like on the wire" decisions live in one reviewable
// place (same discipline as ./groups and ./info). The registry attaches the
// matching signature to each method's public shape; the discovery wizard ranks
// its check suggestions from them, and the scanner probes every TcpPorts entry
// listed here on each live host.
//
// A method with no entry is simply never suggested. Only list a port or service
// type you are confident identifies the device; a wrong 'high' match puts the
// wrong check at the top of the list. Ports many devices share (80, 8080, 23)
// belong at 'low', where they rank below anything more specific.
//
// UDP-only protocols (ATEM, sACN, Art-Net, OSC consoles) cannot be seen by a TCP
// probe; they are only suggested when the device advertises itself over mDNS.

import type { MonitoringMethodDiscovery } from './types';

export const MethodDiscovery: Record<string, MonitoringMethodDiscovery> = {
  // Projectors
  pjlink: {
    Confidence: 'high',
    PJLink: true,
    TcpPorts: [4352],
    ServiceTypes: ['_pjlink._tcp'],
    PortSetting: 'Port',
  },

  // Video
  hyperdeck: { Confidence: 'high', TcpPorts: [9993], PortSetting: 'Port' },
  videohub: { Confidence: 'high', TcpPorts: [9990], PortSetting: 'Port' },
  // Every Blackmagic device advertises _blackmagic._tcp; the TCP ports above
  // tell a HyperDeck or Videohub apart, so an ATEM is the low-confidence guess.
  atem: { Confidence: 'low', ServiceTypes: ['_blackmagic._tcp'] },
  'ndi-source': { Confidence: 'high', ServiceTypes: ['_ndi._tcp'], NameSetting: 'SourceName' },
  'obs-studio': { Confidence: 'high', TcpPorts: [4455], PortSetting: 'Port' },

  // Show control
  qlab5: {
    Confidence: 'high',
    TcpPorts: [53000],
    ServiceTypes: ['_qlab._tcp'],
    PortSetting: 'Port',
  },
  // Same wire signature as QLab 5; ranked below it as the older version.
  qlab4: {
    Confidence: 'medium',
    TcpPorts: [53000],
    ServiceTypes: ['_qlab._tcp'],
    PortSetting: 'Port',
  },
  'mqtt-topic': {
    Confidence: 'high',
    TcpPorts: [1883],
    ServiceTypes: ['_mqtt._tcp'],
    PortSetting: 'Port',
  },
  'companion-status': { Confidence: 'low', TcpPorts: [8000], PortSetting: 'Port' },

  // Media servers
  'watchout-status': { Confidence: 'medium', TcpPorts: [3040], PortSetting: 'Port' },
  pixera: { Confidence: 'medium', TcpPorts: [1400], PortSetting: 'Port' },
  'resolume-status': { Confidence: 'low', TcpPorts: [8080], PortSetting: 'Port' },

  // Sound
  'dante-device': {
    Confidence: 'high',
    ServiceTypes: ['_netaudio-arc._udp', '_netaudio-cmc._udp'],
    NameSetting: 'DeviceName',
  },
  'qsys-core': { Confidence: 'high', TcpPorts: [1710], PortSetting: 'Port' },
  'yamaha-console': { Confidence: 'high', TcpPorts: [49280], PortSetting: 'Port' },
  'allen-heath-console': { Confidence: 'high', TcpPorts: [51325], PortSetting: 'Port' },
  'symetrix-dsp': { Confidence: 'high', TcpPorts: [48631], PortSetting: 'Port' },
  'shure-wireless': { Confidence: 'high', TcpPorts: [2202], PortSetting: 'Port' },
  'tascam-mx8a': { Confidence: 'high', TcpPorts: [54726], PortSetting: 'Port' },
  'biamp-tesira': { Confidence: 'low', TcpPorts: [23], PortSetting: 'Port' },

  // Lighting
  chamsys: { Confidence: 'low', TcpPorts: [8080], PortSetting: 'Port' },

  // Power
  'nut-ups': { Confidence: 'high', TcpPorts: [3493], PortSetting: 'Port' },

  // Web services: the fallback for anything serving a page. One method serves
  // both protocols and defaults to HTTPS, so the match sets which one.
  http: {
    Confidence: 'low',
    TcpPorts: [80, 8080, 443],
    ServiceTypes: ['_http._tcp', '_http-alt._tcp', '_https._tcp'],
    PortSetting: 'Port',
    PortSettings: {
      '80': { Protocol: 'http' },
      '8080': { Protocol: 'http' },
      '443': { Protocol: 'https' },
    },
    ServiceSettings: {
      '_http._tcp': { Protocol: 'http' },
      '_http-alt._tcp': { Protocol: 'http' },
      '_https._tcp': { Protocol: 'https' },
    },
  },
};
