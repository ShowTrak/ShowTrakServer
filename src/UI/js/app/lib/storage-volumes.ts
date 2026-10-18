// Storage section of the client info modal — the decisions, without the DOM.
//
// What the section shows, each volume's card (title, usage, Monitor toggle) and
// the conditions table of a monitored one. The server judges the conditions;
// this only lays them out and turns the operator's edits into a request.
import type { ClientView, StorageVolumeView } from '@showtrak/protocol';
import { AudioPlatformLabel, IsVersionAtLeast } from './audio-devices';

/** The first ShowTrak Client release that reports its volumes. */
export const MINIMUM_STORAGE_MONITORING_VERSION = [3, 28, 0] as const;
export const MINIMUM_STORAGE_MONITORING_VERSION_LABEL =
  MINIMUM_STORAGE_MONITORING_VERSION.join('.');

/** A GB as sizes are shown and `MinFreeGB` is set (mirrors BYTES_PER_GB on the server). */
export const BYTES_PER_GB = 1024 ** 3;

/** The limits the server accepts (mirrors ClientManager/storage). */
export const STORAGE_LIMITS = {
  MinFreePercent: { Min: 1, Max: 99, Unit: '%' },
  MinFreeGB: { Min: 1, Max: 1024 * 1024, Unit: 'GB' },
} as const;

/** What ticking an empty percentage row fills in (the server's first-mark default). */
export const DEFAULT_MIN_FREE_PERCENT = '10';

/**
 * Which overall message the section shows, on the power section's rules:
 *  - `outdated`: the client predates storage reporting and has not sent any;
 *  - `waiting`: online, but its volumes have not been reported yet;
 *  - `offline`: nothing live, so the list is the last one seen;
 *  - `unsupported` / `error`: the client tried and its platform said no;
 *  - `ok`: render the volumes.
 */
export type StorageSectionState =
  'outdated' | 'waiting' | 'offline' | 'unsupported' | 'error' | 'ok';

export function GetStorageSectionState(Client: ClientView): StorageSectionState {
  const View = Client.StorageStatus;
  const Reported = !!View && !!View.Status;
  // A client that has reported is evidently new enough, whatever it says it is.
  if (!Reported && !IsVersionAtLeast(Client.Version, MINIMUM_STORAGE_MONITORING_VERSION)) {
    return 'outdated';
  }
  if (!Client.Online) return 'offline';
  if (!View || !View.Status || View.SampledAt === null || View.SampledAt === undefined) {
    return 'waiting';
  }
  if (View.Status.State === 'unsupported') return 'unsupported';
  if (View.Status.State === 'error') return 'error';
  if (View.Status.State === 'ok') return 'ok';
  return 'waiting';
}

/** The headline + body for every state except `ok`. */
export function StorageSectionMessage(
  State: Exclude<StorageSectionState, 'ok'>,
  Client: ClientView
): { Title: string; Body: string } {
  const Status = Client.StorageStatus?.Status ?? null;
  switch (State) {
    case 'outdated':
      return {
        Title: 'Storage Unsupported',
        Body: `Monitoring storage needs ShowTrak Client ${MINIMUM_STORAGE_MONITORING_VERSION_LABEL} or later${
          Client.Version ? ` — this client runs ${Client.Version}` : ''
        }. Update the client to monitor it.`,
      };
    case 'waiting':
      return {
        Title: 'Waiting for Storage',
        Body: 'This client has not reported its volumes yet.',
      };
    case 'offline':
      return {
        Title: 'Client Offline',
        Body: 'Volumes are reported while the client is connected.',
      };
    case 'unsupported':
      return {
        Title: 'Storage Not Available',
        Body:
          Status?.Message ||
          `Monitoring storage is not available on ${AudioPlatformLabel(Status?.Platform, Client.OperatingSystem)}.`,
      };
    case 'error':
    default:
      return {
        Title: 'Storage Warning',
        Body: Status?.Message || 'The client failed to read its volumes.',
      };
  }
}

/** The volumes the section lists, in the order the server sent them. */
export function StorageVolumesOf(Client: ClientView): StorageVolumeView[] {
  return Client.StorageStatus?.Volumes || [];
}

// --- Sizes --------------------------------------------------------------------
// A copy of the formatting in Modules/ClientManager/storage.ts (the renderer is
// a separate bundle), so the card and the server's issue text agree.

