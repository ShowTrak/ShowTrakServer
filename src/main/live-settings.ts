// Applies settings that used to require a restart, live. Reads the relevant
// settings at boot and re-applies them whenever the SettingsManager fires the
// matching per-setting broadcast (declared via `OnUpdateEvent` in
// DefaultSettings). The OSC port applies itself inside the OSC module; the rest
// are wired here so main.ts stays lean.
import { powerSaveBlocker } from 'electron';
import { CreateLogger, configure as configureLogger } from '../Modules/Logger';
import { Manager as BroadcastManager } from '../Modules/Broadcast';
import { Manager as SettingsManager } from '../Modules/SettingsManager';
import { SetDefaultInterval as SetMonitoringDefaultInterval } from '../Modules/MonitoringTargetManager/normalize';
import { SetDefaultInterval as SetDummyDefaultInterval } from '../Modules/DummyClientManager/normalize';
import { OSC } from '../Modules/OSC';
import { setAccidentalShutdownProtection } from './shutdown-coordinator';

const Logger = CreateLogger('Main');

// Log level. At boot we only override when the user has explicitly set it, so a
// developer's env-based default (LOG_LEVEL / NODE_ENV) still wins on a fresh
// install. Every subsequent change is honoured immediately.
async function ApplyLogLevel(Force: boolean): Promise<void> {
  const Setting = await SettingsManager.Get('SYSTEM_LOG_LEVEL');
  if (!Setting) return;
  if (!Force && Setting.isDefault) return;
  configureLogger({ level: String(Setting.Value) });
  Logger.log(`Log level set to ${Setting.Value}`);
}

// OSC control. The OSC module owns the socket; we resolve the enabled flag and
// configured port and drive it so the listener starts/stops/rebinds without an
// app restart.
async function ApplyOsc(): Promise<void> {
  const Enabled = await SettingsManager.GetValue('SYSTEM_OSC_ENABLED');
  if (!Enabled) {
    OSC.StopServer();
    return;
  }
  const Port = await SettingsManager.GetValue('SYSTEM_OSC_PORT');
  OSC.RestartServer(Port);
}

// Default monitoring / dummy-client interval used for entities that don't set
// their own. Applies to targets created or reloaded after the change.
async function ApplyMonitoringDefaults(): Promise<void> {
  const Ms = await SettingsManager.GetValue('MONITORING_DEFAULT_INTERVAL_MS');
  SetMonitoringDefaultInterval(Ms);
  SetDummyDefaultInterval(Ms);
}

// Accidental-shutdown confirmation guard (Alt+F4 / window close in show mode).
async function ApplyShutdownProtection(): Promise<void> {
  const Enabled = await SettingsManager.GetValue('SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4');
  setAccidentalShutdownProtection(!!Enabled);
}

// Display-sleep blocker. Start/stop the Electron powerSaveBlocker to match the
// setting, tracking the active id so it can be released when toggled off.
let DisplaySleepBlockerId: number | null = null;
async function ApplyDisplaySleep(): Promise<void> {
  const Enabled = await SettingsManager.GetValue('SYSTEM_PREVENT_DISPLAY_SLEEP');
  if (Enabled) {
    if (DisplaySleepBlockerId === null || !powerSaveBlocker.isStarted(DisplaySleepBlockerId)) {
      DisplaySleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      Logger.log('Prevent Display Sleep enabled; powerSaveBlocker started.');
    }
  } else if (DisplaySleepBlockerId !== null) {
    if (powerSaveBlocker.isStarted(DisplaySleepBlockerId)) {
      powerSaveBlocker.stop(DisplaySleepBlockerId);
    }
    DisplaySleepBlockerId = null;
    Logger.log('Prevent Display Sleep disabled; powerSaveBlocker stopped.');
  }
}

function RunGuarded(Label: string, Fn: () => Promise<void>): void {
  Fn().catch((Err) => Logger.error(`Failed to apply ${Label}:`, Err));
}

// Apply current values once and subscribe to their change events. Called from
// the main-process boot sequence.
export async function initLiveSettings(): Promise<void> {
  await ApplyLogLevel(false);
  await ApplyMonitoringDefaults();
  await ApplyDisplaySleep();
  await ApplyOsc();

  BroadcastManager.on('LoggingSettingsChanged', () =>
    RunGuarded('log level', () => ApplyLogLevel(true))
  );
  BroadcastManager.on('MonitoringSettingsChanged', () =>
    RunGuarded('monitoring defaults', ApplyMonitoringDefaults)
  );
  BroadcastManager.on('OscSettingsChanged', () => RunGuarded('OSC', ApplyOsc));
  BroadcastManager.on('ShutdownProtectionChanged', () =>
    RunGuarded('shutdown protection', ApplyShutdownProtection)
  );
  BroadcastManager.on('DisplaySleepSettingsChanged', () =>
    RunGuarded('display sleep blocker', ApplyDisplaySleep)
  );
}
