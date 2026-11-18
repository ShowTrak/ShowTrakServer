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

// Actions that call out over the network, each of which can take its full
// timeout (5 s by default) against an unreachable host.
const OUTBOUND_ACTIONS = new Set([
  'http-api',
  'discord-webhook',
  'slack-webhook',
  'teams-webhook',
  'telegram-bot',
]);

// At most this many outbound actions are in flight at once; the rest wait their
// turn, first come first served. Alerts no longer wait on one another (see
// AlertsManager), so a burst (the settle sweep raising every client that was
// already offline at start-up) would otherwise open a connection per alert per
// webhook at the same moment. Local actions (in-app alerts, sounds, OSC) never
// wait for a slot.
const MAX_OUTBOUND_IN_FLIGHT = 16;
let OutboundInFlight = 0;
const OutboundQueue: Array<() => void> = [];

function AcquireOutboundSlot(): Promise<void> {
  if (OutboundInFlight < MAX_OUTBOUND_IN_FLIGHT) {
    OutboundInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => OutboundQueue.push(resolve));
}

// Hand the slot straight to the next waiter, so a new arrival can never slip in
// between and push the count over the limit.
function ReleaseOutboundSlot(): void {
  const Next = OutboundQueue.shift();
  if (Next) Next();
  else OutboundInFlight -= 1;
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
      if (!OUTBOUND_ACTIONS.has(Type)) {
        return await Action.Execute(Prepared, Context, Logger.child(Type));
      }
      await AcquireOutboundSlot();
      try {
        return await Action.Execute(Prepared, Context, Logger.child(Type));
      } finally {
        ReleaseOutboundSlot();
      }
    } catch (Err) {
      return {
        Success: false,
        Error: Err && (Err as Error).message ? (Err as Error).message : String(Err),
      };
    }
  },
};

export { Manager };
