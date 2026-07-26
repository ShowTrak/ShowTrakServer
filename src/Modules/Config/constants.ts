// Shared ports and timing constants that were previously inlined at their
// call sites. Keep values here so a change lands everywhere at once.

// HTTP + Socket.IO server port (desktop bridge, Web UI, client agents).
export const APP_PORT = 3000;

// UDP port the inbound OSC control server listens on.
export const OSC_PORT = 3333;

// UDP port sACN (ANSI E1.31) streaming DMX is transmitted on. A single shared
// receiver binds here and joins the multicast group for each monitored universe.
export const SACN_PORT = 5568;

// UDP port Art-Net is transmitted on. Unlike sACN, Art-Net is broadcast/unicast
// (no multicast), so a single shared receiver binds here and simply listens.
export const ARTNET_PORT = 6454;

// Fallback timeout for a queued script execution when the script does not
// declare its own `Timeout`.
export const SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS = 15000;

// Debounce between a script-folder change and redeploying to adopted clients.
export const SCRIPT_DEPLOY_DEBOUNCE_MS = 450;

// Minimum gap between automatic deploys to a client that just came online.
export const ONLINE_DEPLOY_COOLDOWN_MS = 10000;

// How long after a client connects its critical applications, USB devices and
// displays are allowed to still be missing before that counts as a fault.
//
// A machine that has just powered on connects long before it has finished
// starting up: the ShowTrak client is running (so it heartbeats and reports
// honestly) while the show software is still launching and hardware is still
// enumerating. Every one of those gaps is a real observation of a state that is
// about to fix itself, and at rig power-up they arrive from every machine at
// once. Inside this window the tile reads "Starting Up" rather than degraded
// and the alert is held; the moment it closes, whatever is still missing is a
// genuine fault and is reported as one.
export const CLIENT_STARTUP_GRACE_MS = 20000;

// Minimum time the preloader window stays visible before the main window swaps in.
export const PRELOADER_MIN_DISPLAY_MS = 800;

// Stagger between per-client dispatches during a bulk script deployment.
export const BULK_DISPATCH_DELAY_MS = 150;

// Interval between monitoring target check ticks.
export const MONITORING_TICK_INTERVAL_MS = 1500;

// How long a fault that was already true the first time we looked at something
// must persist before it is announced.
//
// Alerts are transition-driven, so a device that was dead before the server
// started is not an event and is not announced as one — that is what stops a
// restart mid-show from firing for every machine still coming up. It is not
// forgotten either: anything still faulty this long after the server (or the
// entity) was first seen gets one alert, so a genuinely dead device is not
// discoverable only by looking at the screen. Long enough for a rig to finish
// powering up.
export const ALERT_BASELINE_SETTLE_MS = 3 * 60 * 1000;

// How often the settle sweep runs. Only the age above decides whether a fault
// is announced; this just bounds how late that announcement can be.
export const ALERT_BASELINE_SWEEP_INTERVAL_MS = 30 * 1000;

// Default polling interval applied to a monitoring target / dummy client / check
// method when none is configured (or the configured value is invalid).
export const DEFAULT_MONITORING_INTERVAL_MS = 30000;

// How long DB shutdown waits for in-flight SQLite operations to drain.
export const DB_PENDING_OPERATION_TIMEOUT_MS = 15000;
