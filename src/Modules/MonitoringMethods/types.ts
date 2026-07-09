// Shared types for the MonitoringMethods family.

export interface MonitoringResult {
  Success: boolean;
  Error?: string;
  LatencyMs?: number | null;
  Degraded?: boolean;
  DegradedReason?: string;
  [key: string]: unknown;
}

export interface MonitoringTargetLike {
  Address?: string;
  Settings?: Record<string, unknown>;
}

export interface MonitoringSettingField {
  Key: string;
  Label: string;
  Type: string;
  Default?: unknown;
  Min?: number;
  Max?: number;
  Options?: Array<string | { value: string; label?: string }>;
  Advanced?: boolean;
  [key: string]: unknown;
}

export interface MonitoringMethod {
  ID: string;
  Name: string;
  Description?: string;
  DefaultInterval?: number;
  Settings: MonitoringSettingField[];
  Run(Target: MonitoringTargetLike): Promise<MonitoringResult> | MonitoringResult;
  Debug?(Result: MonitoringResult, Target: MonitoringTargetLike): string;
  NormalizeSettings?(Input: unknown): Record<string, unknown>;
  GetRunCacheKeyExtra?(Target: MonitoringTargetLike, Settings: Record<string, unknown>): unknown;
  GetRunCacheTtlMs?(Target: MonitoringTargetLike): number;
  RunCacheTtlMs?: number;
  _internal?: unknown;
}