/** "184 GB", "9.4 GB", "512 MB" — rounded down, so a volume under a limit never reads as at it. */
export function FormatStorageBytes(Bytes: number): string {
  const Units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let Value = Math.max(0, Number(Bytes) || 0);
  let Unit = 0;
  while (Value >= 1024 && Unit < Units.length - 1) {
    Value /= 1024;
    Unit += 1;
  }
  const Decimals = Value >= 100 || Unit === 0 ? 0 : 1;
  const Factor = 10 ** Decimals;
  return `${(Math.floor(Value * Factor) / Factor).toFixed(Decimals)} ${Units[Unit]}`;
}

/** Free space as a percentage of the volume; null for a volume of unknown size. */
export function FreePercentOf(Volume: Pick<StorageVolumeView, 'TotalBytes' | 'FreeBytes'>) {
  if (!(Volume.TotalBytes > 0)) return null;
  return (Volume.FreeBytes / Volume.TotalBytes) * 100;
}

const KIND_LABELS: Record<StorageVolumeView['Kind'], string> = {
  internal: 'Internal',
  external: 'External',
  network: 'Network',
  unknown: '',
};

// --- Cards ------------------------------------------------------------------------

/** The card's title: the volume's label, else where it is mounted. */
export function StorageVolumeTitle(Volume: StorageVolumeView): string {
  return Volume.Name || Volume.Critical?.Name || Volume.MountPoint;
}

/**
 * The card's subtitle: "/Volumes/Media · apfs · External · 1.8 TB" — the mount
 * point first (unless it is already the title), then whatever else is known.
 */
export function StorageVolumeSummary(Volume: StorageVolumeView): string {
  const Parts: string[] = [];
  if (StorageVolumeTitle(Volume) !== Volume.MountPoint) Parts.push(Volume.MountPoint);
  if (!Volume.IsConnected) {
    Parts.push(Volume.Missing ? 'Not mounted' : 'Not reported');
    return Parts.join(' · ');
  }
  if (Volume.FileSystem) Parts.push(Volume.FileSystem);
  if (KIND_LABELS[Volume.Kind]) Parts.push(KIND_LABELS[Volume.Kind]);
  if (Volume.TotalBytes > 0) Parts.push(FormatStorageBytes(Volume.TotalBytes));
  return Parts.join(' · ');
}

/** The usage bar of a mounted volume: how full it is, and what that leaves. */
export function StorageUsage(
  Volume: StorageVolumeView
): { UsedPercent: number; Text: string; Low: boolean } | null {
  const Free = FreePercentOf(Volume);
  if (!Volume.IsConnected || Free === null) return null;
  const UsedPercent = Math.min(100, Math.max(0, 100 - Free));
  return {
    UsedPercent,
    Text: `${FormatStorageBytes(Volume.FreeBytes)} free of ${FormatStorageBytes(Volume.TotalBytes)}`,
    Low: Volume.Issues.some(
      (Issue) => Issue.Kind === 'free_percent' || Issue.Kind === 'free_space'
    ),
  };
}

export type StorageVolumeState = 'healthy' | 'issue' | 'missing' | 'unreported' | 'plain';

/** The badge the Monitor toggle shows, and what clicking it will do. */
export function StorageVolumeBadge(Volume: StorageVolumeView): {
  State: StorageVolumeState;
  Label: string;
  Icon: string;
  Title: string;
} {
  if (!Volume.IsCritical) {
    return {
      State: 'plain',
      Label: 'Monitor',
      Icon: 'bi-check-circle',
      Title: 'Monitor this volume',
    };
  }
  if (Volume.Missing) {
    return {
      State: 'missing',
      Label: 'Missing',
      Icon: 'bi-x-circle-fill',
      Title: 'Stop monitoring (volume not mounted)',
    };
  }
  if (!Volume.IsConnected) {
    return {
      State: 'unreported',
      Label: 'Monitored',
      Icon: 'bi-question-circle',
      Title: 'Stop monitoring (not reported yet)',
    };
  }
  if (Volume.Issues.length) {
    return {
      State: 'issue',
      Label: 'Alarm',
      Icon: 'bi-exclamation-triangle-fill',
      Title: 'Stop monitoring (conditions not met)',
    };
  }
  return {
    State: 'healthy',
    Label: 'Monitored',
    Icon: 'bi-check-circle-fill',
    Title: 'Stop monitoring',
  };
}

