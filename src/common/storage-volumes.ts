// Storage volume sizes and limits, shared by the main process (judging a
// monitored volume and wording its issue) and the renderer (the storage card and
// its conditions table), so the card and the server's issue text agree.
//
// Compiled into both programs: no Node and no DOM here.

/** A GB as the cards show sizes, and as `MinFreeGB` is set in. */
export const BYTES_PER_GB = 1024 ** 3;

/** What a first "Monitor" press guards free space at. */
export const STORAGE_DEFAULT_MIN_FREE_PERCENT = 10;

/** The limits the server accepts; both minimums are 1. */
export const MAX_FREE_PERCENT = 99;
/** A petabyte: far beyond any single volume, only here to bound the input. */
export const MAX_FREE_GB = 1024 * 1024;

/** Free space as a percentage of the volume; null for a volume of unknown size. */
export function FreePercentOf(Volume: { TotalBytes: number; FreeBytes: number }): number | null {
  if (!(Volume.TotalBytes > 0)) return null;
  return (Volume.FreeBytes / Volume.TotalBytes) * 100;
}

/**
 * "184 GB", "9.4 GB", "512 MB". Rounded DOWN, so a volume just under a limit
 * never reads as being at it ("49.9 GB free (minimum 50 GB)", not "50 GB").
 */
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
