import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';
import { OSC_PORT } from '../Config/constants';

const { Client, Message } = require('node-osc');

// Minimal surface of the node-osc client used below (node-osc ships no types).
interface OscClient {
  send(message: unknown, callback: () => void): void;
  close(): void;
}

const ID = 'osc-trigger';

const Settings: AlertActionSettingField[] = [
  { Key: 'TargetIP', Label: 'Target IP / Hostname', Type: 'string', Default: '127.0.0.1' },
  { Key: 'Port', Label: 'Port', Type: 'number', Default: OSC_PORT, Min: 1, Max: 65535 },
  { Key: 'Message', Label: 'OSC Message Path', Type: 'string', Default: '/API/Alert' },
];

function interpolate(Input: unknown, Context: AlertContext): string {
  const Source = String(Input == null ? '' : Input);
  const Tokens: Record<string, string> = {
    triggerType: Context && Context.TriggerType ? (Context.TriggerType as string) : '',
    entityName: Context && Context.EntityName ? (Context.EntityName as string) : '',
    severity: Context && Context.Severity ? (Context.Severity as string) : '',
    ip: Context && Context.IP ? (Context.IP as string) : '',
    uuid: Context && Context.UUID ? (Context.UUID as string) : '',
    groupId: Context && Context.GroupID != null ? String(Context.GroupID) : '',
  };

  return Source.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key) =>
    Object.prototype.hasOwnProperty.call(Tokens, key) ? (Tokens[key] ?? '') : ''
  );
}

function NormalizeSettings(Input: unknown): { TargetIP: string; Port: number; Message: string } {
  const Next = (Input && typeof Input === 'object' ? Input : {}) as Record<string, unknown>;
  const Port = Number(Next.Port);
  return {
    TargetIP: String(Next.TargetIP || '127.0.0.1').trim(),
    Port: Number.isFinite(Port) ? Math.max(1, Math.min(65535, Math.round(Port))) : OSC_PORT,
    Message: String(Next.Message || '/API/Alert').trim() || '/API/Alert',
  };
}

function ValidateSettings(SettingsInput: unknown): boolean {
  const S = NormalizeSettings(SettingsInput);
  if (!S.TargetIP) throw new Error('TargetIP is required');
  if (!S.Message.startsWith('/')) throw new Error('Message must start with "/"');
  return true;
}

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});
  const MsgPath = interpolate(S.Message, Context);

  return new Promise<AlertActionResult>((resolve) => {
    let ClientRef: OscClient | undefined;
    try {
      const Connection: OscClient = new Client(S.TargetIP, S.Port);
      ClientRef = Connection;
      const MessageRef = new Message(MsgPath);
      Connection.send(MessageRef, () => {
        try {
          Connection.close();
        } catch (_closeErr) {
          void 0;
        }
        Logger.info(`OSC alert sent to ${S.TargetIP}:${S.Port} (${MsgPath})`);
        resolve({ Success: true });
      });
    } catch (Err) {
      try {
        if (ClientRef) ClientRef.close();
      } catch (_closeErr) {
        void 0;
      }
      resolve({
        Success: false,
        Error: Err && (Err as Error).message ? (Err as Error).message : String(Err),
      });
    }
  });
}

export const Name = 'OSC Trigger';
export const Description = 'Sends an OSC message route/path to a remote endpoint.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