// --- Conditions -----------------------------------------------------------------

/** A condition a monitored volume can be held to, as its form field is named. */
export type StorageConditionField =
  'RequirePresent' | 'MinFreePercent' | 'MinFreeGB' | 'RequireWritable' | 'RequireHealthy';

export interface StorageConditionInput {
  /** The stored limit, or '' while the condition is unticked. */
  Value: string;
  /** What ticking an empty row fills in. */
  Default: string;
  Unit: string;
  Min: number;
  Max: number;
}

/** One row of a monitored volume's conditions table. */
export interface StorageConditionRow {
  Field: StorageConditionField;
  Label: string;
  /** What the volume reports now ("Yes", "18% free"), for rows without an input. */
  Value: string;
  Input: StorageConditionInput | null;
  /** Whether this volume can be held to it. A condition already set always is, so it can be cleared. */
  Supported: boolean;
  /** Whether the condition is being monitored. */
  Checked: boolean;
  /** Always on: monitoring a volume is requiring it to stay mounted. Never sent. */
  Locked: boolean;
  /** The issue this condition currently raises, when it is not met. */
  Failing: string | null;
}

/**
 * What ticking the GB row fills in: a tenth of the volume, between 1 and 50 GB,
 * so a small card is not held to more than it can ever hold free.
 */
export function DefaultMinFreeGB(Volume: StorageVolumeView): string {
  if (!(Volume.TotalBytes > 0)) return '10';
  return String(Math.min(50, Math.max(1, Math.floor(Volume.TotalBytes / BYTES_PER_GB / 10))));
}

const HEALTH_LABELS: Record<NonNullable<StorageVolumeView['Health']>, string> = {
  ok: 'Yes',
  warning: 'Needs repair',
  failing: 'Failing',
};

/** The conditions table of a monitored volume, one row per condition. */
export function StorageConditionRows(Volume: StorageVolumeView): StorageConditionRow[] {
  const Critical = Volume.Critical;
  if (!Critical) return [];
  const Issue = (...Kinds: string[]) =>
    Volume.Issues.find((Candidate) => Kinds.includes(Candidate.Kind))?.Message ?? null;
  const Mounted = Volume.IsConnected;
  const Number_ = (
    Field: 'MinFreePercent' | 'MinFreeGB',
    Value: number | null,
    Default: string
  ): StorageConditionInput => ({
    Value: Value === null ? '' : String(Value),
    Default,
    Unit: STORAGE_LIMITS[Field].Unit,
    Min: STORAGE_LIMITS[Field].Min,
    Max: STORAGE_LIMITS[Field].Max,
  });
  // A mounted volume says what it can report; a missing one is assumed able to.
  const WritableKnown = !Mounted || Volume.ReadOnly !== null;
  const HealthKnown = !Mounted || Volume.Health !== null;
  const Dash = (Known: boolean, Text: string) => (!Mounted ? '—' : Known ? Text : 'Unsupported');
  return [
    {
      Field: 'RequirePresent',
      Label: 'Mounted',
      Value: Mounted ? 'Yes' : 'No',
      Input: null,
      Supported: true,
      Checked: true,
      Locked: true,
      Failing: Issue('missing'),
    },
    {
      Field: 'MinFreePercent',
      Label: 'Minimum free space',
      Value: '',
      Input: Number_('MinFreePercent', Critical.MinFreePercent, DEFAULT_MIN_FREE_PERCENT),
      Supported: true,
      Checked: Critical.MinFreePercent !== null,
      Locked: false,
      Failing: Issue('free_percent'),
    },
    {
      Field: 'MinFreeGB',
      Label: 'Minimum free space',
      Value: '',
      Input: Number_('MinFreeGB', Critical.MinFreeGB, DefaultMinFreeGB(Volume)),
      Supported: true,
      Checked: Critical.MinFreeGB !== null,
      Locked: false,
      Failing: Issue('free_space'),
    },
    {
      Field: 'RequireWritable',
      Label: 'Is writable',
      Value: Dash(Volume.ReadOnly !== null, Volume.ReadOnly ? 'No (read-only)' : 'Yes'),
      Input: null,
      Supported: WritableKnown || Critical.RequireWritable,
      Checked: Critical.RequireWritable,
      Locked: false,
      Failing: Issue('read_only'),
    },
    {
      Field: 'RequireHealthy',
      Label: 'Is healthy',
      Value: Dash(Volume.Health !== null, Volume.Health ? HEALTH_LABELS[Volume.Health] : ''),
      Input: null,
      Supported: HealthKnown || Critical.RequireHealthy,
      Checked: Critical.RequireHealthy,
      Locked: false,
      Failing: Issue('health'),
    },
  ];
}

