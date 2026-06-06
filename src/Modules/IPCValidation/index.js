const Manager = {};

function _fail(message) {
  throw new Error(message);
}

function _isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function _normalizeNonEmptyString(value, fieldName, options = {}) {
  const { minLength = 1, maxLength = 256 } = options;
  if (typeof value !== 'string') {
    _fail(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength) {
    _fail(`${fieldName} must be at least ${minLength} characters`);
  }
  if (normalized.length > maxLength) {
    _fail(`${fieldName} must be at most ${maxLength} characters`);
  }
  return normalized;
}

Manager.UUID = (value, fieldName = 'UUID') => {
  return _normalizeNonEmptyString(value, fieldName, { minLength: 2, maxLength: 128 });
};

Manager.UUIDList = (value, fieldName = 'Targets') => {
  if (!Array.isArray(value)) {
    _fail(`${fieldName} must be an array`);
  }
  if (value.length === 0) {
    _fail(`${fieldName} cannot be empty`);
  }

  const normalized = [];
  for (const item of value) {
    normalized.push(Manager.UUID(item, `${fieldName} item`));
  }

  return Array.from(new Set(normalized));
};

Manager.GroupID = (value, fieldName = 'GroupID') => {
  if (value === null || value === undefined || value === 'null') return null;

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      _fail(`${fieldName} must be a positive integer`);
    }
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
      _fail(`${fieldName} must be numeric`);
    }
    return parseInt(normalized, 10);
  }

  _fail(`${fieldName} is invalid`);
};

Manager.GroupTitle = (value) => {
  return _normalizeNonEmptyString(value, 'Group title', { minLength: 3, maxLength: 50 });
};

Manager.ScriptID = (value) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) _fail('Script ID is invalid');
    return String(value);
  }
  return _normalizeNonEmptyString(value, 'Script ID', { minLength: 1, maxLength: 128 });
};

Manager.Boolean = (value, fieldName) => {
  if (typeof value !== 'boolean') {
    _fail(`${fieldName} must be a boolean`);
  }
  return value;
};

Manager.ClientUpdatePayload = (value) => {
  if (!_isPlainObject(value)) {
    _fail('Client update payload must be an object');
  }

  const normalized = {};
  let hasAnyField = false;

  if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
    hasAnyField = true;
    normalized.Nickname = _normalizeNonEmptyString(value.Nickname, 'Nickname', {
      minLength: 1,
      maxLength: 64,
    });
  }

  if (Object.prototype.hasOwnProperty.call(value, 'GroupID')) {
    hasAnyField = true;
    normalized.GroupID = Manager.GroupID(value.GroupID);
  }

  if (!hasAnyField) {
    _fail('Client update payload does not include supported fields');
  }

  return normalized;
};

Manager.MonitoringTargetID = (value, fieldName = 'TargetID') => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) _fail(`${fieldName} must be a positive integer`);
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) _fail(`${fieldName} must be numeric`);
    return parseInt(normalized, 10);
  }
  _fail(`${fieldName} is invalid`);
};

// Method-specific Settings are validated against the registered schema by
// the MonitoringMethods module; here we only enforce the shape.
function _normalizeMonitoringSettings(value) {
  if (value == null) return {};
  if (!_isPlainObject(value)) _fail('Monitoring Settings must be an object');
  return value;
}

Manager.MonitoringTargetCreatePayload = (value) => {
  if (!_isPlainObject(value)) _fail('Monitoring target payload must be an object');
  const out = {};
  out.Nickname = _normalizeNonEmptyString(value.Nickname, 'Nickname', { minLength: 1, maxLength: 64 });
  out.Address = _normalizeNonEmptyString(value.Address, 'Address', { minLength: 1, maxLength: 253 });
  out.Method = _normalizeNonEmptyString(value.Method, 'Method', { minLength: 1, maxLength: 64 });
  if (value.Interval === undefined || value.Interval === null) _fail('Interval is required');
  const Interval = Number(value.Interval);
  if (!Number.isFinite(Interval)) _fail('Interval must be a number');
  out.Interval = Interval;
  out.StoreHistory =
    Object.prototype.hasOwnProperty.call(value, 'StoreHistory') ? !!value.StoreHistory : false;
  if (Object.prototype.hasOwnProperty.call(value, 'DegradedThresholdMs')) {
    const Threshold = Number(value.DegradedThresholdMs);
    if (!Number.isFinite(Threshold)) _fail('DegradedThresholdMs must be a number');
    out.DegradedThresholdMs = Threshold;
  }
  out.GroupID =
    Object.prototype.hasOwnProperty.call(value, 'GroupID') ? Manager.GroupID(value.GroupID) : null;
  out.Settings = _normalizeMonitoringSettings(value.Settings);
  return out;
};

