// TypeScript row shapes for every table declared in ./schema.ts.
// Keep these in lockstep with the DDL (and its versioned migrations): a column
// added there must be added here. Columns without NOT NULL are nullable.

export interface GroupRow {
  GroupID: number;
  Title: string | null;
  Weight: number | null;
  FullWidth: number; // 0 | 1
  KeyBind: string | null;
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
  Timestamp: number;
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
  Scope: string; // JSON: { Workspace, Groups[], Clients[] }
  UpdatedAt: number;
}

export interface SchemaMigrationRow {
  Version: number;
  AppliedAt: number;
}
