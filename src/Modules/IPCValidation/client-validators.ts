// Client / group / script identifier validators.
import { fail, isPlainObject, normalizeNonEmptyString } from './primitives';
import { NormalizeMacAddress } from '../MacAddress';
import { IsNetmask, NormalizeIPText, ParseIP } from '../ClientManager/network';
import {
  MIN_OFFLINE_GRACE_SECONDS,
  MAX_OFFLINE_GRACE_SECONDS,
} from '../ClientManager/offline-grace';
import {
  IsSystemCheckKey,
  MAX_SUSTAIN_SECONDS,
  MAX_TEMPERATURE_CELSIUS,
  MAX_UPTIME_DAYS,
} from '../ClientManager/system-checks';
import type {
  ClientSystemCheckPayloadResult,
  AudioLevelRequestResult,
  CriticalAudioDevicePayloadResult,
  CriticalNetworkInterfacePayloadResult,
  CriticalDisplayPayloadResult,
  CriticalUSBConditionOptionsResult,
  IPCValidationManager,
} from './index';

// Minimum delay (seconds) enforced before a run-on-launch script fires. The
// delay doubles as the abort-window countdown shown on the client, so it must
// stay long enough for an operator to cancel a destructive launch action.
const MIN_LAUNCH_DELAY_SECONDS = 10;

// Upper bound on how many reserved slots one request may create. Generous for
// the intended use (pre-building a rig's worth of slots) while keeping a
// malformed or hostile count from flooding the client list.
const MAX_UNASSIGNED_CLIENTS_PER_REQUEST = 64;

