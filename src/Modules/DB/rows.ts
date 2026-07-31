// TypeScript row shapes for every table declared in ./schema.ts.
// Keep these in lockstep with the DDL (and its versioned migrations): a column
// added there must be added here. Columns without NOT NULL are nullable.

export interface GroupRow {
  GroupID: number;
  Title: string | null;
  Weight: number | null;
  FullWidth: number; // 0 | 1
  KeyBind: string | null;
  Slug: string | null; // back-filled non-null on first boot; nullable pre-migration
}

export interface ClientRow {
  UUID: string;
  Nickname: string | null;
  Hostname: string | null;
  OperatingSystem: string | null;
  MacAddress: string | null;
  GroupID: number | null;
  Weight: number;
  Version: string | null;
  IP: string | null;
  RunOnLaunchScriptID: string | null;
  RunOnLaunchDelaySeconds: number | null;
  // Reserved slot standing in for hardware that has not arrived yet. Cleared
  // when the slot is filled via ReplaceClientUUID.
  Unassigned: number; // 0 | 1
  Slug: string | null; // back-filled non-null on first boot; nullable pre-migration
  Timestamp: number;
}

// One MAC address a client is known by. `MacAddress` is stored normalized
// (upper-case, colon-separated) so the composite PK de-duplicates regardless of
// how the address was formatted on the way in.
export interface ClientMacAddressRow {
  UUID: string;
  MacAddress: string;
  Source: 'Reported' | 'Manual';
  // Interface the address was observed on, when known. Reporting-only metadata:
  // manual entries and pre-migration back-fills leave it null.
  InterfaceName: string | null;
  FirstSeen: number;
  LastSeen: number;
}

export interface SettingRow {
  Key: string;
  Value: unknown; // BLOB
}

export interface MonitoringTargetRow {
  TargetID: number;
  Nickname: string | null;
  Address: string | null;
  Method: string;
  Interval: number;
  Settings: string | null; // JSON
  GroupID: number | null;
  Weight: number;
  LastSuccessAt: number | null;
  DegradedThresholdMs: number;
  Slug: string | null; // back-filled non-null on first boot; nullable pre-migration
  Timestamp: number;
}

export interface MonitoringCheckRow {
  CheckID: number;
  TargetID: number;
  Name: string | null;
  Address: string | null;
  Method: string;
  Settings: string | null; // JSON
  DegradedThresholdMs: number;
  Weight: number;
  LastSuccessAt: number | null;
  Timestamp: number;
}

export interface DummyClientRow {
  UUID: string;
  DummyID: string;
  Nickname: string | null;
  Interval: number;
  IP: string | null;
  GroupID: number | null;
  Weight: number;
  Timestamp: number;
}

export interface FreeKioskTerminalRow {
  UUID: string;
  Nickname: string | null;
  Address: string;
  Port: number;
  ApiKey: string | null;
  Interval: number;
  TimeoutMs: number;
  /** JSON: per-metric alarm configuration, keyed A_<MetricKey>_On/_Op/_V/_V2. */
  Settings: string | null;
  GroupID: number | null;
  Weight: number;
  LastSuccessAt: number | null;
  Slug: string | null;
  Timestamp: number;
}

export interface AlertRuleRow {
  RuleID: number;
  Title: string;
  Scope: string; // JSON
  TriggerType: string; // JSON array of trigger type IDs (legacy rows store a bare string)
  TriggerConfig: string | null; // JSON
  Actions: string; // JSON
  Enabled: number; // 0 | 1
  Timestamp: number;
  UpdatedAt: number;
}

export interface AlertHistoryRow {
  HistoryID: number;
  RuleID: number;
  TriggerType: string;
  TriggerSource: string;
  Context: string | null; // JSON
  Result: string | null; // JSON
  Timestamp: number;
}

export interface CriticalUSBDeviceRow {
  UUID: string;
  SerialNumber: string;
  ManufacturerName: string | null;
  ProductName: string | null;
  Timestamp: number;
}

export interface CriticalUSBDeviceNameRow {
  UUID: string;
  NameKey: string;
  ManufacturerName: string | null;
  ProductName: string | null;
  Quantity: number;
  Timestamp: number;
}

export interface CriticalApplicationRow {
  UUID: string;
  ApplicationKey: string;
  ApplicationName: string;
  Timestamp: number;
}

export interface CriticalDisplayRow {
  UUID: string;
  DisplayID: string;
  Label: string | null;
  Width: number | null;
  Height: number | null;
  RefreshRate: number | null;
  ScaleFactor: number | null;
  Timestamp: number;
}

export interface ScriptWhitelistRow {
  ScriptID: string;
  Scope: string; // JSON: { Workspace, Groups[], Clients[], Tags[] }
  UpdatedAt: number;
}

export interface TagRow {
  TagID: number;
  Slug: string | null; // back-filled non-null on first boot; nullable pre-migration
  Colour: number; // index into the shared Scripts colour palette
  Icon: string; // bare Bootstrap Icons name (no "bi-" prefix)
  Display: string; // tile presentation: 'hidden' | 'icon' | 'name' | 'both'
  Scope: string; // JSON: { Workspace, Groups[], Clients[], Tags[] }
  Weight: number;
}

export interface FogHostRow {
  UUID: string; // ShowTrak client UUID
  FogHostID: number;
  FogHostName: string | null; // cached at link time so the editor reads offline
  Timestamp: number;
}

export interface FogTaskRow {
  FogTaskRecordID: number;
  UUID: string | null; // owning ShowTrak client; null if the link was since removed
  FogHostID: number;
  FogHostName: string | null;
  FogTaskID: number | null; // null until the poller matches the task up by host
  TaskTypeID: number;
  TaskTypeName: string | null;
  StateID: number; // see FOG_TASK_STATES in Modules/Config/fog
  Percent: string | null; // FOG returns percent as display text, not a number
  LastError: string | null;
  CreatedAt: number;
  UpdatedAt: number;
}

export interface SchemaMigrationRow {
  Version: number;
  AppliedAt: number;
}
