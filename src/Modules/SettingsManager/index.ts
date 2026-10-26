// SettingsManager
// - Loads default settings and merges persisted overrides from DB (or, for
//   install-scoped settings, from the install-level store)
// - Coerces types on read/write to keep a consistent shape across the app
// - Emits 'SettingsUpdated' and optional per-setting events on change
import { CreateLogger } from '../Logger';
import { DefaultSettings, Groups } from './DefaultSettings';
import type { SettingDefinition, SettingGroup, SettingValue } from './DefaultSettings';
import { Manager as BroadcastManager } from '../Broadcast';
import { Manager as DB } from '../DB';
import { CreateSettingsRepository } from '../DB/repositories/settings';
import { CreateInstallSettingsStore } from './install-settings';
import { RecordEdit } from '../AuditLog/edits';
import { Line, Value as AuditValue } from '../AuditLog/message';
import { FormatValue } from '../AuditLog/diff';
import { CurrentAuditSource } from '../AuditLog/source';
import { AuditStep, Seconds } from '../Shared/audit-names';

const Logger = CreateLogger('Settings');

// Secrets whose values must never reach a log line: the log file is what an
// operator sends back when asked, and the log console streams to the Web UI.
// PASSWORD-typed settings are secret by definition; these two are typed STRING
// because the settings modal shows them in the clear on purpose.
const SECRET_SETTING_KEYS = new Set(['WEBUI_PASSWORD', 'SDK_API_KEY']);

const SettingsRepo = CreateSettingsRepository(DB);
const InstallSettingsStore = CreateInstallSettingsStore();

// Install-scoped settings persist outside the show file; everything else is
// stored in the open show's database.
function StoreFor(Setting: { Scope?: SettingDefinition['Scope'] | null }) {
  return Setting.Scope === 'INSTALL' ? InstallSettingsStore : SettingsRepo;
}

// Runtime, cached representation of a single setting.
interface Setting {
  Group: string;
  Key: string;
  Title: string;
  Description: string;
  Type: SettingDefinition['Type'];
  Value: SettingValue;
  isDefault: boolean;
  DefaultValue: SettingValue;
  OnUpdateEvent: string | null;
  Options: string[] | null;
  Min: number | null;
  Max: number | null;
  Unit: string | null;
  Scope: SettingDefinition['Scope'] | null;
  ShowWhen: string[] | null;
}

interface SettingsManagerShape {
  Initialized: boolean;
  Initializing: Promise<void> | null;
  Init(): Promise<void>;
  GetGroups(): Promise<SettingGroup[]>;
  GetAll(): Promise<Setting[]>;
  GetValue(Key: string): Promise<SettingValue | null>;
  Get(Key: string): Promise<Setting | undefined>;
  Set(Key: string, Value: unknown): Promise<[string | null, Setting | null]>;
  Reload(): Promise<void>;
}

// In-memory cache keyed by setting.Key -> setting object
const Settings = new Map<string, Setting>();

// Clamp an integer into a setting's optional [Min, Max] bounds.
function ClampInteger(
  Setting: { Min?: number | null; Max?: number | null },
  Value: number
): number {
  let Result = Value;
  if (typeof Setting.Min === 'number' && Number.isFinite(Setting.Min) && Result < Setting.Min) {
    Result = Setting.Min;
  }
  if (typeof Setting.Max === 'number' && Number.isFinite(Setting.Max) && Result > Setting.Max) {
    Result = Setting.Max;
  }
  return Result;
}

function SettingValueText(Setting: Setting, Value: SettingValue): string | null {
  const Text = FormatValue(Value);
  if (Text === null || !Setting.Unit || typeof Value !== 'number') return Text;
  if (Setting.Unit === 's') return Seconds(Value);
  return Setting.Unit === '%' ? `${Text}%` : `${Text} ${Setting.Unit}`;
}

// A change made from a surface (Desktop, Web UI, SDK…). One with no surface is
// ShowTrak's own doing — generating the SDK key on first start — not an edit.
function RecordSettingChange(Setting: Setting, Previous: SettingValue, IsSecret: boolean) {
  if (!CurrentAuditSource()) return Promise.resolve();
  return AuditStep(() =>
    RecordEdit({
      EntityType: 'system',
      EntityID: null,
      Summary: Line('Changed setting ', AuditValue(Setting.Title || Setting.Key)),
      Changes: [
        IsSecret
          ? { Field: Setting.Title || Setting.Key, From: null, To: 'Changed' }
          : {
              Field: Setting.Title || Setting.Key,
              From: SettingValueText(Setting, Previous),
              To: SettingValueText(Setting, Setting.Value),
            },
      ],
    })
  );
}

