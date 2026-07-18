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

// Conditional visibility for a setting field. The field only renders (and is only
// collected) when the sibling field named by Key currently equals Equals. Used to
// gate attribute-specific thresholds behind an "enable this check" toggle.
export interface MonitoringSettingVisibleWhen {
  Key: string;
  Equals: unknown;
}

export interface MonitoringSettingField {
  Key: string;
  Label: string;
  // 'string' (default) | 'number' | 'boolean' | 'select' | 'list'. A 'list' field
  // collects multiple values as a string[] (chip/tag input) — see ItemType.
  Type: string;
  Default?: unknown;
  Min?: number;
  Max?: number;
  Options?: Array<string | { value: string; label?: string }>;
  // For Type 'list': hints how each entry is validated/coerced. 'number' keeps only
  // entries that parse as finite numbers; 'string' (default) trims and keeps text.
  ItemType?: 'string' | 'number';
  Advanced?: boolean;
  // Marks a setting the check cannot run without. The editor appends a red
  // asterisk to the label. Purely a display hint — server-side validation in the
  // method's Run() remains the source of truth.
  Required?: boolean;
  // Optional per-input hint. Rendered as a hover popover on a small info icon to
  // the right of the input — keep it to a sentence or two. Escaped before display.
  Note?: string;
  // When set, the field is shown only while the referenced sibling setting equals
  // the given value. Its value is still retained while hidden so toggling the
  // controlling field back on restores it.
  VisibleWhen?: MonitoringSettingVisibleWhen;
  [key: string]: unknown;
}

// Editor-facing "how to set this up" help, shown in a panel below the method
// picker. Purely informational — never affects probe behaviour. All fields are
// treated as plain text by the renderer (escaped before display).
export interface MonitoringMethodInfo {
  Summary: string;
  Setup?: string[];
  // External references (protocol specs, vendor docs, API references). Rendered
  // as buttons at the bottom of the info panel that open in the default browser.
  Links?: Array<{ Label: string; Url: string }>;
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
