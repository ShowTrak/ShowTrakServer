// Per-method setup / usage help, surfaced in the check editor as an info panel
// below the method picker. Keyed by method ID. Kept here (rather than in each
// method file) so all editor copy lives in one reviewable place; the registry
// attaches the matching entry to each method's public shape.
//
// This is informational only — it never affects how a check runs. When adding a
// new monitoring method, add its help here too (same discipline as registering
// it in index.ts).
//
// Style: state facts, not reassurances. Name supported vendors/ports/defaults
// explicitly rather than saying "most" or "best effort". Keep per-input hints on
// the setting's `Note` field (see MonitoringSettingField), not in Setup — Setup
// is for the sequence of actions, not for describing individual fields. Put
// specifications and API references in `Links`, not inline in the prose.
import type { MonitoringMethodInfo } from './types';

const MethodInfo: Record<string, MonitoringMethodInfo> = {
  ping: {
    Summary:
      'Sends a single ICMP echo request to the address and reports round-trip latency. Online when a reply is received; Offline when it times out.',
    Setup: [
      'Enter the target IP or hostname in the Address field.',
      'The host and every hop in between must permit ICMP echo. Networks that block ICMP will report the host as Offline even when it is up.',
    ],
  },
  'tcp-port': {
    Summary:
      'Opens a TCP connection to a host and port and succeeds when the handshake completes. No data is sent.',
    Setup: [
      'Set the port of the service you want to confirm is listening.',
      'Online = connection accepted. Degraded = actively refused (ECONNREFUSED / RESET). Offline = no response or host unreachable.',
    ],
  },
  http: {
    Summary:
      'Makes an HTTP or HTTPS request and confirms the response status code falls in the expected range.',
    Setup: [
      'Choose HTTP or HTTPS and set the request path.',
      'Leave Port at 0 to use the protocol default (80 for HTTP, 443 for HTTPS).',
    ],
  },
  'http-json': {
    Summary:
      'HTTP or HTTPS request that also asserts the response body — either a JSON path equals a value, or the body contains a substring. The response body is read up to 1 MiB.',
    Setup: [
      'Set a JSON path (e.g. data.status) and an expected value, or leave the path empty for a plain substring match.',
    ],
  },
  dns: {
    Summary:
      'Resolves a hostname and confirms it answers, optionally via a specific resolver and record type.',
    Setup: ['Enter the hostname to resolve in the Address field.'],
  },
  qlab5: {
    Summary:
      'Holds a persistent OSC connection to QLab 5+ and subscribes to its live updates to check a workspace. Baseline: confirms a workspace is open. Optional assertions: workspace name, Show/Edit mode, whether listed cues are running, and whether any I/O override is engaged. Online = connected and a workspace is open; Degraded = an enabled assertion fails.',
    Setup: [
      'Requires QLab 5 or newer. Enable OSC under Workspace Settings → OSC with at least View access (add a passcode below if one is set).',
      'The default OSC port is 53000. Point the Address at the QLab machine.',
      'Leave the Workspace field blank to inspect whichever workspace is currently open, or name one to target it specifically.',
      'The overrides check flags any engaged override (MIDI, MSC, SysEx, timecode, DMX, or network I/O turned off in QLab’s Overrides window).',
    ],
    Links: [{ Label: 'QLab OSC Dictionary', Url: 'https://qlab.app/docs/v5/scripting/osc-dictionary-v5/' }],
  },
  qlab4: {
    Summary:
      'Lightweight check for legacy QLab 4 (end-of-life): connects over OSC (default TCP 53000) and confirms a workspace is open, matched by name, filename, or unique ID. Degraded = QLab replied but that workspace is not open. For mode, cue, and override inspection, use a QLab 5 machine with the QLab 5 check.',
    Setup: [
      'In QLab, enable OSC control under Workspace Settings → OSC. The default OSC port is 53000.',
      'Leave the Workspace field blank to accept any open workspace, or name one to require it specifically.',
    ],
  },
  'sacn-universe': {
    Summary:
      'Passively listens for sACN (E1.31) streaming DMX and confirms a source is transmitting the given universe (1–63999). Online = packets seen recently from that source; Offline = none within the grace window.',
    Setup: [
      "Enter the transmitter's source IP in the Address field and set the universe.",
      'ShowTrak must be on the same network / VLAN as the sACN multicast traffic.',
    ],
  },
  'sacn-universe-priority': {
    Summary:
      'As the sACN universe check, but also asserts the stream arrives at a specific per-packet priority (0–200). Degraded = the universe is present but at a different priority than expected.',
    Setup: ["Enter the source IP, universe, and expected priority."],
  },
  'artnet-universe': {
    Summary:
      'Passively listens for Art-Net (ArtDmx) on UDP 6454 and confirms a source is transmitting the given universe. Online = ArtDmx seen recently from that source.',
    Setup: [
      "Enter the transmitter's source IP and the Art-Net universe.",
      'ShowTrak must be on the same network as the Art-Net traffic to receive it.',
    ],
  },
  eos: {
    Summary:
      'Connects to an ETC Eos-family console (Eos Ti, Gio, Ion Xe, Element, ETCnomad) over OSC, measures round-trip liveness, and reads the software version, cue-list count and patch count in one connection. Acts as background OSC user 0 and never touches the live command line. Online when the console answers; enable the version and show toggles to also flag an unexpected version or an empty/default show.',
    Setup: [
      'On the console, enable OSC under Setup → System → Show Control → OSC (RX and TX).',
      'The default OSC port is TCP 3032, framed as OSC 1.0 (packet length). Use OSC 1.1 (SLIP) on port 3037.',
    ],
  },
  ma2: {
    Summary:
      'Connects to a grandMA2 console or onPC on its Telnet remote (TCP 30000) and confirms it responds as a grandMA2 — sending no commands, so it is safe against a live desk. Enable the version or show toggle to also log in and check the software version or loaded show file.',
    Setup: [
      'Enable the Telnet remote under Setup → Console → Global Settings → Telnet (Login Enabled). It is off by default.',
      'Leave the login user and password blank for a read-only liveness check. The version and show toggles require credentials — use a dedicated Telnet user rather than a live operator account.',
    ],
  },
  ma3: {
    Summary:
      'Confirms a grandMA3 console or onPC is reachable by opening and immediately closing a TCP connection to its Web Remote port (default 8080). Liveness only — grandMA3 exposes no safe read-only status API over the network, and opening a full Web Remote session can crash a live console.',
    Setup: ['Enable the Web Remote on the console under the Network menu.'],
  },
  avolites: {
    Summary:
      'Connects to an Avolites Titan console over the Titan WebAPI (HTTP, TCP 4430) and reads the software version and current show name. Read-only — it issues only /titan/get requests. Not available on Titan One / T1. Online when the WebAPI answers; enable the version and show toggles to also flag an unexpected version or a wrong loaded show.',
    Setup: [
      'Enable the WebAPI on the console. If the port is refused, the check reports that it needs enabling.',
    ],
  },
  chamsys: {
    Summary:
      'Connects to a ChamSys MagicQ console over its built-in web server (HTTP, default TCP 8080), confirms it responds as MagicQ, and reads the software version where the page exposes it. The web server is used rather than OSC because MagicQ OSC has no query/echo and a stray message can fire a playback. Enable the version toggle to flag an unexpected software version.',
    Setup: [
      'Enable the web server under Setup → Network Settings. It is disabled by default.',
    ],
  },
  'ndi-source': {
    Summary:
      'Discovers NDI video sources on the network via mDNS and confirms a named source is being advertised. Presence-only: Online when seen, Offline when not. Source names take the form "MACHINE (Source Name)".',
    Setup: [
      'Discovery is network-wide — the Address field is not used.',
      'ShowTrak and the NDI source must share a subnet that passes mDNS / Bonjour.',
    ],
  },
  'mqtt-topic': {
    Summary:
      'Connects to an MQTT broker, subscribes to a topic, and confirms a message arrives within the timeout. Retained messages arrive immediately on subscribe; non-retained topics require a publish within the timeout window to count as Online.',
    Setup: [
      'Set the broker address, port (1883, or 8883 for MQTT over TLS), and topic. MQTT wildcards are supported.',
    ],
  },
  brightsign: {
    Summary:
      "BrightSign player health via the player's Local DWS API. Confirms reachability by default; enable the firmware, power, PoE, and video toggles to also check those in the same probe (video adds a second request). Uptime, model, and serial are shown in the debug panel but are never alerted on.",
    Setup: [
      'Enable the Local DWS on the player in BrightAuthor:connected. It is disabled by default as of BrightSignOS 9.0.218 / 9.1.75.',
      "The username is always 'admin'; the default password is the player's serial number.",
      'BrightSignOS 9.0.218+ serves HTTPS with a self-signed certificate and redirects HTTP. The redirect is followed and TLS errors are ignored by default so the self-signed certificate does not read as an outage.',
      'Enable a factor toggle to check it. PoE reports Degraded on hardware that does not support it, so only enable PoE on PoE-capable players. The video output index is 0-based; dual-output players use 0 and 1.',
    ],
    Links: [{ Label: 'BrightSign Local DWS APIs', Url: 'https://docs.brightsign.biz/developers/local-dws-apis' }],
  },
  'nut-ups': {
    Summary:
      'UPS health via Network UPS Tools (NUT). Reports reachability and ups.status by default — Online on mains, Degraded on battery, low/replace battery, overload, or alarm. Enable the charge, load, temperature, and input-voltage toggles to also threshold those readings in the same probe.',
    Setup: [
      'Point Address at the machine running upsd (default port 3493) and set the UPS name exactly as configured in upsd.',
      "upsd must permit queries from ShowTrak's IP — check the ACLs in upsd.conf.",
      'Enable a factor toggle to threshold that reading; each is skipped automatically when the UPS does not report it. Voltage uses the reported nominal ± tolerance, or an explicit min/max.',
    ],
    Links: [{ Label: 'Network UPS Tools', Url: 'https://networkupstools.org/' }],
  },
  'snmp-ups': {
    Summary:
      'UPS health via SNMP v1/v2c against the standard UPS-MIB (RFC 1628) — no NUT server required. Reports reachability, battery status, output source, and active alarms by default (Degraded on battery, bypass, or low/depleted battery). Enable the charge, load, and temperature toggles to threshold those readings too. Compatible with Eaton/MGE Network-M2/M3, Riello NetMan 204/208, APC Network Management Card 2/3 (AP96xx), CyberPower RMCARD, Tripp Lite, and Vertiv/Liebert cards.',
    Setup: [
      'Point Address at the UPS network card itself (its own IP, not a NUT server) and enable SNMP v1/v2c on the card.',
      'For cards locked to SNMPv3 (username + auth/priv), use "UPS Health (SNMP v3)" instead.',
      'Objects the card does not report are skipped rather than failing the check.',
    ],
    Links: [
      { Label: 'RFC 1628 — UPS Management Information Base', Url: 'https://datatracker.ietf.org/doc/html/rfc1628' },
    ],
  },
  'snmp-ups-v3': {
    Summary:
      'UPS health via authenticated / encrypted SNMPv3 against the same UPS-MIB (RFC 1628) as the v1/v2c method. For cards locked down to SNMPv3, such as Riello NetMan 208 or Eaton Network-M2/M3. Reports reachability and status by default; the same charge/load/temperature toggles and line index behave as in the v1/v2c method.',
    Setup: [
      'Point Address at the UPS network card and enter the SNMPv3 username exactly as configured on the card.',
      'Security level follows the protocol choices: Auth protocol None = noAuthNoPriv; Auth protocol set, Priv protocol None = authNoPriv; both set = authPriv.',
      'Enter the auth password when an Auth protocol is set, and the priv password when a Priv protocol is set. A credential mismatch is reported as Offline because the card silently drops the request.',
    ],
    Links: [
      { Label: 'RFC 1628 — UPS Management Information Base', Url: 'https://datatracker.ietf.org/doc/html/rfc1628' },
      { Label: 'RFC 3414 — SNMPv3 User-based Security Model', Url: 'https://datatracker.ietf.org/doc/html/rfc3414' },
    ],
  },
  'watchout-status': {
    Summary:
      'Connects to a Dataton WATCHOUT computer over its legacy production protocol (TCP 3040) and reports whether a show is loaded and running. Degraded covers a different show, no show loaded, and not-ready; Offline = unreachable.',
    Setup: [
      'Enable the production protocol on the WATCHOUT machine.',
      'Optionally set an expected show name to be alerted when a different show is loaded.',
    ],
  },
  'resolume-status': {
    Summary:
      'Queries the Resolume Arena / Avenue REST API for product and composition info. Degraded = a different composition is open; Offline = the REST API is not reachable.',
    Setup: [
      'Enable the web server / REST API under Preferences → Webserver. The default port is 8080.',
    ],
    Links: [{ Label: 'Resolume REST API', Url: 'https://resolume.com/docs/restapi/' }],
  },
  'companion-status': {
    Summary:
      'Confirms a Bitfocus Companion instance is up by reaching its web admin over HTTP (default port 8000). Companion 3.x exposes no version or health JSON endpoint, so this verifies reachability only.',
    Setup: ['Point Address at the Companion machine. No Companion configuration is required.'],
  },
  'disguise-status': {
    Summary:
      'Polls the disguise (d3) Session API health endpoint over HTTP and reports reachability, optionally asserting a health field. The endpoint and port are Designer-version dependent.',
    Setup: [
      'The Session API defaults to HTTP port 80 at /api/session/status/health. Adjust the path and port to match your Designer version.',
      'Optionally set a JSON path and expected value to drive a Degraded state from a health field.',
    ],
    Links: [{ Label: 'disguise developer API', Url: 'https://developer.disguise.one/' }],
  },
  'millumin-status': {
    Summary:
      "Passively listens for Millumin's outbound OSC feedback and confirms the configured machine is sending it, via a grace window. Presence-only.",
    Setup: [
      "In Millumin, open Device manager (⌘K) → OSC, enable 'API feedback', and add ShowTrak's IP and the listen port as an OSC destination.",
      "Set Address to the Millumin machine's IP — it is matched against the OSC source.",
    ],
  },
  pjlink: {
    Summary:
      'Projector health over PJLink (TCP 4352). Confirms reachability by default; enable the power-state, error-status, lamp-hours, and input toggles to check those in the same connection. Compatible with any projector implementing PJLink Class 1, including Epson, NEC, Panasonic, Christie, Sony, Barco, Sharp, and Optoma. All ShowTrak PJLink checks against one projector share a single connection per interval, since some projectors accept only one PJLink connection at a time.',
    Setup: [
      'Enable PJLink on the projector under its Network / Control settings. Epson ships with it disabled.',
      'Enter the PJLink password if one is set, or leave it blank when authentication is off.',
      'Enable a factor toggle to check it. Input codes are two characters — source type (1 RGB, 2 Video, 3 Digital, 4 Storage, 5 Network) + input number, e.g. 31. Laser models without lamps are handled automatically.',
    ],
    Links: [{ Label: 'PJLink specification (JBMIA)', Url: 'https://pjlink.jbmia.or.jp/english/' }],
  },
  'snmp-projector': {
    Summary:
      'Reads projector status over SNMP using a brand profile — Epson and Christie report lamp / light-source hours; NEC/Sharp, Sony, Barco, and Panasonic report SNMP reachability and device identity only. Generic covers unlisted brands. SNMP support and OIDs vary by brand and model; prefer a PJLink check where available.',
    Setup: [
      'Enable SNMP on the projector and match the community string (default "public").',
      'Pick the brand profile, or Generic for unlisted brands.',
      'Under Advanced, up to two custom OIDs can be asserted (equals / not-equals / numeric limits) for model-specific values.',
    ],
    Links: [
      { Label: 'RFC 1157 — Simple Network Management Protocol', Url: 'https://datatracker.ietf.org/doc/html/rfc1157' },
    ],
  },
};

export { MethodInfo };