export = function registerClientValidators(Manager: IPCValidationManager): void {
  Manager.UUID = (value: unknown, fieldName = 'UUID') => {
    return normalizeNonEmptyString(value, fieldName, { minLength: 2, maxLength: 128 });
  };

  Manager.UUIDList = (value: unknown, fieldName = 'Targets') => {
    if (!Array.isArray(value)) {
      fail(`${fieldName} must be an array`);
    }
    if (value.length === 0) {
      fail(`${fieldName} cannot be empty`);
    }

    const normalized: string[] = [];
    for (const item of value) {
      normalized.push(Manager.UUID(item, `${fieldName} item`));
    }

    return Array.from(new Set(normalized));
  };

  Manager.UnassignedClientCreatePayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Unassigned client payload must be an object');
    }

    const Name = normalizeNonEmptyString(value.Name, 'Name', { minLength: 1, maxLength: 64 });

    const Count = Number(value.Count);
    if (!Number.isInteger(Count) || Count < 1) {
      fail('Count must be a positive integer');
    }
    if (Count > MAX_UNASSIGNED_CLIENTS_PER_REQUEST) {
      fail(`Count cannot exceed ${MAX_UNASSIGNED_CLIENTS_PER_REQUEST}`);
    }

    return { Name, Count };
  };

  Manager.GroupID = (value: unknown, fieldName = 'GroupID') => {
    if (value === null || value === undefined || value === 'null') return null;

    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0) {
        fail(`${fieldName} must be a positive integer`);
      }
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!/^\d+$/.test(normalized)) {
        fail(`${fieldName} must be numeric`);
      }
      return parseInt(normalized, 10);
    }

    fail(`${fieldName} is invalid`);
  };

  Manager.GroupTitle = (value: unknown) => {
    return normalizeNonEmptyString(value, 'Group title', { minLength: 3, maxLength: 32 });
  };

  // Selection-toggle keybind: keyboard number row (Digit0-9) or numpad numbers
  // (Numpad0-9). null/empty clears the keybind.
  Manager.GroupKeyBind = (value: unknown, fieldName = 'KeyBind') => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') fail(`${fieldName} is invalid`);
    const normalized = value.trim();
    if (!normalized) return null;
    if (!/^(Digit|Numpad)[0-9]$/.test(normalized)) {
      fail(`${fieldName} must be a keyboard or numpad number`);
    }
    return normalized;
  };

  // Columns a non-full-width group spans: 1 up to the largest column count the
  // layout setting allows (UI_GROUP_COLUMN_COUNT max).
  Manager.GroupColumnSpan = (value: unknown, fieldName = 'ColumnSpan') => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 6) {
      fail(`${fieldName} must be a whole number from 1 to 6`);
    }
    return value as number;
  };

  // Group background tint: an index into the 8-entry shared colour palette
  // (SCRIPT_COLOURS), or null to clear the tint.
  Manager.GroupColour = (value: unknown, fieldName = 'Colour') => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 7) {
      fail(`${fieldName} must be a palette index from 0 to 7, or null`);
    }
    return value as number;
  };

  // Human-friendly OSC/API identifier. Enforces the slug charset (letters,
  // digits, `-`, `_`; no spaces) so a manually-entered slug is always route-safe.
  // Auto-generated slugs (derived from a name) are slugified server-side; this
  // guards the manual-entry path.
  Manager.Slug = (value: unknown, fieldName = 'Slug') => {
    const normalized = normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 64 });
    if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
      fail(`${fieldName} may only contain letters, numbers, - and _`);
    }
    return normalized;
  };

  Manager.ScriptID = (value: unknown) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('Script ID is invalid');
      return String(value);
    }
    return normalizeNonEmptyString(value, 'Script ID', { minLength: 1, maxLength: 128 });
  };

  // Integrated client event identifier (declared by the client via the SDK).
  Manager.IntegratedEventID = (value: unknown) => {
    const normalized = normalizeNonEmptyString(value, 'Event ID', { minLength: 1, maxLength: 128 });
    if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
      fail('Event ID contains invalid characters');
    }
    return normalized;
  };

  Manager.Boolean = (value: unknown, fieldName?: string) => {
    if (typeof value !== 'boolean') {
      fail(`${fieldName} must be a boolean`);
    }
    return value;
  };

  Manager.USBSerialNumber = (value: unknown, fieldName = 'SerialNumber') => {
    return normalizeNonEmptyString(value, fieldName, {
      minLength: 1,
      maxLength: 256,
    }).toUpperCase();
  };

  // The conditions a USB mark request may set. Requests from before conditions
  // existed carry none of them, which keeps every condition as it is.
  const USBConditionOptions = (value: Record<string, unknown>) => {
    const out: CriticalUSBConditionOptionsResult = {};
    for (const key of [
      'RequirePresent',
      'CheckLocation',
      'CheckFirmware',
      'RequireNoError',
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) continue;
      if (typeof value[key] !== 'boolean') fail(`${key} must be true or false`);
      out[key] = value[key] as boolean;
    }
    return out;
  };

  Manager.CriticalUSBDevicePayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Critical USB payload must be an object');
    }
    return {
      ...USBConditionOptions(value),
      SerialNumber: Manager.USBSerialNumber(value.SerialNumber),
      ManufacturerName: Object.prototype.hasOwnProperty.call(value, 'ManufacturerName')
        ? normalizeNonEmptyString(value.ManufacturerName, 'ManufacturerName', {
            minLength: 1,
            maxLength: 256,
          })
        : null,
      ProductName: Object.prototype.hasOwnProperty.call(value, 'ProductName')
        ? normalizeNonEmptyString(value.ProductName, 'ProductName', {
            minLength: 1,
            maxLength: 256,
          })
        : null,
    };
  };

  Manager.CriticalUSBNamePayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Critical USB payload must be an object');
    }
    return {
      ...USBConditionOptions(value),
      ManufacturerName: Object.prototype.hasOwnProperty.call(value, 'ManufacturerName')
        ? normalizeNonEmptyString(value.ManufacturerName, 'ManufacturerName', {
            minLength: 1,
            maxLength: 256,
          })
        : null,
      ProductName: Object.prototype.hasOwnProperty.call(value, 'ProductName')
        ? normalizeNonEmptyString(value.ProductName, 'ProductName', {
            minLength: 1,
            maxLength: 256,
          })
        : null,
    };
  };

  Manager.CriticalApplicationPayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Critical application payload must be an object');
    }
    const Conditions: Record<string, boolean> = {};
    for (const Key of ['RequireResponding', 'RequireForeground'] as const) {
      if (value[Key] === undefined) continue;
      if (typeof value[Key] !== 'boolean') fail(`${Key} must be a boolean when present`);
      Conditions[Key] = value[Key] as boolean;
    }
    return {
      Name: normalizeNonEmptyString(value.Name, 'Name', {
        minLength: 1,
        maxLength: 256,
      }),
      ...Conditions,
    };
  };

  Manager.DisplayID = (value: unknown, fieldName = 'DisplayID') => {
    return normalizeNonEmptyString(value, fieldName, {
      minLength: 1,
      maxLength: 256,
    });
  };

  Manager.MacAddress = (value: unknown, fieldName = 'MacAddress') => {
    const Raw = normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 64 });
    const Normalized = NormalizeMacAddress(Raw);
    if (!Normalized) fail(`${fieldName} must be a valid MAC address`);
    return Normalized as string;
  };

  // The baseline is always captured server-side from what the client reports,
  // so a request only says which conditions to guard. Older callers also sent
  // the display's Label/Width/Height/RefreshRate/ScaleFactor; those are ignored.
  Manager.CriticalDisplayPayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Critical display payload must be an object');
    }
    const out: CriticalDisplayPayloadResult = {
      DisplayID: Manager.DisplayID(value.DisplayID),
    };
    for (const key of [
      'RequirePresent',
      'RequirePrimary',
      'CheckResolution',
      'CheckRefreshRate',
      'CheckScale',
      'CheckRotation',
      'CheckPosition',
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) continue;
      if (typeof value[key] !== 'boolean') fail(`${key} must be true or false`);
      out[key] = value[key] as boolean;
    }
    return out;
  };

  Manager.AudioEndpointID = (value: unknown, fieldName = 'EndpointID') => {
    return normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 512 });
  };

  // A 0-100 level for a critical bound: null clears it.
  const OptionalLevel = (raw: unknown, name: string): number | null => {
    if (raw === null || raw === '') return null;
    const num = Number(raw);
    if (typeof raw === 'boolean' || !Number.isFinite(num)) fail(`${name} must be a number`);
    if (num < 0 || num > 100) fail(`${name} must be between 0 and 100`);
    return Math.round(num);
  };

  Manager.CriticalAudioDevicePayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Critical audio device payload must be an object');
    const out: CriticalAudioDevicePayloadResult = {
      EndpointID: Manager.AudioEndpointID(value.EndpointID),
    };
    const Has = (key: string) =>
      Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
    for (const key of [
      'RequireDefault',
      'RequireUnmuted',
      'CheckChannels',
      'CheckSampleRate',
    ] as const) {
      if (!Has(key)) continue;
      if (typeof value[key] !== 'boolean') fail(`${key} must be true or false`);
      out[key] = value[key] as boolean;
    }
    if (Has('MinVolume')) out.MinVolume = OptionalLevel(value.MinVolume, 'MinVolume');
    if (Has('MaxVolume')) out.MaxVolume = OptionalLevel(value.MaxVolume, 'MaxVolume');
    if (
      out.MinVolume !== undefined &&
      out.MaxVolume !== undefined &&
      out.MinVolume !== null &&
      out.MaxVolume !== null &&
      out.MinVolume > out.MaxVolume
    ) {
      fail('MinVolume cannot be above MaxVolume');
    }
    return out;
  };

  Manager.AudioLevelRequest = (value: unknown) => {
    if (!isPlainObject(value)) fail('Audio level request must be an object');
    const out: AudioLevelRequestResult = { EndpointID: Manager.AudioEndpointID(value.EndpointID) };
    if (value.Volume !== undefined && value.Volume !== null) {
      const level = OptionalLevel(value.Volume, 'Volume');
      if (level !== null) out.Volume = level;
    }
    if (value.Muted !== undefined && value.Muted !== null) {
      if (typeof value.Muted !== 'boolean') fail('Muted must be true or false');
      out.Muted = value.Muted;
    }
    if (out.Volume === undefined && out.Muted === undefined) {
      fail('Audio level request must set Volume or Muted');
    }
    return out;
  };

  Manager.NetworkInterfaceName = (value: unknown, fieldName = 'Name') => {
    return normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 128 });
  };

  // An IP address condition: null (or empty) stops guarding it.
  const OptionalAddress = (raw: unknown, name: string): string | null => {
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
    if (typeof raw !== 'string') fail(`${name} must be an IP address`);
    const normalized = NormalizeIPText(raw);
    if (!normalized) fail(`${name} must be an IP address`);
    return normalized as string;
  };

  Manager.CriticalNetworkInterfacePayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Critical network interface payload must be an object');
    const out: CriticalNetworkInterfacePayloadResult = {
      Name: Manager.NetworkInterfaceName(value.Name),
    };
    const Has = (key: string) =>
      Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
    if (Has('Family')) {
      if (value.Family !== 'IPv4' && value.Family !== 'IPv6') fail('Family must be IPv4 or IPv6');
      out.Family = value.Family;
    }
    if (Has('RequirePresent')) {
      if (typeof value.RequirePresent !== 'boolean') fail('RequirePresent must be true or false');
      out.RequirePresent = value.RequirePresent as boolean;
    }
    for (const key of ['Address', 'RangeStart', 'RangeEnd', 'Netmask', 'Gateway'] as const) {
      if (Has(key)) out[key] = OptionalAddress(value[key], key);
    }
    if (out.Netmask && !IsNetmask(out.Netmask)) fail('Netmask must be a subnet mask');
    if (Has('RangeStart') !== Has('RangeEnd') || !!out.RangeStart !== !!out.RangeEnd) {
      fail('RangeStart and RangeEnd must be set together');
    }
    if (out.RangeStart && out.RangeEnd) {
      const start = ParseIP(out.RangeStart)!;
      const end = ParseIP(out.RangeEnd)!;
      if (start.Family !== end.Family) fail('RangeStart and RangeEnd must be the same family');
      if (start.Value > end.Value) fail('RangeStart cannot be after RangeEnd');
    }
    return out;
  };

  Manager.SystemCheckKey = (value: unknown) => {
    if (!IsSystemCheckKey(value)) fail('Key must be one of cpu, ram, uptime, power, thermal');
    return value;
  };

  // A system-check edit. Each field is checked against the check it belongs
  // to, so a stray field from another check is refused rather than ignored.
  Manager.ClientSystemCheckPayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('System check payload must be an object');
    const Key = Manager.SystemCheckKey(value.Key);
    const out: ClientSystemCheckPayloadResult = { Key };
    const Allowed: Record<string, string[]> = {
      cpu: ['MaxPercent', 'SustainSeconds'],
      ram: ['MaxPercent', 'SustainSeconds'],
      uptime: ['MaxDays'],
      power: ['RequireMains', 'MinBatteryPercent', 'ChargingBelowPercent'],
      thermal: ['MaxCelsius', 'MaxThermalState'],
    };
    const Whole = (Field: string, Min: number, Max: number, Nullable = true): number | null => {
      const Raw = value[Field];
      if (Raw === null && Nullable) return null;
      const n = Number(Raw);
      if (
        Raw === null ||
        Raw === '' ||
        typeof Raw === 'boolean' ||
        !Number.isInteger(n) ||
        n < Min ||
        n > Max
      ) {
        fail(`${Field} must be a whole number from ${Min} to ${Max}`);
      }
      return n;
    };
    for (const Field of Object.keys(value)) {
      if (Field === 'Key' || value[Field] === undefined) continue;
      if (!Allowed[Key]!.includes(Field)) fail(`${Field} does not apply to the ${Key} check`);
      switch (Field) {
        case 'MaxPercent':
          out.MaxPercent = Whole(Field, 1, 100);
          break;
        case 'SustainSeconds':
          out.SustainSeconds = Whole(Field, 0, MAX_SUSTAIN_SECONDS, false) as number;
          break;
        case 'MaxDays':
          out.MaxDays = Whole(Field, 1, MAX_UPTIME_DAYS);
          break;
        case 'RequireMains':
          if (typeof value.RequireMains !== 'boolean') fail('RequireMains must be true or false');
          out.RequireMains = value.RequireMains as boolean;
          break;
        case 'MinBatteryPercent':
          out.MinBatteryPercent = Whole(Field, 1, 100);
          break;
        case 'ChargingBelowPercent':
          out.ChargingBelowPercent = Whole(Field, 1, 100);
          break;
        case 'MaxCelsius':
          out.MaxCelsius = Whole(Field, 1, MAX_TEMPERATURE_CELSIUS);
          break;
        case 'MaxThermalState': {
          const State = value.MaxThermalState;
          if (State !== null && State !== 'nominal' && State !== 'fair' && State !== 'serious') {
            fail('MaxThermalState must be nominal, fair or serious');
          }
          out.MaxThermalState = State as ClientSystemCheckPayloadResult['MaxThermalState'];
          break;
        }
      }
    }
    return out;
  };

  Manager.ClientUpdatePayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Client update payload must be an object');
    }

    const normalized: Record<string, unknown> = {};
    let hasAnyField = false;

    if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
      hasAnyField = true;
      normalized.Nickname = normalizeNonEmptyString(value.Nickname, 'Nickname', {
        minLength: 1,
        maxLength: 64,
      });
    }

    if (Object.prototype.hasOwnProperty.call(value, 'GroupID')) {
      hasAnyField = true;
      normalized.GroupID = Manager.GroupID(value.GroupID);
    }

    if (Object.prototype.hasOwnProperty.call(value, 'Slug')) {
      hasAnyField = true;
      normalized.Slug = Manager.Slug(value.Slug);
    }

    // Run-on-launch script id: null/empty clears it ("None"); otherwise it must
    // be a script-folder-safe id. Existence is not checked here (the client
    // gracefully skips an unknown/removed script at launch).
    let LaunchScriptSelected = false;
    if (Object.prototype.hasOwnProperty.call(value, 'RunOnLaunchScriptID')) {
      hasAnyField = true;
      const raw = value.RunOnLaunchScriptID;
      if (raw === null || raw === undefined || raw === '') {
        normalized.RunOnLaunchScriptID = null;
      } else {
        const id = normalizeNonEmptyString(raw, 'Run-on-launch script', {
          minLength: 1,
          maxLength: 128,
        });
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
          fail('Run-on-launch script id contains invalid characters');
        }
        normalized.RunOnLaunchScriptID = id;
        LaunchScriptSelected = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(value, 'RunOnLaunchDelaySeconds')) {
      hasAnyField = true;
      const raw = value.RunOnLaunchDelaySeconds;
      if (raw === null || raw === undefined || raw === '') {
        normalized.RunOnLaunchDelaySeconds = null;
      } else {
        const num = Number(raw);
        if (!Number.isInteger(num) || num < 0) {
          fail('Run-on-launch delay must be a non-negative integer');
        }
        // Enforce the abort-window minimum only when a script is actually set.
        if (LaunchScriptSelected && num < MIN_LAUNCH_DELAY_SECONDS) {
          fail(`Run-on-launch delay must be at least ${MIN_LAUNCH_DELAY_SECONDS} seconds`);
        }
        normalized.RunOnLaunchDelaySeconds = num;
      }
    }

    // Disconnect grace period: null/empty inherits the server-wide setting.
    if (Object.prototype.hasOwnProperty.call(value, 'OfflineGraceSeconds')) {
      hasAnyField = true;
      const raw = value.OfflineGraceSeconds;
      if (raw === null || raw === undefined || raw === '') {
        normalized.OfflineGraceSeconds = null;
      } else {
        const num = Number(raw);
        if (
          !Number.isInteger(num) ||
          num < MIN_OFFLINE_GRACE_SECONDS ||
          num > MAX_OFFLINE_GRACE_SECONDS
        ) {
          fail(
            `Offline grace period must be a whole number of seconds from ${MIN_OFFLINE_GRACE_SECONDS} to ${MAX_OFFLINE_GRACE_SECONDS}`
          );
        }
        normalized.OfflineGraceSeconds = num;
      }
    }

    // Show variable overrides: VariableID -> value, null to go back to
    // inheriting the default. Only the shape is checked here; VariableManager
    // owns value sanitization and silently skips IDs it does not recognise, so
    // an editor left open while a variable was deleted elsewhere still saves.
    if (Object.prototype.hasOwnProperty.call(value, 'Variables')) {
      hasAnyField = true;
      normalized.Variables = Manager.ClientVariableMap(value.Variables);
    }

    if (!hasAnyField) {
      fail('Client update payload does not include supported fields');
    }

    return normalized;
  };
};
