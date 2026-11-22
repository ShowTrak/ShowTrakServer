// Clear-Com FreeSpeak II base station check (FSII-BASE-II).
//
// The base's CCM web UI reads JSON from the base itself over plain HTTP on
// port 80, with no authentication. Clear-Com publishes no specification for
// it; the resources and fields below are the ones Bitfocus Companion's
// companion-module-clearcom-freespeakii reads from a real base (src/api.ts,
// src/types.ts, src/resolve.ts):
//
//   GET /api/1/devices/<id>/liveStatus  -> { uptime, version, label, state }
//   GET /api/1/devices/<id>/endpoints   -> [{ id, label, type: 'FSII-BP' | 'FSII-Antenna',
//                                             versionSW, role: { id, label },
//                                             settings: { default_role },
//                                             liveStatus: { status: 'online' | ..., role,
//                                               batteryLevel, batteryType,
//                                               longevity: { hours, minutes },
//                                               RSSI, linkQuality, ... } }]
//   GET /api/1/roles                    -> [{ id, type, label }]
//
// A beltpack's live role is liveStatus.role while it is online (65535 = none);
// otherwise its assigned role (role.id, then settings.default_role). Device id
// is 1 unless the base is part of a linked system.
//
// Read-only by construction: three GETs per interval, never a write. The base's
// control interface is unauthenticated (anyone on the network can kill mics),
// which is why this check never offers actions.
import {
  BeltpackConditionSettings,
  BeltpackResult,
  ClearComDebug,
  NO_ROLE,
  NormaliseEndpoints,
  ParseBeltpackOptions,
  RoleMap,
} from './_clearcom-shared';
import {
  BuildBaseUrl,
  IsObject,
  NumOrNull,
  RequestJson,
  StrOrNull,
  TimeoutOf,
  WithPath,
} from './_videoproc-http-shared';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';
import { AddressPortError } from './_target-checks';

const ID = 'clearcom-freespeak-ii';

const DEFAULT_PORT = 80;
const DEFAULT_TIMEOUT_MS = 6000;

const Settings: MonitoringSettingField[] = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: DEFAULT_PORT,
    Min: 1,
    Max: 65535,
    Required: true,
  },
  ...BeltpackConditionSettings(),
  {
    Key: 'DeviceId',
    Label: 'Device ID',
    Type: 'number',
    Default: 1,
    Min: 1,
    Max: 255,
    Advanced: true,
    Note: 'Leave at 1 unless the base is part of a linked system.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: 500,
    Max: 30000,
    Advanced: true,
    Note: 'Budget for the whole probe: every request it makes.',
  },
];

interface FsiiConfig {
  Address: string;
  Port: number;
  DeviceId: number;
  TimeoutMs: number;
}

function ParseConfig(Target: MonitoringTargetLike): FsiiConfig {
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number(Cfg.Port);
  const DeviceId = Number(Cfg.DeviceId);
  return {
    Address: Target && Target.Address ? String(Target.Address).trim() : '',
    Port: Number.isFinite(Port) && Port > 0 ? Math.trunc(Port) : DEFAULT_PORT,
    DeviceId: Number.isInteger(DeviceId) && DeviceId >= 1 && DeviceId <= 255 ? DeviceId : 1,
    TimeoutMs: TimeoutOf(Cfg, DEFAULT_TIMEOUT_MS),
  };
}

// The role a FreeSpeak II beltpack is using now: its live role while online,
// its assigned role otherwise.
function FsiiRoleId(Record: Record<string, unknown>, Live: Record<string, unknown>): number | null {
  const Online = String(Live.status ?? '').toLowerCase() === 'online';
  const LiveRole = NumOrNull(Live.role);
  if (Online && LiveRole != null && LiveRole !== NO_ROLE) return LiveRole;
  const Assigned = IsObject(Record.role) ? NumOrNull(Record.role.id) : null;
  if (Assigned != null) return Assigned;
  const Default = IsObject(Record.settings) ? NumOrNull(Record.settings.default_role) : null;
  return Default != null && Default !== NO_ROLE ? Default : null;
}

function IsAntenna(Record: Record<string, unknown>): boolean {
  return /antenna|tcvr|transceiver/i.test(String(Record.type ?? ''));
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Config = ParseConfig(Target);
  const AddressError = AddressPortError(Config);
  if (AddressError) return { Success: false, Error: AddressError };
  const Base = BuildBaseUrl(Config.Address, 'http', Config.Port);
  if (!Base) return { Success: false, Error: 'Invalid address' };

  const DeadlineAt = Date.now() + Config.TimeoutMs;
  const Started = Date.now();
  const Get = (Path: string) => RequestJson(WithPath(Base, Path), { Method: 'GET', DeadlineAt });

  // Device status first: it is the liveness signal, and its latency is the
  // reply time. The rest only runs once the base has answered.
  const Device = await Get(`/api/1/devices/${Config.DeviceId}/liveStatus`);
  if (!Device.Ok) return { Success: false, Error: Device.Error };
  const LatencyMs = Date.now() - Started;
  if (Device.Status < 200 || Device.Status > 299) {
    return {
      Success: false,
      Degraded: true,
      Error: `The base answered HTTP ${Device.Status} for its status; check the Device ID and that this is a FreeSpeak II base`,
      Status: Device.Status,
    };
  }
  if (!IsObject(Device.Json)) {
    return {
      Success: false,
      Degraded: true,
      Error: 'The reply was not FreeSpeak II status JSON',
    };
  }

  const [Endpoints, Roles] = await Promise.all([
    Get(`/api/1/devices/${Config.DeviceId}/endpoints`),
    Get('/api/1/roles'),
  ]);
  const Out: MonitoringResult = {
    Success: true,
    LatencyMs,
    Label: StrOrNull(Device.Json.label),
    Firmware: StrOrNull(Device.Json.version),
    Uptime: NumOrNull(Device.Json.uptime),
    State: StrOrNull(Device.Json.state),
  };
  if (
    !Endpoints.Ok ||
    Endpoints.Status < 200 ||
    Endpoints.Status > 299 ||
    !Array.isArray(Endpoints.Json)
  ) {
    return {
      ...Out,
      Degraded: true,
      DegradedReason: 'The base answered, but its beltpack list could not be read',
    };
  }

  // A failed roles read only costs role names; packs still match by label or id.
  const RoleById = RoleMap(
    Roles.Ok && Roles.Status >= 200 && Roles.Status <= 299 ? Roles.Json : []
  );
  const List = NormaliseEndpoints(Endpoints.Json, {
    IsTransceiver: IsAntenna,
    RoleId: FsiiRoleId,
    Roles: RoleById,
  });
  return { ...Out, ...BeltpackResult(List, RoleById, ParseBeltpackOptions(Target)) };
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Config = ParseConfig(Target);
  return ClearComDebug(Result, {
    Host: `${Config.Address || '-'}:${Config.Port}`,
    DeviceLabel: 'Base station',
    OfflineText: 'Failed to reach the base station',
  });
}

export const Name = 'Clear-Com FreeSpeak II';
export const Description =
  'Reads a Clear-Com FreeSpeak II base station over its CCM web interface (HTTP): base status and firmware, and every beltpack’s online state, role, battery, runtime and link quality. It reports Degraded when a listed beltpack or role is not online, or a beltpack’s battery is low. Read-only.';
export const Group = 'Sound';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
export const _internal = { ParseConfig, FsiiRoleId, IsAntenna };
export { ID, Settings, Run, Debug };
