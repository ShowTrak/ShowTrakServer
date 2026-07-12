// MonitoringMethods registry.
// Each method is a self-contained module that describes its UI-facing schema
// and provides a Run() implementation. New methods are added by dropping a new
// file into this folder and adding it to the require list below.
import { CreateLogger } from '../Logger';
import { Manager as CacheManager } from '../CacheManager';
import { MethodInfo } from './info';
import type { MonitoringMethod, MonitoringResult, MonitoringTargetLike } from './types';

const Logger = CreateLogger('MonitoringMethods');

const RUN_CACHE = CacheManager.GetBucket('MonitoringMethods:Run', {
  defaultTtlMs: 1000,
  maxEntries: 2000,
});

const MethodModules: MonitoringMethod[] = [
  require('./ping'),
  require('./tcp-port'),
  require('./http'),
  require('./http-json'),
  require('./dns'),
  require('./qlab-workspace'),
  require('./sacn-universe'),
  require('./sacn-universe-priority'),
  require('./artnet-universe'),
  require('./ndi-source'),
  require('./mqtt-topic'),
  require('./nut-ups'),
  require('./watchout-status'),
  require('./resolume-status'),
  require('./companion-status'),
  require('./disguise-status'),
  require('./millumin-status'),
];

const Methods = new Map<string, MonitoringMethod>();

for (const Mod of MethodModules) {
  if (!Mod || !Mod.ID) {
    Logger.warn('Skipping monitoring method with missing ID');
    continue;
  }
  Methods.set(Mod.ID, Mod);
}

// Strip the Run() implementation; the renderer only needs the schema.
function PublicShape(Method: MonitoringMethod) {
  return {
    ID: Method.ID,
    Name: Method.Name,
    Description: Method.Description || '',
    Info: Method.Info || MethodInfo[Method.ID] || null,
    Settings: Array.isArray(Method.Settings) ? Method.Settings : [],
    DefaultInterval: Method.DefaultInterval || 30000,
    // Capability flags default to true; a method opts out by exporting `false`.
    // The editor uses these to hide the Address / Degraded Threshold fields.
    UsesAddress: Method.UsesAddress !== false,
    SupportsLatencyThreshold: Method.SupportsLatencyThreshold !== false,
  };
}

function stableStringify(Value: unknown): string {
  if (Value == null) return 'null';
  if (typeof Value !== 'object') return JSON.stringify(Value);
  if (Array.isArray(Value)) {
    return `[${Value.map((Item) => stableStringify(Item)).join(',')}]`;
  }
  const Obj = Value as Record<string, unknown>;
  const Keys = Object.keys(Obj).sort();
  return `{${Keys.map((Key) => `${JSON.stringify(Key)}:${stableStringify(Obj[Key])}`).join(',')}}`;
}

function normalizeAddress(Target: MonitoringTargetLike | undefined): string {
  return String((Target && Target.Address) || '')
    .trim()
    .toLowerCase();
}

function getMethodRunCacheKey(
  ID: string,
  Method: MonitoringMethod,
  Target: MonitoringTargetLike
): string {
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

function getMethodRunCacheTtlMs(Method: MonitoringMethod, Target: MonitoringTargetLike): number {
  const DefaultTtl = 1000;
  if (!Method) return DefaultTtl;
  if (typeof Method.GetRunCacheTtlMs === 'function') {
    const Value = Number(Method.GetRunCacheTtlMs(Target));
    return Number.isFinite(Value) ? Math.max(0, Value | 0) : DefaultTtl;
  }
  if (Number.isFinite(Method.RunCacheTtlMs)) {
    return Math.max(0, (Method.RunCacheTtlMs as number) | 0);
  }
  return DefaultTtl;
}

const Manager = {
  GetAll: () => Array.from(Methods.values()).map(PublicShape),

  Get: (ID: string): MonitoringMethod | null => Methods.get(ID) || null,

  Has: (ID: string): boolean => Methods.has(ID),

  // Apply schema defaults to whatever the user submitted.
  NormalizeSettings: (ID: string, Input: unknown): Record<string, unknown> => {
    const Method = Methods.get(ID);
    if (!Method) return {};

    // Allow methods to apply custom normalization logic
    let MethodNormalized: unknown = Input;
    if (typeof Method.NormalizeSettings === 'function') {
      MethodNormalized = Method.NormalizeSettings(Input);
    }

    const out: Record<string, unknown> = {};
    const Schema = Array.isArray(Method.Settings) ? Method.Settings : [];
    const Source: Record<string, unknown> =
      MethodNormalized && typeof MethodNormalized === 'object'
        ? (MethodNormalized as Record<string, unknown>)
        : {};
    for (const Field of Schema) {
      const Key = Field.Key;
      if (!Key) continue;
      let Value: unknown = Source[Key];
      if (Value === undefined || Value === null || Value === '') {
        Value = Field.Default;
      }
      if (Field.Type === 'number') {
        Value = Number(Value);
        if (!Number.isFinite(Value)) Value = Field.Default;
        if (typeof Field.Min === 'number' && (Value as number) < Field.Min) Value = Field.Min;
        if (typeof Field.Max === 'number' && (Value as number) > Field.Max) Value = Field.Max;
      } else if (Field.Type === 'boolean') {
        Value = !!Value;
      } else if (Field.Type === 'select') {
        // For select fields, validate against options
        const Options = Field.Options || [];
        const ValidValues = Options.map((o) => (typeof o === 'object' ? o.value : o));
        Value = ValidValues.includes(Value as string) ? Value : Field.Default;
        Value = String(Value);
      } else {
        Value = String(Value == null ? '' : Value);
      }
      out[Key] = Value;
    }
    return out;
  },

  Run: async (ID: string, Target: MonitoringTargetLike): Promise<MonitoringResult> => {
    const Method = Methods.get(ID);
    if (!Method) return { Success: false, Error: `Unknown monitoring method: ${ID}` };

    const CacheKey = getMethodRunCacheKey(ID, Method, Target);
    const CacheTtlMs = getMethodRunCacheTtlMs(Method, Target);
    try {
      return (await RUN_CACHE.GetOrCreate(CacheKey, () => Method.Run(Target), {
        ttlMs: CacheTtlMs,
      })) as MonitoringResult;
    } catch (Err) {
      return { Success: false, Error: Err && (Err as Error).message ? (Err as Error).message : String(Err) };
    }
  },

  // Build the HTML "last response" debug panel for a check. Each method may
  // expose an optional Debug(Result, Target) returning an HTML string; the method
  // is responsible for escaping any untrusted values it embeds. Returns null when
  // the method provides no debug view or rendering fails.
  BuildDebug: (ID: string, Result: MonitoringResult, Target: MonitoringTargetLike): string | null => {
    const Method = Methods.get(ID);
    if (!Method || typeof Method.Debug !== 'function') return null;
    try {
      const Html = Method.Debug(Result, Target);
      return typeof Html === 'string' && Html.length ? Html : null;
    } catch (Err) {
      Logger.warn(
        `Debug renderer failed for method ${ID}: ${Err && (Err as Error).message ? (Err as Error).message : Err}`
      );
      return null;
    }
  },
};

export { Manager };
