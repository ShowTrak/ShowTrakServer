const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('AlertActions');

const ActionModules = [
  require('./osc-trigger'),
  require('./http-api'),
  require('./discord-webhook'),
];

const Actions = new Map();

for (const Mod of ActionModules) {
  if (!Mod || !Mod.ID) {
    Logger.warn('Skipping alert action with missing ID');
    continue;
  }
  Actions.set(Mod.ID, Mod);
}

function publicShape(Action) {
  return {
    ID: Action.ID,
    Name: Action.Name,
    Description: Action.Description || '',
    Settings: Array.isArray(Action.Settings) ? Action.Settings : [],
  };
}

const Manager = {};

Manager.GetAll = () => Array.from(Actions.values()).map(publicShape);

Manager.Get = (ID) => Actions.get(ID) || null;

Manager.Has = (ID) => Actions.has(ID);

Manager.NormalizeSettings = (ID, Input) => {
  const Action = Actions.get(ID);
  if (!Action) return {};

  if (typeof Action.NormalizeSettings === 'function') {
    return Action.NormalizeSettings(Input || {});
  }

  const out = {};
  const Schema = Array.isArray(Action.Settings) ? Action.Settings : [];
  const Source = Input && typeof Input === 'object' ? Input : {};
  for (const Field of Schema) {
    const Key = Field.Key;
    if (!Key) continue;
    let Value = Source[Key];
    if (Value === undefined || Value === null || Value === '') Value = Field.Default;
    if (Field.Type === 'number') {
      Value = Number(Value);
      if (!Number.isFinite(Value)) Value = Field.Default;
      if (typeof Field.Min === 'number' && Value < Field.Min) Value = Field.Min;
      if (typeof Field.Max === 'number' && Value > Field.Max) Value = Field.Max;
    } else if (Field.Type === 'boolean') {
      Value = !!Value;
    } else {
      Value = String(Value == null ? '' : Value);
    }
    out[Key] = Value;
  }
  return out;
};

Manager.ValidateSettings = (ID, Input) => {
  const Action = Actions.get(ID);
  if (!Action) throw new Error(`Unknown alert action: ${ID}`);
  const Normalized = Manager.NormalizeSettings(ID, Input);
  if (typeof Action.ValidateSettings === 'function') {
    Action.ValidateSettings(Normalized);
  }
  return Normalized;
};

Manager.Execute = async (ActionConfig, Context) => {
  const Type = ActionConfig && ActionConfig.Type ? ActionConfig.Type : null;
  const Action = Type ? Actions.get(Type) : null;
  if (!Action) return { Success: false, Error: `Unknown alert action: ${Type}` };

  try {
    const Normalized = Manager.ValidateSettings(Type, ActionConfig.Settings || {});
    const Prepared = {
      ...ActionConfig,
      Settings: Normalized,
    };
    return await Action.Execute(Prepared, Context, Logger.child(Type));
  } catch (Err) {
    return {
      Success: false,
      Error: Err && Err.message ? Err.message : String(Err),
    };
  }
};

module.exports = {
  Manager,
};
