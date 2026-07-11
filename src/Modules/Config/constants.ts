// Shared ports and timing constants that were previously inlined at their
// call sites. Keep values here so a change lands everywhere at once.

// HTTP + Socket.IO server port (desktop bridge, Web UI, client agents).
export const APP_PORT = 3000;

// UDP port the inbound OSC control server listens on.
export const OSC_PORT = 3333;

// UDP port sACN (ANSI E1.31) streaming DMX is transmitted on. A single shared
// receiver binds here and joins the multicast group for each monitored universe.
export const SACN_PORT = 5568;

// Fallback timeout for a queued script execution when the script does not
// declare its own `Timeout`.
export const SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS = 15000;

// Debounce between a script-folder change and redeploying to adopted clients.
export const SCRIPT_DEPLOY_DEBOUNCE_MS = 450;

// Minimum gap between automatic deploys to a client that just came online.
export const ONLINE_DEPLOY_COOLDOWN_MS = 10000;

// Minimum time the preloader window stays visible before the main window swaps in.
export const PRELOADER_MIN_DISPLAY_MS = 800;

// Stagger between per-client dispatches during a bulk script deployment.
export const BULK_DISPATCH_DELAY_MS = 150;

// Interval between monitoring target check ticks.
export const MONITORING_TICK_INTERVAL_MS = 1500;

// Default polling interval applied to a monitoring target / dummy client / check
// method when none is configured (or the configured value is invalid).
export const DEFAULT_MONITORING_INTERVAL_MS = 30000;

// How long DB shutdown waits for in-flight SQLite operations to drain.
export const DB_PENDING_OPERATION_TIMEOUT_MS = 15000;
