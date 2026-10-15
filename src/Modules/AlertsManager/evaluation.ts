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
  AudioDevice?: Record<string, unknown> | null;
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

// Triggers raised from a client's health telemetry (see ClientManager/health).
// None takes configuration, so each matches its own stimulus exactly.
const HEALTH_TRIGGERS: ReadonlySet<string> = new Set([
  TRIGGERS.CLIENT_RECOVERED,
  TRIGGERS.CLIENT_REBOOTED,
  TRIGGERS.CLIENT_VERSION_CHANGED,
  TRIGGERS.CLIENT_SLEEPING,
  TRIGGERS.CLIENT_RESUMED,
  TRIGGERS.CPU_USAGE_HIGH,
  TRIGGERS.RAM_USAGE_HIGH,
  TRIGGERS.UPTIME_HIGH,
  TRIGGERS.TEMPERATURE_HIGH,
  TRIGGERS.THERMAL_STATE_HIGH,
  TRIGGERS.BATTERY_LOW,
  TRIGGERS.BATTERY_NOT_CHARGING,
  TRIGGERS.CRITICAL_POWER_ON_BATTERY,
  TRIGGERS.POWER_ON_BATTERY,
  TRIGGERS.POWER_RESTORED,
  TRIGGERS.APPLICATION_NOT_RESPONDING,
  TRIGGERS.CRITICAL_APPLICATION_NOT_RESPONDING,
  TRIGGERS.APPLICATION_RESPONDING,
  TRIGGERS.CRITICAL_APPLICATION_MULTIPLE_INSTANCES,
  TRIGGERS.FOREGROUND_APPLICATION_CHANGED,
  TRIGGERS.CRITICAL_APPLICATION_LOST_FOREGROUND,
  TRIGGERS.DISPLAY_CONNECTED,
  TRIGGERS.DISPLAY_DISCONNECTED,
  TRIGGERS.CRITICAL_DISPLAY_CONNECTED,
  TRIGGERS.CRITICAL_DISPLAY_DISCONNECTED,
  TRIGGERS.DISPLAY_CONFIGURATION_CHANGED,
  TRIGGERS.NETWORK_INTERFACE_UP,
  TRIGGERS.NETWORK_INTERFACE_DOWN,
  TRIGGERS.CRITICAL_NETWORK_INTERFACE_DOWN,
  TRIGGERS.NETWORK_ADDRESS_CHANGED,
  TRIGGERS.NETWORK_GATEWAY_CHANGED,
  TRIGGERS.USB_DEVICE_MOVED,
  TRIGGERS.USB_FIRMWARE_CHANGED,
  TRIGGERS.USB_DEVICE_ERROR,
  TRIGGERS.AUDIO_VOLUME_OUT_OF_RANGE,
]);

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
    case TRIGGERS.AUDIO_DEVICE_CONNECTED:
    case TRIGGERS.AUDIO_DEVICE_DISCONNECTED:
    case TRIGGERS.CRITICAL_AUDIO_DEVICE_CONNECTED:
    case TRIGGERS.CRITICAL_AUDIO_DEVICE_DISCONNECTED:
    case TRIGGERS.NON_CRITICAL_AUDIO_DEVICE_CONNECTED:
    case TRIGGERS.NON_CRITICAL_AUDIO_DEVICE_DISCONNECTED:
    case TRIGGERS.AUDIO_DEFAULT_DEVICE_CHANGED:
    case TRIGGERS.AUDIO_DEVICE_MUTED:
    case TRIGGERS.AUDIO_FORMAT_CHANGED:
      return Context.TriggerType === TriggerType;
    case TRIGGERS.FREEKIOSK_METRIC_ALARM: {
      if (Context.TriggerType !== TRIGGERS.FREEKIOSK_METRIC_ALARM) return false;
      // The metric filter. Mirrors the TriggerConfig.Source gating below: an
      // unset list means "any", so a rule saved before the filter existed keeps
      // matching everything rather than silently going quiet.
      const Metrics = Rule.TriggerConfig && Rule.TriggerConfig.Metrics;
      if (!Array.isArray(Metrics) || !Metrics.length) return true;
      return Metrics.map(String).includes(String(Context.MetricKey));
    }
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
      return HEALTH_TRIGGERS.has(TriggerType) && Context.TriggerType === TriggerType;
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

// "Scarlett 18i20 (output)". The direction matters: one interface is two
// endpoints, and "Scarlett disconnected" would not say which half went.
function describeAudioDevice(Device: Record<string, unknown> | null | undefined): string {
  const D: Record<string, unknown> = Device || {};
  const Name = typeof D.Name === 'string' && D.Name.trim() ? D.Name.trim() : 'Audio device';
  return D.Direction === 'input' || D.Direction === 'output' ? `${Name} (${D.Direction})` : Name;
}

