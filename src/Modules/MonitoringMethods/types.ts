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

// Editor-facing "how to set this up" help, shown in a panel below the method
// picker. Purely informational — never affects probe behaviour. All fields are
// treated as plain text by the renderer (escaped before display).
export interface MonitoringMethodInfo {
  Summary: string;
  Setup?: string[];
  Docs?: Array<{ Label: string; Url: string }>;
}

export interface MonitoringMethod {
  ID: string;
  Name: string;
  Description?: string;
  Info?: MonitoringMethodInfo;
  // Optional grouping label for the editor's method picker. When omitted the
  // registry falls back to the central map in ./groups (then "Other").
  Group?: string;
  DefaultInterval?: number;
  // Whether this method uses the per-check Address (target IP / hostname / domain)
  // field. Defaults to true. Presence/discovery methods that ignore Address (e.g.
  // network-wide NDI discovery) set this false so the editor hides the field and
  // stops requiring it.
  UsesAddress?: boolean;
  // Whether the latency-based "Degraded Threshold (ms)" applies. Defaults to true.
  // Passive presence checks that don't measure round-trip latency (sACN, Art-Net,
  // NDI, Millumin, MQTT) set this false so the editor hides the field.
  SupportsLatencyThreshold?: boolean;
  Settings: MonitoringSettingField[];
  Run(Target: MonitoringTargetLike): Promise<MonitoringResult> | MonitoringResult;
  Debug?(Result: MonitoringResult, Target: MonitoringTargetLike): string;
  NormalizeSettings?(Input: unknown): Record<string, unknown>;
  GetRunCacheKeyExtra?(Target: MonitoringTargetLike, Settings: Record<string, unknown>): unknown;
  GetRunCacheTtlMs?(Target: MonitoringTargetLike): number;
  RunCacheTtlMs?: number;
  _internal?: unknown;
}
