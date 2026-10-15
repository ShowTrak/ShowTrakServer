// History retention sweep (main process).
//
// Nothing ShowTrak remembers is ever needed beyond HISTORY_RETENTION_MS (12h).
// Each store trims itself when it is read or written, but a store nothing
// touches any more never would: a client that goes offline stops recording, so
// its last readings — and a finished script run nobody clears — would otherwise
// sit in memory for as long as the server runs, which on a permanent install is
// weeks. This sweep is the backstop that reaches all of them.
//
// Alert history (DB) and finished FOG tasks prune themselves on their own
// schedules against the same constant; see AlertsManager and FogManager.
import { CreateLogger } from '../Modules/Logger';
import {
  HISTORY_RETENTION_MS,
  HISTORY_RETENTION_SWEEP_INTERVAL_MS,
} from '../Modules/Config/constants';
import { Manager as ScriptExecutionManager } from '../Modules/ScriptExecutionManager';
import { pruneMonitoringHistoryStore } from './monitoring-history';
import { pruneFreeKioskHistory } from './freekiosk-history';
import { pruneClientVitalsHistory } from './client-vitals-history';

const Logger = CreateLogger('HistoryRetention');

let SweepTimer: ReturnType<typeof setInterval> | null = null;

export function SweepExpiredHistory(Now: number = Date.now()): void {
  try {
    pruneMonitoringHistoryStore(Now);
    pruneFreeKioskHistory(Now);
    pruneClientVitalsHistory(Now);
    const Dropped = ScriptExecutionManager.PruneSettledBefore(Now - HISTORY_RETENTION_MS);
    if (Dropped > 0) Logger.debug(`Forgot ${Dropped} script execution(s) older than 12 hours`);
  } catch (Err) {
    Logger.error('History retention sweep failed', Err);
  }
}

export function StartHistoryRetentionSweep(): void {
  if (SweepTimer) return;
  SweepTimer = setInterval(() => SweepExpiredHistory(), HISTORY_RETENTION_SWEEP_INTERVAL_MS);
  // Never hold the process open at shutdown for housekeeping.
  if (typeof SweepTimer.unref === 'function') SweepTimer.unref();
}

export function StopHistoryRetentionSweep(): void {
  if (!SweepTimer) return;
  clearInterval(SweepTimer);
  SweepTimer = null;
}
