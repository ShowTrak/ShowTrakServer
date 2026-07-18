// Renderer bootstrap (REFACTOR_PLAN.md Phase 7 item 2).
//
// Everything here used to run as import-time side effects in
// 14-selection-init.ts: a jQuery document-ready IIFE (global context-menu /
// tile / keybind wiring) and Init() (show-file bootstrap, cogs-menu wiring and
// the final window.API.Loaded() handshake). The bootstrap orchestrator in
// main.ts calls WireGlobalUI() then Init(), after every module's Init*()
// subscriptions are registered — Loaded() must stay last so the main process
// pushes initial state only once every subscriber is listening.
import { closeModal, openModal } from './lib/modal';
import { AppMode, Capabilities, Config, NetworkDiscoveryResults, NetworkDiscoveryScanning, __LastGroups, setConfig, setMonitorHistoryTooltipHover, setUpdateManagerDownloadInProgress } from './01-state';
import { RenderMode } from './02-mode';
import { HandleNonFatalError } from './04-utils';
import { HideStatusTimelineTooltip, OpenDummyClientHistory, OpenMonitoringTargetHistory, RenderMonitoringHistoryModal, ShowStatusTimelineTooltip } from './07-monitoring';
import { OpenOSCDictionary, OpenOscHttpDebugTerminal } from './09-osc-feeds';
import { ApplyUpdateManagerButtonLocks, CloseAllModals, NewShow, OpenAboutModal, OpenClientEditor, OpenGroupCreationModal, OpenGroupManager, OpenShow, OpenUpdateManagerModal, RenderShowFileName, SaveShow, SaveShowAs, SetUpdateManagerDownloadProgress } from './11-modals';
import { HandleNetworkDiscoveryEvent, OpenMonitoringTargetEditor, OpenNetworkDiscoveryModal, ResetNetworkDiscoveryState, SetNetworkDiscoveryStatus, StartNetworkDiscoveryScan, StopNetworkDiscoveryScan } from './12-monitoring-editor';
import { OpenAlertRuleManager, OpenCreateAlertRuleEditor } from './13-alert-rules';
import { GetIdentifyingUUIDs, HideExecutionToast, Notify, StopIdentifyingForUUIDs, UpdateIdentifyStatusBanner } from './14-selection-init';
import { OpenClientInfo } from './client-info-modal';
import { TestAllNotifications } from './lib/debug-notifications';
import { OpenScriptManager } from './15-script-manager';
import { OpenTagManager } from './19-tag-manager';
import { OpenDummyClientEditor } from './16-dummy-clients';
import {
  OpenUnassignedClientCreationModal,
  RefreshUnassignedClientMenuVisibility,
} from './17-unassigned-clients';
import { ClearSelection, SelectByGroup, ToggleSelection } from './selection';
import { wireAppUpdates } from './wire-app-updates';
import { wireContextMenu } from './wire-context-menu';

