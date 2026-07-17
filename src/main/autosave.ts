// Autosave scheduler (main process). Extracted verbatim from main.ts.
//
// Periodically snapshots the open ShowTrak file back to its path. The timer is
// rescheduled whenever the relevant settings change (main.ts wires the
// `AutosaveSettingsChanged` broadcast to `scheduleAutosave`). A tick is a no-op
// when autosave is disabled or no file is currently open. `stopAutosave` is
// called from the shutdown cleanup path.
import { CreateLogger } from '../Modules/Logger';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { Manager as BackupManager } from '../Modules/BackupManager';

const Logger = CreateLogger('Main');

let AutosaveTimer: ReturnType<typeof setInterval> | null = null;

async function RunAutosaveTick(): Promise<void> {
  try {
    const Enabled = await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED');
    if (!Enabled) return;
    const CurrentPath = BackupManager.GetCurrentFilePath();
    if (!CurrentPath) return;
    const [Err] = await BackupManager.Save(CurrentPath);
    if (Err) {
      Logger.error('Autosave failed:', Err);
      return;
    }
    Logger.log('Autosave completed to:', CurrentPath);
  } catch (Err) {
    Logger.error('Autosave tick error:', Err);
  }
}

async function scheduleAutosave(): Promise<void> {
  if (AutosaveTimer) {
    clearInterval(AutosaveTimer);
    AutosaveTimer = null;
  }
  const Enabled = await SettingsManager.GetValue('SYSTEM_AUTOSAVE_ENABLED');
  if (!Enabled) return;
  let Minutes = await SettingsManager.GetValue('SYSTEM_AUTOSAVE_INTERVAL_MINUTES');
  Minutes = Number(Minutes);
  if (!Number.isFinite(Minutes) || Minutes < 1) Minutes = 1;
  AutosaveTimer = setInterval(RunAutosaveTick, Minutes * 60 * 1000);
  Logger.log(`Autosave scheduled every ${Minutes} minute(s)`);
}

// Best-effort timer teardown for the shutdown cleanup path.
function stopAutosave(): void {
  if (AutosaveTimer) {
    clearInterval(AutosaveTimer);
    AutosaveTimer = null;
  }
}

export { scheduleAutosave, stopAutosave };