function ApplySettingRules(
  Setting: { Key?: string } | null | undefined,
  Value: unknown
): [string | null, SettingValue] {
  if (!Setting || !Setting.Key) return [null, Value as SettingValue];

  if (Setting.Key === 'WEBUI_PASSWORD') {
    const Normalized = String(Value == null ? '' : Value)
      .replace(/\D/g, '')
      .slice(0, 4);
    if (Normalized !== '' && !/^\d{4}$/.test(Normalized)) {
      return ['WEBUI_PASSWORD must be exactly 4 digits', ''];
    }
    return [null, Normalized];
  }

  return [null, Value as SettingValue];
}

const Manager: SettingsManagerShape = {
  Initialized: false,
  Initializing: null,

  async Init(): Promise<void> {
    if (Manager.Initialized) return;
    if (Manager.Initializing) {
      await Manager.Initializing;
      return;
    }

    Manager.Initializing = (async () => {
      if (typeof DB.Ready === 'function') {
        await DB.Ready();
      }

      for (const Setting of DefaultSettings) {
        let [Err, ManualSetting] = await StoreFor(Setting).GetByKey(Setting.Key);
        if (Err) throw Err;

        // An install-scoped setting the install store has never seen used to be
        // stored per show file. Adopt the open show's value once (or the default)
        // and record it, so later show swaps never seed it again.
        if (Setting.Scope === 'INSTALL' && !ManualSetting) {
          [Err, ManualSetting] = await SettingsRepo.GetByKey(Setting.Key);
          if (Err) throw Err;
          const [SeedErr] = await InstallSettingsStore.Upsert(
            Setting.Key,
            ManualSetting ? ManualSetting.Value : Setting.DefaultValue
          );
          if (SeedErr)
            Logger.error(`Failed to migrate ${Setting.Key} to install settings:`, SeedErr);
        }

        // Normalize value based on type so persisted strings/ints map to the declared Setting.Type
        const normalize = (val: unknown): SettingValue => {
          switch (Setting.Type) {
            case 'BOOLEAN': {
              if (typeof val === 'boolean') return val;
              if (val === 1 || val === '1' || val === 'true') return true;
              if (val === 0 || val === '0' || val === 'false') return false;
              return !!val;
            }
            case 'INTEGER':
            case 'SLIDER': {
              if (val === null || val === undefined || val === '') return Setting.DefaultValue;
              const n = parseInt(val as string, 10);
              return isNaN(n) ? Setting.DefaultValue : ClampInteger(Setting, n);
            }
            case 'STRING':
            case 'PASSWORD': {
              return val == null ? '' : String(val);
            }
            case 'OPTION': {
              if (Setting.Options && Array.isArray(Setting.Options)) {
                return typeof val === 'string' && Setting.Options.includes(val)
                  ? val
                  : Setting.DefaultValue;
              }
              return val as SettingValue;
            }
            default: {
              return val as SettingValue;
            }
          }
        };

        let EffectiveValue: SettingValue = ManualSetting
          ? normalize(ManualSetting.Value)
          : Setting.DefaultValue;
        const [RuleErr, RuleValue] = ApplySettingRules(Setting, EffectiveValue);
        if (RuleErr) {
          EffectiveValue = Setting.DefaultValue;
        } else {
          EffectiveValue = RuleValue;
        }

        const NewSetting: Setting = {
          Group: Setting.Group,
          Key: Setting.Key,
          Title: Setting.Title,
          Description: Setting.Description,
          Type: Setting.Type,
          Value: EffectiveValue,
          isDefault: ManualSetting ? EffectiveValue === Setting.DefaultValue : true,
          DefaultValue: Setting.DefaultValue,
          OnUpdateEvent: Setting.OnUpdateEvent || null,
          Options: Setting.Options || null,
          Min: typeof Setting.Min === 'number' ? Setting.Min : null,
          Max: typeof Setting.Max === 'number' ? Setting.Max : null,
          Unit: Setting.Unit || null,
          Scope: Setting.Scope || null,
          ShowWhen: Setting.ShowWhen || null,
        };

        Settings.set(NewSetting.Key, NewSetting);

        // Avoid log spam during boot; enable if you need verbose setting audits.
      }

      Manager.Initialized = true;
    })();

    try {
      await Manager.Initializing;
    } finally {
      Manager.Initializing = null;
    }
  },

  async GetGroups(): Promise<SettingGroup[]> {
    return Groups;
  },

  // Return a snapshot array; callers shouldn't mutate entries in-place.
  async GetAll(): Promise<Setting[]> {
    if (!Manager.Initialized) await Manager.Init();
    return Array.from(Settings.values());
  },

  // Get just the setting.Value; returns null for unknown keys.
  async GetValue(Key: string): Promise<SettingValue | null> {
    if (!Manager.Initialized) await Manager.Init();
    const Setting = Settings.get(Key);
    if (!Setting) return null;
    return Setting.Value;
  },

  async Get(Key: string): Promise<Setting | undefined> {
    if (!Manager.Initialized) await Manager.Init();
    return Settings.get(Key);
  },

  // Persist a change with strict type coercion and broadcast change events.
  async Set(Key: string, Value: unknown): Promise<[string | null, Setting | null]> {
    if (!Manager.Initialized) await Manager.Init();

    const Setting = Settings.get(Key);
    if (!Setting) return ['Invalid Setting Key', null];

    // Coerce incoming value to correct type
    const coerce = (val: unknown): SettingValue => {
      switch (Setting.Type) {
        case 'BOOLEAN': {
          if (typeof val === 'boolean') return val;
          if (val === 1 || val === '1' || val === 'true') return true;
          if (val === 0 || val === '0' || val === 'false') return false;
          return !!val;
        }
        case 'INTEGER':
        case 'SLIDER': {
          if (val === null || val === undefined || val === '') return Setting.DefaultValue;
          const n = parseInt(val as string, 10);
          return isNaN(n) ? Setting.DefaultValue : ClampInteger(Setting, n);
        }
        case 'STRING':
        case 'PASSWORD': {
          return val == null ? '' : String(val);
        }
        case 'OPTION': {
          if (Setting.Options && Array.isArray(Setting.Options)) {
            return typeof val === 'string' && Setting.Options.includes(val)
              ? val
              : Setting.DefaultValue;
          }
          return val as SettingValue;
        }
        default: {
          return val as SettingValue;
        }
      }
    };

    const CoercedValue = coerce(Value);

    const [RuleErr, NormalizedValue] = ApplySettingRules(Setting, CoercedValue);
    if (RuleErr) return [RuleErr, null];

    if (Setting.Value === NormalizedValue) return [null, Setting];

    const Previous = Setting.Value;
    Setting.Value = NormalizedValue;

    const [Err] = await StoreFor(Setting).Upsert(Key, Setting.Value);
    if (Err) return ['Error updating setting', null];

    Setting.isDefault = Setting.Value === Setting.DefaultValue;

    Settings.set(Key, Setting);

    const IsSecret = Setting.Type === 'PASSWORD' || SECRET_SETTING_KEYS.has(Key);
    Logger.log(`Setting ${Key} updated to ${IsSecret ? '(hidden)' : Value}`);
    await RecordSettingChange(Setting, Previous, IsSecret);

    BroadcastManager.emit('SettingsUpdated');

    // Fire optional feature-specific follow-up event (e.g., to start/stop services)
    if (Setting.OnUpdateEvent) BroadcastManager.emit(Setting.OnUpdateEvent);

    return [null, Setting];
  },

  // Rebuild in-memory settings cache from DB after external bulk writes.
  async Reload(): Promise<void> {
    Settings.clear();
    Manager.Initialized = false;
    Manager.Initializing = null;
    await Manager.Init();

    BroadcastManager.emit('SettingsUpdated');

    const Events = new Set<string>();
    for (const Setting of Settings.values()) {
      if (Setting && Setting.OnUpdateEvent) Events.add(Setting.OnUpdateEvent);
    }
    for (const EventName of Events) BroadcastManager.emit(EventName);
  },
};

Manager.Init().catch((Err) => {
  Logger.error('Failed to initialize settings manager:', Err);
});

export { Manager };
