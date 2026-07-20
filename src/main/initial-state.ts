// Initial-state hydration for the desktop renderer.
//
// When the Electron renderer (re)loads it emits 'Loaded'; the main process must
// then push the current authoritative state across every channel the renderer
// hydrates from. Centralizing that sequence here (rather than inline in the IPC
// handler) keeps the single source of truth for "what a fresh renderer needs"
// next to the Update* fan-out functions it composes.

import { Manager as ModeManager } from '../Modules/ModeManager';
import { PushToRenderers } from './renderer-bus';
import { hasMainWindow } from './app-window';
import {
  UpdateSettings,
  UpdateAdoptionList,
  UpdateFullClientList,
  UpdateScriptList,
  UpdateOSCList,
  UpdateMonitoringTargetList,
  UpdateDummyClientList,
  UpdateAlertRuleList,
  UpdateFogTaskList,
  UpdateFogStatus,
} from './broadcast-bridge';

// Push the full authoritative state to the desktop renderer, in the same order
// the original inline 'Loaded' handler used.
async function PushInitialDesktopState(): Promise<void> {
  await UpdateSettings();
  await UpdateAdoptionList();
  await UpdateFullClientList();
  await UpdateScriptList();
  await UpdateOSCList();
  await UpdateMonitoringTargetList();
  await UpdateDummyClientList();
  await UpdateAlertRuleList();
  await UpdateFogStatus();
  await UpdateFogTaskList();
  // Push current application mode to renderer on initial load.
  if (hasMainWindow()) {
    PushToRenderers('ModeUpdated', ModeManager.Get());
  }
}

export { PushInitialDesktopState };
