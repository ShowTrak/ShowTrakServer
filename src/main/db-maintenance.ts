// Working-database housekeeping (main process).
//
// Rows the server deletes as it runs (alert history retention, mostly) leave
// free pages in the working database that SQLite keeps rather than returns, so
// the file only ever grows. DB.CompactIfFragmented rewrites it when most of it
// is free space. It runs a while after the main window is up, never during
// startup, and then hourly; when there is nothing worth reclaiming a check is
// three PRAGMA reads.
import { CreateLogger } from '../Modules/Logger';
import { Manager as DB } from '../Modules/DB';

const Logger = CreateLogger('DBMaintenance');

const FIRST_CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

let FirstTimer: ReturnType<typeof setTimeout> | null = null;
let IntervalTimer: ReturnType<typeof setInterval> | null = null;

export async function CompactWorkingDatabase(): Promise<void> {
  try {
    const [Err] = await DB.CompactIfFragmented();
    if (Err) Logger.warn('Could not compact the working database:', Err);
  } catch (Err) {
    Logger.warn('Could not compact the working database:', Err);
  }
}

export function StartDatabaseMaintenance(): void {
  if (FirstTimer || IntervalTimer) return;
  FirstTimer = setTimeout(() => {
    FirstTimer = null;
    void CompactWorkingDatabase();
    IntervalTimer = setInterval(() => void CompactWorkingDatabase(), CHECK_INTERVAL_MS);
    // Housekeeping never holds the process open at shutdown.
    IntervalTimer.unref?.();
  }, FIRST_CHECK_DELAY_MS);
  FirstTimer.unref?.();
}

export function StopDatabaseMaintenance(): void {
  if (FirstTimer) clearTimeout(FirstTimer);
  if (IntervalTimer) clearInterval(IntervalTimer);
  FirstTimer = null;
  IntervalTimer = null;
}
