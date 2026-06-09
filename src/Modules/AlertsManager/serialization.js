// Pure (de)serialization helpers for translating AlertRule database rows
// to/from the in-memory rule shape used by the AlertsManager.

function parseJson(Value, Fallback) {
  if (Value == null) return Fallback;
  if (typeof Value === 'object') return Value;
  try {
    const Parsed = JSON.parse(Value);
    return Parsed == null ? Fallback : Parsed;
  } catch {
    return Fallback;
  }
}

function normalizeRuleRow(Row) {
  return {
    RuleID: Row.RuleID,
    Title: Row.Title || '',
    Scope: parseJson(Row.Scope, {
      Workspace: false,
      Groups: [],
      Clients: [],
    }),
    TriggerType: Row.TriggerType,
    TriggerConfig: parseJson(Row.TriggerConfig, {}),
    Actions: parseJson(Row.Actions, []),
    Enabled: !!Row.Enabled,
    Timestamp: Row.Timestamp,
    UpdatedAt: Row.UpdatedAt,
  };
}

function toRowScope(Scope) {
  return JSON.stringify({
    Workspace: !!Scope.Workspace,
    Groups: Array.isArray(Scope.Groups) ? Scope.Groups : [],
    Clients: Array.isArray(Scope.Clients) ? Scope.Clients : [],
  });
}

function toRowActions(Actions) {
  return JSON.stringify(Array.isArray(Actions) ? Actions : []);
}

function toRowTriggerConfig(Config) {
  return JSON.stringify(Config && typeof Config === 'object' ? Config : {});
}

module.exports = {
  parseJson,
  normalizeRuleRow,
  toRowScope,
  toRowActions,
  toRowTriggerConfig,
};
