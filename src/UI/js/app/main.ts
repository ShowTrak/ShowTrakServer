// Shared renderer entry point (desktop bundle + Web UI via dynamic import).
//
// Modules are imported first — imports carry declarations only, never side
// effects — then initialized explicitly in the original module load order.
// The desktop bundle loads with `defer` and the Web UI imports this after the
// document is ready, so the DOM is always parsed by the time this runs; the
// former DOMContentLoaded handlers are invoked directly from the Init*()
// functions.
//
// Hard invariant: Init() (init.ts) calls window.API.Loaded() to request the
// initial state push, so it MUST stay last — every push subscription above it
// has to be registered first or that state is silently dropped.
import './00-animations';
import './01-state';
import { InitMode } from './02-mode';
import { InitSettings } from './03-settings';
import './04-utils';
import { InitKeyboard } from './05-keyboard';
import { InitClientList } from './06-client-list';
import './07-monitoring';
import { InitDnd } from './08-dnd';
import { InitOscFeeds } from './09-osc-feeds';
import { InitAlertsTray } from './10-alerts-tray';
import { InitModals } from './11-modals';
import './12-monitoring-editor';
import './13-alert-rules';
import './14-selection-init';
import { InitScriptManager } from './15-script-manager';
import './16-dummy-clients';
import { InitAudioAssets } from './17-audio-assets';
import { InitIconPicker } from './18-icon-picker';
import { InitOfflineIndicators } from './offline-indicators';
import { Init, WireGlobalUI } from './init';

InitMode();
InitSettings();
InitKeyboard();
InitClientList();
InitDnd();
InitOscFeeds();
InitAlertsTray();
InitModals();
InitScriptManager();
InitAudioAssets();
InitIconPicker();
InitOfflineIndicators();
void WireGlobalUI();
void Init();