Manager.MonitoringTargetUpdatePayload = (value) => {
  if (!_isPlainObject(value)) _fail('Monitoring target payload must be an object');
  const out = {};
  if (Object.prototype.hasOwnProperty.call(value, 'Nickname')) {
    out.Nickname = _normalizeNonEmptyString(value.Nickname, 'Nickname', { minLength: 1, maxLength: 64 });
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Address')) {
    out.Address = _normalizeNonEmptyString(value.Address, 'Address', { minLength: 1, maxLength: 253 });
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Method')) {
    out.Method = _normalizeNonEmptyString(value.Method, 'Method', { minLength: 1, maxLength: 64 });
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Interval')) {
    const Interval = Number(value.Interval);
    if (!Number.isFinite(Interval)) _fail('Interval must be a number');
    out.Interval = Interval;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'StoreHistory')) {
    out.StoreHistory = !!value.StoreHistory;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'DegradedThresholdMs')) {
    const Threshold = Number(value.DegradedThresholdMs);
    if (!Number.isFinite(Threshold)) _fail('DegradedThresholdMs must be a number');
    out.DegradedThresholdMs = Threshold;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'GroupID')) {
    out.GroupID = Manager.GroupID(value.GroupID);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Settings')) {
    out.Settings = _normalizeMonitoringSettings(value.Settings);
  }
  return out;
};

Manager.AlertRuleID = (value, fieldName = 'RuleID') => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) _fail(`${fieldName} must be a positive integer`);
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) _fail(`${fieldName} must be numeric`);
    return parseInt(normalized, 10);
  }
  _fail(`${fieldName} is invalid`);
};

const ALERT_TRIGGER_TYPES = new Set([
  'CLIENT_OFFLINE',
  'CLIENT_DEGRADED',
  'CLIENT_ONLINE',
  'SCRIPT_EXECUTION_FAILED',
]);

function _normalizeAlertScope(value) {
  if (!_isPlainObject(value)) {
    _fail('Alert Scope must be an object');
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
      if (typeof c !== 'string') _fail('Scope client entries must be strings');
      const normalized = c.trim();
      if (!normalized) continue;
      if (normalized.startsWith('monitor:')) {
        const id = normalized.slice('monitor:'.length).trim();
        if (!/^\d+$/.test(id)) _fail('Scope monitor entries must use monitor:<TargetID> format');
        next.push(`monitor:${parseInt(id, 10)}`);
      } else {
        next.push(Manager.UUID(normalized, 'Scope client UUID'));
      }
    }
    out.Clients = Array.from(new Set(next));
  }

  return out;
}

function _normalizeAlertAction(value) {
  if (!_isPlainObject(value)) {
    _fail('Alert action must be an object');
  }

  const out = {};
  out.Type = _normalizeNonEmptyString(value.Type, 'Action Type', { minLength: 2, maxLength: 64 });
  out.Title =
    Object.prototype.hasOwnProperty.call(value, 'Title') && value.Title != null
      ? _normalizeNonEmptyString(value.Title, 'Action Title', { minLength: 1, maxLength: 80 })
      : '';
  if (Object.prototype.hasOwnProperty.call(value, 'Settings')) {
    if (!_isPlainObject(value.Settings)) _fail('Action Settings must be an object');
    out.Settings = value.Settings;
  } else {
    out.Settings = {};
  }

  return out;
}

function _normalizeAlertActions(value) {
  if (!Array.isArray(value)) {
    _fail('Actions must be an array');
  }
  const out = [];
  for (const item of value) out.push(_normalizeAlertAction(item));
  return out;
}

function _normalizeAlertTriggerType(value) {
  const TriggerType = _normalizeNonEmptyString(value, 'TriggerType', { minLength: 2, maxLength: 64 });
  if (!ALERT_TRIGGER_TYPES.has(TriggerType)) {
    _fail(`Unsupported TriggerType: ${TriggerType}`);
  }
  return TriggerType;
}

