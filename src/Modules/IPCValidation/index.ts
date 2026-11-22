// IPCValidation
// Validates and normalizes payloads crossing the IPC boundary. Validators are
// grouped by domain in sibling files and registered onto a single Manager so
// callers keep using `IPCValidation.<Validator>(...)` exactly as before.
//
// Every validator throws (via `fail`) on invalid input and otherwise returns a
// normalized value. The Manager type below is the composition of every domain's
// validator surface; each domain file imports it to type its register function.
import type {
  AudioLevelRequest,
  ClientSystemCheckKey,
  ClientSystemCheckPayload,
  CriticalAudioDevicePayload,
  CriticalDisplayPayload,
  CriticalNetworkInterfacePayload,
  CriticalStorageVolumePayload,
  CriticalUSBConditionOptions,
} from '@showtrak/protocol';
import type { AlertRuleCreatePayload } from '../AlertsManager';
import type { MonitoringTargetCreatePayload } from '../MonitoringTargetManager';

// What a validator returns for a payload the protocol describes is that payload
// type, normalized: only the options the request carried are present (an absent
// one keeps its current value; null stops guarding it). The USB marks are the
// exception: their names are normalized to string-or-null, always present.
export interface CriticalUSBDevicePayloadResult extends CriticalUSBConditionOptions {
  SerialNumber: string;
  ManufacturerName: string | null;
  ProductName: string | null;
}

export interface CriticalUSBNamePayloadResult extends CriticalUSBConditionOptions {
  ManufacturerName: string | null;
  ProductName: string | null;
}

// No protocol type: MarkClientApplicationCritical takes its payload as unknown.
export interface CriticalApplicationPayloadResult {
  Name: string;
  // Absent leaves an existing entry's foreground condition as it was.
  RequireForeground?: boolean;
  RequireResponding?: boolean;
}

export interface IPCValidationManager {
  // Client / group / script identifiers (client-validators.ts)
  UUID(value: unknown, fieldName?: string): string;
  UUIDList(value: unknown, fieldName?: string): string[];
  GroupID(value: unknown, fieldName?: string): number | null;
  GroupTitle(value: unknown): string;
  GroupKeyBind(value: unknown, fieldName?: string): string | null;
  GroupColumnSpan(value: unknown, fieldName?: string): number;
  GroupColour(value: unknown, fieldName?: string): number | null;
  // Human-friendly OSC/API identifier: letters, digits, `-`, `_`; no spaces.
  Slug(value: unknown, fieldName?: string): string;
  ScriptID(value: unknown): string;
  IntegratedEventID(value: unknown): string;
  UnassignedClientCreatePayload(value: unknown): { Name: string; Count: number };

  // Script catalog (script-validators.ts)
  ScriptFolderID(value: unknown, fieldName?: string): string;
  ScriptSampleID(value: unknown, fieldName?: string): string;
  ScriptFieldsPayload(value: unknown): Record<string, unknown>;
  ScriptOrderList(value: unknown, fieldName?: string): string[];
  ScriptWhitelistScope(value: unknown): {
    Workspace: boolean;
    Groups: number[];
    Clients: string[];
    Tags: number[];
  };
  Boolean(value: unknown, fieldName?: string): boolean;
  USBSerialNumber(value: unknown, fieldName?: string): string;
  CriticalUSBDevicePayload(value: unknown): CriticalUSBDevicePayloadResult;
  CriticalUSBNamePayload(value: unknown): CriticalUSBNamePayloadResult;
  CriticalApplicationPayload(value: unknown): CriticalApplicationPayloadResult;
  DisplayID(value: unknown, fieldName?: string): string;
  // A MAC address, normalized to upper-case colon-separated form. Enforces only
  // syntactic validity: unlike the reported-address ingest path, an operator
  // typing an address by hand may legitimately enter one for an interface the
  // server has never observed, so the external/physical filter is not applied.
  MacAddress(value: unknown, fieldName?: string): string;
  CriticalDisplayPayload(value: unknown): CriticalDisplayPayload;
  AudioEndpointID(value: unknown, fieldName?: string): string;
  CriticalAudioDevicePayload(value: unknown): CriticalAudioDevicePayload;
  AudioLevelRequest(value: unknown): AudioLevelRequest;
  NetworkInterfaceName(value: unknown, fieldName?: string): string;
  CriticalNetworkInterfacePayload(value: unknown): CriticalNetworkInterfacePayload;
  StorageMountPoint(value: unknown, fieldName?: string): string;
  CriticalStorageVolumePayload(value: unknown): CriticalStorageVolumePayload;
  SystemCheckKey(value: unknown): ClientSystemCheckKey;
  ClientSystemCheckPayload(value: unknown): ClientSystemCheckPayload;
  ClientUpdatePayload(value: unknown): Record<string, unknown>;

