// Pure normalization helpers and interval bounds shared across the
// DummyClientManager modules.
const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 30000;

// Clamp a requested heartbeat interval into the supported slider range.
function ClampInterval(Value) {
  let n = Number(Value);
  if (!Number.isFinite(n)) n = DEFAULT_INTERVAL_MS;
  if (n < MIN_INTERVAL_MS) n = MIN_INTERVAL_MS;
  if (n > MAX_INTERVAL_MS) n = MAX_INTERVAL_MS;
  return Math.round(n);
}

// Dummy IDs are alphanumeric with no spaces. We strip anything else so an ID
// is always safe to embed in an OSC/HTTP route.
function SanitizeDummyID(Value) {
  if (typeof Value !== 'string') return '';
  return Value.replace(/[^A-Za-z0-9]/g, '');
}

function IsValidDummyID(Value) {
  return typeof Value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(Value);
}

// Random 6 digit suffix used for both the default ID and default title.
function RandomSuffix() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Normalize a heartbeat source address: strip the IPv4-mapped IPv6 prefix so
// stored/displayed IPs match the format used elsewhere for real clients.
function NormalizeIP(Value) {
  if (typeof Value !== 'string') return null;
  let IP = Value.trim();
  if (!IP) return null;
  if (IP.startsWith('::ffff:')) IP = IP.substring(7);
  return IP;
}

module.exports = {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  ClampInterval,
  SanitizeDummyID,
  IsValidDummyID,
  RandomSuffix,
  NormalizeIP,
};
