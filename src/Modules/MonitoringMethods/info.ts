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
  eos: {
    Summary:
      'Connects to an ETC Eos-family console (Eos Ti, Gio, Ion Xe, Element, ETCnomad) over OSC, pings it for a round-trip liveness check and reads the software version. Non-intrusive — it acts as background OSC user 0 and never touches the live command line.',
    Setup: [
      'On the console enable OSC in Setup → System → Show Control → OSC (RX and TX). OSC is on by default on current software, but confirm it has not been disabled.',
      'Default OSC port is TCP 3032. Set the OSC TCP framing to match the console’s "OSC TCP Mode": OSC 1.0 (packet length) is the Eos default; choose OSC 1.1 (SLIP) if you point it at port 3037.',
      'Online = the console answered the OSC ping. Optionally set an expected version prefix to be alerted on version drift.',
    ],
  },
  'eos-show': {
    Summary:
      'Reads the cue-list and patch counts from an ETC Eos console over OSC and flags a desk that is online but appears to be running an empty or default show.',
    Setup: [
      'Same OSC connection as the Console Health (ETC Eos) check — shares one connection per interval.',
      'Set the minimum cue lists and minimum patched channels a real show should have (0 disables a check).',
      'Degraded = reachable but below those minimums (e.g. no cue lists or nothing patched).',
    ],
  },
  ma2: {
    Summary:
      'Connects to a grandMA2 console (or onPC) on its Telnet remote (TCP 30000) and confirms it responds as a grandMA2, sending no commands. Optionally logs in to read the software version and loaded show file.',
    Setup: [
      'Enable the Telnet remote in Setup → Console → Global Settings → Telnet (Login Enabled). It is off by default.',
      'Leave the login user/password blank for a pure liveness check (recommended, fully read-only).',
      'To read software/show details, supply a login user + password. The login occupies a remote user session, so create a dedicated telnet user rather than using a live operator’s.',
      'Degraded = something answered but it is not a grandMA2, or (when credentials are set) the login failed.',
    ],
  },
  'ma2-show': {
    Summary:
      'Logs in to a grandMA2 over the Telnet remote and confirms the expected show file is loaded — catches a desk that is online but running the wrong show.',
    Setup: [
      'Requires a login user + password (a dedicated telnet user is recommended).',
      'Enter the expected show file name, or leave it blank to simply confirm a show is loaded.',
      'Degraded = login failed, no show file could be read, or the loaded show differs from the expected one.',
    ],
  },
  ma3: {
    Summary:
      'Confirms a grandMA3 console (or onPC) is reachable by opening a TCP connection to its Web Remote port and closing it immediately — no data is sent. Liveness only: grandMA3 exposes no safe read-only status API over the network.',
    Setup: [
      'Enable the Web Remote on the console (Network menu). The default port is 8080 (HTTP is also served on 80 on some builds).',
      'This check never opens a full Web Remote session — doing so can crash a live console — so it is a plain, safe connectivity test.',
      'Online = the port accepted a TCP connection.',
    ],
  },
  avolites: {
    Summary:
      'Connects to an Avolites Titan console over the Titan WebAPI (HTTP, TCP 4430) and reads the software version. Read-only — it only ever issues /titan/get requests.',
    Setup: [
      'Enable the WebAPI on the console (Titan does not always have it on by default). If the port is refused, the check tells you to enable it.',
      'Default port is 4430. Optionally set an expected Titan version prefix to be alerted on drift.',
      'Online = the WebAPI answered. Not available on Titan One / T1.',
    ],
  },
  'avolites-show': {
    Summary:
      'Reads the current show file name from an Avolites Titan console over the WebAPI and confirms it matches the show you expect to be loaded.',
    Setup: [
      'Same WebAPI (TCP 4430) as the Console Health (Avolites Titan) check.',
      'Enter the expected show name, or leave it blank to simply confirm a show is loaded.',
      'Degraded = reachable but the loaded show is not the expected one.',
    ],
  },
  chamsys: {
    Summary:
      'Connects to a ChamSys MagicQ console over its built-in web server (HTTP, default TCP 8080) and confirms it responds as a MagicQ system, reading the software version where the page exposes it.',
    Setup: [
      'Enable the web server on the console: Setup → Network Settings. It is disabled by default; the default port is 8080.',
      'MagicQ’s OSC is intentionally not used here — it has no query/echo and a stray message can fire a playback, so the web server is the safe read-only channel.',
      'Online = a MagicQ web page answered. Optionally set an expected version prefix; Degraded = wrong version, an HTTP error, or a non-MagicQ response.',
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
  brightsign: {
    Summary:
      "Combined BrightSign player health via the player's Local DWS API. Reads firmware, power source and PoE in one request and reports a single healthy / degraded verdict. Use this when you just want to know the player is OK.",
    Setup: [
      'The Local DWS must be enabled on the player — it is disabled by default as of BrightSignOS 9.0.218 / 9.1.75. Enable it in BrightAuthor:connected.',
      "The username is always 'admin' so it is not configurable here; the default password is the player's serial number.",
      'Protocol defaults to HTTP. BrightSignOS 9.0.218+ serves HTTPS with a self-signed certificate and redirects HTTP — the redirect is followed automatically, and TLS errors are ignored by default so the self-signed cert does not read as an outage.',
      'Set an expected firmware version to be alerted on drift; leave it blank to ignore firmware.',
      'Optionally also check the video output — this costs a second request per interval and is skipped automatically on audio-only players.',
      'Uptime, model and serial are shown in the debug panel for context but are never alerted on.',
    ],
    Docs: [{ Label: 'BrightSign Local DWS APIs', Url: 'https://docs.brightsign.biz/developers/local-dws-apis' }],
  },
  'brightsign-firmware': {
    Summary:
      "Reads only the firmware version from a BrightSign player's Local DWS API. Degraded when it does not match the expected version. Use this to catch firmware drift across a fleet.",
    Setup: [
      'Enter the exact expected version as the player reports it (e.g. 8.5.33).',
      'Leave the expected version blank to report the running firmware without alerting — the version still shows in the debug panel.',
    ],
  },
  'brightsign-power': {
    Summary:
      "Reads only the power source and battery state from a BrightSign player's Local DWS API. Degraded when the player is running on or discharging a battery, or when the source is not the expected one.",
    Setup: [
      "Set the expected source (e.g. 'AC') to be alerted when the player switches away from it; leave it blank to alert only on battery use.",
      'The API reports the power source and battery state only — there are no voltage or current readings available.',
    ],
  },
  'brightsign-poe': {
    Summary:
      "Reads only the Power over Ethernet status from a BrightSign player's Local DWS API. Degraded when the hardware does not support PoE or the status is not the expected one.",
    Setup: [
      "Players without PoE hardware report 'not_supported', which is treated as Degraded — only add this check to PoE-capable players.",
      'Leave the expected status blank to accept any status other than not_supported.',
    ],
  },
  'brightsign-video': {
    Summary:
      "Reads an HDMI output from a BrightSign player's Local DWS API. Reports the active resolution and Degraded when no display is detected, the signal is unstable, the output is blanked for power save, or the mode is not the expected one.",
    Setup: [
      'Enter the expected mode exactly as the player reports it (e.g. 1920x1080x60p); leave it blank to report the active mode without alerting.',
      'The output index is 0-based — dual-output players (HD/XT/XD) use 0 and 1. Add one check per output.',
      'Audio-only players have no video API and report Degraded here.',
    ],
    Docs: [{ Label: 'BrightSign Local DWS APIs', Url: 'https://docs.brightsign.biz/developers/local-dws-apis' }],
  },
  'nut-ups': {
    Summary:
      'Combined UPS health via Network UPS Tools (NUT). Reads status, battery charge, load, temperature and input voltage in one probe and reports a single healthy / degraded verdict using informed defaults. Use this when you just want to know the UPS is OK.',
    Setup: [
      'Point Address at the machine running upsd; default port is 3493.',
      "Set the UPS name exactly as configured in upsd (e.g. 'ups').",
      "upsd must allow queries from ShowTrak's IP — check the ACLs in upsd.conf.",
      'Defaults: on mains, charge ≥ 50%, load ≤ 90%, temp ≤ 45°C, voltage within 15% of nominal. Tune the thresholds to taste; variables the UPS does not report are skipped.',
      'Add a NUT username/password under Advanced if your server requires them.',
    ],
    Docs: [{ Label: 'Network UPS Tools', Url: 'https://networkupstools.org/' }],
  },
  'nut-ups-status': {
    Summary:
      'Reads only ups.status from a NUT server. Online on mains (OL); Degraded on battery / low battery / replace-battery / overload / alarm; Offline if unreachable.',
    Setup: [
      'Point Address at the machine running upsd; default port is 3493.',
      "Set the UPS name exactly as configured in upsd (e.g. 'ups').",
      'Use this when you want to alert purely on the power state and ignore charge/load/etc.',
    ],
    Docs: [{ Label: 'Network UPS Tools', Url: 'https://networkupstools.org/' }],
  },
  'nut-ups-charge': {
    Summary:
      'Reads battery.charge (percent) from a NUT server and goes Degraded below a minimum charge — catching a UPS too depleted to ride out an outage even while on mains.',
    Setup: [
      'Point Address at the machine running upsd; default port is 3493, and set the UPS name.',
      'Set Minimum charge (%) — default 50. Below it the check reports Degraded.',
    ],
    Docs: [{ Label: 'Network UPS Tools', Url: 'https://networkupstools.org/' }],
  },
  'nut-ups-load': {
    Summary:
      'Reads ups.load (percent of rated capacity) from a NUT server and goes Degraded above a maximum — an early warning of overload and shrinking runtime.',
    Setup: [
      'Point Address at the machine running upsd; default port is 3493, and set the UPS name.',
      'Set Maximum load (%) — default 80. Above it the check reports Degraded.',
    ],
    Docs: [{ Label: 'Network UPS Tools', Url: 'https://networkupstools.org/' }],
  },
  'nut-ups-temperature': {
    Summary:
      'Reads ups.temperature (or battery.temperature) from a NUT server and goes Degraded above a maximum in degrees Celsius.',
    Setup: [
      'Point Address at the machine running upsd; default port is 3493, and set the UPS name.',
      'Set Maximum temperature (°C) — default 40. Not all UPS models report temperature.',
    ],
    Docs: [{ Label: 'Network UPS Tools', Url: 'https://networkupstools.org/' }],
  },
  'nut-ups-voltage': {
    Summary:
      'Reads input.voltage from a NUT server and goes Degraded when incoming mains voltage falls outside an accepted band — catching brownouts and surges before the UPS switches to battery.',
    Setup: [
      'Point Address at the machine running upsd; default port is 3493, and set the UPS name.',
      'By default the band is the UPS reported nominal ± the Auto tolerance % (default 10%), so it works on 120 V and 230 V supplies alike.',
      'Set explicit Minimum / Maximum voltage (non-zero) to override the automatic band.',
    ],
    Docs: [{ Label: 'Network UPS Tools', Url: 'https://networkupstools.org/' }],
  },
  'snmp-ups': {
    Summary:
      'Combined UPS health via direct SNMP v1/v2c (no NUT server required). Reads status, battery charge, load, temperature, input voltage and active alarms from the standard UPS-MIB (RFC 1628) — implemented by Eaton/MGE Network-M2/M3, Riello NetMan 208/204, APC AP96xx, CyberPower RMCARD and most other network-managed UPS cards, including a Netman 208c.',
    Setup: [
      'Point Address at the UPS network card itself (its own IP, not a NUT server) and enable SNMP v1/v2c on the card if it is off by default.',
      "Set the Community string to match the card's configuration (often 'public' read-only by default — change it if the card requires something else).",
      'If the card is configured for SNMPv3 (username + auth/priv), use "UPS Health (SNMP v3)" instead.',
      'Most single-phase UPS units use line index 1 (the default); leave it unless the card documents otherwise.',
      'Defaults: charge ≥ 50%, load ≤ 90%, battery temp ≤ 45°C. Objects the card does not report (e.g. temperature) are skipped rather than failing the check.',
      'Degraded also covers on-battery, on-bypass, low/depleted battery and any active alarms reported by the card.',
    ],
    Docs: [
      { Label: 'RFC 1628 — UPS Management Information Base', Url: 'https://datatracker.ietf.org/doc/html/rfc1628' },
    ],
  },
  'snmp-ups-v3': {
    Summary:
      'Combined UPS health via authenticated/encrypted SNMPv3. Same UPS-MIB (RFC 1628) health readout as the v1/v2c method, but connects with an SNMPv3 username and auth/priv passwords instead of a community string — for UPS cards (e.g. a Riello NetMan 208 or Eaton NMC) locked down to v3.',
    Setup: [
      'Point Address at the UPS network card and enter the SNMPv3 Username exactly as configured on the card.',
      'The security level follows the protocol choices: set Auth protocol to None for noAuthNoPriv; set an Auth protocol but leave Priv protocol None for authNoPriv; set both for authPriv (recommended).',
      'When an Auth protocol is set, enter the matching Auth password; when a Priv protocol is set, enter the Priv password too. A mismatch shows as Offline (the card silently drops the request). Privacy needs authentication, so a Priv protocol is ignored while Auth protocol is None.',
      'Leave Context blank unless the card documents a specific SNMPv3 context name.',
      'Health thresholds and line index behave exactly as in the v1/v2c method.',
    ],
    Docs: [
      { Label: 'RFC 1628 — UPS Management Information Base', Url: 'https://datatracker.ietf.org/doc/html/rfc1628' },
      { Label: 'RFC 3414 — SNMPv3 User-based Security Model', Url: 'https://datatracker.ietf.org/doc/html/rfc3414' },
    ],
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
  pjlink: {
    Summary:
      'Combined projector health over PJLink (the cross-brand projector control protocol on TCP 4352). One connection reads power state, error status, lamp hours and input, and reports a single healthy / degraded verdict. Works with Epson, NEC/Sharp, Panasonic, Christie, Sony, Barco and most others.',
    Setup: [
      'Enable PJLink on the projector (usually under Network / Control settings) — most brands support it on TCP 4352, though some (e.g. Epson) ship with it off.',
      'If the projector has a PJLink password set, enter it; leave blank when authentication is off.',
      'By default a projector in standby reports Degraded — switch "When in standby" to Report Online for rigs where standby is normal.',
      'Set a lamp-hours threshold to be warned before a lamp expires; laser models without lamps are handled automatically.',
      'Some projectors accept only one PJLink connection at a time — all ShowTrak PJLink checks against the same projector share a single connection per interval automatically.',
    ],
    Docs: [{ Label: 'PJLink specification (JBMIA)', Url: 'https://pjlink.jbmia.or.jp/english/' }],
  },
  'pjlink-power': {
    Summary:
      'Reads the projector power state over PJLink and checks it against the expected state (on / on-or-warming-up / any).',
    Setup: [
      'Choose the expected power state; Degraded = reachable but in a different state.',
      'Standby, cooling and warm-up are reported distinctly in the debug panel.',
    ],
  },
  'pjlink-lamp': {
    Summary:
      'Reads lamp usage hours over PJLink and warns when any lamp reaches the configured threshold.',
    Setup: [
      "Set the warning threshold to your lamp's rated life (0 = just report the hours).",
      'Laser projectors without lamps report Online with a note.',
    ],
  },
  'pjlink-errors': {
    Summary:
      'Reads the PJLink error status (fan, lamp, temperature, cover, filter, other) and reports Degraded on any error — and on warnings, unless disabled.',
    Setup: [
      'Errors always degrade; uncheck "Treat warnings as Degraded" to ignore warnings such as a dirty filter.',
    ],
  },
  'pjlink-input': {
    Summary:
      'Reads the active input over PJLink and optionally checks it against an expected input code.',
    Setup: [
      'Input codes are two characters: source type (1 RGB, 2 Video, 3 Digital, 4 Storage, 5 Network) + input number — e.g. 31 = Digital 1 (often HDMI 1).',
      'Leave the expected input blank to just report the current input.',
      'The projector must be powered on for the input to be readable; standby reports Degraded.',
    ],
  },
  'snmp-projector': {
    Summary:
      'Reads projector status over SNMP using a brand profile (Epson, NEC, Panasonic, Christie, Sony, Barco), falling back to generic SNMP reachability and device identity. Custom OID checks are available under Advanced.',
    Setup: [
      'Enable SNMP on the projector’s network settings and match the community string (usually "public").',
      'Pick the brand profile; use Generic for unlisted brands — it still confirms the device answers SNMP and shows its identity.',
      'Prefer PJLink where available; SNMP support and OIDs vary by brand and model, and several brands expose no useful status over SNMP.',
      'Under Advanced, up to two custom OIDs can be asserted (equals / not-equals / numeric limits) for model-specific values.',
    ],
  },
};

export { MethodInfo };