function describeAudioFormat(Device: Record<string, unknown>): string {
  const Parts: string[] = [];
  if (Number.isFinite(Number(Device.Channels))) Parts.push(`${Number(Device.Channels)} ch`);
  if (Number.isFinite(Number(Device.SampleRate))) {
    Parts.push(`${Number(Device.SampleRate) / 1000} kHz`);
  }
  return Parts.join(' / ') || 'unknown format';
}

function describeAudioContext(Context: AlertContext): string | null {
  const Client = Context.EntityName || 'Client';
  const Device = Context.AudioDevice || {};
  const Name = describeAudioDevice(Device);
  switch (Context.TriggerType) {
    case TRIGGERS.AUDIO_DEVICE_CONNECTED:
      return `${Name} connected to ${Client}`;
    case TRIGGERS.AUDIO_DEVICE_DISCONNECTED:
      return `${Name} disconnected from ${Client}`;
    case TRIGGERS.CRITICAL_AUDIO_DEVICE_CONNECTED:
      return `${Name} (monitored) connected to ${Client}`;
    case TRIGGERS.CRITICAL_AUDIO_DEVICE_DISCONNECTED:
      return `${Name} (monitored) disconnected from ${Client}`;
    case TRIGGERS.NON_CRITICAL_AUDIO_DEVICE_CONNECTED:
      return `${Name} (unmonitored) connected to ${Client}`;
    case TRIGGERS.NON_CRITICAL_AUDIO_DEVICE_DISCONNECTED:
      return `${Name} (unmonitored) disconnected from ${Client}`;
    case TRIGGERS.AUDIO_DEVICE_MUTED:
      return `${Name} was muted on ${Client}`;
    case TRIGGERS.AUDIO_DEFAULT_DEVICE_CHANGED: {
      const Direction = Device.Direction === 'input' ? 'input' : 'output';
      const NewName =
        typeof Device.Name === 'string' && Device.Name.trim()
          ? Device.Name.trim()
          : 'another device';
      const Previous = Device.PreviousName;
      return `Default ${Direction} on ${Client} changed to ${NewName}${
        typeof Previous === 'string' && Previous.trim() ? ` (was ${Previous.trim()})` : ''
      }`;
    }
    case TRIGGERS.AUDIO_FORMAT_CHANGED: {
      const Before =
        Device.Previous && typeof Device.Previous === 'object'
          ? describeAudioFormat(Device.Previous as Record<string, unknown>)
          : null;
      return `${Name} on ${Client} changed format${Before ? ` from ${Before}` : ''} to ${describeAudioFormat(Device)}`;
    }
    default:
      return null;
  }
}

function describeDisplay(Value: unknown): string {
  const D = (Value && typeof Value === 'object' ? Value : {}) as Record<string, unknown>;
  const Label = typeof D.Label === 'string' && D.Label.trim() ? D.Label.trim() : null;
  const Screen = Number.isFinite(Number(D.ScreenNumber))
    ? `Screen ${Number(D.ScreenNumber)}`
    : null;
  return Label || Screen || 'A display';
}

function describeDisplayMode(Value: unknown): string {
  const D = (Value && typeof Value === 'object' ? Value : {}) as Record<string, unknown>;
  const Hz = Number.isFinite(Number(D.RefreshRate))
    ? `@${Math.round(Number(D.RefreshRate))}Hz`
    : '';
  return `${D.Width}x${D.Height}${Hz}`;
}

function describeInterface(Context: AlertContext): string {
  const I = (
    Context.Interface && typeof Context.Interface === 'object' ? Context.Interface : {}
  ) as Record<string, unknown>;
  return typeof I.Name === 'string' && I.Name ? I.Name : 'A network interface';
}

function describeDuration(Seconds: unknown): string {
  const n = Number(Seconds);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 90) return `${Math.round(n)}s`;
  if (n < 5400) return `${Math.round(n / 60)}m`;
  return `${Math.round(n / 3600)}h`;
}