  // Monitoring targets (monitoring-validators.ts)
  MonitoringTargetID(value: unknown, fieldName?: string): number;
  // Typed as the manager's input, so the registrar hands it over without a cast.
  MonitoringTargetCreatePayload(value: unknown): MonitoringTargetCreatePayload;
  MonitoringTargetUpdatePayload(value: unknown): Record<string, unknown>;

  // Dummy clients (dummy-validators.ts)
  DummyClientUUID(value: unknown, fieldName?: string): string;
  DummyClientCreatePayload(value: unknown): Record<string, unknown>;
  DummyClientUpdatePayload(value: unknown): Record<string, unknown>;

  // FreeKiosk terminals (freekiosk-validators.ts)
  FreeKioskUUID(value: unknown, fieldName?: string): string;
  FreeKioskUUIDList(value: unknown, fieldName?: string): string[];
  FreeKioskCommand(value: unknown): string;
  FreeKioskCommandParams(command: unknown, value: unknown): Record<string, unknown>;
  FreeKioskCapturePayload(value: unknown): { Camera: 'front' | 'back'; Quality: number };
  FreeKioskMetricKeys(value: unknown): string[];
  FreeKioskCreatePayload(value: unknown): Record<string, unknown>;
  FreeKioskUpdatePayload(value: unknown): Record<string, unknown>;

  // Monitoring check actions (monitoring-validators.ts)
  MonitoringTargetIDList(value: unknown, fieldName?: string): number[];
  MonitoringMethodID(value: unknown, fieldName?: string): string;
  MonitoringActionID(method: unknown, value: unknown): string;
  MonitoringActionParams(method: unknown, action: unknown, value: unknown): Record<string, unknown>;

  // Alert rules (alert-validators.ts)
  AlertRuleID(value: unknown, fieldName?: string): number;
  AlertRuleCreatePayload(value: unknown): AlertRuleCreatePayload;
  AlertRuleUpdatePayload(value: unknown): Record<string, unknown>;

  // Tags (tag-validators.ts)
  TagID(value: unknown, fieldName?: string): number;
  TagColour(value: unknown, fieldName?: string): number;
  TagDisplay(value: unknown, fieldName?: string): string;
  TagScope(value: unknown): {
    Workspace: boolean;
    Groups: number[];
    Clients: string[];
    Tags: number[];
  };

  // Show Variables (variable-validators.ts)
  VariableID(value: unknown, fieldName?: string): number;
  VariableText(value: unknown, fieldName?: string): string;
  ClientVariableMap(value: unknown): Record<string, string | null>;

  // Audio assets (audio-validators.ts)
  AudioAssetID(value: unknown, fieldName?: string): string;
  AudioImportPayload(value: unknown): Record<string, unknown>;
  AudioUpdatePayload(value: unknown): Record<string, unknown>;

  // FOG integration (fog-validators.ts)
  FogHostID(value: unknown, fieldName?: string): number;
  FogHostIDOrNull(value: unknown, fieldName?: string): number | null;
  FogTaskTypeID(value: unknown, fieldName?: string): number;
  FogTaskRecordID(value: unknown, fieldName?: string): number;
  FogSnapinID(value: unknown, fieldName?: string): number | null;

  // Network discovery / settings (system-validators.ts)
  NetworkDiscoveryScanID(value: unknown): string;
  NetworkDiscoveryScanOptions(value: unknown): Record<string, unknown>;
  SettingUpdatePayload(key: unknown, value: unknown): [string, string | number | boolean];
}

const Manager = {} as IPCValidationManager;

// Each domain module adds its validators to Manager. They only import this
// module's types, so there is no import cycle at runtime.
import registerClientValidators from './client-validators';
import registerScriptValidators from './script-validators';
import registerMonitoringValidators from './monitoring-validators';
import registerDummyValidators from './dummy-validators';
import registerFreeKioskValidators from './freekiosk-validators';
import registerAlertValidators from './alert-validators';
import registerTagValidators from './tag-validators';
import registerVariableValidators from './variable-validators';
import registerAudioValidators from './audio-validators';
import registerFogValidators from './fog-validators';
import registerSystemValidators from './system-validators';

registerClientValidators(Manager);
registerScriptValidators(Manager);
registerMonitoringValidators(Manager);
registerDummyValidators(Manager);
registerFreeKioskValidators(Manager);
registerAlertValidators(Manager);
registerTagValidators(Manager);
registerVariableValidators(Manager);
registerAudioValidators(Manager);
registerFogValidators(Manager);
registerSystemValidators(Manager);

export { Manager };
