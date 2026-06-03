// MonitoringMethods registry.
// Each method is a self-contained module that describes its UI-facing schema
// and provides a Run() implementation. New methods are added by dropping a new
// file into this folder and adding it to the require list below.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('MonitoringMethods');

const Manager = {};

const MethodModules = [
  require('./ping'),
  require('./tcp-port'),
  require('./http'),
  require('./https'),
  require('./http-json'),
  require('./dns'),
];

const Methods = new Map();

for (const Mod of MethodModules) {
  if (!Mod || !Mod.ID) {
    Logger.warn('Skipping monitoring method with missing ID');
    continue;
  }
  Methods.set(Mod.ID, Mod);
}

// Strip the Run() implementation; the renderer only needs the schema.
function PublicShape(Method) {
  return {
    ID: Method.ID,
    Name: Method.Name,
    Description: Method.Description || '',
    Settings: Array.isArray(Method.Settings) ? Method.Settings : [],
    DefaultInterval: Method.DefaultInterval || 30000,
  };
}

Manager.GetAll = () => Array.from(Methods.values()).map(PublicShape);

Manager.Get = (ID) => Methods.get(ID) || null;

Manager.Has = (ID) => Methods.has(ID);

// Apply schema defaults to whatever the user submitted.
Manager.NormalizeSettings = (ID, Input) => {
  const Method = Methods.get(ID);
  if (!Method) return {};
  const out = {};
  const Schema = Array.isArray(Method.Settings) ? Method.Settings : [];
  const Source = Input && typeof Input === 'object' ? Input : {};
  for (const Field of Schema) {
    const Key = Field.Key;
    if (!Key) continue;
    let Value = Source[Key];
    if (Value === undefined || Value === null || Value === '') {
      Value = Field.Default;
    }
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

Manager.Run = async (ID, Target) => {
  const Method = Methods.get(ID);
  if (!Method) return { Success: false, Error: `Unknown monitoring method: ${ID}` };
  try {
    return await Method.Run(Target);
  } catch (Err) {
    return { Success: false, Error: Err && Err.message ? Err.message : String(Err) };
  }
};

module.exports = { Manager };
