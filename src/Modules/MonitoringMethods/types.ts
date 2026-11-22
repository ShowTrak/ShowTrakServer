// Shared types for the MonitoringMethods family.
//
// The parts of a method's definition that reach the renderer and the SDK as
// they are (its settings schema, actions, info panel, discovery signature and
// option lists) are the protocol's own types, re-exported below with the notes
// on how a method fills them in. What a method streams and returns is the
// protocol's too, less the fields the manager fills in.
import type {
  MonitoringActionDef,
  MonitoringActionOptions,
  MonitoringMethodDiscovery,
  MonitoringMethodInfo,
  MonitoringSettingField,
  MonitoringSettingOptions,
  MonitoringSettingVisibleWhen,
  MonitoringTileWidgetView,
  MonitorLiveLevelChange,
  MonitorLiveLevelResult,
  MonitorLiveLevelsCheck,
} from '@showtrak/protocol';

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
// gates cannot be written as an equality: the FreeKiosk alarm schema hides its
// threshold input whenever the chosen operator is one of the value-less edge
// detectors, which is a set test, not a comparison against one value.
export type { MonitoringSettingVisibleWhen };

// One field of a method's settings schema, rendered by the editor's
// schema-driven field renderer and normalised against by NormalizeFields.
//
//   Type        'string' (default) | 'number' | 'boolean' | 'select' | 'list' |
//               'names' | 'channels'. A 'list' field collects multiple values as
//               a string[] (chip/tag input); see ItemType.
//   ItemType    For Type 'list': how each entry is validated/coerced. 'number'
//               keeps only entries that parse as finite numbers; 'string'
//               (default) trims and keeps text.
//   FromDevice  For Type 'list': the editor also offers what the device itself
//               reported on the check's last successful run (the method's
//               GetSettingOptions, keyed by this field's Key) as a checkbox per
//               item. Ticked items are stored like typed entries, so the value
//               stays a plain string[] and typing still works.
//   Count,      For Type 'names': one name box per channel, Count of them. The
//   ItemDefault value is a string[] of exactly that length; a blank entry means
//               the default, ItemDefault with {n} replaced by the channel number.
//   Groups      For Type 'channels': a checkbox per channel, in these groups.
//   Required    The editor appends a red asterisk to the label. Purely a display
//               hint; server-side validation in the method's Run() remains the
//               source of truth.
//   Note        A hover popover on a small info icon beside the input; keep it
//               to a sentence or two. Escaped before display.
//   Sensitive   A credential (password, passcode, community string). Surfaces
//               that must not hand credentials out redact it via Utils/redact.
//   VisibleWhen The field shows only while the referenced sibling setting
//               matches. Its value is still retained while hidden, so toggling
//               the controlling field back on restores it.
export type { MonitoringSettingField };

// Editor-facing "how to set this up" help, shown in a panel below the method
// picker. Purely informational; never affects probe behaviour. All fields are
// treated as plain text by the renderer (escaped before display). Links are
// external references (protocol specs, vendor docs, API references), rendered as
// buttons at the bottom of the info panel that open in the default browser.
export type { MonitoringMethodInfo };

// --- Controllable actions ----------------------------------------------------
//
// A check READS a device; an action DOES something to it. A method opts in by
// exporting `Actions` plus a `RunAction` implementation; nothing else in the
// stack needs to know the method exists. Actions are addressed as
// `<Method>/<ActionID>` in the UI, over IPC and over OSC, so each method owns a
// private action namespace and a new check type gains a control surface without
// a transport change.

// An action's ID is stable and OSC-safe within its method (no slashes or
// spaces), e.g. `power.on`. Its Params reuse MonitoringSettingField, so an
// action's form renders through the same schema-driven renderer as check
// settings and normalises through the same defaults and clamping.
// AllowedWhileOffline keeps the control enabled while the check is offline:
// offline normally disables every control (every press would fail the same
// way), but a recovery action (rebooting a player whose status endpoint has
// stopped answering) is wanted most at exactly that moment.
export type { MonitoringActionDef };

// What RunAction resolves to. The manager folds it into a MonitoringActionOutcome
// per check (adding which target and check it was), so it is the method's half
// of that contract rather than a view of its own.
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
export type { MonitoringActionOptions };

/**
 * Per-check choices for a FromDevice 'list' setting, keyed by the setting's Key:
 * the items the device reported on the last successful run (a UniFi site's
 * devices), so the editor can offer them as checkboxes. `detail` is a secondary
 * line (model, state); `aliases` are other stored values that mean the same item
 * (a device's name, where the value is its MAC address).
 */
export type { MonitoringSettingOptions };

// --- Live levels ----------------------------------------------------------------
//
// A check can also stream audio meters while its monitor's view is open (see
// src/main/monitoring-live.ts). Nothing streams while nobody is watching.