// Global UI wiring: context menu, tile clicks, group keybinds, app-update
// modal and the identify banner. Body unchanged from the former jQuery
// document-ready IIFE.
export async function WireGlobalUI() {

  // Copy-to-clipboard for readonly editor fields and inline values
  $(document).on('click', '.copy-field-btn', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const direct = $(this).attr('data-copy');
    let value = null;
    if (direct && String(direct).length > 0) {
      value = String(direct);
    } else {
      const targetSel = $(this).attr('data-target');
      const $input = targetSel ? $(targetSel) : null;
      if (!$input || $input.length === 0) return false;
      value = String($input.val() || '').trim();
    }
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      // quick feedback: icon swap
      const $icon = $(this).find('i');
      const prev = $icon.attr('class');
      $icon.attr('class', 'bi bi-clipboard-check');
      setTimeout(() => {
        $icon.attr('class', prev || '');
      }, 900);
    } catch (e) {
      HandleNonFatalError('Clipboard:CopyField', e);
    }
    return false;
  });

  $(document).on('click', '#SELECTION_STATUS, #MOBILE_CLEAR_SELECTION_BTN', function () {
    ClearSelection();
  });

  $(document).on('click', '#IDENTIFY_STOP_ALL_BUTTON', async function (e) {
    e.preventDefault();
    try {
      await StopIdentifyingForUUIDs(GetIdentifyingUUIDs());
    } catch (err) {
      HandleNonFatalError('SelectionInit:StopIdentifyAll', err);
    } finally {
      UpdateIdentifyStatusBanner();
    }
  });

  $(document).on('click', '.GROUP_TITLE_CLICKABLE[data-groupid]', function (e) {
    e.preventDefault();
    const groupId = $(this).attr('data-groupid');
    SelectByGroup(groupId);
  });

  // Global keybinds: toggle a group's selection when its assigned keyboard/numpad
  // number is pressed. Ignored while typing in a field or while a modal is open.
  $(document).on('keydown.groupKeybind', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || (e as unknown as KeyboardEvent).repeat) return;

    const Target = e.target as unknown as HTMLElement | null;
    if (Target) {
      const Tag = String(Target.tagName || '').toUpperCase();
      if (Tag === 'INPUT' || Tag === 'TEXTAREA' || Tag === 'SELECT' || Target.isContentEditable) {
        return;
      }
    }

    if (document.querySelector('.modal.show')) return;

    const Groups = Array.isArray(__LastGroups) ? __LastGroups : [];
    const Match = Groups.find((Group) => Group && Group.KeyBind === e.code);
    if (!Match) return;

    e.preventDefault();
    SelectByGroup(Match.GroupID);
  });

  wireAppUpdates();

  // Open client editor from cog without affecting selection
  $(document).on('click', '.CLIENT_TILE_COG', function (e) {
    e.preventDefault();
    e.stopPropagation();
    // Monitoring targets use their own editor
    if ($(this).hasClass('MONITOR_TILE_COG')) {
      const tid = $(this).closest('.SHOWTRAK_PC').attr('data-target-id');
      if (tid) OpenMonitoringTargetEditor(parseInt(tid, 10));
      return false;
    }
    // Dummy clients use their own editor
    if ($(this).hasClass('DUMMY_TILE_COG')) {
      const duid = $(this).closest('.SHOWTRAK_PC').attr('data-dummy-uuid');
      if (duid) OpenDummyClientEditor(duid);
      return false;
    }
    const uuid = $(this).closest('.SHOWTRAK_PC').attr('data-uuid');
    if (uuid) {
      OpenClientEditor(uuid);
    }
    return false;
  });
  $(document).on('click', '.SHOWTRAK_PC', function (e) {
    e.preventDefault();
    // Monitoring and dummy tiles are selectable via their prefixed data-uuid
    // (monitor:/dummy:), so the context menu can offer per-type actions.
    if ($(this).hasClass('MONITOR') || $(this).hasClass('DUMMY')) {
      const TileUUID = $(this).attr('data-uuid');
      if (TileUUID) ToggleSelection(TileUUID);
      return false;
    }
    // Pending-adoption tiles are selectable (for Identify), but clicking the
    // Adopt button must not toggle selection.
    if ($(this).hasClass('PENDING')) {
      if ($(e.target).closest('.ADOPT_BTN, [data-type="PENDING_ACTION"]').length) return false;
      const PendingUUID = $(this).attr('data-uuid');
      if (PendingUUID) ToggleSelection(PendingUUID);
      return false;
    }
    const UUID = $(this).attr('data-uuid');
    ToggleSelection(UUID);
    return;
  });
  // Double-click opens read-only info/history views (not editors)
  $(document).on('dblclick', '.SHOWTRAK_PC', function (e) {
    e.preventDefault();
    e.stopPropagation();
    // Ignore dblclick on pending-adoption tiles
    if ($(this).hasClass('PENDING')) return false;
    // Monitoring tiles always open history on dblclick; edit mode uses the cog.
    if ($(this).hasClass('MONITOR')) {
      const tid = $(this).attr('data-target-id');
      if (tid) {
        OpenMonitoringTargetHistory(parseInt(tid, 10));
      }
      return false;
    }
    // Dummy tiles open uptime history on dblclick
    if ($(this).hasClass('DUMMY')) {
      const duid = $(this).attr('data-dummy-uuid');
      if (duid) OpenDummyClientHistory(duid);
      return false;
    }
    const uuid = $(this).attr('data-uuid');
    if (uuid) OpenClientInfo(uuid);
    return false;
  });
  wireContextMenu();

  // Close execution toast on Escape
  $(document).on('keydown.execToast', function (e) {
    if (e.key === 'Escape') {
      HideExecutionToast();
    }
  });

  UpdateIdentifyStatusBanner();
}

