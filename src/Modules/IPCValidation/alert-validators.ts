// Alert rule scope / action / trigger validators.
import { fail, isPlainObject, normalizeNonEmptyString } from './primitives';
import type { IPCValidationManager } from './index';

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
  'APPLICATION_STARTED',
  'APPLICATION_STOPPED',
  'CRITICAL_APPLICATION_STARTED',
  'CRITICAL_APPLICATION_STOPPED',
  'NON_CRITICAL_APPLICATION_STARTED',
  'NON_CRITICAL_APPLICATION_STOPPED',
]);

export = function registerAlertValidators(Manager: IPCValidationManager): void {
  function normalizeAlertScope(value: unknown) {
    if (!isPlainObject(value)) {
      fail('Alert Scope must be an object');
    }

    const out: Record<string, unknown> = {
      Workspace: !!value.Workspace,
      Groups: [],
      Clients: [],
      Tags: [],
    };

    if (Array.isArray(value.Groups)) {
      const next: (number | null)[] = [];
      for (const g of value.Groups) {
        next.push(Manager.GroupID(g, 'Scope group ID'));
      }
      out.Groups = Array.from(new Set(next.filter((x) => x != null)));
    }

    if (Array.isArray(value.Clients)) {
      const next: string[] = [];
      for (const c of value.Clients) {
        if (typeof c !== 'string') fail('Scope client entries must be strings');
        const normalized = c.trim();
        if (!normalized) continue;
        if (normalized.startsWith('monitor:')) {
          const id = normalized.slice('monitor:'.length).trim();
          if (!/^\d+$/.test(id)) fail('Scope monitor entries must use monitor:<TargetID> format');
          next.push(`monitor:${parseInt(id, 10)}`);
        } else if (normalized.startsWith('check:')) {
          const id = normalized.slice('check:'.length).trim();
          if (!/^\d+$/.test(id)) fail('Scope check entries must use check:<CheckID> format');
          next.push(`check:${parseInt(id, 10)}`);
        } else {
          next.push(Manager.UUID(normalized, 'Scope client UUID'));
        }
      }
      out.Clients = Array.from(new Set(next));
    }

    // Tags the rule watches. Membership resolves when the event fires, so a
    // machine tagged later is covered without touching the rule.
    if (Array.isArray(value.Tags)) {
      const next: number[] = [];
      for (const t of value.Tags) {
        next.push(Manager.TagID(t, 'Scope tag ID'));
      }
      out.Tags = Array.from(new Set(next));
    }

    return out;
  }

  function normalizeAlertAction(value: unknown) {
    if (!isPlainObject(value)) {
      fail('Alert action must be an object');
    }

    const out: Record<string, unknown> = {};
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

  function normalizeAlertActions(value: unknown) {
    if (!Array.isArray(value)) {
      fail('Actions must be an array');
    }
    const out: Record<string, unknown>[] = [];
    for (const item of value) out.push(normalizeAlertAction(item));
    return out;
  }

  // Accepts an array of trigger IDs (preferred) or a single legacy string, and
  // returns a deduped, validated, non-empty array.
  function normalizeAlertTriggerTypes(value: unknown): string[] {
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of list) {
      const TriggerType = normalizeNonEmptyString(raw, 'TriggerType', {
        minLength: 2,
        maxLength: 64,
      });
      if (!ALERT_TRIGGER_TYPES.has(TriggerType)) {
        fail(`Unsupported TriggerType: ${TriggerType}`);
      }
      if (seen.has(TriggerType)) continue;
      seen.add(TriggerType);
      out.push(TriggerType);
    }
    if (!out.length) fail('At least one TriggerType is required');
    return out;
  }

  function normalizeAlertTriggerConfig(value: unknown): Record<string, unknown> {
    if (value == null) return {};
    if (!isPlainObject(value)) fail('TriggerConfig must be an object');
    return value;
  }

  Manager.AlertRuleID = (value: unknown, fieldName = 'RuleID') => {
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

  Manager.AlertRuleCreatePayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Alert rule payload must be an object');
    const out: Record<string, unknown> = {};
    out.Title = normalizeNonEmptyString(value.Title, 'Title', { minLength: 2, maxLength: 120 });
    out.Scope = normalizeAlertScope(value.Scope);
    out.TriggerTypes = normalizeAlertTriggerTypes(
      Object.prototype.hasOwnProperty.call(value, 'TriggerTypes')
        ? value.TriggerTypes
        : value.TriggerType
    );
    out.TriggerConfig = normalizeAlertTriggerConfig(value.TriggerConfig);
    out.Actions = normalizeAlertActions(value.Actions);
    out.Enabled = Object.prototype.hasOwnProperty.call(value, 'Enabled') ? !!value.Enabled : true;
    return out;
  };

  Manager.AlertRuleUpdatePayload = (value: unknown) => {
    if (!isPlainObject(value)) fail('Alert rule payload must be an object');
    const out: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(value, 'Title')) {
      out.Title = normalizeNonEmptyString(value.Title, 'Title', { minLength: 2, maxLength: 120 });
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Scope')) {
      out.Scope = normalizeAlertScope(value.Scope);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'TriggerTypes')) {
      out.TriggerTypes = normalizeAlertTriggerTypes(value.TriggerTypes);
    } else if (Object.prototype.hasOwnProperty.call(value, 'TriggerType')) {
      out.TriggerTypes = normalizeAlertTriggerTypes(value.TriggerType);
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