function _normalizeAlertTriggerConfig(value) {
  if (value == null) return {};
  if (!_isPlainObject(value)) _fail('TriggerConfig must be an object');
  return value;
}

Manager.AlertRuleCreatePayload = (value) => {
  if (!_isPlainObject(value)) _fail('Alert rule payload must be an object');
  const out = {};
  out.Title = _normalizeNonEmptyString(value.Title, 'Title', { minLength: 2, maxLength: 120 });
  out.Scope = _normalizeAlertScope(value.Scope);
  out.TriggerType = _normalizeAlertTriggerType(value.TriggerType);
  out.TriggerConfig = _normalizeAlertTriggerConfig(value.TriggerConfig);
  out.Actions = _normalizeAlertActions(value.Actions);
  out.Enabled = Object.prototype.hasOwnProperty.call(value, 'Enabled') ? !!value.Enabled : true;
  return out;
};

Manager.AlertRuleUpdatePayload = (value) => {
  if (!_isPlainObject(value)) _fail('Alert rule payload must be an object');
  const out = {};

  if (Object.prototype.hasOwnProperty.call(value, 'Title')) {
    out.Title = _normalizeNonEmptyString(value.Title, 'Title', { minLength: 2, maxLength: 120 });
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Scope')) {
    out.Scope = _normalizeAlertScope(value.Scope);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'TriggerType')) {
    out.TriggerType = _normalizeAlertTriggerType(value.TriggerType);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'TriggerConfig')) {
    out.TriggerConfig = _normalizeAlertTriggerConfig(value.TriggerConfig);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Actions')) {
    out.Actions = _normalizeAlertActions(value.Actions);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Enabled')) {
    out.Enabled = !!value.Enabled;
  }

  return out;
};

Manager.NetworkDiscoveryScanID = (value) => {
  return _normalizeNonEmptyString(value, 'ScanID', { minLength: 8, maxLength: 128 });
};

Manager.NetworkDiscoveryScanOptions = (value) => {
  if (value == null) return {};
  if (!_isPlainObject(value)) _fail('Network discovery options must be an object');

  const out = {};

  if (Object.prototype.hasOwnProperty.call(value, 'EnableBonjour')) {
    out.EnableBonjour = !!value.EnableBonjour;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'EnableProbe')) {
    out.EnableProbe = !!value.EnableProbe;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'TimeoutMs')) {
    const timeout = Number(value.TimeoutMs);
    if (!Number.isFinite(timeout)) _fail('TimeoutMs must be a number');
    if (timeout < 1000 || timeout > 120000) _fail('TimeoutMs must be between 1000 and 120000');
    out.TimeoutMs = Math.floor(timeout);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'MaxHostsPerSubnet')) {
    const maxHosts = Number(value.MaxHostsPerSubnet);
    if (!Number.isFinite(maxHosts)) _fail('MaxHostsPerSubnet must be a number');
    if (maxHosts < 8 || maxHosts > 4096) _fail('MaxHostsPerSubnet must be between 8 and 4096');
    out.MaxHostsPerSubnet = Math.floor(maxHosts);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Concurrency')) {
    const concurrency = Number(value.Concurrency);
    if (!Number.isFinite(concurrency)) _fail('Concurrency must be a number');
    if (concurrency < 1 || concurrency > 128) _fail('Concurrency must be between 1 and 128');
    out.Concurrency = Math.floor(concurrency);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'ProbePorts')) {
    if (!Array.isArray(value.ProbePorts)) _fail('ProbePorts must be an array');
    if (!value.ProbePorts.length) _fail('ProbePorts cannot be empty');
    const ports = value.ProbePorts.map((p) => {
      const port = Number(p);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        _fail('ProbePorts must contain valid TCP port numbers');
      }
      return port;
    });
    out.ProbePorts = Array.from(new Set(ports));
  }

  return out;
};

Manager.SettingUpdatePayload = (key, value) => {
  const normalizedKey = _normalizeNonEmptyString(key, 'Setting key', { minLength: 2, maxLength: 128 });

  if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
    _fail('Setting value must be a boolean, string, or number');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    _fail('Setting value number is invalid');
  }

  return [normalizedKey, value];
};

module.exports = {
  Manager,
};