export async function Init() {
  window.API.OnAppMenuAction((ActionID) => {
    const id = String(ActionID || '').trim();
    if (!id) return;
    const button = document.getElementById(id);
    if (!button) return;
    button.click();
  });

  const isMacOS =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ===
      'macOS' || /Mac/i.test(navigator.platform || '');
  if (isMacOS) {
    window.API.OnWindowFullscreenChanged((IsFullscreen) => {
      document.body.classList.toggle('macos-native-fullscreen', Boolean(IsFullscreen));
    });
  }

    setConfig(await window.API.GetConfig());
  $('#APPLICATION_NAVBAR_TITLE').text(`${Config.Application.Name}`);
  $('#APPLICATION_NAVBAR_STATUS').text('');

  // Reveal dev-only debug tools on uncompiled builds (electron-forge start),
  // where app.isPackaged is false. Hidden entirely on packaged releases.
  if (!Config.Application.IsPackaged) {
    document
      .querySelectorAll('.debug-menu-item')
      .forEach((el) => el.removeAttribute('hidden'));
    $('#SHOWTRAK_DEBUG_TEST_NOTIFICATIONS').on('click', () => {
      TestAllNotifications();
    });
  }

  // The Web UI is a live control surface, not a show-file editor. Skip the
  // desktop show-file bootstrap prompts entirely on the browser surface.
  if (!Capabilities.isWeb) {
    // Show the currently open .ShowTrak file name in the navbar and keep it in
    // sync as files are opened/saved/created.
    // First, verify the previously open file still exists; if it was deleted or
    // moved, the working data is wiped so we can prompt for a fresh start.
    const [, MissingResult] = (await window.API.EnsureShowFileExists()) || [];
    if (MissingResult && MissingResult.Missing) {
      await Notify('Previous show file was missing. Open or create a new show.', 'error');
    }
    const CurrentShowFile = await window.API.GetCurrentShowFile();
    RenderShowFileName(CurrentShowFile);
    window.API.OnShowFileUpdated((Path) => RenderShowFileName(Path));

    // When no show is open, prompt the user to open one or create a new show.
    $('#NO_SHOW_OPEN').on('click', async () => {
      await OpenShow();
      const Opened = await window.API.GetCurrentShowFile();
      if (Opened) closeModal('SHOWTRAK_MODAL_NO_SHOW');
    });
    $('#NO_SHOW_NEW').on('click', async () => {
      const [Err] = await window.API.NewShow();
      if (Err) {
        await Notify(String(Err), 'error');
        return;
      }
      closeModal('SHOWTRAK_MODAL_NO_SHOW');
      await Notify('Created new show.', 'success');
    });

    // Legacy-data migration guard: force a Save As before continuing so data from
    // a pre-show-file version is not lost.
    $('#MIGRATE_SAVE').on('click', async () => {
      await SaveShowAs();
      const Saved = await window.API.GetCurrentShowFile();
      if (Saved) closeModal('SHOWTRAK_MODAL_MIGRATE');
    });

    if (!CurrentShowFile) {
      const HasLegacyData = await window.API.HasUnsavedShowData();
      if (HasLegacyData) {
        openModal('SHOWTRAK_MODAL_MIGRATE');
      } else {
        openModal('SHOWTRAK_MODAL_NO_SHOW');
      }
    }
  } else {
    // Ensure the desktop-only modal never leaks into the browser surface.
    closeModal('SHOWTRAK_MODAL_NO_SHOW');
    closeModal('SHOWTRAK_MODAL_MIGRATE');
  }

  $('#SHOWTRAK_MODEL_CORE_OPEN_SETTINGS').on('click', async () => {
    await CloseAllModals();
    openModal('SHOWTRAK_MODAL_SETTINGS');
  });

  $('#SHOWTRAK_ABOUT_BUTTON').on('click', async () => {
    await OpenAboutModal();
  });

  $('#SHOWTRAK_ABOUT_WEBSITE').on('click', async () => {
    await window.API.OpenShowTrakWebsiteInBrowser();
  });

  $('#SHOWTRAK_ABOUT_GITHUB').on('click', async () => {
    await window.API.OpenShowTrakGithubInBrowser();
  });

  $('#SHOWTRAK_ABOUT_DEPENDENCIES').on(
    'click',
    '.SHOWTRAK_ABOUT_DEPENDENCY_LINK',
    async (Event) => {
      const PackageName = $(Event.currentTarget).attr('data-package-name');
      if (!PackageName) return;
      await window.API.OpenNpmPackageInBrowser(PackageName);
    }
  );

  const settingsMenu = document.getElementById('SETTINGS_MENU');
  $('#SETTINGS_MENU_DROPDOWN')
    .off('shown.bs.dropdown.settingsOffset hidden.bs.dropdown.settingsOffset')
    .on('shown.bs.dropdown.settingsOffset', () => {
      if (!settingsMenu) return;
      const currentTransform = settingsMenu.style.transform || '';
      if (currentTransform.includes('translateY(-10px)')) return;
      settingsMenu.style.transform = `${currentTransform} translateY(-10px)`.trim();
    })
    .on('hidden.bs.dropdown.settingsOffset', () => {
      if (!settingsMenu) return;
      const currentTransform = settingsMenu.style.transform || '';
      settingsMenu.style.transform = currentTransform
        .replace(' translateY(-10px)', '')
        .replace('translateY(-10px)', '')
        .trim();
    });

  $('#ADD_TARGET_MANUAL_ACTION').on('click', async () => {
    await OpenMonitoringTargetEditor(null);
  });

  $('#ADD_DUMMY_CLIENT_ACTION').on('click', async () => {
    await OpenDummyClientEditor(null);
  });

  $('#ADD_UNASSIGNED_CLIENT_ACTION').on('click', async () => {
    await OpenUnassignedClientCreationModal();
  });
  await RefreshUnassignedClientMenuVisibility();

  $('#ADD_TARGET_BROWSE_ACTION').on('click', async () => {
    await OpenNetworkDiscoveryModal();
  });

  $('#ADD_GROUP_ACTION').on('click', async () => {
    await OpenGroupCreationModal();
  });

  $('#ADD_ALERT_ACTION').on('click', async () => {
    await OpenCreateAlertRuleEditor();
  });

  const addTargetMenu = document.getElementById('ADD_MONITORING_TARGET_MENU');
  $('#ADD_MONITORING_TARGET_DROPDOWN')
    .off('shown.bs.dropdown.addTargetOffset hidden.bs.dropdown.addTargetOffset')
    .on('shown.bs.dropdown.addTargetOffset', () => {
      if (!addTargetMenu) return;
      const currentTransform = addTargetMenu.style.transform || '';
      if (currentTransform.includes('translateY(-10px)')) return;
      addTargetMenu.style.transform = `${currentTransform} translateY(-10px)`.trim();
    })
    .on('hidden.bs.dropdown.addTargetOffset', () => {
      if (!addTargetMenu) return;
      const currentTransform = addTargetMenu.style.transform || '';
      addTargetMenu.style.transform = currentTransform
        .replace(' translateY(-10px)', '')
        .replace('translateY(-10px)', '')
        .trim();
    });

  $('#NETWORK_DISCOVERY_TOGGLE_SCAN').on('click', async () => {
    if (NetworkDiscoveryScanning) {
      await StopNetworkDiscoveryScan();
      SetNetworkDiscoveryStatus('Stopped');
      return;
    }
    await StartNetworkDiscoveryScan();
  });

  $('#NETWORK_DISCOVERY_RESULTS')
    .off('click', '.NETWORK_DISCOVERY_ADD')
    .on('click', '.NETWORK_DISCOVERY_ADD', async function () {
      const id = String($(this).attr('data-id') || '')
        .trim()
        .toLowerCase();
      if (!id || !NetworkDiscoveryResults.has(id)) return;
      const selected = NetworkDiscoveryResults.get(id);
      await StopNetworkDiscoveryScan();
      await OpenMonitoringTargetEditor(null, {
        Nickname: selected.Name || '',
        Address: selected.Address || '',
        Method: selected.MethodHint || null,
      });
    });

  $('#SHOWTRAK_MODAL_NETWORK_DISCOVERY')
    .off('hidden.bs.modal.networkDiscovery')
    .on('hidden.bs.modal.networkDiscovery', async () => {
      await StopNetworkDiscoveryScan();
      ResetNetworkDiscoveryState();
    });

  $('#SHOWTRAK_CLIENT_INFO')
    .off('shown.bs.modal.monitorHistory')
    .on('shown.bs.modal.monitorHistory', () => {
      RenderMonitoringHistoryModal();
    });

  $('#MONITOR_HISTORY_EDIT_BUTTON')
    .off('click.monitorHistoryEdit')
    .on('click.monitorHistoryEdit', async function (e) {
      e.preventDefault();
      if (AppMode !== 'EDIT') return;
      const TargetID = Number($(this).attr('data-target-id'));
      if (!Number.isFinite(TargetID)) return;
      await OpenMonitoringTargetEditor(TargetID);
    });

  // Hover tooltip for status-timeline blocks (delegated; container persists).
  $('#MONITOR_HISTORY_TIMELINES')
    .off('mousemove.statusTt mouseleave.statusTt')
    .on('mousemove.statusTt', '.status-timeline-block', function (e) {
            setMonitorHistoryTooltipHover({ x: e.clientX, y: e.clientY });
      ShowStatusTimelineTooltip(this, e.clientX, e.clientY);
    })
    .on('mouseleave.statusTt', function () {
            setMonitorHistoryTooltipHover(null);
      HideStatusTimelineTooltip();
    });

  window.API.OnNetworkDeviceScanEvent((Event) => {
    HandleNetworkDiscoveryEvent(Event);
  });

  $('#SHOWTRAK_MODEL_CORE_OSC_ROUTE_LIST_BUTTON').on('click', async () => {
    await OpenOSCDictionary();
  });

  $('#SHOWTRAK_MODEL_CORE_OSC_HTTP_DEBUG_BUTTON').on('click', async () => {
    await OpenOscHttpDebugTerminal();
  });

  $('#SHOWTRAK_MODEL_CORE_SCRIPT_MANAGER_BUTTON').on('click', async () => {
    await OpenScriptManager();
  });

  $('#SHOWTRAK_MODEL_CORE_GROUP_MANAGER_BUTTON').on('click', async () => {
    await OpenGroupManager();
  });

  $('#SHOWTRAK_MODEL_CORE_TAG_MANAGER_BUTTON').on('click', async () => {
    await OpenTagManager();
  });

  $('#SHOWTRAK_MODEL_CORE_ALERT_MANAGER_BUTTON').on('click', async () => {
    await OpenAlertRuleManager();
  });

  $('#SHOWTRAK_MODEL_CORE_UPDATE_MANAGER_BUTTON').on('click', async () => {
    await OpenUpdateManagerModal();
  });

  $('#SHOWTRAK_MODEL_CORE_LOGSFOLDER').on('click', async () => {
    await window.API.OpenLogsFolder();
  });

  $('#SHOWTRAK_MODEL_CORE_SCRIPTSFOLDER').on('click', async () => {
    await window.API.OpenScriptsFolder();
  });

  $('#SHOWTRAK_MODEL_CORE_SAVEAS').on('click', async () => {
    await SaveShowAs();
  });

  $('#SHOWTRAK_MODEL_CORE_SAVE').on('click', async () => {
    await SaveShow();
  });

  $('#SHOWTRAK_MODEL_CORE_OPEN').on('click', async () => {
    await OpenShow();
  });

  $('#SHOWTRAK_MODEL_CORE_NEW').on('click', async () => {
    await NewShow();
  });

  $('#SHOWTRAK_MODEL_CORE_SUPPORTDISCORD').on('click', async () => {
    await window.API.OpenDiscordInviteLinkInBrowser();
  });

  $('#SHOWTRAK_MODEL_CORE_SHUTDOWN_BUTTON').on('click', async () => {
    await window.API.Shutdown();
  });

  window.API.OnUpdateManagerDownloadProgress((Progress) => {
    try {
      if (!Progress) return;
      const Percent = typeof Progress.percent === 'number' ? Progress.percent : 0;
      const Message = Progress.message || '';
      setUpdateManagerDownloadInProgress((Progress.phase || '') !== 'complete');
      SetUpdateManagerDownloadProgress(Percent, Message);
      ApplyUpdateManagerButtonLocks();
    } catch (e) {
      HandleNonFatalError('UpdateManager:DownloadProgress', e);
    }
  });

  // Initialize application mode from backend and wire toggle
  try {
    const mode = await window.API.GetMode();
    RenderMode(mode);
  } catch (_) {
    RenderMode('SHOW');
  }

  await window.API.Loaded();
  UpdateIdentifyStatusBanner();
}

