// Pure rule-matching and human-readable description helpers used to decide
// whether an alert rule fires for a given runtime context.
import type { AlertRuleView } from '@showtrak/protocol';
import { TRIGGERS } from './triggers';
import { ScopeCoversEntity } from '../ScopeMatching';
import type { ScopeTag } from '../ScopeMatching';

// The in-memory alert rule (as produced by normalizeRuleRow) matches the wire
// AlertRuleView shape.
type AlertRule = AlertRuleView;

// Runtime context describing the event being evaluated against the rules. Built
// by the AlertsManager event handlers; the concrete fields present depend on the
// trigger, and per-trigger payloads are carried under dynamic keys, so extra
// properties are permitted.
interface AlertContext {
  TriggerType: string;
  EntityType: string;
  EntityName?: string;
  UUID?: string | null;
  GroupID?: number | null;
  IP?: string | null;
  Severity?: string;
  TargetID?: number;
  CheckID?: number | null;
  Degraded?: boolean;
  LastLatencyMs?: number | null;
  LastError?: string | null;
  ScriptName?: string;
  ScriptID?: string | null;
  Error?: string | null;
  Device?: Record<string, unknown> | null;
  Application?: Record<string, unknown> | null;
  Description?: string;
  RawData?: unknown;
  [key: string]: unknown;
}

// `Tags` is the full tag list, needed only to expand a rule that targets tags
// (tags nest, so expansion is a graph walk — see ../ScopeMatching). Omitting it
// silently under-matches such rules, so the evaluator always supplies it.
function isScopeMatch(Rule: AlertRule, Context: AlertContext, Tags?: readonly ScopeTag[]): boolean {
  const Scope = Rule.Scope || {};
  const Workspace = !!Scope.Workspace;
  const GroupIDs = new Set(Array.isArray(Scope.Groups) ? Scope.Groups.map((x) => Number(x)) : []);
  const Clients = new Set(Array.isArray(Scope.Clients) ? Scope.Clients.map((x) => String(x)) : []);

  // Per-check alerts are strictly opt-in: they only fire when a rule explicitly
  // targets that check (check:<CheckID>). They intentionally ignore Workspace /
  // Group / Tag scopes so that a broad rule doesn't fire once per check on top
  // of the aggregated target-level alert.
  if (Context.EntityType === 'monitor-check') {
    return Context.CheckID != null && Clients.has(`check:${Context.CheckID}`);
  }

  if (Workspace) return true;
  if (Context.GroupID != null && GroupIDs.has(Number(Context.GroupID))) return true;

  // The scoped id this event's entity is named by in a scope's Clients list —
  // also what a targeted tag's own membership is resolved against.
  const ScopedID =
    Context.EntityType === 'monitor' && Context.TargetID != null
      ? `monitor:${Context.TargetID}`
      : Context.UUID
        ? String(Context.UUID)
        : '';
  if (!ScopedID) return false;

  return ScopeCoversEntity(
    Scope,
    { ScopedID, GroupID: Context.GroupID ?? null },
    Tags as readonly ScopeTag[] | undefined
  );
}

// Whether a single trigger type on the rule matches the runtime context. The
// CLIENT_DEGRADED case additionally consults the rule's TriggerConfig.Source.
function singleTriggerMatches(
  TriggerType: string,
  Rule: AlertRule,
  Context: AlertContext
): boolean {
  switch (TriggerType) {
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
    case TRIGGERS.APPLICATION_STARTED:
      return Context.TriggerType === TRIGGERS.APPLICATION_STARTED;
    case TRIGGERS.APPLICATION_STOPPED:
      return Context.TriggerType === TRIGGERS.APPLICATION_STOPPED;
    case TRIGGERS.CRITICAL_APPLICATION_STARTED:
      return Context.TriggerType === TRIGGERS.CRITICAL_APPLICATION_STARTED;
    case TRIGGERS.CRITICAL_APPLICATION_STOPPED:
      return Context.TriggerType === TRIGGERS.CRITICAL_APPLICATION_STOPPED;
    case TRIGGERS.NON_CRITICAL_APPLICATION_STARTED:
      return Context.TriggerType === TRIGGERS.NON_CRITICAL_APPLICATION_STARTED;
    case TRIGGERS.NON_CRITICAL_APPLICATION_STOPPED:
      return Context.TriggerType === TRIGGERS.NON_CRITICAL_APPLICATION_STOPPED;
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

      if (Context.EntityType === 'monitor-check') {
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

// A rule fires when ANY of its configured trigger types matches the context.
function triggerMatches(Rule: AlertRule, Context: AlertContext): boolean {
  const Types = Array.isArray(Rule.TriggerTypes) ? Rule.TriggerTypes : [];
  for (const TriggerType of Types) {
    if (singleTriggerMatches(TriggerType, Rule, Context)) return true;
  }
  return false;
}

function describeMonitorReason(Context: AlertContext): string {
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
  if (Number.isFinite(Context.LastLatencyMs))
    return `${Math.round(Context.LastLatencyMs as number)}ms`;
  return 'unknown reason';
}

function describeUSBDevice(Context: AlertContext): string {
  const Device: Record<string, unknown> = (Context && Context.Device) || {};
  const Name = [Device.ManufacturerName, Device.ProductName].filter(Boolean).join(' ').trim();
  return Name || 'USB device';
}

function describeApplication(Context: AlertContext): string {
  const Application: Record<string, unknown> = (Context && Context.Application) || {};
  const Name = typeof Application.Name === 'string' ? Application.Name.trim() : '';
  return Name || 'application';
}

function describeContext(Context: AlertContext): string {
  if (Context.TriggerType === TRIGGERS.SCRIPT_EXECUTION_FAILED) {
    return `${Context.ScriptName || 'Script'} failed on ${Context.EntityName || 'Unknown Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CLIENT_DEGRADED) {
    if (Context.EntityType === 'monitor' || Context.EntityType === 'monitor-check') {
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
  if (Context.TriggerType === TRIGGERS.APPLICATION_STARTED) {
    return `${describeApplication(Context)} started on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.APPLICATION_STOPPED) {
    return `${describeApplication(Context)} stopped on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CRITICAL_APPLICATION_STARTED) {
    return `${describeApplication(Context)} (critical) started on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CRITICAL_APPLICATION_STOPPED) {
    return `${describeApplication(Context)} (critical) stopped on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.NON_CRITICAL_APPLICATION_STARTED) {
    return `${describeApplication(Context)} (non-critical) started on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.NON_CRITICAL_APPLICATION_STOPPED) {
    return `${describeApplication(Context)} (non-critical) stopped on ${Context.EntityName || 'Client'}`;
  }
  return 'Alert triggered';
}

export { isScopeMatch, triggerMatches, describeMonitorReason, describeContext };
export type { AlertContext, AlertRule };
