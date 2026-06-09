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

function clientDegradedByConfig(Data, Config) {
  const CpuThreshold = Number(Config && Config.ClientCpuUsagePct);
  const RamThreshold = Number(Config && Config.ClientRamUsagePct);
  const LastSeenStaleMs = Number(Config && Config.ClientLastSeenStaleMs);

  let Hit = false;
  if (Number.isFinite(CpuThreshold) && CpuThreshold > 0) {
    const Cpu = Number(Data && Data.Vitals && Data.Vitals.CPU ? Data.Vitals.CPU.UsagePercentage : NaN);
    if (Number.isFinite(Cpu) && Cpu >= CpuThreshold) Hit = true;
  }
  if (Number.isFinite(RamThreshold) && RamThreshold > 0) {
    const Ram = Number(Data && Data.Vitals && Data.Vitals.Ram ? Data.Vitals.Ram.UsagePercentage : NaN);
    if (Number.isFinite(Ram) && Ram >= RamThreshold) Hit = true;
  }
  if (Number.isFinite(LastSeenStaleMs) && LastSeenStaleMs > 0) {
    const LastSeen = Number(Data && Data.LastSeen);
    if (Number.isFinite(LastSeen) && Date.now() - LastSeen >= LastSeenStaleMs) Hit = true;
  }

  return Hit;
}

function triggerMatches(Rule, Context) {
  switch (Rule.TriggerType) {
    case TRIGGERS.CLIENT_OFFLINE:
      return Context.TriggerType === TRIGGERS.CLIENT_OFFLINE;
    case TRIGGERS.CLIENT_ONLINE:
      return Context.TriggerType === TRIGGERS.CLIENT_ONLINE;
    case TRIGGERS.SCRIPT_EXECUTION_FAILED:
      return Context.TriggerType === TRIGGERS.SCRIPT_EXECUTION_FAILED;
    case TRIGGERS.CLIENT_DEGRADED: {
      if (Context.EntityType === 'monitor') {
        const Source = String((Rule.TriggerConfig && Rule.TriggerConfig.Source) || 'any').toLowerCase();
        if (Source !== 'any' && Source !== 'monitor') return false;
        return !!Context.Degraded;
      }

      if (Context.EntityType === 'client') {
        const Source = String((Rule.TriggerConfig && Rule.TriggerConfig.Source) || 'any').toLowerCase();
        if (Source !== 'any' && Source !== 'client') return false;
        return clientDegradedByConfig(Context.RawData || {}, Rule.TriggerConfig || {});
      }
      return false;
    }
    default:
      return false;
  }
}

function describeMonitorReason(Context) {
  const ErrorText = typeof Context.LastError === 'string' ? Context.LastError.trim() : '';
  if (/timed?\s*out|timeout|unreachable|refused|reset|network\s+is\s+unreachable|no\s+route\s+to\s+host|socket\s+hang\s+up|econnrefused|econnreset|ehostunreach|enetunreach/i.test(ErrorText)) {
    return 'Offline';
  }
  if (/enotfound|eai_again|nxdomain|dns|name\s+or\s+service\s+not\s+known/i.test(ErrorText)) {
    return 'DNS Error';
  }
  if (/cert|certificate|tls|ssl|self\s*signed|unable\s+to\s+verify|hostname\/?ip\s+does\s+not\s+match/i.test(ErrorText)) {
    return 'TLS Error';
  }
  const HttpMatch = ErrorText.match(/\bHTTP\s+(\d{3})\b/i);
  if (HttpMatch) return `HTTP ${HttpMatch[1]}`;
  if (ErrorText) return ErrorText;
  if (Number.isFinite(Context.LastLatencyMs)) return `${Math.round(Context.LastLatencyMs)}ms`;
  return 'unknown reason';
}

function describeContext(Context) {
  if (Context.TriggerType === TRIGGERS.SCRIPT_EXECUTION_FAILED) {
    return `${Context.ScriptName || 'Script'} failed on ${Context.EntityName || 'Unknown Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CLIENT_DEGRADED) {
    if (Context.EntityType === 'monitor') {
      return `${Context.EntityName || 'Monitor'} degraded (${describeMonitorReason(Context)})`;
    }
    return `${Context.EntityName || 'Client'} exceeded degradation criteria`;
  }
  if (Context.TriggerType === TRIGGERS.CLIENT_OFFLINE) {
    return `${Context.EntityName || 'Client'} is offline`;
  }
  if (Context.TriggerType === TRIGGERS.CLIENT_ONLINE) {
    return `${Context.EntityName || 'Client'} came online`;
  }
  return 'Alert triggered';
}

module.exports = {
  isScopeMatch,
  clientDegradedByConfig,
  triggerMatches,
  describeMonitorReason,
  describeContext,
};