function describeHealthContext(Context: AlertContext): string | null {
  const Client = Context.EntityName || 'Client';
  const App = describeApplication(Context);
  const Value = Context.Value == null ? null : Number(Context.Value);
  const Threshold = Context.Threshold == null ? null : Number(Context.Threshold);
  switch (Context.TriggerType) {
    case TRIGGERS.CLIENT_RECOVERED:
      return `${Client} recovered`;
    case TRIGGERS.CLIENT_REBOOTED:
      return `${Client} restarted`;
    case TRIGGERS.CLIENT_VERSION_CHANGED:
      return `${Client} updated from ${Context.PreviousVersion || 'unknown'} to ${Context.Version || 'unknown'}`;
    case TRIGGERS.CLIENT_SLEEPING:
      return `${Client} is going to sleep`;
    case TRIGGERS.CLIENT_RESUMED: {
      const Asleep = describeDuration(Context.AsleepSeconds);
      return `${Client} woke from sleep${Asleep ? ` after ${Asleep}` : ''}`;
    }
    case TRIGGERS.CPU_USAGE_HIGH:
      return `${Client} CPU at ${Value ?? '?'}% (limit ${Threshold ?? '?'}%)`;
    case TRIGGERS.RAM_USAGE_HIGH:
      return `${Client} memory at ${Value ?? '?'}% (limit ${Threshold ?? '?'}%)`;
    case TRIGGERS.UPTIME_HIGH:
      return `${Client} has been up ${Value ?? '?'} days without a restart (limit ${Threshold ?? '?'} days)`;
    case TRIGGERS.TEMPERATURE_HIGH: {
      const Sensor =
        typeof Context.Sensor === 'string' && Context.Sensor ? ` (${Context.Sensor})` : '';
      return `${Client} at ${Value ?? '?'}°C${Sensor}, limit ${Threshold ?? '?'}°C`;
    }
    case TRIGGERS.THERMAL_STATE_HIGH:
      return `${Client} is throttling to cool down (thermal state ${
        typeof Context.Value === 'string' ? Context.Value : 'raised'
      })`;
    case TRIGGERS.BATTERY_LOW:
      return `${Client} battery at ${Value ?? '?'}% (limit ${Threshold ?? '?'}%)`;
    case TRIGGERS.BATTERY_NOT_CHARGING:
      return `${Client} battery is not charging at ${Value ?? '?'}% while on mains power`;
    case TRIGGERS.CRITICAL_POWER_ON_BATTERY:
      return `${Client} (monitored) is running on battery`;
    case TRIGGERS.POWER_ON_BATTERY:
      return `${Client} lost mains power and is running on battery`;
    case TRIGGERS.POWER_RESTORED:
      return `${Client} is back on mains power`;
    case TRIGGERS.APPLICATION_NOT_RESPONDING:
      return `${App} is not responding on ${Client}`;
    case TRIGGERS.CRITICAL_APPLICATION_NOT_RESPONDING:
      return `${App} (monitored) is not responding on ${Client}`;
    case TRIGGERS.APPLICATION_RESPONDING:
      return `${App} is responding again on ${Client}`;
    case TRIGGERS.CRITICAL_APPLICATION_MULTIPLE_INSTANCES: {
      const Count = Number((Context.Application || {}).Count);
      return `${App} (monitored) is running ${Number.isFinite(Count) ? `${Count} instances` : 'more than once'} on ${Client}`;
    }
    case TRIGGERS.FOREGROUND_APPLICATION_CHANGED:
      return `${App} is now in the foreground on ${Client}`;
    case TRIGGERS.CRITICAL_APPLICATION_LOST_FOREGROUND: {
      const Front =
        typeof Context.Foreground === 'string' && Context.Foreground ? Context.Foreground : null;
      return `${App} (monitored) lost the foreground on ${Client}${Front ? ` to ${Front}` : ''}`;
    }
    case TRIGGERS.DISPLAY_CONNECTED:
      return `${describeDisplay(Context.Display)} connected to ${Client}`;
    case TRIGGERS.CRITICAL_DISPLAY_CONNECTED:
      return `${describeDisplay(Context.Display)} (monitored) connected to ${Client}`;
    case TRIGGERS.DISPLAY_DISCONNECTED:
      return `${describeDisplay(Context.Display)} disconnected from ${Client}`;
    case TRIGGERS.CRITICAL_DISPLAY_DISCONNECTED:
      return `${describeDisplay(Context.Display)} (monitored) disconnected from ${Client}`;
    case TRIGGERS.DISPLAY_CONFIGURATION_CHANGED:
      return `${describeDisplay(Context.Display)} on ${Client} changed from ${describeDisplayMode(Context.Previous)} to ${describeDisplayMode(Context.Display)}`;
    case TRIGGERS.NETWORK_INTERFACE_UP:
      return `${describeInterface(Context)} came up on ${Client}`;
    case TRIGGERS.NETWORK_INTERFACE_DOWN:
      return `${describeInterface(Context)} went down on ${Client}`;
    case TRIGGERS.CRITICAL_NETWORK_INTERFACE_DOWN:
      return `${describeInterface(Context)} (monitored) went down on ${Client}`;
    case TRIGGERS.NETWORK_ADDRESS_CHANGED: {
      const I = (Context.Interface || {}) as Record<string, unknown>;
      const Now = Array.isArray(I.Addresses) ? I.Addresses.join(', ') : 'a new address';
      return `${describeInterface(Context)} on ${Client} changed address to ${Now}`;
    }
    case TRIGGERS.NETWORK_GATEWAY_CHANGED: {
      const I = (Context.Interface || {}) as Record<string, unknown>;
      return `${describeInterface(Context)} on ${Client} changed router to ${I.Gateway || 'none'}`;
    }
    case TRIGGERS.USB_DEVICE_MOVED: {
      const Device = (Context.Device || {}) as Record<string, unknown>;
      return `${describeUSBDevice(Context)} moved to port ${Device.Location || '?'} on ${Client}`;
    }
    case TRIGGERS.USB_FIRMWARE_CHANGED: {
      const Device = (Context.Device || {}) as Record<string, unknown>;
      return `${describeUSBDevice(Context)} firmware changed to ${Device.FirmwareVersion || '?'} on ${Client}`;
    }
    case TRIGGERS.USB_DEVICE_ERROR: {
      const Device = (Context.Device || {}) as Record<string, unknown>;
      const State = (Device.DeviceState || {}) as Record<string, unknown>;
      const Why = typeof State.Message === 'string' && State.Message ? `: ${State.Message}` : '';
      return `${describeUSBDevice(Context)} reports a device problem on ${Client}${Why}`;
    }
    case TRIGGERS.AUDIO_VOLUME_OUT_OF_RANGE: {
      const Device = (Context.AudioDevice || {}) as Record<string, unknown>;
      const Level = Number.isFinite(Number(Device.Volume)) ? ` (${Number(Device.Volume)}%)` : '';
      return `${describeAudioDevice(Device)} level out of range on ${Client}${Level}`;
    }
    default:
      return null;
  }
}

