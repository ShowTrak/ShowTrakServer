import { requestJson } from './_http-shared';
import type {
  ActionLogger,
  AlertActionInput,
  AlertActionResult,
  AlertActionSettingField,
  AlertContext,
} from './types';

const ID = 'http-api';

const Settings: AlertActionSettingField[] = [
  { Key: 'Protocol', Label: 'Protocol (http/https)', Type: 'string', Default: 'http' },
  { Key: 'TargetIP', Label: 'Target IP / Hostname', Type: 'string', Default: '127.0.0.1' },
  { Key: 'Port', Label: 'Port', Type: 'number', Default: 8080, Min: 1, Max: 65535 },
  { Key: 'Route', Label: 'Route', Type: 'string', Default: '/api/alerts' },
  { Key: 'Method', Label: 'Method', Type: 'string', Default: 'POST' },
  { Key: 'Timeout', Label: 'Timeout (ms)', Type: 'number', Default: 5000, Min: 250, Max: 60000 },
];

function NormalizeSettings(Input: unknown): {
  Protocol: string;
  TargetIP: string;
  Port: number;
  Route: string;
  Method: string;
  Timeout: number;
} {
  const Next = (Input && typeof Input === 'object' ? Input : {}) as Record<string, unknown>;
  const ProtocolRaw = String(Next.Protocol || 'http')
    .toLowerCase()
    .trim();
  const Protocol = ProtocolRaw === 'https' ? 'https' : 'http';
  const Port = Number(Next.Port);
  const Timeout = Number(Next.Timeout);
  const RouteRaw = String(Next.Route || '/api/alerts').trim();
  return {
    Protocol,
    TargetIP: String(Next.TargetIP || '127.0.0.1').trim(),
    Port: Number.isFinite(Port) ? Math.max(1, Math.min(65535, Math.round(Port))) : 8080,
    Route: RouteRaw.startsWith('/') ? RouteRaw : `/${RouteRaw}`,
    Method:
      String(Next.Method || 'POST')
        .toUpperCase()
        .trim() || 'POST',
    Timeout: Number.isFinite(Timeout) ? Math.max(250, Math.min(60000, Math.round(Timeout))) : 5000,
  };
}

function ValidateSettings(SettingsInput: unknown): boolean {
  const S = NormalizeSettings(SettingsInput);
  if (!S.TargetIP) throw new Error('TargetIP is required');
  if (!S.Route) throw new Error('Route is required');
  return true;
}

async function Execute(
  Action: AlertActionInput,
  Context: AlertContext,
  Logger: ActionLogger
): Promise<AlertActionResult> {
  const S = NormalizeSettings(Action && Action.Settings ? Action.Settings : {});
  const Url = `${S.Protocol}://${S.TargetIP}:${S.Port}${S.Route}`;
  const Response = await requestJson({
    Url,
    Method: S.Method,
    Timeout: S.Timeout,
    Body: {
      Event: 'ShowTrakAlert',
      TriggerType: Context.TriggerType,
      Timestamp: Date.now(),
      EntityType: Context.EntityType,
      EntityName: Context.EntityName,
      UUID: Context.UUID || null,
      GroupID: Context.GroupID == null ? null : Context.GroupID,
      IP: Context.IP || null,
      Severity: Context.Severity || 'info',
      Context,
    },
  });

  if (!Response.Success) {
    return {
      Success: false,
      Error: Response.Error || `HTTP ${Response.StatusCode}`,
    };
  }

  Logger.info(`HTTP alert action succeeded (${Url})`);
  return { Success: true, StatusCode: Response.StatusCode };
}

export const Name = 'HTTP/S API';
export const Description = 'POSTs alert context to an HTTP or HTTPS endpoint.';
export { ID, Settings, NormalizeSettings, ValidateSettings, Execute };
