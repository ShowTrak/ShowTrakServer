// Pure normalization helpers and bounds shared across the FreeKioskManager
// modules. No I/O, so they are unit-testable on their own.
import { BuildFreeKioskAlarmFields } from '../FreeKiosk/metrics';

const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;

// FreeKiosk's own Home Assistant guidance polls /api/status every 30s, and the
// device captures its status synchronously, so this is the interval the device
// is designed for rather than an arbitrary default.
const DEFAULT_INTERVAL_MS = 30000;

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 5000;

const DEFAULT_PORT = 8080;

function ClampInterval(Value: unknown): number {
  let n = Number(Value);
  if (!Number.isFinite(n)) n = DEFAULT_INTERVAL_MS;
  if (n < MIN_INTERVAL_MS) n = MIN_INTERVAL_MS;
  if (n > MAX_INTERVAL_MS) n = MAX_INTERVAL_MS;
  return Math.round(n);
}

function ClampTimeout(Value: unknown): number {
  let n = Number(Value);
  if (!Number.isFinite(n)) n = DEFAULT_TIMEOUT_MS;
  if (n < MIN_TIMEOUT_MS) n = MIN_TIMEOUT_MS;
  if (n > MAX_TIMEOUT_MS) n = MAX_TIMEOUT_MS;
  return Math.round(n);
}

function ClampPort(Value: unknown): number {
  const n = Number(Value);
  if (!Number.isFinite(n)) return DEFAULT_PORT;
  const Rounded = Math.trunc(n);
  if (Rounded < 1 || Rounded > 65535) return DEFAULT_PORT;
  return Rounded;
}

/**
 * Reduce whatever the user typed to a bare host.
 *
 * People paste `http://10.0.0.5:8080/` out of a browser, so a scheme, a port and
 * a trailing path are all stripped rather than rejected — the port has its own
 * field, and leaving a path on the host would corrupt every request line.
 */
function NormalizeAddress(Value: unknown): string {
  if (typeof Value !== 'string') return '';
  let Address = Value.trim();
  if (!Address) return '';
  Address = Address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const Slash = Address.indexOf('/');
  if (Slash !== -1) Address = Address.slice(0, Slash);
  // A bracketed IPv6 literal keeps its brackets; anything else loses a :port.
  if (Address.startsWith('[')) {
    const End = Address.indexOf(']');
    if (End !== -1) Address = Address.slice(0, End + 1);
  } else {
    const Colon = Address.indexOf(':');
    if (Colon !== -1) Address = Address.slice(0, Colon);
  }
  return Address.trim();
}

const HOSTNAME_PATTERN =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function IsValidAddress(Value: unknown): boolean {
  const Address = String(Value ?? '').trim();
  if (!Address || Address.length > 255) return false;
  if (Address.startsWith('[') && Address.endsWith(']')) {
    // IPv6 literal: hex groups, colons and an optional embedded IPv4 tail.
    return /^\[[0-9A-Fa-f:.]+\]$/.test(Address);
  }
  return HOSTNAME_PATTERN.test(Address);
}

/** Random 6-digit suffix used for the default nickname, matching dummy clients. */
function RandomSuffix(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Only the keys the generated alarm schema declares are stored. A show file that
// predates a metric being withdrawn would otherwise keep feeding settings that
// nothing evaluates back into the editor.
const ALARM_FIELD_KEYS: ReadonlySet<string> = new Set(
  BuildFreeKioskAlarmFields().map((Field) => Field.Key)
);

/**
 * Read the stored Settings JSON, dropping anything the alarm schema does not
 * declare. Accepts an object as well as a string so the same helper serves both
 * a DB row and an IPC payload.
 */
function ParseSettings(Value: unknown): Record<string, unknown> {
  let Source: unknown = Value;
  if (typeof Value === 'string') {
    const Text = Value.trim();
    if (!Text) return {};
    try {
      Source = JSON.parse(Text);
    } catch {
      return {};
    }
  }
  if (!Source || typeof Source !== 'object' || Array.isArray(Source)) return {};

  const Settings: Record<string, unknown> = {};
  for (const [Key, Entry] of Object.entries(Source as Record<string, unknown>)) {
    if (!ALARM_FIELD_KEYS.has(Key)) continue;
    Settings[Key] = Entry;
  }
  return Settings;
}

export {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PORT,
  ALARM_FIELD_KEYS,
  ClampInterval,
  ClampTimeout,
  ClampPort,
  NormalizeAddress,
  IsValidAddress,
  RandomSuffix,
  ParseSettings,
};