// A method streams one check's frames; the manager names the check (CheckID,
// Name) to make the MonitorLiveLevelsCheck a viewer receives. Control marks a
// channel the view may move (see SetLiveLevel), with its current Fader (dB,
// null = −∞) and Muted when read; the move arrives as a MonitorLiveLevelChange
// and its answer goes back to the view as a MonitorLiveLevelResult.
export type LiveLevelsFrame = Pick<MonitorLiveLevelsCheck, 'State' | 'Message' | 'Channels'>;

// --- Tile widgets ---------------------------------------------------------------
//
// A monitor whose only check is of a method with a tile widget shows that widget
// at the bottom of its dashboard tile, in place of the latency line. Kind picks
// the renderer's drawer (src/UI/js/app/tile-widgets.ts); Data is whatever that
// drawer needs from the check's last result. 'levels' draws live meters from
// the check's tile channels (StartLiveLevels), streamed only while a dashboard is
// open. The manager adds the check the widget belongs to (CheckID) to make the
// tile's MonitoringTileWidgetView.
export type MonitoringTileWidget = Omit<MonitoringTileWidgetView, 'CheckID'>;

// --- LAN discovery --------------------------------------------------------------
//
// What a device this method can monitor looks like on the network, so the LAN
// discovery wizard can suggest the check rather than leaving the operator to
// pick from the whole catalogue. Purely declarative: the scan gathers evidence
// (open TCP ports, mDNS service types, PJLink replies) and the renderer matches
// it against these, so a method gains discovery without touching the scanner.
//
//   Confidence       How sure a match makes us. 'high' for a port or service
//                    only this kind of device uses; 'low' for one many devices
//                    share (80, 8080, telnet).
//   TcpPorts         Any of these TCP ports open is a match. Every port listed
//                    across the catalogue is probed on each live host, so keep
//                    generic ports out unless the confidence says so.
//   ServiceTypes     mDNS service types, `_type._proto` (e.g. '_qlab._tcp').
//                    Case-insensitive.
//   PJLink           Matches a projector that answered PJLink's UDP search.
//   PortSetting      Setting filled with the port the match was made on.
//   NameSetting      Setting filled with the matching mDNS service's instance
//                    name, for methods that find their device by name rather
//                    than address (Dante, NDI).
//   PortSettings,    Settings implied by which port, or which service type,
//   ServiceSettings  matched, keyed by port number / service type: the HTTP
//                    method serves both protocols, so port 443 means
//                    `Protocol: 'https'`.
export type { MonitoringMethodDiscovery };

export interface MonitoringMethod {
  ID: string;
  Name: string;
  // LAN discovery signature. When omitted the registry falls back to the central
  // map in ./discovery (then none: never suggested).
  Discovery?: MonitoringMethodDiscovery;
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
   * Choices for FromDevice 'list' settings (see MonitoringSettingOptions), derived
   * from a successful probe result. Must be pure and must never throw.
   */
  GetSettingOptions?(Result: MonitoringResult): MonitoringSettingOptions;
  /**
   * One-line description of an action WITH its parameters bound, used to label
   * a starred favourite: 'Set Input - Digital 1 (31)' rather than 'Set Input'.
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
  /**
   * Whether this check streams live levels (see StartLiveLevels), usually a
   * setting the operator turned on. Must be pure and must never throw.
   */
  HasLiveLevels?(Target: MonitoringTargetLike): boolean;
  /**
   * Start streaming live levels for a check while someone is watching its view.
   * OnFrame is called with the current state at a steady rate; the returned
   * function stops the stream. Never called unless HasLiveLevels said yes.
   */
  StartLiveLevels?(
    Target: MonitoringTargetLike,
    OnFrame: (Frame: LiveLevelsFrame) => void
  ): () => void;
  /**
   * The widget this check puts on its monitor's tile when it is the monitor's
   * only check, or null for the usual latency line. Result is the check's last
   * probe result (null before the first). Must be pure and must never throw.
   */
  GetTileWidget?(
    Target: MonitoringTargetLike,
    Result: MonitoringResult | null
  ): MonitoringTileWidget | null;
  /**
   * Move one live channel's fader or mute (a channel the frames mark Control).
   * Must resolve rather than throw for a refusal, with the reason.
   */
  SetLiveLevel?(
    Target: MonitoringTargetLike,
    ChannelID: string,
    Change: MonitorLiveLevelChange
  ): Promise<MonitorLiveLevelResult>;
  NormalizeSettings?(Input: unknown): Record<string, unknown>;
  GetRunCacheKeyExtra?(Target: MonitoringTargetLike, Settings: Record<string, unknown>): unknown;
  GetRunCacheTtlMs?(Target: MonitoringTargetLike): number;
  RunCacheTtlMs?: number;
  _internal?: unknown;
}
