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

// The outcome of a control action. Distinct from MonitoringResult because a
// probe answers "what state is the device in" while an action answers "did the
// thing I asked for happen".
export interface MonitoringActionResult {
  Success: boolean;
  Error?: string;
  // Human-readable outcome for the workflow run log, e.g. "Power on acknowledged".
  Detail?: string;
  LatencyMs?: number | null;
  // Whether the DEVICE confirmed it acted, as opposed to the command merely
  // reaching a live socket. False for fire-and-forget transports (QLab OSC).
  // The run log must not present an unconfirmed send as a confirmed one — that
  // is the difference between "QLab fired cue 5" and "we posted cue 5 at QLab".
  Confirmed?: boolean;
  Data?: Record<string, unknown>;
  [key: string]: unknown;
}

// A command a method can SEND to its device, as opposed to Run() which only
// reads. Declaring one here is what makes it available as a workflow step, so
// this registry is the allowlist — the same discipline as FreeKiosk commands.
export interface MonitoringMethodAction {
  ID: string;
  Label: string;
  // Bootstrap Icons name without the `bi-` prefix.
  Icon?: string;
  // Grouping label for the step picker (e.g. 'Power', 'Playback').
  Group?: string;
  // Parameter schema. Reuses MonitoringSettingField so an action's parameter
  // form renders through the same field renderer as check settings do.
  //
  // NOTE the deliberate departure: on check Settings, `Required` is documented
  // as a display hint only. On action params it is ENFORCED by RunAction. A
  // check missing a setting reads as unhealthy and the operator investigates; a
  // QLab GO with an empty cue number fires the wrong cue in front of an
  // audience. Refusing is the only safe reading.
  Params?: MonitoringSettingField[];
  // Needs a confirmation dialog before running from the UI.
  Destructive?: boolean;
  // No reply is possible on this transport, so Success means "written to a live
  // connection" and nothing more. Forces Confirmed: false on the result.
  FireAndForget?: boolean;
  // The device is expected to drop the connection carrying this out. A PJLink
  // power-off tears down the session mid-command, so the socket dies before an
  // answer arrives — that is the command WORKING. Without this flag ShowTrak
  // reports a hang-up as failure on exactly the commands most likely to have
  // succeeded.
  ExpectDisconnect?: boolean;
  Note?: string;
  Run(
    Target: MonitoringTargetLike,
    Params: Record<string, unknown>
  ): Promise<MonitoringActionResult> | MonitoringActionResult;
}

export interface MonitoringMethod {
  ID: string;
  Name: string;
  Description?: string;
  Info?: MonitoringMethodInfo;
  // Control actions this method can send. Absent means the method is read-only,
  // which is the default for every presence/status probe.
  Actions?: MonitoringMethodAction[];
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
  // Drop any method-private cached read state for this target. Called after a
  // control action so the next probe re-reads the device instead of replaying a
  // snapshot taken BEFORE the command.
  //
  // The registry can only evict its own per-check RUN_CACHE key. Methods that
  // share a family-level cache across several checks pointed at one device
  // (PJLink) must invalidate the whole device here, or a second check on the
  // same projector keeps serving the pre-command state.
  InvalidateCaches?(Target: MonitoringTargetLike): void;
  GetRunCacheKeyExtra?(Target: MonitoringTargetLike, Settings: Record<string, unknown>): unknown;
  GetRunCacheTtlMs?(Target: MonitoringTargetLike): number;
  RunCacheTtlMs?: number;
  _internal?: unknown;
}
