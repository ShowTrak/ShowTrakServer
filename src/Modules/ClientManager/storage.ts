// Monitored storage volumes — the pure half.
//
// Everything here is a function of its arguments: normalising a reported
// snapshot, judging a monitored volume against its conditions, building the
// view the renderer draws, and working out the entry a mark/update request
// produces. The Client entity (./client.ts) holds the state and calls these.
//
// Volumes are keyed by mount point ("/", "/Volumes/Media", "D:"): it is what
// the client reports them by, and what an operator recognises.
//
// The principle the other monitored kinds follow holds here too: an unknown is
// never a fault. A volume whose platform cannot say whether it is read-only, or
// a drive that reports no health verdict, is skipped rather than failed.
import type {
  CollectorStatus,
  CriticalStorageVolume,
  StorageHealth,
  StorageIssue,
  StorageIssueKind,
  StorageStatusView,
  StorageVolume,
  StorageVolumeKind,
  StorageVolumeView,
} from '@showtrak/protocol';
import { AsRecord } from './normalizers';
import { CollectorStatusOf } from './health';
import type { CriticalKind } from './critical-kind';

/** A GB as the cards show sizes, and as `MinFreeGB` is set in. */
export const BYTES_PER_GB = 1024 ** 3;

/** What a first "Monitor" press guards free space at. */
export const STORAGE_DEFAULT_MIN_FREE_PERCENT = 10;

export const MAX_FREE_PERCENT = 99;
/** A petabyte: far beyond any single volume, only here to bound the input. */
export const MAX_FREE_GB = 1024 * 1024;

const MAX_VOLUMES = 128;

/** DegradedWarnings entries, one per kind of fault (both free-space kinds share one). */
export const STORAGE_WARNINGS: Record<StorageIssueKind, string> = {
  missing: 'Missing Storage Volume',
  free_percent: 'Low Disk Space',
  free_space: 'Low Disk Space',
  read_only: 'Storage Volume Read-Only',
  health: 'Storage Health Warning',
};

/** What the server holds from the client's last storage report. */
export interface ObservedStorage {
  SampledAt: number | null;
  /** Null until the client has reported at all. */
  Status: CollectorStatus | null;
  Volumes: StorageVolume[];
}

const KINDS: ReadonlySet<string> = new Set<StorageVolumeKind>([
  'internal',
  'external',
  'network',
  'unknown',
]);
const HEALTH: ReadonlySet<string> = new Set<StorageHealth>(['ok', 'warning', 'failing']);

export function EmptyObservedStorage(): ObservedStorage {
  return { SampledAt: null, Status: null, Volumes: [] };
}

export function EmptyStorageView(): StorageStatusView {
  return { SampledAt: null, Status: null, Volumes: [] };
}

function TrimmedOrNull(Value: unknown, Max: number): string | null {
  if (typeof Value !== 'string') return null;
  const Trimmed = Value.trim();
  return Trimmed ? Trimmed.slice(0, Max) : null;
}

