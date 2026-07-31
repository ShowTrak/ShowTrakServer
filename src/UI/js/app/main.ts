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
import { InitTagBadgeMetrics } from './lib/tag-badge-metrics';
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
import { LoadFreeKioskCatalogues } from './freekiosk';
import { WireFreeKioskModal } from './freekiosk-modal';
import { RenderMonitoringHistoryModal } from './monitoring';

InitMode();
InitSettings();
InitKeyboard();
// Ahead of InitClientList: tile tag rows are fitted from a width model, and the
// real measurer has to be in place before the first row is fitted or that row
// gets the coarse fallback and can crop instead of showing its "+N".
InitTagBadgeMetrics();
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
// The metric registry and command map are static for the session and every
// FreeKiosk surface needs them, so they are fetched once up front rather than
// per render. Not awaited: a tile renders fine before they land.
void LoadFreeKioskCatalogues();
WireFreeKioskModal(() => RenderMonitoringHistoryModal());
void WireGlobalUI();
void Init();
