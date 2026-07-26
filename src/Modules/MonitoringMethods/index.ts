// MonitoringMethods registry.
// Each method is a self-contained module that describes its UI-facing schema
// and provides a Run() implementation. New methods are added by dropping a new
// file into this folder, importing it below, and adding it to MethodModules.
//
// The imports are `import * as` rather than `require()` on purpose. `require()`
// returns `any`, so annotating the array as MonitoringMethod[] checked nothing:
// a method could rename Debug, change Run's signature or drop Settings entirely
// and still compile, failing only when a probe ran in production. A namespace
// import carries the module's real shape, so MethodModules now type-checks all
// of them against the contract in ./types.
import { CreateLogger } from '../Logger';
import { Manager as CacheManager } from '../CacheManager';
import { MethodInfo } from './info';
import { MethodGroups, DEFAULT_GROUP } from './groups';
import type { MonitoringMethod, MonitoringResult, MonitoringTargetLike } from './types';

// General
import * as ping from './ping';
import * as tcpPort from './tcp-port';
import * as http from './http';
import * as httpJson from './http-json';
import * as dns from './dns';
// Lighting (DMX)
import * as sacnUniverse from './sacn-universe';
import * as sacnUniversePriority from './sacn-universe-priority';
import * as artnetUniverse from './artnet-universe';
// Lighting consoles — ETC Eos (OSC)
import * as eos from './eos';
// Lighting consoles — MA Lighting grandMA2 (Telnet remote) & grandMA3 (liveness)
import * as ma2 from './ma2';
import * as ma3 from './ma3';
// Lighting consoles — Avolites Titan (WebAPI)
import * as avolites from './avolites';
// Lighting consoles — ChamSys MagicQ (web server)
import * as chamsys from './chamsys';
// Video
import * as ndiSource from './ndi-source';
// Sound — cue playback & audio networking
import * as qlab5 from './qlab5';
import * as qlab4 from './qlab4';
import * as danteDevice from './dante-device';
// Media Servers
import * as watchoutStatus from './watchout-status';
import * as resolumeStatus from './resolume-status';
import * as disguiseStatus from './disguise-status';
import * as milluminStatus from './millumin-status';
// Control & Messaging
import * as companionStatus from './companion-status';
import * as mqttTopic from './mqtt-topic';
// Digital Signage
import * as brightsign from './brightsign';
// Projectors
import * as pjlink from './pjlink';
import * as snmpProjector from './snmp-projector';
// Power (UPS)
import * as nutUps from './nut-ups';
import * as snmpUps from './snmp-ups';
import * as snmpUpsV3 from './snmp-ups-v3';

const Logger = CreateLogger('MonitoringMethods');

const RUN_CACHE = CacheManager.GetBucket('MonitoringMethods:Run', {
  defaultTtlMs: 1000,
  maxEntries: 2000,
});

// Ordered so methods sharing a Group (see ./groups) are contiguous, which keeps
// the editor's grouped method picker tidy.
const MethodModules: MonitoringMethod[] = [
  // General
  ping,
  tcpPort,
  http,
  httpJson,
  dns,
  // Lighting (DMX)
  sacnUniverse,
  sacnUniversePriority,
  artnetUniverse,
  // Lighting consoles — ETC Eos (OSC)
  eos,
  // Lighting consoles — MA Lighting grandMA2 (Telnet remote) & grandMA3 (liveness)
  ma2,
  ma3,
  // Lighting consoles — Avolites Titan (WebAPI)
  avolites,
  // Lighting consoles — ChamSys MagicQ (web server)
  chamsys,
  // Video
  ndiSource,
  // Sound — cue playback & audio networking
  qlab5,
  qlab4,
  danteDevice,
  // Media Servers
  watchoutStatus,
  resolumeStatus,
  disguiseStatus,
  milluminStatus,
  // Control & Messaging
  companionStatus,
  mqttTopic,
  // Digital Signage
  brightsign,
  // Projectors
  pjlink,
  snmpProjector,
  // Power (UPS)
  nutUps,
  snmpUps,
  snmpUpsV3,
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
    // Grouping label for the editor's method picker. A method may export its own
    // Group; otherwise the central map decides, falling back to "Other".
    Group: Method.Group || MethodGroups[Method.ID] || DEFAULT_GROUP,
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

function getMethodRunCacheKey(
  ID: string,
  Method: MonitoringMethod,
  Target: MonitoringTargetLike
): string {
  // The key MUST be a pure function of exactly what Method.Run() receives, so a
  // cache hit only ever replays a probe computed from identical inputs. Run()
  // reads Address and Settings straight off the target (raw), so we key on those
  // raw values — NOT a normalized/clamped view. Keying on a normalized view was
  // unsound: two targets that merely normalize alike (a timeout past the same
  // clamp bound, or an address differing only in case) would collide onto one
  // cached result even though Run() would probe them differently.
  const Address = String((Target && Target.Address) != null ? Target.Address : '');
  const Settings = (Target && Target.Settings) || {};

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
      // A 'list' field is an array; only fall back to the default when it is truly
      // absent (not for a legitimately empty array the user cleared).
      if (Field.Type === 'list') {
        const Raw = Array.isArray(Value)
          ? Value
          : Value === undefined || Value === null || Value === ''
            ? Array.isArray(Field.Default)
              ? Field.Default
              : []
            : [Value];
        const Seen = new Set<string>();
        const List: string[] = [];
        for (const Item of Raw as unknown[]) {
          let Entry = String(Item == null ? '' : Item).trim();
          if (Field.ItemType === 'number') {
            const N = Number(Entry);
            if (!Number.isFinite(N)) continue;
            Entry = String(N);
          }
          if (!Entry || Seen.has(Entry)) continue;
          Seen.add(Entry);
          List.push(Entry);
        }
        out[Key] = List;
        continue;
      }
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
    // A saved check whose method no longer exists (e.g. a removed/renamed method)
    // surfaces as Degraded rather than Offline, so the operator is alerted to fix
    // it instead of it silently reading as an outage.
    if (!Method) {
      return {
        Success: true,
        Degraded: true,
        DegradedReason: `Unknown method: ${ID}`,
        LatencyMs: null,
      };
    }

    const CacheKey = getMethodRunCacheKey(ID, Method, Target);
    const CacheTtlMs = getMethodRunCacheTtlMs(Method, Target);
    try {
      return (await RUN_CACHE.GetOrCreate(CacheKey, () => Method.Run(Target), {
        ttlMs: CacheTtlMs,
      })) as MonitoringResult;
    } catch (Err) {
      return {
        Success: false,
        Error: Err && (Err as Error).message ? (Err as Error).message : String(Err),
      };
    }
  },

  // Build the HTML "last response" debug panel for a check. Each method may
  // expose an optional Debug(Result, Target) returning an HTML string; the method
  // is responsible for escaping any untrusted values it embeds. Returns null when
  // the method provides no debug view or rendering fails.
  BuildDebug: (
    ID: string,
    Result: MonitoringResult,
    Target: MonitoringTargetLike
  ): string | null => {
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

export { Manager, getMethodRunCacheKey };
