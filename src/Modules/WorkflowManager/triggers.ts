// The Triggers section of a workflow: what starts it.
//
// Pure and I/O-free — the IPC validators import the trigger catalogue from here.
//
// Event stimuli reuse the AlertsManager TRIGGERS vocabulary verbatim rather than
// inventing a parallel set. That shared vocabulary is what would make a later
// migration of alert rules onto workflows a data move instead of a rewrite, and
// it means an operator who has learned one list has learned both.
import { TRIGGERS } from '../AlertsManager/triggers';
import type { ScopeShape } from '../ScopeMatching';

export interface WorkflowTriggers {
  // Offered in context menus and the check workflows row.
  Manual: boolean;
  // May be called by another workflow, the alert action, OSC and the SDK.
  Callable: boolean;
  // Event stimuli; the workflow runs when ANY of them matches.
  Events: string[];
  // Per-event options, the same untyped escape hatch AlertRules.TriggerConfig is.
  EventConfig: Record<string, unknown>;
  // Which entities the manual and event triggers apply to.
  Scope: ScopeShape;
}

export interface WorkflowTriggerType {
  ID: string;
  Name: string;
}

// The catalogue shown in the editor. Kept in step with AlertsManager.GetTriggers
// — note FREEKIOSK_METRIC_ALARM is included here, which the alert validator's
// own duplicated allowlist currently omits.
export const WORKFLOW_TRIGGER_TYPES: readonly WorkflowTriggerType[] = Object.freeze([
  { ID: TRIGGERS.CLIENT_OFFLINE, Name: 'Client / monitor goes offline' },
  { ID: TRIGGERS.CLIENT_ONLINE, Name: 'Client / monitor comes online' },
  { ID: TRIGGERS.CLIENT_DEGRADED, Name: 'Client / monitor becomes degraded' },
  { ID: TRIGGERS.SCRIPT_EXECUTION_FAILED, Name: 'Script execution fails' },
  { ID: TRIGGERS.USB_DEVICE_CONNECTED, Name: 'USB device connected' },
  { ID: TRIGGERS.USB_DEVICE_DISCONNECTED, Name: 'USB device disconnected' },
  { ID: TRIGGERS.CRITICAL_USB_DEVICE_CONNECTED, Name: 'Critical USB device connected' },
  { ID: TRIGGERS.CRITICAL_USB_DEVICE_DISCONNECTED, Name: 'Critical USB device disconnected' },
  {
    ID: TRIGGERS.NON_CRITICAL_USB_DEVICE_CONNECTED,
    Name: 'Non-critical USB device connected',
  },
  {
    ID: TRIGGERS.NON_CRITICAL_USB_DEVICE_DISCONNECTED,
    Name: 'Non-critical USB device disconnected',
  },
  { ID: TRIGGERS.APPLICATION_STARTED, Name: 'Application started' },
  { ID: TRIGGERS.APPLICATION_STOPPED, Name: 'Application stopped' },
  { ID: TRIGGERS.CRITICAL_APPLICATION_STARTED, Name: 'Critical application started' },
  { ID: TRIGGERS.CRITICAL_APPLICATION_STOPPED, Name: 'Critical application stopped' },
  { ID: TRIGGERS.NON_CRITICAL_APPLICATION_STARTED, Name: 'Non-critical application started' },
  { ID: TRIGGERS.NON_CRITICAL_APPLICATION_STOPPED, Name: 'Non-critical application stopped' },
  { ID: TRIGGERS.FREEKIOSK_METRIC_ALARM, Name: 'FreeKiosk metric alarm' },
]);

const VALID_EVENT_IDS = new Set(WORKFLOW_TRIGGER_TYPES.map((T) => T.ID));

export function IsValidTriggerEvent(ID: unknown): boolean {
  return VALID_EVENT_IDS.has(String(ID));
}

export const EMPTY_SCOPE: ScopeShape = Object.freeze({
  Workspace: false,
  Groups: [],
  Clients: [],
  Tags: [],
});

function normalizeScope(Input: unknown): ScopeShape {
  const Raw = Input && typeof Input === 'object' ? (Input as Record<string, unknown>) : {};
  return {
    Workspace: !!Raw.Workspace,
    Groups: Array.isArray(Raw.Groups) ? Raw.Groups : [],
    Clients: Array.isArray(Raw.Clients) ? Raw.Clients : [],
    Tags: Array.isArray(Raw.Tags) ? Raw.Tags : [],
  };
}

export function NormalizeTriggers(Input: unknown): WorkflowTriggers {
  const Raw = Input && typeof Input === 'object' ? (Input as Record<string, unknown>) : {};
  const Events = Array.isArray(Raw.Events)
    ? Array.from(new Set(Raw.Events.map((E) => String(E)).filter(IsValidTriggerEvent)))
    : [];

  return {
    // A workflow with no trigger at all would be unreachable, so Manual is the
    // default rather than false — the operator can always turn it off.
    Manual: Raw.Manual === undefined ? true : !!Raw.Manual,
    Callable: Raw.Callable === undefined ? true : !!Raw.Callable,
    Events,
    EventConfig:
      Raw.EventConfig && typeof Raw.EventConfig === 'object'
        ? (Raw.EventConfig as Record<string, unknown>)
        : {},
    Scope: normalizeScope(Raw.Scope),
  };
}

// Whether one event stimulus matches this workflow's Events list. Scope is
// judged separately by the manager, which has the tag list.
export function TriggerEventMatches(
  Triggers: WorkflowTriggers,
  TriggerType: unknown,
  Context: Record<string, unknown>
): boolean {
  const Type = String(TriggerType || '');
  if (!Triggers.Events.includes(Type)) return false;

  // FREEKIOSK_METRIC_ALARM may be narrowed to specific metrics; an empty or
  // absent list means every metric. Same semantics as the alert rule.
  if (Type === TRIGGERS.FREEKIOSK_METRIC_ALARM) {
    const Wanted = Triggers.EventConfig.Metrics;
    if (Array.isArray(Wanted) && Wanted.length) {
      return Wanted.map((M) => String(M)).includes(String(Context.MetricKey || ''));
    }
  }

  // CLIENT_DEGRADED may be narrowed to a source ('client' | 'monitor' | 'any').
  if (Type === TRIGGERS.CLIENT_DEGRADED) {
    const Source = String(Triggers.EventConfig.Source || 'any');
    if (Source !== 'any') return String(Context.EntityType || '') === Source;
  }

  return true;
}

export { TRIGGERS };
