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
import './animations';
import './state';
import { InitMode } from './mode';
import { InitSettings } from './settings';
import './utils';
import { InitKeyboard } from './keyboard';
import { InitClientList } from './client-list';
import './monitoring';
import { InitDnd } from './dnd';
import { InitOscFeeds } from './osc-feeds';
import { InitAlertsTray } from './alerts-tray';
import { InitModals } from './modals';
import './monitoring-editor';
import './alert-rules';
import './selection-init';
import { InitScriptManager } from './script-manager';
import './dummy-clients';
import { InitAudioAssets } from './audio-assets';
import { InitIconPicker } from './icon-picker';
import { InitScopePicker } from './scope-picker';
import { InitTagManager } from './tag-manager';
import { InitFog } from './fog';
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
InitScopePicker();
InitTagManager();
InitFog();
InitOfflineIndicators();
void WireGlobalUI();
void Init();