// "Lobby Kiosk — Battery Level 12% is below 20%". The reason is worded by the
// alarm evaluator, which is the only thing that knows the metric's unit and
// precision, so it is used verbatim rather than rebuilt here.
function describeFreeKioskAlarm(Context: AlertContext): string {
  const Name = Context.EntityName || 'FreeKiosk terminal';
  const Reason = Context.Reason ? String(Context.Reason) : String(Context.MetricLabel || 'alarm');
  return `${Name} — ${Reason}`;
}

function describeContext(Context: AlertContext): string {
  const Audio = describeAudioContext(Context);
  if (Audio) return Audio;
  const Health = describeHealthContext(Context);
  if (Health) return Health;
  if (Context.TriggerType === TRIGGERS.FREEKIOSK_METRIC_ALARM) {
    return describeFreeKioskAlarm(Context);
  }
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
    return `${describeUSBDevice(Context)} (unmonitored) connected to ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.NON_CRITICAL_USB_DEVICE_DISCONNECTED) {
    return `${describeUSBDevice(Context)} (unmonitored) disconnected from ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CRITICAL_USB_DEVICE_CONNECTED) {
    return `${describeUSBDevice(Context)} (monitored) connected to ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CRITICAL_USB_DEVICE_DISCONNECTED) {
    return `${describeUSBDevice(Context)} (monitored) disconnected from ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.APPLICATION_STARTED) {
    return `${describeApplication(Context)} started on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.APPLICATION_STOPPED) {
    return `${describeApplication(Context)} stopped on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CRITICAL_APPLICATION_STARTED) {
    return `${describeApplication(Context)} (monitored) started on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.CRITICAL_APPLICATION_STOPPED) {
    return `${describeApplication(Context)} (monitored) stopped on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.NON_CRITICAL_APPLICATION_STARTED) {
    return `${describeApplication(Context)} (unmonitored) started on ${Context.EntityName || 'Client'}`;
  }
  if (Context.TriggerType === TRIGGERS.NON_CRITICAL_APPLICATION_STOPPED) {
    return `${describeApplication(Context)} (unmonitored) stopped on ${Context.EntityName || 'Client'}`;
  }
  return 'Alert triggered';
}

export {
  describeAudioDevice,
  isScopeMatch,
  triggerMatches,
  describeMonitorReason,
  describeFreeKioskAlarm,
  describeContext,
};
export type { AlertContext, AlertRule };
