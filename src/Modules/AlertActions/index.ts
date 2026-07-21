import { CreateLogger } from '../Logger';
import type { AlertAction, AlertActionInput, AlertActionResult, AlertContext } from './types';

const Logger = CreateLogger('AlertActions');

const ActionModules: AlertAction[] = [
  require('./showtrak-alert'),
  require('./play-sound'),
  require('./play-custom-audio'),
  require('./osc-trigger'),
  require('./http-api'),
  require('./discord-webhook'),
  require('./slack-webhook'),
  require('./teams-webhook'),
  require('./telegram-bot'),
];

const Actions = new Map<string, AlertAction>();

for (const Mod of ActionModules) {
  if (!Mod || !Mod.ID) {
    Logger.warn('Skipping alert action with missing ID');
    continue;
  }
  Actions.set(Mod.ID, Mod);
}

function publicShape(Action: AlertAction) {
  return {
    ID: Action.ID,
    Name: Action.Name,
    Description: Action.Description || '',
    Settings: Array.isArray(Action.Settings) ? Action.Settings : [],
  };
}

const Manager = {
  GetAll: () => Array.from(Actions.values()).map(publicShape),

  Get: (ID: string): AlertAction | null => Actions.get(ID) || null,

  Has: (ID: string): boolean => Actions.has(ID),

  NormalizeSettings: (ID: string, Input: unknown): Record<string, unknown> => {
    const Action = Actions.get(ID);
    if (!Action) return {};

    if (typeof Action.NormalizeSettings === 'function') {
      return Action.NormalizeSettings(Input || {});
    }

    const out: Record<string, unknown> = {};
    const Schema = Array.isArray(Action.Settings) ? Action.Settings : [];
    const Source: Record<string, unknown> =
      Input && typeof Input === 'object' ? (Input as Record<string, unknown>) : {};
    for (const Field of Schema) {
      const Key = Field.Key;
      if (!Key) continue;
      let Value: unknown = Source[Key];
      if (Value === undefined || Value === null || Value === '') Value = Field.Default;
      if (Field.Type === 'number') {
        Value = Number(Value);
        if (!Number.isFinite(Value)) Value = Field.Default;
        if (typeof Field.Min === 'number' && (Value as number) < Field.Min) Value = Field.Min;
        if (typeof Field.Max === 'number' && (Value as number) > Field.Max) Value = Field.Max;
      } else if (Field.Type === 'boolean') {
        Value = !!Value;
      } else {
        Value = String(Value == null ? '' : Value);
      }
      out[Key] = Value;
    }
    return out;
  },

  ValidateSettings: (ID: string, Input: unknown): Record<string, unknown> => {
    const Action = Actions.get(ID);
    if (!Action) throw new Error(`Unknown alert action: ${ID}`);
    const Normalized = Manager.NormalizeSettings(ID, Input);
    if (typeof Action.ValidateSettings === 'function') {
      Action.ValidateSettings(Normalized);
    }
    return Normalized;
  },

  Execute: async (
    ActionConfig: AlertActionInput,
    Context: AlertContext
  ): Promise<AlertActionResult> => {
    const Type = ActionConfig && ActionConfig.Type ? ActionConfig.Type : null;
    const Action = Type ? Actions.get(Type) : null;
    if (!Action || !Type) return { Success: false, Error: `Unknown alert action: ${Type}` };

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
        Error: Err && (Err as Error).message ? (Err as Error).message : String(Err),
      };
    }
  },
};

export { Manager };
