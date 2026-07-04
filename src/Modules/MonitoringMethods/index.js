// MonitoringMethods registry.
// Each method is a self-contained module that describes its UI-facing schema
// and provides a Run() implementation. New methods are added by dropping a new
// file into this folder and adding it to the require list below.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('MonitoringMethods');
const { Manager: CacheManager } = require('../CacheManager');

const Manager = {};
const RUN_CACHE = CacheManager.GetBucket('MonitoringMethods:Run', {
  defaultTtlMs: 1000,
  maxEntries: 2000,
});

const MethodModules = [
  require('./ping'),
  require('./tcp-port'),
  require('./http'),
  require('./http-json'),
  require('./dns'),
  require('./qlab-workspace'),
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

function stableStringify(Value) {
  if (Value == null) return 'null';
  if (typeof Value !== 'object') return JSON.stringify(Value);
  if (Array.isArray(Value)) {
    return `[${Value.map((Item) => stableStringify(Item)).join(',')}]`;
  }
  const Keys = Object.keys(Value).sort();
  return `{${Keys.map((Key) => `${JSON.stringify(Key)}:${stableStringify(Value[Key])}`).join(',')}}`;
}

function normalizeAddress(Target) {
  return String((Target && Target.Address) || '')
    .trim()
    .toLowerCase();
}

function getMethodRunCacheKey(ID, Method, Target) {
  const Address = normalizeAddress(Target);
  const Settings = Manager.NormalizeSettings(ID, (Target && Target.Settings) || {});

  // Allow methods to contribute additional key parts when they use extra
  // target properties beyond Address/Settings.
  const Extra =
    Method && typeof Method.GetRunCacheKeyExtra === 'function'
      ? Method.GetRunCacheKeyExtra(Target, Settings)
      : null;

  return stableStringify({ ID, Address, Settings, Extra });
}

function getMethodRunCacheTtlMs(Method, Target) {
  const DefaultTtl = 1000;
  if (!Method) return DefaultTtl;
  if (typeof Method.GetRunCacheTtlMs === 'function') {
    const Value = Number(Method.GetRunCacheTtlMs(Target));
    return Number.isFinite(Value) ? Math.max(0, Value | 0) : DefaultTtl;
  }
  if (Number.isFinite(Method.RunCacheTtlMs)) {
    return Math.max(0, Method.RunCacheTtlMs | 0);
  }
  return DefaultTtl;
}

Manager.GetAll = () => Array.from(Methods.values()).map(PublicShape);

Manager.Get = (ID) => Methods.get(ID) || null;

Manager.Has = (ID) => Methods.has(ID);

// Apply schema defaults to whatever the user submitted.
Manager.NormalizeSettings = (ID, Input) => {
  const Method = Methods.get(ID);
  if (!Method) return {};
  
  // Allow methods to apply custom normalization logic
  let MethodNormalized = Input;
  if (typeof Method.NormalizeSettings === 'function') {
    MethodNormalized = Method.NormalizeSettings(Input);
  }
  
  const out = {};
  const Schema = Array.isArray(Method.Settings) ? Method.Settings : [];
  const Source = MethodNormalized && typeof MethodNormalized === 'object' ? MethodNormalized : {};
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
    } else if (Field.Type === 'select') {
      // For select fields, validate against options
      const Options = Field.Options || [];
      const ValidValues = Options.map((o) => (typeof o === 'object' ? o.value : o));
      Value = ValidValues.includes(Value) ? Value : Field.Default;
      Value = String(Value);
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

  const CacheKey = getMethodRunCacheKey(ID, Method, Target);
  const CacheTtlMs = getMethodRunCacheTtlMs(Method, Target);
  try {
    return await RUN_CACHE.GetOrCreate(
      CacheKey,
      () => Method.Run(Target),
      { ttlMs: CacheTtlMs }
    );
  } catch (Err) {
    return { Success: false, Error: Err && Err.message ? Err.message : String(Err) };
  }
};

// Build the HTML "last response" debug panel for a check. Each method may
// expose an optional Debug(Result, Target) returning an HTML string; the method
// is responsible for escaping any untrusted values it embeds. Returns null when
// the method provides no debug view or rendering fails.
Manager.BuildDebug = (ID, Result, Target) => {
  const Method = Methods.get(ID);
  if (!Method || typeof Method.Debug !== 'function') return null;
  try {
    const Html = Method.Debug(Result, Target);
    return typeof Html === 'string' && Html.length ? Html : null;
  } catch (Err) {
    Logger.warn(`Debug renderer failed for method ${ID}: ${Err && Err.message ? Err.message : Err}`);
    return null;
  }
};

module.exports = { Manager };
