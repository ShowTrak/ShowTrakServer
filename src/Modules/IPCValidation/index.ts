// IPCValidation
// Validates and normalizes payloads crossing the IPC boundary. Validators are
// grouped by domain in sibling files and registered onto a single Manager so
// callers keep using `IPCValidation.<Validator>(...)` exactly as before.
//
// Every validator throws (via `fail`) on invalid input and otherwise returns a
// normalized value. The Manager type below is the composition of every domain's
// validator surface; each domain file imports it to type its register function.

export interface CriticalUSBDevicePayloadResult {
  SerialNumber: string;
  ManufacturerName: string | null;
  ProductName: string | null;
}

export interface CriticalUSBNamePayloadResult {
  ManufacturerName: string | null;
  ProductName: string | null;
}

export interface CriticalApplicationPayloadResult {
  Name: string;
}

export interface CriticalDisplayPayloadResult {
  DisplayID: string;
  Label: string | null;
  Width: number | null;
  Height: number | null;
  RefreshRate: number | null;
  ScaleFactor: number | null;
}

export interface IPCValidationManager {
  // Client / group / script identifiers (client-validators.ts)
  UUID(value: unknown, fieldName?: string): string;
  UUIDList(value: unknown, fieldName?: string): string[];
  GroupID(value: unknown, fieldName?: string): number | null;
  GroupTitle(value: unknown): string;
  GroupKeyBind(value: unknown, fieldName?: string): string | null;
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
  CriticalDisplayPayload(value: unknown): CriticalDisplayPayloadResult;
  ClientUpdatePayload(value: unknown): Record<string, unknown>;

  // Monitoring targets (monitoring-validators.ts)
  MonitoringTargetID(value: unknown, fieldName?: string): number;
  MonitoringTargetCreatePayload(value: unknown): Record<string, unknown>;
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

  // Alert rules (alert-validators.ts)
  AlertRuleID(value: unknown, fieldName?: string): number;
  AlertRuleCreatePayload(value: unknown): Record<string, unknown>;
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

require('./client-validators')(Manager);
require('./script-validators')(Manager);
require('./monitoring-validators')(Manager);
require('./dummy-validators')(Manager);
require('./freekiosk-validators')(Manager);
require('./alert-validators')(Manager);
require('./tag-validators')(Manager);
require('./audio-validators')(Manager);
require('./fog-validators')(Manager);
require('./system-validators')(Manager);

export { Manager };
