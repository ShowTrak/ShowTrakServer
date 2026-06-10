// Pure rule-matching and human-readable description helpers used to decide
// whether an alert rule fires for a given runtime context.
const { TRIGGERS } = require('./triggers');

function isScopeMatch(Rule, Context) {
  const Scope = Rule.Scope || {};
  const Workspace = !!Scope.Workspace;
  const GroupIDs = new Set(Array.isArray(Scope.Groups) ? Scope.Groups.map((x) => Number(x)) : []);
  const Clients = new Set(Array.isArray(Scope.Clients) ? Scope.Clients.map((x) => String(x)) : []);

  if (Workspace) return true;
  if (Context.GroupID != null && GroupIDs.has(Number(Context.GroupID))) return true;

  if (Context.UUID && Clients.has(String(Context.UUID))) return true;
  if (Context.EntityType === 'monitor' && Context.TargetID != null) {
    if (Clients.has(`monitor:${Context.TargetID}`)) return true;
  }
  return false;
}

function triggerMatches(Rule, Context) {
  switch (Rule.TriggerType) {
    case TRIGGERS.CLIENT_OFFLINE:
      return Context.TriggerType === TRIGGERS.CLIENT_OFFLINE;
    case TRIGGERS.CLIENT_ONLINE:
      return Context.TriggerType === TRIGGERS.CLIENT_ONLINE;
    case TRIGGERS.USB_DEVICE_CONNECTED:
      return Context.TriggerType === TRIGGERS.USB_DEVICE_CONNECTED;
    case TRIGGERS.USB_DEVICE_DISCONNECTED:
      return Context.TriggerType === TRIGGERS.USB_DEVICE_DISCONNECTED;
    case TRIGGERS.NON_CRITICAL_USB_DEVICE_CONNECTED:
      return Context.TriggerType === TRIGGERS.NON_CRITICAL_USB_DEVICE_CONNECTED;
    case TRIGGERS.NON_CRITICAL_USB_DEVICE_DISCONNECTED:
      return Context.TriggerType === TRIGGERS.NON_CRITICAL_USB_DEVICE_DISCONNECTED;
    case TRIGGERS.CRITICAL_USB_DEVICE_CONNECTED:
      return Context.TriggerType === TRIGGERS.CRITICAL_USB_DEVICE_CONNECTED;
    case TRIGGERS.CRITICAL_USB_DEVICE_DISCONNECTED:
      return Context.TriggerType === TRIGGERS.CRITICAL_USB_DEVICE_DISCONNECTED;
    case TRIGGERS.SCRIPT_EXECUTION_FAILED:
      return Context.TriggerType === TRIGGERS.SCRIPT_EXECUTION_FAILED;
    case TRIGGERS.CLIENT_DEGRADED: {
      if (Context.EntityType === 'monitor') {
        const Source = String(
          (Rule.TriggerConfig && Rule.TriggerConfig.Source) || 'any'
        ).toLowerCase();
        if (Source !== 'any' && Source !== 'monitor') return false;
        return !!Context.Degraded;
      }

      if (Context.EntityType === 'client') {
        const Source = String(
          (Rule.TriggerConfig && Rule.TriggerConfig.Source) || 'any'
        ).toLowerCase();
        if (Source !== 'any' && Source !== 'client') return false;
        return !!Context.Degraded;
      }
      return false;
    }
    default:
      return false;
  }
}

function describeMonitorReason(Context) {
  const ErrorText = typeof Context.LastError === 'string' ? Context.LastError.trim() : '';
  if (
    /timed?\s*out|timeout|unreachable|refused|reset|network\s+is\s+unreachable|no\s+route\s+to\s+host|socket\s+hang\s+up|econnrefused|econnreset|ehostunreach|enetunreach/i.test(
      ErrorText
    )
  ) {
    return 'Offline';
  }
  if (/enotfound|eai_again|nxdomain|dns|name\s+or\s+service\s+not\s+known/i.test(ErrorText)) {
    return 'DNS Error';
  }
  if (
    /cert|certificate|tls|ssl|self\s*signed|unable\s+to\s+verify|hostname\/?ip\s+does\s+not\s+match/i.test(
      ErrorText
    )
  ) {
    return 'TLS Error';
  }
  const HttpMatch = ErrorText.match(/\bHTTP\s+(\d{3})\b/i);
  if (HttpMatch) return `HTTP ${HttpMatch[1]}`;
  if (ErrorText) return ErrorText;
  if (Number.isFinite(Context.LastLatencyMs)) return `${Math.round(Context.LastLatencyMs)}ms`;
  return 'unknown reason';
}

function describeUSBDevice(Context) {
  const Device = (Context && Context.Device) || {};
  const Name = [Device.ManufacturerName, Device.ProductName].filter(Boolean).join(' ').trim();
  return Name || 'USB device';
}

function describeContext(Context) {
  if (Context.TriggerType === TRIGGERS.SCRIPT_EXECUTION_FAILED) {
    return `${Context.ScriptName || 'Script'} failed on ${Context.EntityName || 'Unknown Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CLIENT_DEGRADED) {
    if (Context.EntityType === 'monitor') {
      return `${Context.EntityName || 'Monitor'} degraded (${describeMonitorReason(Context)})`;
    }
    return `${Context.EntityName || 'Client'} is degraded`;
  }
  if (Context.TriggerType === TRIGGERS.CLIENT_OFFLINE) {
    return `${Context.EntityName || 'Client'} is offline`;
  }
  if (Context.TriggerType === TRIGGERS.CLIENT_ONLINE) {
    return `${Context.EntityName || 'Client'} came online`;
  }
  if (Context.TriggerType === TRIGGERS.USB_DEVICE_CONNECTED) {
    return `${describeUSBDevice(Context)} connected to ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.USB_DEVICE_DISCONNECTED) {
    return `${describeUSBDevice(Context)} disconnected from ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.NON_CRITICAL_USB_DEVICE_CONNECTED) {
    return `${describeUSBDevice(Context)} (non-critical) connected to ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.NON_CRITICAL_USB_DEVICE_DISCONNECTED) {
    return `${describeUSBDevice(Context)} (non-critical) disconnected from ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CRITICAL_USB_DEVICE_CONNECTED) {
    return `${describeUSBDevice(Context)} (critical) connected to ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CRITICAL_USB_DEVICE_DISCONNECTED) {
    return `${describeUSBDevice(Context)} (critical) disconnected from ${Context.EntityName || 'Client'}`;
  }
  return 'Alert triggered';
}

module.exports = {
  isScopeMatch,
  triggerMatches,
  describeMonitorReason,
  describeContext,
};
