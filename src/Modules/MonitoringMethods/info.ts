// Per-method setup / usage help, surfaced in the check editor as an info panel
// below the method picker. Keyed by method ID. Kept here (rather than in each
// method file) so all editor copy lives in one reviewable place; the registry
// attaches the matching entry to each method's public shape.
//
// This is informational only — it never affects how a check runs. When adding a
// new monitoring method, add its help here too (same discipline as registering
// it in index.ts).
import type { MonitoringMethodInfo } from './types';

const MethodInfo: Record<string, MonitoringMethodInfo> = {
  ping: {
    Summary:
      'Sends a single ICMP echo (ping) to the address and reports round-trip latency. Online when a reply is received, Offline when it times out.',
    Setup: [
      'Enter the target IP or hostname in the Address field.',
      'The host and any firewalls in between must allow ICMP echo — some networks block ping.',
      'Tune how long to wait for a reply with the Advanced timeout.',
    ],
  },
  'tcp-port': {
    Summary:
      'Opens a TCP connection to a host and port and succeeds when the handshake completes. No data is sent, so it is safe against any service.',
    Setup: [
      'Set Port to the service you want to confirm is listening.',
      'Online = connection accepted. Degraded = actively refused (ECONNREFUSED/RESET). Offline = no response or unreachable.',
    ],
  },
  http: {
    Summary:
      'Makes an HTTP or HTTPS request and confirms the response status code falls in the expected range.',
    Setup: [
      'Choose HTTP or HTTPS and set the request Path.',
      'Leave Port at 0 to use the protocol default (80 / 443).',
      'Use the Advanced options to follow redirects or ignore TLS certificate errors.',
    ],
  },
  'http-json': {
    Summary:
      'HTTP/HTTPS request that also asserts the response body — either a JSON path equals a value, or the body contains a substring.',
    Setup: [
      'Set a JSON path (e.g. data.status) and an expected value, or leave the path empty to do a plain substring match.',
      'The expected value is compared as text. The response body is capped at 1 MiB.',
    ],
  },
  dns: {
    Summary:
      'Resolves a hostname and confirms it answers, optionally via a specific resolver and record type.',
    Setup: [
      'Enter the hostname to resolve in the Address field.',
      'Optionally set a custom DNS server and record type in the settings.',
    ],
  },
  'qlab-workspace': {
    Summary:
      "Connects to QLab's OSC API over TCP and confirms a specific workspace is open, matched by name/filename or unique ID.",
    Setup: [
      'In QLab, enable OSC control (Workspace Settings → OSC) so it accepts network connections.',
      'Default OSC port is 53000.',
      'Enter the workspace name, .qlab filename, or unique ID to match.',
      "Degraded = QLab replied but that workspace isn't currently open.",
    ],
  },
  'sacn-universe': {
    Summary:
      'Passively listens for sACN (E1.31) streaming DMX and confirms a source is transmitting the given universe.',
    Setup: [
      "Enter the transmitter's source IP in the Address field and set the universe (1–63999).",
      'ShowTrak must be on the same network/VLAN as the sACN multicast traffic.',
      'Online = packets seen recently from that source; Offline = none within the grace window.',
    ],
  },
  'sacn-universe-priority': {
    Summary:
      'Like the sACN universe check, but also asserts the stream arrives at a specific per-packet priority.',
    Setup: [
      'Set the source IP, universe, and the expected priority (0–200, default 100).',
      'Degraded = the universe is present but at a different priority than expected.',
    ],
  },
  'artnet-universe': {
    Summary:
      'Passively listens for Art-Net (ArtDmx) and confirms a source is transmitting the given universe.',
    Setup: [
      "Enter the transmitter's source IP and the Art-Net universe.",
      'Art-Net is usually broadcast on UDP 6454 — ShowTrak must be on the same network to hear it.',
      'Online = ArtDmx seen recently from that source.',
    ],
  },
  'ndi-source': {
    Summary:
      'Discovers NDI video sources on the network via mDNS and confirms a named source is being advertised. Presence-only: Online when seen, Offline when not.',
    Setup: [
      'Discovery is network-wide — the Address field is not used for this check.',
      "Enter the NDI source name or a substring; names look like 'MACHINE (Source Name)'.",
      'Choose exact or contains matching.',
      'ShowTrak and the NDI source must share a subnet that passes mDNS/Bonjour.',
    ],
  },
  'mqtt-topic': {
    Summary:
      'Connects to an MQTT broker, subscribes to a topic, and confirms a message arrives within the timeout. Retained messages arrive immediately on subscribe.',
    Setup: [
      'Set the broker Address, Port (1883, or 8883 for mqtts), and the Topic (MQTT wildcards supported).',
      'Add a username/password under Advanced if the broker requires authentication.',
      "Optionally assert the payload contains an expected substring — Degraded if it doesn't.",
      'For non-retained topics, a message must be published within the timeout window to count as Online.',
    ],
  },
  'nut-ups': {
    Summary:
      'Queries a Network UPS Tools (NUT) server for a UPS status. Online on mains power; Degraded on battery, low battery, or replace-battery; Offline if unreachable.',
    Setup: [
      'Point Address at the machine running upsd; default port is 3493.',
      "Set the UPS name exactly as configured in upsd (e.g. 'ups').",
      "upsd must allow queries from ShowTrak's IP — check the ACLs in upsd.conf.",
      'Add a NUT username/password under Advanced if your server requires them.',
    ],
    Docs: [{ Label: 'Network UPS Tools', Url: 'https://networkupstools.org/' }],
  },
  'watchout-status': {
    Summary:
      'Connects to a Dataton WATCHOUT computer over its legacy TCP protocol and reports whether a show is loaded and running.',
    Setup: [
      'Enable the legacy/production protocol on the WATCHOUT machine; default port is 3040.',
      'Optionally set an expected show name — Degraded if a different show is loaded.',
      'Degraded also covers no-show-loaded / not-ready; Offline = unreachable.',
    ],
  },
  'resolume-status': {
    Summary: 'Queries the Resolume Arena/Avenue REST API for product and composition info.',
    Setup: [
      'In Resolume, enable the web server / REST API (Preferences → Webserver); default port is 8080.',
      'Optionally set an expected composition name — Degraded if a different composition is open.',
      'Offline = the REST API is not reachable.',
    ],
    Docs: [{ Label: 'Resolume REST API', Url: 'https://resolume.com/docs/restapi/' }],
  },
  'companion-status': {
    Summary: 'Confirms a Bitfocus Companion instance is up by reaching its web admin over HTTP.',
    Setup: [
      'Point Address at the Companion machine; the default admin port is 8000.',
      'No extra Companion configuration is required — its web UI responds by default.',
      'Companion 3.x exposes no version/health JSON endpoint, so this verifies reachability only.',
    ],
  },
  'disguise-status': {
    Summary:
      'Polls the disguise (d3) Session API health endpoint over HTTP and reports reachability, optionally asserting a health field.',
    Setup: [
      'The Session API serves on HTTP port 80 at /api/session/status/health by default — all configurable here.',
      'The endpoint and port are Designer-version dependent; adjust Path/Port to match your setup.',
      'Optionally set a JSON path + expected value to drive a Degraded state from a health field.',
    ],
    Docs: [{ Label: 'disguise developer API', Url: 'https://developer.disguise.one/' }],
  },
  'millumin-status': {
    Summary:
      "Passively listens for Millumin's outbound OSC feedback and confirms the configured machine is sending it. Presence-only, via a grace window.",
    Setup: [
      "In Millumin, open Device manager (⌘K) → OSC and enable 'API feedback', adding ShowTrak's IP and the Listen Port as an OSC destination.",
      'Set Listen Port to the UDP port Millumin sends to (default 5001).',
      "Set Address to the Millumin machine's IP — it is matched against the OSC source.",
      'Optionally filter by an OSC address prefix such as /millumin.',
    ],
  },
};

export { MethodInfo };