/**
 * Rebuild the list only when what it shows changes. Free space is shown to the
 * GB, so a disk that is filling redraws as it crosses each one, not on every
 * byte; the conditions hold typed values, so the modal also holds a rebuild
 * while one of them has focus.
 */
export function StorageRenderKey(Client: ClientView, State: StorageSectionState): string {
  const Volumes = StorageVolumesOf(Client).map((Volume) =>
    [
      Volume.MountPoint,
      Volume.Name ?? '',
      Volume.FileSystem ?? '',
      Volume.Kind,
      Volume.TotalBytes,
      FormatStorageBytes(Volume.FreeBytes),
      Volume.ReadOnly === null ? '' : Volume.ReadOnly ? 1 : 0,
      Volume.Health ?? '',
      Volume.IsConnected ? 1 : 0,
      Volume.Missing ? 1 : 0,
      Volume.Issues.map((Issue) => Issue.Message).join(','),
      JSON.stringify(Volume.Critical),
    ].join('|')
  );
  return `${Client.UUID}::${State}::${Client.StorageStatus?.Status?.Message ?? ''}::${Volumes.join(';;')}`;
}

/**
 * The fields of a monitored volume's conditions form, as read from the DOM.
 * Presence is locked on, so it is never read or sent; an unsupported row is
 * left out (undefined), which keeps what is stored.
 */
export interface StorageRuleFields {
  /** '' for an unticked row. */
  MinFreePercent?: string;
  MinFreeGB?: string;
  RequireWritable?: boolean;
  RequireHealthy?: boolean;
}

export interface StorageRulePayload {
  MountPoint: string;
  MinFreePercent?: number | null;
  MinFreeGB?: number | null;
  RequireWritable?: boolean;
  RequireHealthy?: boolean;
}

/** Turn the conditions form into a request, or say what is wrong with it. */
export function ParseStorageRuleFields(
  MountPoint: string,
  Fields: StorageRuleFields
): { Payload: StorageRulePayload } | { Error: string } {
  const Payload: StorageRulePayload = { MountPoint };
  for (const Field of ['MinFreePercent', 'MinFreeGB'] as const) {
    const Raw = Fields[Field];
    if (Raw === undefined) continue;
    const Text = String(Raw).trim();
    if (!Text) {
      Payload[Field] = null;
      continue;
    }
    const Limit = STORAGE_LIMITS[Field];
    const n = Number(Text);
    if (!Number.isInteger(n) || n < Limit.Min || n > Limit.Max) {
      return {
        Error: `Minimum free space must be a whole number from ${Limit.Min} to ${Limit.Max}${
          Limit.Unit === '%' ? '%' : ` ${Limit.Unit}`
        }`,
      };
    }
    Payload[Field] = n;
  }
  if (Fields.RequireWritable !== undefined) Payload.RequireWritable = Fields.RequireWritable;
  if (Fields.RequireHealthy !== undefined) Payload.RequireHealthy = Fields.RequireHealthy;
  return { Payload };
}

/**
 * The live state of a monitored volume's history row: green while mounted and
 * meeting its conditions, orange while mounted but not, red while missing. Idle
 * while the client is offline or the volume has not been judged yet.
 */
export function StorageTimelineLiveState(
  Volume: StorageVolumeView,
  Online: boolean
): { State: 'IDLE' | 'ONLINE' | 'DEGRADED' | 'OFFLINE'; Label: string } {
  if (!Online) return { State: 'IDLE', Label: 'Idle' };
  if (Volume.Missing) return { State: 'OFFLINE', Label: 'Not Mounted' };
  if (!Volume.IsConnected) return { State: 'IDLE', Label: 'Not Reported' };
  if (Volume.Issues.length) {
    return { State: 'DEGRADED', Label: Volume.Issues.map((Issue) => Issue.Message).join('; ') };
  }
  const Usage = StorageUsage(Volume);
  return { State: 'ONLINE', Label: Usage ? Usage.Text : 'Mounted' };
}
