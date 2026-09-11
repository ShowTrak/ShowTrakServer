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
// collected) when the sibling field named by Key currently matches. Used to gate
// attribute-specific thresholds behind an "enable this check" toggle.
//
// Give either Equals (exact match) or In (membership). In exists because some
// gates cannot be written as an equality — the FreeKiosk alarm schema hides its
// threshold input whenever the chosen operator is one of the value-less edge
// detectors, which is a set test, not a comparison against one value.
export interface MonitoringSettingVisibleWhen {
  Key: string;
  Equals?: unknown;
  In?: unknown[];
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
  // When set, the field is shown only while the referenced sibling setting
  // matches. An array is ANDed: every condition must hold. Its value is still
  // retained while hidden so toggling the controlling field back on restores it.
  VisibleWhen?: MonitoringSettingVisibleWhen | MonitoringSettingVisibleWhen[];
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

// --- Controllable actions ----------------------------------------------------
//
// A check READS a device; an action DOES something to it. A method opts in by
// exporting `Actions` plus a `RunAction` implementation — nothing else in the
// stack needs to know the method exists. Actions are addressed as
// `<Method>/<ActionID>` in the UI, over IPC and over OSC, so each method owns a
// private action namespace and a new check type gains a control surface without
// a transport change.

export interface MonitoringActionDef {
  /** Stable and OSC-safe within its method (no slashes/spaces), e.g. `power.on`. */
  ID: string;
  Label: string;
  /** Bootstrap Icons name without the `bi-` prefix. */
  Icon: string;
  /** Grouping label for the monitor modal's control panel (e.g. "Power"). */
  Group: string;
  /**
   * Parameter schema, reusing MonitoringSettingField so an action's form renders
   * through the same schema-driven renderer as check settings, and normalizes
   * through the same defaults/clamping.
   */
  Params?: MonitoringSettingField[];
  /** Needs a confirmation dialog before it is sent. */
  Destructive?: boolean;
  Note?: string;
}

export interface MonitoringActionResult {
  Success: boolean;
  /** Why it failed. Shown to the operator verbatim, so make it specific. */
  Error?: string;
  /** Human confirmation of what happened, e.g. 'Input set to Digital 1'. */
  Detail?: string;
}

/**
 * Per-check choices for an action parameter, keyed by the parameter's Key.
 * Derived from the check's most recent result so a method can offer what THIS
 * device reported (a projector's actual input sources) instead of free text.
 */
export type MonitoringActionOptions = Record<string, Array<{ value: string; label: string }>>;

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
  // Controllable actions. Declaring any obliges the method to export RunAction.
  Actions?: MonitoringActionDef[];
  Run(Target: MonitoringTargetLike): Promise<MonitoringResult> | MonitoringResult;
  /**
   * Perform one declared action. Params arrive already normalized against the
   * action's own schema. Must resolve rather than throw for an expected refusal
   * (device busy, unsupported command) so the operator gets the reason.
   */
  RunAction?(
    Target: MonitoringTargetLike,
    ActionID: string,
    Params: Record<string, unknown>
  ): Promise<MonitoringActionResult> | MonitoringActionResult;
  /**
   * Dynamic parameter choices derived from a probe result (see
   * MonitoringActionOptions). Called after every successful run; must be pure
   * and must never throw.
   */
  GetActionOptions?(Result: MonitoringResult): MonitoringActionOptions;
  /**
   * One-line description of an action WITH its parameters bound, used to label
   * a starred favourite — 'Set Input - Digital 1 (31)' rather than 'Set Input'.
   * Return null to fall back to the action's plain label. Must be pure.
   */
  DescribeAction?(ActionID: string, Params: Record<string, unknown>): string | null;
  /**
   * Drop any method-private cached state for this target. Called after a
   * successful action so the follow-up probe reads the device's NEW state
   * rather than a snapshot taken moments before the action landed.
   */
  InvalidateCaches?(Target: MonitoringTargetLike): void;
  Debug?(Result: MonitoringResult, Target: MonitoringTargetLike): string;
  NormalizeSettings?(Input: unknown): Record<string, unknown>;
  GetRunCacheKeyExtra?(Target: MonitoringTargetLike, Settings: Record<string, unknown>): unknown;
  GetRunCacheTtlMs?(Target: MonitoringTargetLike): number;
  RunCacheTtlMs?: number;
  _internal?: unknown;
}
