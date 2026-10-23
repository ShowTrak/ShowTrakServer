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
      'Actions (GO, stop, show mode, overrides) need Control access. If QLab only grants that to a passcode, enter it under Advanced.',
    ],
    Links: [
      {
        Label: 'QLab OSC Dictionary',
        Url: 'https://qlab.app/docs/v5/scripting/osc-dictionary-v5/',
      },
    ],
  },
  qlab4: {
    Summary:
      'Lightweight check for legacy QLab 4 (end-of-life): connects over OSC (default TCP 53000) and confirms a workspace is open, matched by name, filename, or unique ID. Degraded = QLab replied but that workspace is not open. For mode, cue, and override inspection, use a QLab 5 machine with the QLab 5 check.',
    Setup: [
      'In QLab, enable OSC control under Workspace Settings → OSC. The default OSC port is 53000.',
      'Leave the Workspace field blank to accept any open workspace, or name one to require it specifically.',
      'Actions (GO, stop, show mode) are sent to that same workspace. If it has an OSC passcode, enter it under Advanced.',
    ],
  },
  'dante-device': {
    Summary:
      'Passively browses mDNS for Audinate Dante devices and confirms one matching the configured name is advertising. Browses both _netaudio-arc._udp (port 4440) and _netaudio-cmc._udp (port 8800), merging them into one device record, so a device stays Online while it answers on either. Reports presence only — Dante does not publish subscription state over mDNS.',
    Setup: [
      'Enter the device name exactly as it appears in Dante Controller, or a substring of it with Match mode set to Contains.',
      'ShowTrak must be on the same network / VLAN as the Dante primary interface. Dante devices do not answer mDNS across a router unless an mDNS reflector is configured.',
      'On a redundant (primary/secondary) Dante network, devices are discovered on whichever subnet the ShowTrak host is attached to. A device reachable only on the secondary network will read as Offline.',
      'Dante Via and Dante Virtual Soundcard advertise the same services as hardware and are discovered identically.',
    ],
    Links: [
      {
        Label: 'Which network ports does Dante use?',
        Url: 'https://support.getdante.com/hc/en-gb/articles/5508285534239-Which-network-ports-does-Dante-use',
      },
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
    Setup: ['Enter the source IP, universe, and expected priority.'],
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
    Setup: ['Enable the web server under Setup → Network Settings.'],
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
      'The display actions act on the video output index above. Reboot stays available while the check is offline.',
    ],
    Links: [
      {
        Label: 'BrightSign Local DWS APIs',
        Url: 'https://docs.brightsign.biz/developers/local-dws-apis',
      },
    ],
  },
  'nut-ups': {
    Summary:
      'UPS health via Network UPS Tools (NUT). Reports reachability and ups.status by default — Online on mains, Degraded on battery, low/replace battery, overload, or alarm. Enable the charge, load, temperature, and input-voltage toggles to also threshold those readings in the same probe.',
    Setup: [
      'Point Address at the machine running upsd (default port 3493) and set the UPS name exactly as configured in upsd.',
      "upsd must permit queries from ShowTrak's IP — check the ACLs in upsd.conf.",
      'Enable a factor toggle to threshold that reading; each is skipped automatically when the UPS does not report it. Voltage uses the reported nominal ± tolerance, or an explicit min/max.',
      'Actions (muting the alarm, battery tests) need a username and password under Advanced, for a upsd.users entry whose instcmds include them, e.g. instcmds = beeper.mute test.battery.start.quick.',
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
      {
        Label: 'RFC 1628 — UPS Management Information Base',
        Url: 'https://datatracker.ietf.org/doc/html/rfc1628',
      },
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
      {
        Label: 'RFC 1628 — UPS Management Information Base',
        Url: 'https://datatracker.ietf.org/doc/html/rfc1628',
      },
      {
        Label: 'RFC 3414 — SNMPv3 User-based Security Model',
        Url: 'https://datatracker.ietf.org/doc/html/rfc3414',
      },
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
      {
        Label: 'RFC 1157 — Simple Network Management Protocol',
        Url: 'https://datatracker.ietf.org/doc/html/rfc1157',
      },
    ],
  },
  hyperdeck: {
    Summary:
      'Connects to a Blackmagic HyperDeck recorder on the HyperDeck Ethernet Protocol (TCP 9993) and reads its transport state and every media slot in one short session, sending only queries. Degraded by default when no media is mounted, the active slot is empty, or a slot reports a media error. Enable the recording toggle to flag a deck that is not recording, and the recording-time toggle to flag recording time left below a minimum (default 15 minutes, counted across all mounted slots because HyperDeck continues recording on the next card when one fills).',
    Setup: [
      "Set Address to the HyperDeck's IP address, set in Blackmagic HyperDeck Setup or the deck's Setup menu. The protocol port is 9993.",
      'HyperDeck accepts a limited number of protocol clients at once. A deck that answers "120 connection failed" reports Degraded — close other control software connected to it.',
      'Enable Check recording for the period the deck should be rolling, e.g. the show.',
      'Set the minimum recording time to the longest stretch that must record without a card change. Under Advanced, count the active slot only to be warned before each card fills.',
    ],
    Links: [
      {
        Label: 'HyperDeck Ethernet Protocol (Blackmagic Design)',
        Url: 'https://documents.blackmagicdesign.com/DeveloperManuals/HyperDeckEthernetProtocol.pdf',
      },
    ],
  },
  videohub: {
    Summary:
      'Connects to a Blackmagic Videohub router, or a computer running Videohub Server, on the Videohub Ethernet Protocol (TCP 9990) and reads the state dump it sends on connect. It sends nothing, so it cannot change a route, label or lock. Degraded when no router is attached, the router needs a firmware update, or the router reports a hardware alarm (power supply, fan). Enable Check routes to flag listed outputs that are not on their expected inputs.',
    Setup: [
      "Set Address to the router's IP address, set in Blackmagic Videohub Setup. For a USB-connected router, use the computer running Videohub Server.",
      'Enable Check routes and add one Output:Input entry per route, numbered from 1 as on the chassis and in Videohub Control, e.g. 3:7 for output 3 on input 7.',
      'Only main video outputs are checked. Monitoring outputs and serial ports are not.',
    ],
    Links: [
      {
        Label: 'Videohub Ethernet Protocol (Blackmagic Design)',
        Url: 'https://documents.blackmagicdesign.com/DeveloperManuals/VideohubDeveloperInformation.pdf',
      },
    ],
  },
  atem: {
    Summary:
      'Holds a read-only session to a Blackmagic ATEM switcher on UDP 9910 and reads the state the switcher pushes: product name, protocol version, power supplies, ME 1 program and preview, and streaming and recording status on models that have them. Only acknowledgements are sent; no command is ever sent to the switcher.',
    Setup: [
      'Find the switcher’s IP address in Blackmagic ATEM Setup (Configure tab) or on its front-panel network menu, and enter it as the address.',
      'Leave the port at 9910. ATEM switchers always use UDP 9910.',
      'Leave Check power supplies on. A supply that reports OK and then drops out turns the check Degraded; a supply that has never reported OK while monitored shows as not connected and is not flagged, so a dual-supply switcher run from one supply stays healthy.',
      'Turn on Check streaming or Check recording only for shows where the switcher must be live or recording for the whole check.',
      'The check holds one of the switcher’s limited control-client slots and gives it up a few minutes after the check is deleted or disabled.',
    ],
    Links: [
      {
        Label: 'atem-connection (protocol reference)',
        Url: 'https://github.com/Sofie-Automation/sofie-atem-connection',
      },
      {
        Label: 'OpenSwitcher UDP protocol notes',
        Url: 'https://docs.openswitcher.org/udptransport.html',
      },
      {
        Label: 'Blackmagic ATEM support',
        Url: 'https://www.blackmagicdesign.com/support/family/atem-live-production-switchers',
      },
    ],
  },
  'artnet-node': {
    Summary:
      'Unicasts an ArtPoll to an Art-Net node on UDP 6454 and reads its ArtPollReply: short and long name, node report, firmware, OEM/ESTA codes, MAC and the status of every DMX port (merging the replies of nodes with more than four ports). Online = a reply after the poll within the timeout. Degraded = a port reports a DMX output short or input receive errors, the node report carries a fault code, or (opt-in) the name does not match.',
    Setup: [
      "Enter the node's IPv4 address in the Address field. Art-Net always uses UDP port 6454.",
      'ShowTrak must be on the same network as the node (usually the 2.x.x.x or 10.x.x.x Art-Net range) with UDP 6454 allowed through the firewall.',
      "Close other Art-Net software on the ShowTrak machine (consoles, DMX-Workshop) or run it elsewhere: with two applications bound to UDP 6454, the node's unicast reply can reach the other application instead.",
      "Optionally enable the name check and enter the node's short or long name.",
    ],
    Links: [
      { Label: 'Art-Net 4 specification', Url: 'https://art-net.org.uk/downloads/art-net.pdf' },
    ],
  },
  'artnet-timecode': {
    Summary:
      'Passively listens for Art-Net timecode (ArtTimeCode) on UDP 6454 and confirms a source is sending it now. Online = packets from that source within the grace period. Degraded = packets keep arriving but the time has not advanced (opt-out), or the timecode type differs from the expected frame rate (opt-in). Many generators stop sending ArtTimeCode when their clock is stopped, so this check suits moments when timecode must be running.',
    Setup: [
      "Enter the timecode generator's source IP in the Address field.",
      'ShowTrak must be on the same network as the generator, with UDP 6454 allowed through the firewall.',
      'Optionally enable the frame-rate check and choose Film 24, EBU 25, Drop-frame 29.97 or SMPTE 30.',
    ],
    Links: [
      { Label: 'Art-Net 4 specification', Url: 'https://art-net.org.uk/downloads/art-net.pdf' },
    ],
  },
  'shure-wireless': {
    Summary:
      'Shure ULX-D, QLX-D, SLX-D and Axient Digital receivers over Shure command strings (TCP 2202). One read-only GET ALL per interval reads every channel: transmitter presence and model, battery bars, charge and runtime, mute, RF level and RF warnings. Battery is checked by default — Degraded when a monitored channel’s pack is at or below the bar or minutes threshold. Require transmitter, Check mute and Check RF warnings are opt-in. Battery is only judged while a transmitter is on.',
    Setup: [
      'Point Address at the receiver’s control IP address, not its Dante address. Port 2202 is fixed by Shure.',
      'List the channel numbers to monitor, or leave Channels empty to monitor every channel the receiver reports.',
      'Runtime in minutes is reported only for Shure rechargeable packs; AA batteries are judged on bars only.',
      'Enable Require transmitter only on channels that must always have a pack on, so spares do not raise alerts.',
    ],
    Links: [
      {
        Label: 'ULX-D command strings (Shure)',
        Url: 'https://pubs.shure.com/command-strings/ULXD/en-US',
      },
      {
        Label: 'SLX-D command strings (Shure)',
        Url: 'https://pubs.shure.com/command-strings/SLXD/en-US',
      },
      {
        Label: 'Axient Digital command strings (Shure)',
        Url: 'https://pubs.shure.com/command-strings/AD4/en-US',
      },
    ],
  },
  'sennheiser-wireless': {
    Summary:
      'Sennheiser Digital 6000 (EM 6000, EM 6000 Dante) and EW-DX (EM 2, EM 2 Dante, EM 4 Dante) receivers over Sennheiser Sound Control (SSC v1, JSON over UDP 45). Read-only queries read every channel: transmitter link, battery level and runtime, mute, RF and link quality, and the receiver’s own warnings. Battery is checked by default — Degraded when a monitored channel’s pack is low or at or below the percentage or minutes threshold. Require transmitter, Check mute and Check receiver warnings are opt-in.',
    Setup: [
      'Point Address at the receiver’s control IP address. SSC uses UDP 45; if a Digital 6000 receiver does not answer, set Port to 6970.',
      'EW-DX firmware 4.0 and later answers SSC v1 only with Legacy Mode enabled for the receiver in Sennheiser Wireless Systems Manager (WSM). Firmware below 4.0 needs no change.',
      'List the channel numbers to monitor, or leave Channels empty to monitor every channel the receiver reports.',
      'Runtime in minutes is reported only for rechargeable packs (BA 70, BA 60/61); AA batteries are judged on percentage only.',
    ],
    Links: [
      {
        Label: 'Sennheiser Sound Control Protocol (SSC)',
        Url: 'https://docs.cloud.sennheiser.com/en-us/api-docs/api-docs/sound-control-protocol.html',
      },
      {
        Label: 'SSC developer guide for Digital 6000 (TI 1109)',
        Url: 'https://www.sennheiser.com/globalassets/digizuite/41931-en-ti_1109_v2.2_sennheiser_sound_control_protocol_digital_6000_en.pdf',
      },
    ],
  },
  'x32-console': {
    Summary:
      'Queries a Behringer X32 / Midas M32 console or a Behringer X-Air / Midas MR mixer over its OSC remote protocol (UDP) for model, network name and firmware. Optionally flags a different console name, a muted main bus or muted input channels. Degraded = something answered but is not a console of this family, or an enabled assertion failed; Offline = no reply. Channel mutes reflect each channel’s own mute; mute groups and DCA mutes are not included.',
    Setup: [
      'Point Address at the console. X32 and M32 listen on UDP 10023; X-Air (XR12/16/18) and MR mixers listen on UDP 10024, so set Port to 10024 for those.',
      'No console configuration is required; the OSC remote is always on. The console replies to the port the request came from, so no firewall rule is needed on ShowTrak for an inbound port.',
      'To check the console name, enter the network name shown under Setup → Network (e.g. X32-02-4A-53).',
    ],
    Links: [
      {
        Label: 'X32/M32 OSC protocol (P. Maillot)',
        Url: 'https://github.com/bitfocus/companion-module-behringer-x32/blob/master/docs/X32-OSC.pdf',
      },
      {
        Label: 'Companion X32 module',
        Url: 'https://github.com/bitfocus/companion-module-behringer-x32',
      },
    ],
  },
  pixera: {
    Summary:
      'Calls PIXERA’s JSON-RPC API over TCP to read the API revision, the open project name and the transport state of each timeline. Optionally flags a different project or listed timelines that are paused, stopped or missing. Degraded = something answered but is not the PIXERA API, or an enabled assertion failed; Offline = no reply.',
    Setup: [
      'In PIXERA open Settings → API and set an API access point to protocol JSON/TCP (or JSON/TCP(dl)) with a port. 1400 is the conventional port. Restart PIXERA for the change to take effect.',
      'Set Port to that access point’s port and Access point protocol to the same protocol. With the wrong protocol PIXERA does not reply.',
    ],
    Links: [
      {
        Label: 'PIXERA API quick start',
        Url: 'https://pixera.helpjuice.com/api-quick-start-guide',
      },
      {
        Label: 'Companion PIXERA module',
        Url: 'https://github.com/bitfocus/companion-module-avstumpfl-pixera',
      },
    ],
  },
  'obs-studio': {
    Summary:
      'Connects to OBS Studio over obs-websocket 5 and reads the OBS and plugin versions, stream and recording state, program scene and performance stats in one request batch. Optionally flags a stream or recording that is not running, and dropped frames since the previous check. Degraded = OBS rejected the password, the server is not obs-websocket 5, or an enabled assertion failed; Offline = the WebSocket server is not reachable.',
    Setup: [
      'In OBS open Tools → WebSocket Server Settings, tick Enable WebSocket server and note the Server Port (default 4455).',
      'If Enable Authentication is ticked, copy the Server Password into Password.',
      'OBS 28 and later include obs-websocket 5. The older obs-websocket 4.x plugin (port 4444) is not supported.',
    ],
    Links: [
      {
        Label: 'obs-websocket 5 protocol',
        Url: 'https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md',
      },
    ],
  },
  'qsys-core': {
    Summary:
      'Q-SYS Core health over Q-SYS Remote Control (QRC, JSON-RPC 2.0 on TCP 1710). Reads platform, state (Active / Standby / Idle), running design, redundancy and emulator flags and the Core status in one read-only session. Degraded by default when the Core status is not OK or the Core is not Active; enable the design and Named Control toggles to also assert the running design and individual control values. Turn on Check design devices to also read the status of the amplifiers (CX-Q, DPA-Q, SPA-Q), I/O frames and peripherals (QIO, I/O-Frame, Core Flex I/O), NC Series cameras, PTZ-IP, I/O-USB and USB video bridges and TSC touch panels in the running design, plus amplifier channel Protect, Over Current and Short faults. Two actions, both confirmed before sending and only sent to the Active Core: Load Snapshot recalls a snapshot from a named bank, with an optional ramp, and Set Named Control sets one Named Control to a value. Works with hardware Cores and the Q-SYS Designer emulator.',
    Setup: [
      'Enable the Q-SYS Remote Control Protocol (JSONRPC) service, TCP 1710, for the Core LAN adapter ShowTrak can reach, in Core Manager → Network → Services (the service label varies by Q-SYS version).',
      'When Access Control is enabled, create a user with an external-control PIN in Q-SYS Administrator and enter it as User and PIN. Leave both blank when Access Control is off.',
      'For a redundant pair, add one check per Core and turn off Require Active state on the backup Core’s check, which sits in Standby by design.',
      'To assert controls, add each control to Named Controls in Q-SYS Designer, redeploy, and list them as Name=Value, e.g. MainMute=unmuted or MainGain=-6. Controls are read only while the Core is Active.',
      'To check design devices, Q-SYS must be told that outside systems may read them. In Q-SYS Designer, select each device’s Status component (and, for amplifier channel faults, its Amp Output component), open Properties, and set Script Access to External or All. The default, None, hides the component from ShowTrak completely. Save to the Core and run the design again.',
      'Choose Find them in the design to check every exposed device in the ticked categories, or Only the devices listed to name devices by the Code Name shown in their Properties. The debug panel lists exposed components that matched no category, with their type, so they can be listed by name instead.',
      'Devices are read only while the Core is Active. A device that is not required, or not yet paired, shows as Not Present; Q-SYS does not count that as a fault, so neither does ShowTrak unless Flag Not Present devices is on.',
      'Load Snapshot needs the snapshot bank’s name as given in Q-SYS Designer and the snapshot number. Set Named Control needs the control in the Named Controls list; the controls this check already asserts are offered as choices. Both use the same user and PIN as the check.',
    ],
    Links: [
      {
        Label: 'QRC overview (Q-SYS Help)',
        Url: 'https://help.qsys.com/Content/External_Control_APIs/QRC/QRC_Overview.htm',
      },
      {
        Label: 'QRC commands (Q-SYS Help)',
        Url: 'https://help.qsys.com/Content/External_Control_APIs/QRC/QRC_Commands.htm',
      },
      {
        Label: 'Code Name and Script Access (Q-SYS Help)',
        Url: 'https://help.qsys.com/Content/Control_Scripting/Code_Name_Script_Access.htm',
      },
      {
        Label: 'Status values (Q-SYS Help)',
        Url: 'https://help.qsys.com/Content/Control_Scripting/status_overview.htm',
      },
      {
        Label: 'Amp Output, CX-Q / DPA-Q (Q-SYS Help)',
        Url: 'https://help.qsys.com/Content/Schematic_Library/cxq_amplifier.htm',
      },
      {
        Label: 'Q-SYS component types (Q-SYS developer community)',
        Url: 'https://github.com/Q-SYS-Communities-for-Developers/reference-files/blob/main/Lua%20Modules/ComponentSelector/init.lua',
      },
    ],
  },
  'yamaha-console': {
    Summary:
      'Yamaha digital mixing console health over Yamaha’s Remote Control Protocol (RCP, plain text on TCP 49280). Reads model, firmware version, device name and run mode without changing anything on the desk. Degraded by default when the console is not in its normal run mode; enable the model, alert-status and stereo-master toggles to check those too. Covers CL, QL, TF, DM3, DM7 and RIVAGE PM.',
    Setup: [
      'Point Address at the console’s control IP, the NETWORK (Ethernet) port set on the console’s network setup screen, not its Dante primary or secondary port.',
      'Consoles accept only a few simultaneous remote-control clients (Companion, StageMix and editors count). ShowTrak connects for one query burst per interval and disconnects.',
      'Check stereo master is on reads MIXER:Current/St/Fader/On for the first stereo bus (ST L and ST R). Other Yamaha products (RIO, Tio, DME) report it as unsupported.',
    ],
    Links: [
      {
        Label: 'Yamaha RCP specification (DME7, same protocol family)',
        Url: 'https://data.yamaha.com/files/download/other_assets/8/1623778/DME7_remote_control_protocol_spec_v100_en.pdf',
      },
      {
        Label: 'Bitfocus Companion yamaha-rcp module',
        Url: 'https://github.com/bitfocus/companion-module-yamaha-rcp',
      },
    ],
  },
  '7thsense-delta': {
    Summary:
      'Connects to a 7thSense Delta Media Server on its external control Telnet port (TCP 23) and reads STATUS in one short session, sending nothing else: server name, Leader / Follower role, show file, play mode, current frame, frame rate, graphics mode and licence. Degraded = the server answered but is not Delta, did not recognise STATUS, has external control switched off (EXTCTRLCOMMS), or an enabled assertion failed; Offline = the port does not answer. Optional assertions flag a server that is not Playing, a frame that has not advanced since the previous check, the wrong show or role, a time-limited licence that has expired or is about to, and GPUs over a temperature limit (read from DeltaMonitor over HTTP).',
    Setup: [
      "Set Address to the Delta server's IP address. The external control port is set in DeltaGUI under Configure > Preferences > Communication (TCP External Control, default 23).",
      'Delta accepts 5 Telnet connections at once by default. Each probe holds one for under a second; show control systems that stay connected use the others.',
      'Enable Check playing and Check frame advancing for the period the show should be running. Frame advancing also trips on a timeline deliberately held on a frame.',
      'For a group, add one check per server with Check role enabled so a change of leader is flagged.',
      "GPU temperature comes from DeltaMonitor, which runs on Infinity, Nucleus, Proton and Nano servers but not on R-Series or P-Series servers. 7thSense documents its web API at http://<server>/api/deltamonitor/ (port 80); the ports list gives DeltaMonitor's own port as 7790.",
    ],
    Links: [
      {
        Label: 'Delta external control return codes (7thSense)',
        Url: 'https://portal.7thsense.one/user-guides/MC255-managing-servers/deltagui_external_controls_returncodes.html',
      },
      {
        Label: 'Delta external control commands (7thSense)',
        Url: 'https://portal.7thsense.one/user-guides/resources/ExternalControlHelp.html',
      },
      {
        Label: 'Network ports used by Delta Server (7thSense)',
        Url: 'https://portal.7thsense.one/user-guides/M685-systems-comms-ports/ports_ports-used.html',
      },
      {
        Label: 'DeltaMonitor external control commands (7thSense)',
        Url: 'https://portal.7thsense.one/user-guides/MC255-managing-servers/dmext_external_control_commands.html',
      },
    ],
  },
  motive: {
    Summary:
      'Queries OptiTrack Motive over its NatNet protocol (UDP 1510) for the Motive and NatNet versions, Live/Edit mode, frame rate, units and session folder. Flags Edit mode by default; optionally flags a frame rate other than expected, or listed rigid bodies that are not being tracked (sampled from the live frame stream for up to half a second). Degraded = something answered but is not Motive, or an enabled assertion failed; Offline = no NatNet reply. Read-only: nothing that changes Motive’s state is sent.',
    Setup: [
      'In Motive, open View → Settings → Streaming and turn on NatNet streaming (Enable; Broadcast Frame Data in older versions).',
      'Set Local Interface to the network adapter ShowTrak can reach. Loopback (127.0.0.1) only works when ShowTrak runs on the Motive PC.',
      'Point Address at that interface’s IPv4 address. Port is Motive’s Command Port (Streaming → advanced settings), default 1510. Allow UDP 1510 inbound on the Motive PC’s firewall.',
      'For rigid body tracking, also turn on Rigid Bodies under Streaming. In Multicast mode ShowTrak joins the group Motive reports (default 239.255.42.99) on the Data Port (default 1511), so multicast must reach ShowTrak and UDP 1511 must be free or shared on the ShowTrak PC. In Unicast mode frames are sent straight back to ShowTrak.',
      'List rigid bodies by their name in the Assets pane or by their Streaming ID. Rigid body tracking needs NatNet 3.0 (Motive 2.0) or later; names are fully resolved on NatNet 4.1 (Motive 3.1) or later.',
    ],
    Links: [
      {
        Label: 'NatNet remote requests/commands',
        Url: 'https://docs.optitrack.com/developer-tools/natnet-sdk/natnet-remote-requests-commands',
      },
      {
        Label: 'NatNet 4.5 overview',
        Url: 'https://docs.optitrack.com/developer-tools/natnet-sdk/natnet-4.5',
      },
      {
        Label: 'Motive streaming settings',
        Url: 'https://docs.optitrack.com/motive-ui-panes/settings/settings-streaming',
      },
      {
        Label: 'NatNet sample projects',
        Url: 'https://docs.optitrack.com/developer-tools/natnet-sdk/natnet-sample-projects',
      },
    ],
  },
  'snmp-oid': {
    Summary:
      'Reads one or more OIDs from any SNMP agent over v1, v2c or v3 and shows each value with its type. Each OID can carry a check: equals, not equals, greater than, less than, contains or present. Offline when the agent does not answer; Degraded when an OID is missing (noSuchObject, noSuchInstance, endOfMibView) or a check fails, naming the OID and its value. For switches, PDUs, amplifiers and other devices without a dedicated ShowTrak method.',
    Setup: [
      'Enable SNMP on the device. For v1/v2c match the community string (default "public"); for v3 enter the username and the auth/priv protocols and passwords exactly as configured on the device.',
      'Add one OID per entry, in numeric form (e.g. 1.3.6.1.2.1.1.5.0). A leading dot is ignored. Names such as sysName.0 are not accepted — look the number up in the device MIB.',
      'To check a value, follow the OID with a comparison: 1.3.6.1.2.1.1.5.0 = Stage Left, 1.3.6.1.2.1.2.2.1.8.1 != 2, an OID > 20 or < 50, contains Text, or present. A bare OID only has to exist. Give the same OID twice to check a range.',
      'Numbers (Integer, Counter, Gauge, TimeTicks, Counter64) compare numerically. Text compares without regard to case; write "" to match an empty value. Binary values are shown as hex and compare as hex, so a MAC address can be written 00:1a:2b:3c:4d:5e.',
      'A credential mismatch is reported as Offline, because an agent silently drops a request it will not authenticate.',
    ],
    Links: [
      {
        Label: 'RFC 3416 — SNMPv2 protocol operations',
        Url: 'https://datatracker.ietf.org/doc/html/rfc3416',
      },
      {
        Label: 'RFC 3414 — SNMPv3 User-based Security Model',
        Url: 'https://datatracker.ietf.org/doc/html/rfc3414',
      },
      {
        Label: 'RFC 1213 — MIB-II',
        Url: 'https://datatracker.ietf.org/doc/html/rfc1213',
      },
    ],
  },
  'powersoft-amp': {
    Summary:
      'Queries a Powersoft X Series or Canali DSP amplifier (Duecanali, Quattrocanali, Ottocanali) over its UDP control protocol for the model, serial number, standby state, amplifier and channel alarms, and output mutes. Optionally flags standby, amplifier faults (mains phase, converter, AUX voltage, over-temperature, fan), channel faults (over-temperature, rail voltage, low load protection, thermal SOA, AUX current, other), input clip, muted outputs or a different serial number. Degraded = something answered but is not a Powersoft amplifier, or an enabled assertion failed; Offline = no reply. The check itself only reads; the Power On, Standby, Mute Output and Unmute Output actions are sent only when an operator presses them.',
    Setup: [
      'Point Address at the amplifier. It listens on UDP 1234 and replies to the port the request came from, so no inbound firewall rule is needed on ShowTrak.',
      'No amplifier configuration is required. Powersoft discourages using this protocol to change settings alongside ArmoníaPlus: the check only reads, and the actions change just standby and the output mutes.',
      'The mute actions use the output mute ("Way EQ" in Armonía), one channel or all of them. Channels are numbered from 1.',
      'Some alarms (mains phase, AUX voltage, power supply and moderate/high over-temperature, thermal SOA, AUX current) are reported by X Series amplifiers only.',
      'To check the serial number, enter the serial shown in ArmoníaPlus.',
    ],
    Links: [
      {
        Label: 'Powersoft X Series / Canali DSP UDP protocol (PDF)',
        Url: 'https://github.com/bitfocus/companion-module-powersoft-amplifiers/blob/main/docs/API_for_X_T_Canali-DSP_0.16.pdf',
      },
      {
        Label: 'Companion Powersoft module',
        Url: 'https://github.com/bitfocus/companion-module-powersoft-amplifiers',
      },
    ],
  },
  'dbaudio-amp': {
    Summary:
      'd&b audiotechnik amplifier health over AES70 (OCA), using the OCP.1 binary protocol on TCP. Reads model, firmware, device name, serial number, device state, power (on or standby) and each channel’s mute, input signal (ISP), limiter (GR) and overload (OVL) indicators in one read-only session. Degraded by default when the amplifier is in standby, reports an error or a channel is in overload; enable the mute, limiting, input signal and device name toggles to check those too. Covers D20, D40, D80, 10D, 30D, 40D and 5D.',
    Setup: [
      'Connect the amplifier’s Ethernet port to a network ShowTrak can reach and give it an IP address (d&b R1 or the amplifier’s front panel shows it). The amplifier must be on the same network that d&b R1 uses to control it.',
      'Leave Amplifier model on Detect automatically, or pick the model to skip the port search. D20, D80, 10D and 30D use port 30013; D40, 40D and 5D use port 50014.',
      'Overload is a momentary indicator, so a check only sees an overload that is happening as it runs.',
      'To catch a swapped amplifier, turn on Check device name and enter the name set in R1.',
      'The Power On, Standby, Mute Channel and Unmute Channel actions act on the same power and channel mute that R1 shows. If Power On reports that the object was not found, pick the amplifier model instead of Detect automatically.',
    ],
    Links: [
      {
        Label: 'd&b OCA / AES70 overview',
        Url: 'https://www.dbaudio.com/global/en/solutions/signal-distribution-and-networking/ocaaes70/',
      },
      {
        Label: 'AES70 standards (OCA Alliance)',
        Url: 'https://www.ocaalliance.com/resources/standards__specifications/',
      },
      {
        Label: 'NanoOcp d&b object definitions (GitHub)',
        Url: 'https://github.com/ChristianAhrens/NanoOcp/blob/main/Source/Ocp1ObjectDefinitions.h',
      },
      {
        Label: 'Companion d&b amps module (GitHub)',
        Url: 'https://github.com/bitfocus/companion-module-dbaudiotechnik-amps',
      },
    ],
  },
  'biamp-tesira': {
    Summary:
      'Biamp Tesira health over the Tesira Text Protocol (TTP) on Telnet, TCP 23. Reads model, serial number, firmware, hostname, network interface status and the active fault list in one read-only session. Degraded by default while the device has an active fault, including faults on expanders it proxies; enable the port and attribute toggles to also require link on named network ports and assert individual block attributes. Works with Tesira SERVER and SERVER-IO, TesiraFORTÉ and TesiraLUX.',
    Setup: [
      'Enable Telnet on the device: in Tesira software open Device Maintenance → Network Settings and tick Telnet under Services. Telnet has been off by default since 2016-era firmware.',
      'On an unprotected system leave the username and password as default / default. On a protected system enter a user configured in the system. The check only reads, so an observer-level user is enough for it; the Recall Preset, Mute and Unmute actions need a controller-level user or higher.',
      'The actions recall a preset by ID (such as 1001) or by name, and mute or unmute one channel of a level or mute block by its instance tag. Each press opens its own short session using the same port and login as the check.',
      'Add one check per Tesira server-class device. The fault list covers the device you connect to and any expanders that use it as their proxy, not other servers in the system.',
      'To assert block attributes, list each as instance tag, attribute and index, then =expected value, e.g. Level1 mute 1=false or Level1 level 1=-10. Instance tags are case sensitive; the Tesira Command String Calculator shows the right attribute names.',
      'SSH (TCP 22) is not supported; the check uses Telnet only.',
    ],
    Links: [
      {
        Label: 'Tesira Text Protocol (Biamp Cornerstone)',
        Url: 'https://support.biamp.com/Tesira/Control/Tesira_Text_Protocol',
      },
      {
        Label: 'TTP fault responses (Biamp Cornerstone)',
        Url: 'https://support.biamp.com/Tesira/Control/Tesira_TTP_fault_responses',
      },
      {
        Label: 'DEVICE attributes (Tesira Help)',
        Url: 'https://tesira-help.biamp.com/System_Control/Tesira_Text_Protocol/Attribute_tables/Service_Addresses/Device.html',
      },
      {
        Label: 'Telnet negotiation (Tesira Help)',
        Url: 'https://tesira-help.biamp.com/System_Control/Tesira_Text_Protocol/Telnet.htm',
      },
      {
        Label: 'TTP security and login (Tesira Help)',
        Url: 'https://tesira-help.biamp.com/System_Control/Tesira_Text_Protocol/TTP_Security.htm',
      },
    ],
  },
  'symetrix-dsp': {
    Summary:
      'Symetrix Composer DSP health over the Composer Control Protocol (plain text on TCP 48631). Confirms the unit answers commands (NOP), and reads its firmware version report and the last preset loaded, all read-only. The protocol has no fault or status command, so health beyond that comes from control numbers: enable the toggles to assert the loaded preset and the values of listed control numbers, such as the Status LEDs on Composer’s power supply and thermal diagnostics panels. Works with Radius NX, Edge, Prism, Solus NX and other Composer units.',
    Setup: [
      'No setup is needed on the unit for the connectivity and version check: the control port is always on TCP 48631.',
      'To check health, give control numbers to what matters in Composer, e.g. the Status LEDs on the Power Supply and Thermal diagnostics panels (0 = OK, 65535 = Failed), then push the site file. List them as 101=0, or with a comparison such as 205>=30000. Buttons and LEDs read 0 or 65535; on and off also work.',
      'Turn on Check last preset to confirm the expected preset is loaded. A unit that has not loaded a preset since it started reports none.',
      'The actions load a preset by number and set a control number to a position from 0 to 65535. Set Control offers the control numbers listed in the control assertions. Each press opens its own short session and closes it as soon as the unit answers.',
      'A unit accepts six TCP control sessions and closes the least recently used one when a seventh connects. If a control system already holds six, this check or an action can displace one of them.',
    ],
    Links: [
      {
        Label: 'Composer Control Protocol (Symetrix)',
        Url: 'https://composer-docs.symetrix.co/control/reference-topics/control-protocol/CP_Introduction.html',
      },
      {
        Label: 'Control commands: GS2, GPR, CS, LP (Symetrix)',
        Url: 'https://composer-docs.symetrix.co/control/reference-topics/control-protocol/CP_Control_Commands.html',
      },
      {
        Label: 'Setup commands: NOP, V (Symetrix)',
        Url: 'https://composer-docs.symetrix.co/control/reference-topics/control-protocol/CP_Setup_Commands.html',
      },
      {
        Label: 'Parameter notes: diagnostics values (Symetrix)',
        Url: 'https://composer-docs.symetrix.co/control/reference-topics/control-protocol/CP_Parameter_Notes.html',
      },
    ],
  },
  'allen-heath-console': {
    Summary:
      'Allen & Heath console health over the MIDI over TCP protocol (TCP 51325, or 51328 for a dLive Surface). On dLive and Avantis it asks for the name of Input 1, which proves the console is answering; an SQ has no such query, so without mute checks only the connection is tested. Optional checks flag a muted main mix (Main 1 on dLive, LR on SQ) and muted input channels on dLive and SQ. Avantis documents no mute query, so mutes are not read there. The check only sends documented queries. Operator actions recall a scene and mute or unmute an input channel; recall and mute ask for confirmation first.',
    Setup: [
      'Choose the console family, and point Address at the console: the dLive MixRack (port 51325) or Surface (port 51328), the Avantis, or the SQ network port. The encrypted ports (51327 and 51329) are not supported.',
      'Set Base MIDI channel to the channel set under Utility, Control, MIDI on dLive and Avantis (Avantis ships set to 12), or Utility, General, MIDI on SQ. With the wrong channel the console stays silent and the check reads offline.',
      'SQ mute checks need SQ firmware 1.5.0 or later. Older SQ firmware may treat the query as a mute toggle, so leave them off on older desks.',
      'The current scene is not reported: these consoles only send a scene number when a scene is recalled, and have no query for it.',
      'Mute checks read each channel’s own mute. Mute groups and DCA mutes are not reflected.',
      'Actions use the same base MIDI channel, so set it correctly before pressing one: a wrong channel would act on a different kind of channel. On dLive and Avantis the console must answer a name query before the action is sent. Scene recall on dLive needs the MixRack (port 51325), because the Surface treats the same message as a cue recall.',
    ],
    Links: [
      {
        Label: 'dLive MIDI over TCP/IP protocol V2.0',
        Url: 'https://www.allen-heath.com/content/uploads/2024/06/dLive-MIDI-Over-TCP-Protocol-V2.0.pdf',
      },
      {
        Label: 'SQ MIDI protocol (Issue 5)',
        Url: 'https://www.allen-heath.com/content/uploads/2023/11/SQ-MIDI-Protocol-Issue5.pdf',
      },
      {
        Label: 'Avantis MIDI TCP/IP protocol',
        Url: 'https://support.allen-heath.com/hc/en-gb/articles/45146889174801-Avantis-MIDI-TCP-IP-Protocol',
      },
      {
        Label: 'Bitfocus Companion allenheath-dlive module',
        Url: 'https://github.com/bitfocus/companion-module-allenheath-dlive',
      },
      {
        Label: 'Bitfocus Companion allenheath-sq module',
        Url: 'https://github.com/bitfocus/companion-module-allenheath-sq',
      },
    ],
  },
  'digico-console': {
    Summary:
      'DiGiCo SD and Quantum console health over the DiGiCo Pad (iPad) OSC interface. Reads the console name, the loaded session file and the current snapshot index. Optional checks flag a different session and muted input channels. The check only sends "/?" queries. Operator actions fire a snapshot and mute or unmute an input channel; each is sent once, only after the console has answered. Offline means the console did not answer, which is usually the External Control setup.',
    Setup: [
      'On the console, open System, External Control, set Enable External Control to Yes and add a DiGiCo Pad device with this computer’s IP address. Enable it.',
      'Set that device’s Send port to this check’s Listen port (default 7000) and its Rcv port to the Console receive port (default 7001). The console sends replies only to that IP and Send port, so the Listen port must be free on this computer (close Companion’s DiGiCo module if it uses the same port).',
      'Under Commands Allowed, load the iPad command file for the console (iPadv2sd8-9-11-12 on SD8, SD9, SD11 and SD12, ipad_q3 on Quantum). Without it the console ignores the queries.',
      'Current snapshot is the snapshot’s position in the list, not its number on the surface, so it is shown but not checked. Fire Snapshot takes the same position number.',
    ],
    Links: [
      {
        Label: 'Bitfocus Companion digico-osc module (command table)',
        Url: 'https://github.com/bitfocus/companion-module-digico-osc',
      },
      {
        Label: 'DiGiCo: generic OSC control on the SD range',
        Url: 'https://digico.biz/digico-opens-up-the-sd-range-with-generic-osc-control/',
      },
    ],
  },
  'brompton-tessera': {
    Summary:
      'Reads a Brompton Tessera LED processor (SX40, S8, S4, M2, T1, T8) over its HTTP IP control API in one request: model, software version, active input and format, panel counts, blackout, freeze and test pattern, active preset, failover partner, cable loops and processor temperatures. By default flags panels that are offline or reporting errors; optional toggles also flag blackout, freeze, test pattern, an unexpected or missing input format, hot sensors, a missing failover partner and broken cable loops. Degraded = the processor answered but an enabled assertion failed; Offline = no answer, or not the Tessera API.',
    Setup: [
      'In Tessera open the Live Control tile and enable IP control. The API is served on port 80 and has no password.',
      'Expected panels: leave at 0 to expect every panel the processor controls to be online, or enter the number that should be online.',
      'Temperatures and fan readings need newer Tessera firmware. Older versions simply do not report them. Brompton does not document their unit, so temperatures are taken to be °C.',
      'Actions: Blackout, Freeze and Recall Preset ask for confirmation. Clear Blackout, Unfreeze and Test Pattern Off restore the picture. Recall Preset lists the presets the processor reports.',
    ],
    Links: [
      {
        Label: 'Tessera IP Control API (3.1.0)',
        Url: 'https://github.com/bitfocus/companion-module-brompton-tessera/blob/main/docs/TesseraIPControlAPI3_1_0_Beta4.pdf',
      },
      {
        Label: 'Companion Brompton Tessera module',
        Url: 'https://github.com/bitfocus/companion-module-brompton-tessera',
      },
    ],
  },
  'barco-eventmaster': {
    Summary:
      'Calls a Barco Event Master processor (E2, S3, EX, Encore3) over its JSON-RPC API on port 9999: frame type and software version, card over-temperature and fan warnings, power supply status and the video status of every input source. By default flags card temperature or fan warnings and a power supply that has lost AC or DC; optional toggles also flag cards that are not Ready, an empty power supply slot, sources without valid video and frozen sources. Degraded = the processor answered but an enabled assertion failed; Offline = no answer, or not Event Master.',
    Setup: [
      'Point the check at the host processor. In a host and client system, Event Master only answers JSON-RPC on the host unit.',
      'Port 9999 is fixed by Barco. No login is needed.',
      'To watch input signal, enable Check input signal and list the source names to watch, or leave the list empty to watch every live input.',
      'Actions: Recall Preset to Preview runs straight away; Recall Preset to Program, Take and Cut ask for confirmation first. Take and Cut act on every armed destination, as the buttons on the controller do.',
      'If multi-operator mode is on in Event Master, set Multi-operator mode under Advanced so the actions run as an operator or the super operator.',
    ],
    Links: [
      {
        Label: 'Barco JSON-RPC for Encore3 v10.0',
        Url: 'https://github.com/bitfocus/companion-module-barco-eventmaster/blob/master/docs/Barco%20JSON%20RPC%20with%20Encore3%20processors%20v10.0-Final.pdf',
      },
      {
        Label: 'Barco JSON-RPC for Event Master 8.2',
        Url: 'https://github.com/bitfocus/companion-module-barco-eventmaster/blob/master/docs/JSON_RPC_with_EM_processors_Doc_8_2.docx',
      },
      {
        Label: 'Companion Barco Event Master module',
        Url: 'https://github.com/bitfocus/companion-module-barco-eventmaster',
      },
    ],
  },
  'analogway-livepremier': {
    Summary:
      'Reads an Analog Way LivePremier unit (Aquilon RS and C series, firmware 4.0 or later) over its REST API: model, label and firmware version, plus whether each listed input has a valid signal, is enabled and is frozen. Optional toggles flag inputs without a valid signal and an unexpected firmware version. The REST API does not report power supplies, fans or temperatures. Degraded = the unit answered but the password is missing or wrong, or an enabled assertion failed; Offline = no answer, or not the LivePremier REST API.',
    Setup: [
      'In the Web RCS open Application Programming Interfaces and enable the REST API.',
      'If the Web RCS is password protected, enter the password. ShowTrak logs in as Admin and reuses the session.',
      'To watch inputs, enable Check input signal and list the input numbers as shown in the Web RCS.',
      'Actions: Load Memory to Preview runs straight away; Load Memory to Program and Take (one screen) ask for confirmation first. They use the same password as the check.',
    ],
    Links: [
      {
        Label: 'LivePremier REST API Programmer’s Guide v4.01',
        Url: "https://s3.eu-west-3.amazonaws.com/aw.store01/Site+Internet/Series/LivePremier/Common/Rest+API+Programmer's+Guide/livepremier_rest_api_programmers_guide_v4.1.pdf",
      },
      {
        Label: 'LivePremier REST API Programmer’s Guide v4.0',
        Url: "https://s3.eu-west-3.amazonaws.com/aw.store01/Site+Internet/Series/LivePremier/Common/Rest+API+Programmer's+Guide/livepremier_rest_api_programmers_guide_v4.0.pdf",
      },
    ],
  },
  'aja-device': {
    Summary:
      "Reads an AJA Ki Pro, HELO / HELO Plus, FS-series frame sync or other AJA network device over AJA's REST parameter API (HTTP /config), sending only get requests. It lists the device's own alarms from its parameter descriptors (desc.json) and reads the recorder state, media remaining, video input and name where the device has them. Degraded by default when the device raises an alarm (input loss, temperature, dropped frames and so on) or its recorder or streamer reports a failure. Enable the recording toggle to flag a device that is not recording, and the media toggle to flag free space below a minimum (default 10%). Controls: Record and Stop on a Ki Pro or HELO, Play on a Ki Pro, and Start / Stop Streaming on a HELO.",
    Setup: [
      "Set Address to the device's IP address, the same one you open its web interface with. The port is 80 unless it has been changed.",
      'If authentication is turned on in the device, enter its password. Leave it blank otherwise.',
      'Choose the lowest alarm severity that should degrade the check. Alarms below it are still shown.',
      'Enable Check recording for the period the recorder should be rolling, e.g. the show.',
      'Model and firmware are not shown: AJA does not document a parameter for them.',
      'Alarms the device has been told to suppress are still shown: AJA does not document how to tell which alarm a suppression setting belongs to.',
      "The controls send AJA's documented transport commands. Stop on a Ki Pro pauses first; pressed again it returns to idle. A control the device does not have (streaming on a Ki Pro, play on a HELO) is refused without sending anything.",
    ],
    Links: [
      {
        Label: 'AJA REST API (AJA Video Systems)',
        Url: 'https://gitlab.aja.com/pub/rest_api',
      },
      {
        Label: 'AJA alarm parameters (protobuf)',
        Url: 'https://gitlab.aja.com/pub/rest_api/-/blob/master/08_Protobuf_Encoded_Parameters.md',
      },
      {
        Label: 'HELO REST commands',
        Url: 'https://gitlab.aja.com/pub/rest_api/-/blob/master/HELO/03_HELO_Commands.md',
      },
      {
        Label: 'Ki Pro Ultra Plus / Ultra 12G REST commands',
        Url: 'https://gitlab.aja.com/pub/rest_api/-/blob/master/KiProUltraPlus_KiProUltra12G/06_KPUP_KPU12G_Commands.md',
      },
    ],
  },
  'ptz-camera': {
    Summary:
      'Queries a PTZ camera, sending only inquiries. Panasonic AW-series cameras are read over their HTTP control interface (power, model, software version, error information, red tally); Sony cameras over VISCA over IP on UDP 52381 (power, model and ROM version, pan/tilt mechanism status, red tally where the model supports it). Degraded by default when the camera is in standby or reports an error such as a fan, temperature, motor or pan/tilt fault. Controls: Power On, Standby and Recall Preset.',
    Setup: [
      "Choose the protocol, then set Address to the camera's IP address.",
      'Panasonic: the HTTP port is 80. If the camera requires authentication for control commands, enter its username and password; Digest and Basic are both supported.',
      'Sony: turn on VISCA over IP in the camera. The port is 52381. If the camera answers other controllers but never this check, set Receive replies on to UDP 52381 under Advanced.',
      'Panasonic error codes vary by model. Codes that mean the same on every model are named; others are shown as their hex code, to look up in the camera’s interface specification.',
      'Turn off Check standby for cameras that are meant to sit in standby between shows.',
      'Recall Preset takes the preset number as the camera shows it, starting at 1 (Panasonic 1 to 100). A camera in standby refuses presets until it is powered on.',
    ],
    Links: [
      {
        Label: 'Panasonic HD/4K Integrated Camera Interface Specifications',
        Url: 'https://eww.pass.panasonic.co.jp/pro-av/support/content/guide/DEF/InterfaceSpecifications_CompatibleModelTable_E.pdf',
      },
      {
        Label: 'Panasonic camera protocol notes (Bitfocus Companion)',
        Url: 'https://github.com/bitfocus/companion-module-panasonic-cameras',
      },
      {
        Label: 'Sony BRC-X400 / SRG-X400 VISCA Command List (VISCA over IP)',
        Url: 'https://sony.net/Products/CameraSystem/CA/BRC_X400_SRG_X400/Technical_Document/E042100211.pdf',
      },
      {
        Label: 'Sony VISCA command lists (Bitfocus Companion)',
        Url: 'https://github.com/bitfocus/companion-module-sony-visca/tree/main/protocol',
      },
    ],
  },
  'datapath-fx4': {
    Summary:
      'Reads a Datapath Fx4, Fx4-SDI or Fx4-HDR video wall controller over its REST API: serial, firmware, friendly name, active and preferred input, the active input format, power supply rails, temperature, HDCP and, for each output in use, whether it is on, live or showing a test pattern, and its format. By default flags no input signal, a power supply fault and an HDCP failure; optional toggles also flag a fallback from the preferred input, an unexpected input format, outputs switched off, test patterns and a high temperature. Degraded = the controller answered but an enabled assertion failed; Offline = no answer, or not the Fx4 REST API.',
    Setup: [
      'Connect one of the Fx4 LAN ports to the show network and give it an IP address in Wall Designer (Devices, device properties). The REST API is served on port 80.',
      'The check only reads, and reads need no password. If a password has been set on the Fx4, enter it under Device password so the actions work.',
      'Outputs in use: set how many outputs feed screens, counting from output 1, so an unused output is not checked.',
      'Check preferred input: the Fx4 falls back to another input when the preferred one loses its signal. Turn this on to be told when that happens.',
      'Datapath does not publish a temperature limit. Leave the temperature check off, or set the limit a few degrees above what the controller normally reads.',
      'Actions: Set Preferred Input, Show Test Pattern and Switch Output Off ask for confirmation. Show Live Input and Switch Output On restore the picture. Changes are not saved to the controller, so a restart brings back its saved settings.',
    ],
    Links: [
      {
        Label: 'Fx4-HDR, Fx4-SDI and Fx4 REST API v3.0.1 (SDK download)',
        Url: 'https://www.datapathsoftware.com/downloads/fx4-hdr-fx4-sdi-and-fx4-rest-api-v3-0-1-2/',
      },
      {
        Label: 'Fx4-HDR user guide',
        Url: 'https://www.datapathdocuments.co.uk/wp-content/uploads/Fx4-HDR_User_Guide_EN.pdf',
      },
      {
        Label: 'Companion Datapath Fx4 module',
        Url: 'https://github.com/bitfocus/companion-module-datapath-fx4',
      },
    ],
  },
};

export { MethodInfo };
