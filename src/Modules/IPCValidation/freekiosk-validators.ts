// FreeKiosk terminal identifier, payload and command validators.
//
// The command validator is the security boundary for this feature. It resolves
// a requested command against FREEKIOSK_COMMANDS and rejects anything absent —
// so the set of things a terminal can be told to do is exactly what that map
// declares, with no blocklist to keep current. /api/js (arbitrary JavaScript in
// the kiosk WebView) is simply not in the map, and is therefore unreachable.
import { fail, isPlainObject, normalizeNonEmptyString } from './primitives';
import { GetFreeKioskCommand } from '../FreeKiosk/commands';
import type { IPCValidationManager } from './index';

const MAX_UUID_BATCH = 500;

function normalizeAddress(value: unknown, fieldName = 'Address'): string {
  const address = normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 255 });
  // A scheme or a path here would end up concatenated into the request line.
  // The manager strips them defensively too; refusing outright is clearer about
  // what the field means.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
    fail(`${fieldName} must be a bare IP address or hostname, without http:// or https://`);
  }
  if (address.includes('/')) fail(`${fieldName} must not contain a path`);
  return address;
}

function normalizePort(value: unknown, fieldName = 'Port'): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${fieldName} must be a whole number between 1 and 65535`);
  }
  return port;
}

function normalizeMilliseconds(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${fieldName} must be a number`);
  return parsed;
}

function normalizeLevel(value: unknown, fieldName: string): number {
  const level = Number(value);
  if (!Number.isFinite(level)) fail(`${fieldName} must be a number`);
  const rounded = Math.round(level);
  if (rounded < 0 || rounded > 100) fail(`${fieldName} must be between 0 and 100`);
  return rounded;
}

export = function registerFreeKioskValidators(Manager: IPCValidationManager): void {
  Manager.FreeKioskUUID = (value: unknown, fieldName = 'UUID') => {
    return normalizeNonEmptyString(value, fieldName, { minLength: 2, maxLength: 128 });
  };

  Manager.FreeKioskUUIDList = (value: unknown, fieldName = 'UUIDs') => {
    if (!Array.isArray(value)) fail(`${fieldName} must be an array`);
    const list = value as unknown[];
    if (!list.length) fail(`${fieldName} must not be empty`);
    if (list.length > MAX_UUID_BATCH) fail(`${fieldName} must contain at most ${MAX_UUID_BATCH}`);
    // De-duplicated so a repeated id cannot make one device take a command twice.
    const seen = new Set<string>();
    for (const entry of list) {
      seen.add(normalizeNonEmptyString(entry, 'UUID', { minLength: 2, maxLength: 128 }));
    }
    return Array.from(seen);
  };

  Manager.FreeKioskCommand = (value: unknown) => {
    const id = normalizeNonEmptyString(value, 'Command', { minLength: 1, maxLength: 64 });
    // The command map IS the allowlist.
    if (!GetFreeKioskCommand(id)) fail(`Unknown FreeKiosk command "${id}"`);
    return id;
  };

  Manager.FreeKioskCommandParams = (command: unknown, value: unknown) => {
    const id = Manager.FreeKioskCommand(command);
    const definition = GetFreeKioskCommand(id)!;
    if (value !== undefined && value !== null && !isPlainObject(value)) {
      fail('Command parameters must be an object');
    }
    const source = (isPlainObject(value) ? value : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    switch (id) {
      case 'brightness':
      case 'volume':
        out.value = normalizeLevel(source.value, 'Level');
        break;

      default:
        // Every other command is a bare GET; anything sent with it is dropped
        // rather than forwarded to the device unexamined.
        if (definition.Method === 'POST') {
          fail(`FreeKiosk command "${id}" has no validated parameters`);
        }
        break;
    }

    return out;
  };

  Manager.FreeKioskCapturePayload = (value: unknown) => {
    if (value !== undefined && value !== null && !isPlainObject(value)) {
      fail('Capture options must be an object');
    }
    const source = (isPlainObject(value) ? value : {}) as Record<string, unknown>;
    const camera = String(source.Camera ?? 'back').toLowerCase();
    if (camera !== 'front' && camera !== 'back') fail("Camera must be 'front' or 'back'");
    let quality = Number(source.Quality);
    if (!Number.isFinite(quality)) quality = 80;
    quality = Math.min(100, Math.max(1, Math.round(quality)));
    return { Camera: camera as 'front' | 'back', Quality: quality };
  };

  Manager.FreeKioskMetricKeys = (value: unknown) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) fail('Metric keys must be an array');
    return (value as unknown[]).map((entry) =>
      normalizeNonEmptyString(entry, 'Metric key', { minLength: 1, maxLength: 64 })
    );
  };

  function collectPayload(value: unknown, requireObject: boolean): Record<string, unknown> {
    if (!requireObject && (value === undefined || value === null)) return {};
    if (!isPlainObject(value)) fail('FreeKiosk terminal payload must be an object');
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(source, 'Nickname')) {
      out.Nickname = normalizeNonEmptyString(source.Nickname, 'Title', {
        minLength: 1,
        maxLength: 64,
      });
    }
    if (Object.prototype.hasOwnProperty.call(source, 'Address')) {
      out.Address = normalizeAddress(source.Address);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'Port')) {
      out.Port = normalizePort(source.Port);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'ApiKey')) {
      // A blank key means "leave it alone" — the editor is never given the
      // stored key back, so it cannot resubmit one.
      const key = source.ApiKey == null ? '' : String(source.ApiKey);
      if (key.trim()) out.ApiKey = key.trim().slice(0, 256);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'ClearApiKey')) {
      out.ClearApiKey = !!source.ClearApiKey;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'Interval')) {
      out.Interval = normalizeMilliseconds(source.Interval, 'Interval');
    }
    if (Object.prototype.hasOwnProperty.call(source, 'TimeoutMs')) {
      out.TimeoutMs = normalizeMilliseconds(source.TimeoutMs, 'Timeout');
    }
    if (Object.prototype.hasOwnProperty.call(source, 'Slug')) {
      out.Slug = normalizeNonEmptyString(source.Slug, 'Slug', { minLength: 1, maxLength: 64 });
    }
    if (Object.prototype.hasOwnProperty.call(source, 'GroupID')) {
      out.GroupID = Manager.GroupID(source.GroupID);
    }
    if (Object.prototype.hasOwnProperty.call(source, 'Settings')) {
      if (!isPlainObject(source.Settings)) fail('Settings must be an object');
      // Individual alarm keys are filtered against the generated schema by the
      // manager, which is the only place that knows the registry.
      out.Settings = source.Settings;
    }
    return out;
  }

  Manager.FreeKioskCreatePayload = (value: unknown) => {
    const out = collectPayload(value, false);
    if (!out.Address) fail('Address is required');
    return out;
  };

  Manager.FreeKioskUpdatePayload = (value: unknown) => collectPayload(value, true);
};
