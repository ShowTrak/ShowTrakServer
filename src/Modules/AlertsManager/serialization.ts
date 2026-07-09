// Pure (de)serialization helpers for translating AlertRule database rows
// to/from the in-memory rule shape used by the AlertsManager.
import type { AlertRuleView, AlertRuleScope, AlertRuleActionView } from '@showtrak/protocol';

// The persisted/derived row shape consumed by normalizeRuleRow. Rows come either
// from the AlertRules table (JSON columns as strings) or from freshly-built
// Create rows (JSON already serialized), so the JSON-bearing fields are accepted
// as `unknown` and re-parsed defensively.
interface AlertRuleRowInput {
  RuleID: number;
  Title?: string | null;
  Scope?: unknown;
  TriggerType: string;
  TriggerConfig?: unknown;
  Actions?: unknown;
  Enabled?: unknown;
  Timestamp: number;
  UpdatedAt: number;
}

function parseJson<T>(Value: unknown, Fallback: T): T {
  if (Value == null) return Fallback;
  if (typeof Value === 'object') return Value as T;
  try {
    const Parsed = JSON.parse(Value as string);
    return (Parsed == null ? Fallback : Parsed) as T;
  } catch {
    return Fallback;
  }
}

function normalizeRuleRow(Row: AlertRuleRowInput): AlertRuleView {
  return {
    RuleID: Row.RuleID,
    Title: Row.Title || '',
    Scope: parseJson<AlertRuleScope>(Row.Scope, {
      Workspace: false,
      Groups: [],
      Clients: [],
    }),
    TriggerType: Row.TriggerType,
    TriggerConfig: parseJson<Record<string, unknown>>(Row.TriggerConfig, {}),
    Actions: parseJson<AlertRuleActionView[]>(Row.Actions, []),
    Enabled: !!Row.Enabled,
    Timestamp: Row.Timestamp,
    UpdatedAt: Row.UpdatedAt,
  };
}

function toRowScope(Scope: { Workspace?: unknown; Groups?: unknown; Clients?: unknown }): string {
  return JSON.stringify({
    Workspace: !!Scope.Workspace,
    Groups: Array.isArray(Scope.Groups) ? Scope.Groups : [],
    Clients: Array.isArray(Scope.Clients) ? Scope.Clients : [],
  });
}

function toRowActions(Actions: unknown): string {
  return JSON.stringify(Array.isArray(Actions) ? Actions : []);
}

function toRowTriggerConfig(Config: unknown): string {
  return JSON.stringify(Config && typeof Config === 'object' ? Config : {});
}

export { parseJson, normalizeRuleRow, toRowScope, toRowActions, toRowTriggerConfig };