function Bytes(Value: unknown): number {
  const n = Number(Value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** A whole number in [Min, Max], or null for anything that is not a number. */
function WholeInRange(Value: unknown, Min: number, Max: number): number | null {
  if (Value === null || Value === undefined || Value === '' || typeof Value === 'boolean') {
    return null;
  }
  const n = Number(Value);
  if (!Number.isFinite(n)) return null;
  return Math.min(Max, Math.max(Min, Math.round(n)));
}

export function normalizeMountPoint(Value: unknown): string | null {
  return TrimmedOrNull(Value, 512);
}

function normalizeVolume(Value: unknown): StorageVolume | null {
  const V = AsRecord(Value);
  const MountPoint = normalizeMountPoint(V.MountPoint);
  if (!MountPoint) return null;
  const TotalBytes = Bytes(V.TotalBytes);
  const Free = Bytes(V.FreeBytes);
  return {
    MountPoint,
    Name: TrimmedOrNull(V.Name, 256),
    FileSystem: TrimmedOrNull(V.FileSystem, 64),
    Kind:
      typeof V.Kind === 'string' && KINDS.has(V.Kind) ? (V.Kind as StorageVolumeKind) : 'unknown',
    TotalBytes,
    // Free can never exceed the volume; a reading that says so is a unit slip.
    FreeBytes: TotalBytes > 0 ? Math.min(Free, TotalBytes) : Free,
    ReadOnly: typeof V.ReadOnly === 'boolean' ? V.ReadOnly : null,
    Health:
      typeof V.Health === 'string' && HEALTH.has(V.Health) ? (V.Health as StorageHealth) : null,
  };
}

/**
 * Normalise a reported snapshot into what is stored. A volume without a mount
 * point is dropped, and a repeated mount point keeps its first occurrence, so
 * one bad row can never make two volumes share a set of conditions.
 */
export function normalizeStorageSnapshot(Snapshot: unknown): ObservedStorage {
  const S = AsRecord(Snapshot);
  const Volumes: StorageVolume[] = [];
  const Seen = new Set<string>();
  for (const Raw of Array.isArray(S.Volumes) ? S.Volumes : []) {
    const Volume = normalizeVolume(Raw);
    if (!Volume || Seen.has(Volume.MountPoint)) continue;
    Seen.add(Volume.MountPoint);
    Volumes.push(Volume);
    if (Volumes.length >= MAX_VOLUMES) break;
  }
  const SampledAt = Number(S.SampledAt);
  return {
    SampledAt: Number.isFinite(SampledAt) && SampledAt > 0 ? SampledAt : Date.now(),
    Status: CollectorStatusOf(S.Status),
    Volumes,
  };
}

/** Free space as a percentage of the volume; null for a volume of unknown size. */
export function FreePercentOf(
  Volume: Pick<StorageVolume, 'TotalBytes' | 'FreeBytes'>
): number | null {
  if (!(Volume.TotalBytes > 0)) return null;
  return (Volume.FreeBytes / Volume.TotalBytes) * 100;
}

/**
 * "184 GB", "9.4 GB", "512 MB". Rounded DOWN, so a volume just under a limit
 * never reads as being at it ("49.9 GB free (minimum 50 GB)", not "50 GB").
 */
export function FormatStorageBytes(Bytes: number): string {
  const Units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let Value = Math.max(0, Bytes);
  let Unit = 0;
  while (Value >= 1024 && Unit < Units.length - 1) {
    Value /= 1024;
    Unit += 1;
  }
  const Decimals = Value >= 100 || Unit === 0 ? 0 : 1;
  const Factor = 10 ** Decimals;
  return `${(Math.floor(Value * Factor) / Factor).toFixed(Decimals)} ${Units[Unit]}`;
}

/** "6%", or "6.4%" under 10% where the decimal matters. Rounded down, like the sizes. */
export function FormatFreePercent(Percent: number): string {
  if (Percent < 10) return `${(Math.floor(Percent * 10) / 10).toFixed(1)}%`;
  return `${Math.floor(Percent)}%`;
}

/** The name an operator knows a volume by: its label, else where it is mounted. */
export function StorageVolumeLabel(Volume: { Name: string | null; MountPoint: string }): string {
  return Volume.Name || Volume.MountPoint;
}

/** Normalise a stored or requested monitored entry; null when it cannot be one. */
export function normalizeCriticalStorageEntry(Value: unknown): CriticalStorageVolume | null {
  const E = AsRecord(Value);
  const MountPoint = normalizeMountPoint(E.MountPoint);
  if (!MountPoint) return null;
  return {
    MountPoint,
    Name: TrimmedOrNull(E.Name, 256),
    // A monitored volume is always required to stay mounted, so presence is
    // never read from the row (the rule every monitored kind follows).
    RequirePresent: true,
    MinFreePercent: WholeInRange(E.MinFreePercent, 1, MAX_FREE_PERCENT),
    MinFreeGB: WholeInRange(E.MinFreeGB, 1, MAX_FREE_GB),
    // sqlite hands booleans back as 0/1.
    RequireWritable: E.RequireWritable === true || E.RequireWritable === 1,
    RequireHealthy: E.RequireHealthy === true || E.RequireHealthy === 1,
    Timestamp: Number.isFinite(Number(E.Timestamp)) && E.Timestamp ? Number(E.Timestamp) : null,
  };
}

/**
 * Judge one monitored volume. `Volume` is null when the client did not report
 * it. Each condition runs only when it is guarded AND the reading is known.
 */
export function evaluateStorageIssues(
  Volume: StorageVolume | null,
  Critical: CriticalStorageVolume
): StorageIssue[] {
  if (!Volume) {
    return [{ Kind: 'missing', Message: `${StorageVolumeLabel(Critical)} is not mounted` }];
  }
  const Issues: StorageIssue[] = [];
  const Percent = FreePercentOf(Volume);
  if (Critical.MinFreePercent !== null && Percent !== null && Percent < Critical.MinFreePercent) {
    Issues.push({
      Kind: 'free_percent',
      Message: `${FormatFreePercent(Percent)} free (minimum ${Critical.MinFreePercent}%)`,
    });
  }
  if (
    Critical.MinFreeGB !== null &&
    Volume.TotalBytes > 0 &&
    Volume.FreeBytes < Critical.MinFreeGB * BYTES_PER_GB
  ) {
    Issues.push({
      Kind: 'free_space',
      Message: `${FormatStorageBytes(Volume.FreeBytes)} free (minimum ${Critical.MinFreeGB} GB)`,
    });
  }
  if (Critical.RequireWritable && Volume.ReadOnly === true) {
    Issues.push({ Kind: 'read_only', Message: 'Mounted read-only' });
  }
  if (Critical.RequireHealthy && (Volume.Health === 'warning' || Volume.Health === 'failing')) {
    Issues.push({
      Kind: 'health',
      Message:
        Volume.Health === 'failing'
          ? 'The drive reports it is failing'
          : 'The volume needs scanning or repair',
    });
  }
  return Issues;
}

export interface StorageViewResult {
  View: StorageStatusView;
  /** Monitored volumes the client did not report (only populated when trusted). */
  Missing: StorageVolumeView[];
  /** De-duplicated DegradedWarnings entries, in a stable order. */
  Warnings: string[];
}

/**
 * Merge the reported volumes with the monitored ones into the renderer's view.
 * `Trusted` is whether the stored snapshot came from a sample that succeeded on
 * this connection: until then nothing is judged, and a monitored volume the
 * client has not reported reads as "not reported" rather than as missing.
 */
export function buildStorageView(
  Observed: ObservedStorage,
  Criticals: CriticalStorageVolume[],
  Trusted: boolean
): StorageViewResult {
  const CriticalByMount = new Map<string, CriticalStorageVolume>();
  for (const Entry of Criticals) {
    if (Entry && Entry.MountPoint && !CriticalByMount.has(Entry.MountPoint)) {
      CriticalByMount.set(Entry.MountPoint, Entry);
    }
  }
  const Mounted: StorageVolumeView[] = Observed.Volumes.map((Volume) => {
    const Critical = CriticalByMount.get(Volume.MountPoint) || null;
    return {
      ...Volume,
      IsConnected: true,
      IsCritical: !!Critical,
      Missing: false,
      Issues: Critical && Trusted ? evaluateStorageIssues(Volume, Critical) : [],
      Critical,
    };
  });
  const MountedPoints = new Set(Observed.Volumes.map((Volume) => Volume.MountPoint));
  const Absent: StorageVolumeView[] = [];
  for (const Critical of CriticalByMount.values()) {
    if (MountedPoints.has(Critical.MountPoint)) continue;
    Absent.push({
      MountPoint: Critical.MountPoint,
      Name: Critical.Name,
      FileSystem: null,
      Kind: 'unknown',
      TotalBytes: 0,
      FreeBytes: 0,
      ReadOnly: null,
      Health: null,
      IsConnected: false,
      IsCritical: true,
      Missing: Trusted,
      Issues: Trusted ? evaluateStorageIssues(null, Critical) : [],
      Critical,
    });
  }

  const Volumes = Mounted.concat(Absent);
  const Warnings: string[] = [];
  if (Trusted) {
    for (const Volume of Volumes) {
      for (const Issue of Volume.Issues) {
        const Warning = STORAGE_WARNINGS[Issue.Kind];
        if (!Warnings.includes(Warning)) Warnings.push(Warning);
      }
    }
  }
  return {
    View: { SampledAt: Observed.SampledAt, Status: Observed.Status, Volumes },
    Missing: Trusted ? Absent : [],
    Warnings,
  };
}

/** Options a mark/update request may carry; absent ones keep their current value. */
export interface CriticalStorageOptions {
  MinFreePercent?: number | null;
  MinFreeGB?: number | null;
  RequireWritable?: boolean;
  RequireHealthy?: boolean;
}

/**
 * Work out the monitored entry a mark/update request produces.
 *
 * A FIRST mark guards what an operator would want of any show volume: at least
 * 10% free, and — where the volume reports them — that it stays writable and
 * its drive stays healthy. A volume that is read-only right now (the sealed
 * macOS system volume, a write-protected card) is not held to writability, or
 * it would fault the moment it was monitored. A volume that is currently
 * missing can still have its conditions edited; a first mark on one the client
 * has never reported is refused.
 */
export function resolveCriticalStorageEntry(
  MountPoint: string,
  Options: CriticalStorageOptions,
  Live: StorageVolume | null,
  Existing: CriticalStorageVolume | null,
  Now: number
): [string | null, CriticalStorageVolume | null] {
  if (!Live && !Existing) return ['That volume is not mounted on this client', null];
  const Has = (Key: keyof CriticalStorageOptions) =>
    Object.prototype.hasOwnProperty.call(Options, Key) && Options[Key] !== undefined;

  const MinFreePercent = Has('MinFreePercent')
    ? WholeInRange(Options.MinFreePercent, 1, MAX_FREE_PERCENT)
    : Existing
      ? Existing.MinFreePercent
      : STORAGE_DEFAULT_MIN_FREE_PERCENT;
  const MinFreeGB = Has('MinFreeGB')
    ? WholeInRange(Options.MinFreeGB, 1, MAX_FREE_GB)
    : (Existing?.MinFreeGB ?? null);
  const RequireWritable = Has('RequireWritable')
    ? !!Options.RequireWritable
    : Existing
      ? Existing.RequireWritable
      : Live?.ReadOnly === false;
  const RequireHealthy = Has('RequireHealthy')
    ? !!Options.RequireHealthy
    : Existing
      ? Existing.RequireHealthy
      : Live?.Health === 'ok';

  return [
    null,
    {
      MountPoint,
      Name: Live?.Name ?? Existing?.Name ?? null,
      RequirePresent: true,
      MinFreePercent,
      MinFreeGB,
      RequireWritable,
      RequireHealthy,
      Timestamp: Existing?.Timestamp ?? Now,
    },
  ];
}

/** Storage volumes monitored by mount point (see ./critical-kind). */
export const STORAGE_KIND: CriticalKind<CriticalStorageVolume> = {
  KeyOf: (Entry) => Entry.MountPoint,
  NormalizeKey: normalizeMountPoint,
  NormalizeEntry: normalizeCriticalStorageEntry,
  Messages: {
    KeyRequired: 'Volume mount point is required',
    SaveFailed: 'Failed to save monitored volume',
    RemoveFailed: 'Failed to remove monitored volume',
    LookupFailed: 'Failed to determine monitored volume status',
  },
};
