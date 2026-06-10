// Alert rule scope / action / trigger validators.
const { fail, isPlainObject, normalizeNonEmptyString } = require('./primitives');

const ALERT_TRIGGER_TYPES = new Set([
  'CLIENT_OFFLINE',
  'CLIENT_DEGRADED',
  'CLIENT_ONLINE',
  'SCRIPT_EXECUTION_FAILED',
  'USB_DEVICE_CONNECTED',
  'USB_DEVICE_DISCONNECTED',
  'NON_CRITICAL_USB_DEVICE_CONNECTED',
  'NON_CRITICAL_USB_DEVICE_DISCONNECTED',
  'CRITICAL_USB_DEVICE_CONNECTED',
  'CRITICAL_USB_DEVICE_DISCONNECTED',
]);

module.exports = function registerAlertValidators(Manager) {
  function normalizeAlertScope(value) {
    if (!isPlainObject(value)) {
      fail('Alert Scope must be an object');
    }

    const out = {
      Workspace: !!value.Workspace,
      Groups: [],
      Clients: [],
    };

    if (Array.isArray(value.Groups)) {
      const next = [];
      for (const g of value.Groups) {
        next.push(Manager.GroupID(g, 'Scope group ID'));
      }
      out.Groups = Array.from(new Set(next.filter((x) => x != null)));
    }

    if (Array.isArray(value.Clients)) {
      const next = [];
      for (const c of value.Clients) {
        if (typeof c !== 'string') fail('Scope client entries must be strings');
        const normalized = c.trim();
        if (!normalized) continue;
        if (normalized.startsWith('monitor:')) {
          const id = normalized.slice('monitor:'.length).trim();
          if (!/^\d+$/.test(id)) fail('Scope monitor entries must use monitor:<TargetID> format');
          next.push(`monitor:${parseInt(id, 10)}`);
        } else {
          next.push(Manager.UUID(normalized, 'Scope client UUID'));
        }
      }
      out.Clients = Array.from(new Set(next));
    }

    return out;
  }

  function normalizeAlertAction(value) {
    if (!isPlainObject(value)) {
      fail('Alert action must be an object');
    }

    const out = {};
    out.Type = normalizeNonEmptyString(value.Type, 'Action Type', { minLength: 2, maxLength: 64 });
    out.Title =
      Object.prototype.hasOwnProperty.call(value, 'Title') && value.Title != null
        ? normalizeNonEmptyString(value.Title, 'Action Title', { minLength: 1, maxLength: 80 })
        : '';
    if (Object.prototype.hasOwnProperty.call(value, 'Settings')) {
      if (!isPlainObject(value.Settings)) fail('Action Settings must be an object');
      out.Settings = value.Settings;
    } else {
      out.Settings = {};
    }

    return out;
  }

  function normalizeAlertActions(value) {
    if (!Array.isArray(value)) {
      fail('Actions must be an array');
    }
    const out = [];
    for (const item of value) out.push(normalizeAlertAction(item));
    return out;
  }

  function normalizeAlertTriggerType(value) {
    const TriggerType = normalizeNonEmptyString(value, 'TriggerType', {
      minLength: 2,
      maxLength: 64,
    });
    if (!ALERT_TRIGGER_TYPES.has(TriggerType)) {
      fail(`Unsupported TriggerType: ${TriggerType}`);
    }
    return TriggerType;
  }

  function normalizeAlertTriggerConfig(value) {
    if (value == null) return {};
    if (!isPlainObject(value)) fail('TriggerConfig must be an object');
    return value;
  }

  Manager.AlertRuleID = (value, fieldName = 'RuleID') => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value <= 0) fail(`${fieldName} must be a positive integer`);
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!/^\d+$/.test(normalized)) fail(`${fieldName} must be numeric`);
      return parseInt(normalized, 10);
    }
    fail(`${fieldName} is invalid`);
  };

  Manager.AlertRuleCreatePayload = (value) => {
    if (!isPlainObject(value)) fail('Alert rule payload must be an object');
    const out = {};
    out.Title = normalizeNonEmptyString(value.Title, 'Title', { minLength: 2, maxLength: 120 });
    out.Scope = normalizeAlertScope(value.Scope);
    out.TriggerType = normalizeAlertTriggerType(value.TriggerType);
    out.TriggerConfig = normalizeAlertTriggerConfig(value.TriggerConfig);
    out.Actions = normalizeAlertActions(value.Actions);
    out.Enabled = Object.prototype.hasOwnProperty.call(value, 'Enabled') ? !!value.Enabled : true;
    return out;
  };

  Manager.AlertRuleUpdatePayload = (value) => {
    if (!isPlainObject(value)) fail('Alert rule payload must be an object');
    const out = {};

    if (Object.prototype.hasOwnProperty.call(value, 'Title')) {
      out.Title = normalizeNonEmptyString(value.Title, 'Title', { minLength: 2, maxLength: 120 });
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Scope')) {
      out.Scope = normalizeAlertScope(value.Scope);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'TriggerType')) {
      out.TriggerType = normalizeAlertTriggerType(value.TriggerType);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'TriggerConfig')) {
      out.TriggerConfig = normalizeAlertTriggerConfig(value.TriggerConfig);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Actions')) {
      out.Actions = normalizeAlertActions(value.Actions);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Enabled')) {
      out.Enabled = !!value.Enabled;
    }

    return out;
  };
};
