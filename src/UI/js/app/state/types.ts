// Local UI working-state shapes (transient editor/modal state that never crosses
// the wire, so they live here rather than in the shared protocol package).
// Extracted from the old monolithic state.ts when it was partitioned into
// this state/ folder; re-exported through the state barrel unchanged.
import type { HistorySample } from '@showtrak/protocol';

/** One check row inside the monitoring-target editor draft. */
export interface MonitoringEditorCheck {
  CheckID?: number | null;
  Name: string;
  Address: string;
  Method: string;
  Settings: Record<string, unknown>;
  DegradedThresholdMs: number;
}

/** Working draft backing the multi-check monitoring-target editor modal. */
export interface MonitoringEditorStateShape {
  TargetID: number | null;
  Nickname: string;
  Interval: number;
  GroupID: number | null;
  // Current slug in the editor plus the slug loaded from the target, so autosave
  // only sends Slug when the operator actually changed it. Empty for a new target
  // (the server generates one on create).
  Slug: string;
  OriginalSlug: string;
  Checks: MonitoringEditorCheck[];
  View: string;
  EditingIndex: number | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: boolean;
  pendingSave: boolean;
}

/** One series row in the history modal (checks, clients, apps, USB, displays). */
export interface MonitorHistorySeriesEntry {
  samples: HistorySample[];
  checkID?: number;
  dummy?: boolean;
  client?: boolean;
  applicationKey?: string;
  applicationName?: string;
  usbSerial?: string;
  usbName?: string;
  displayID?: string;
  displayName?: string;
}

/** Identifies which entity the history modal is currently showing. */
export interface MonitorHistoryModalContextShape {
  id: string | number;
  type: string;
}

/** Last pointer position over a timeline block, kept across re-renders. */
export interface MonitorHistoryTooltipHoverShape {
  x: number;
  y: number;
}

/** A selectable entity (client, monitor, check, dummy) in the alert scope tree. */
export interface AlertScopeEntity {
  Kind: string;
  Value: string;
  ScopedID: string;
  GroupID: number | null;
  Label: string;
  IconClass: string;
  Weight: number;
}

/** A group node in the alert scope tree, holding its child entities. */
export interface AlertScopeGroupNode {
  Kind: 'group';
  Value: string;
  GroupID: number;
  Label: string;
  Children: AlertScopeEntity[];
  ChildValues: string[];
}

/**
 * A tag node in the scope tree.
 *
 * Unlike a group, a tag carries no fixed child list: its membership is itself a
 * scope (and may name further tags), so it is offered as a single selectable
 * row and resolved — recursively — only when something needs the entities.
 */
export interface AlertScopeTagNode {
  Kind: 'tag';
  Value: string;
  TagID: number;
  Label: string;
  IconClass: string;
  ColourHex: string;
}

/** Full model built by `buildScopeModel()`, backing the scope picker. */
export interface AlertScopeModel {
  Workspace: { Kind: 'workspace'; Value: string; Label: string };
  Tags: AlertScopeTagNode[];
  Groups: AlertScopeGroupNode[];
  Ungrouped: AlertScopeEntity[];
  AllClientValues: string[];
  AllClientValueSet: Set<string>;
  LabelByValue: Map<string, string>;
}
