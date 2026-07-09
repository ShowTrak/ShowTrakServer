// Client / group / script identifier validators.
import { fail, isPlainObject, normalizeNonEmptyString } from './primitives';
import type { IPCValidationManager } from './index';

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

  Manager.CriticalUSBDevicePayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Critical USB payload must be an object');
    }
    return {
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

  Manager.CriticalApplicationPayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Critical application payload must be an object');
    }
    return {
      Name: normalizeNonEmptyString(value.Name, 'Name', {
        minLength: 1,
        maxLength: 256,
      }),
    };
  };

  Manager.DisplayID = (value: unknown, fieldName = 'DisplayID') => {
    return normalizeNonEmptyString(value, fieldName, {
      minLength: 1,
      maxLength: 256,
    });
  };

  Manager.CriticalDisplayPayload = (value: unknown) => {
    if (!isPlainObject(value)) {
      fail('Critical display payload must be an object');
    }
    const OptionalNumber = (raw: unknown, name: string) => {
      if (raw === null || raw === undefined || raw === '') return null;
      const num = Number(raw);
      if (!Number.isFinite(num)) fail(`${name} must be a number`);
      return num;
    };
    return {
      DisplayID: Manager.DisplayID(value.DisplayID),
      Label:
        Object.prototype.hasOwnProperty.call(value, 'Label') && value.Label
          ? normalizeNonEmptyString(value.Label, 'Label', { minLength: 1, maxLength: 256 })
          : null,
      Width: OptionalNumber(value.Width, 'Width'),
      Height: OptionalNumber(value.Height, 'Height'),
      RefreshRate: OptionalNumber(value.RefreshRate, 'RefreshRate'),
      ScaleFactor: OptionalNumber(value.ScaleFactor, 'ScaleFactor'),
    };
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

    if (!hasAnyField) {
      fail('Client update payload does not include supported fields');
    }

    return normalized;
  };
};
