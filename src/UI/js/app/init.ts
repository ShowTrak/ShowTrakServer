// Renderer bootstrap (REFACTOR_PLAN.md Phase 7 item 2).
//
// Everything here used to run as import-time side effects in
// 14-selection-init.ts: a jQuery document-ready IIFE (global context-menu /
// tile / keybind wiring) and Init() (show-file bootstrap, cogs-menu wiring and
// the final window.API.Loaded() handshake). The bootstrap orchestrator in
// main.ts calls WireGlobalUI() then Init(), after every module's Init*()
// subscriptions are registered — Loaded() must stay last so the main process
// pushes initial state only once every subscriber is listening.
import type { ClientView } from '@showtrak/protocol';
import { closeModal, openModal } from './lib/modal';
import { AllClients, AppMode, Capabilities, Config, NetworkDiscoveryResults, NetworkDiscoveryScanning, ScriptList, Selected, __LastGroups, setConfig, setMonitorHistoryTooltipHover, setScriptList, setUpdateManagerDownloadInProgress } from './01-state';
import { RenderMode } from './02-mode';
import { GetSettingValue } from './03-settings';
import { HandleNonFatalError, Safe } from './04-utils';
import { HideStatusTimelineTooltip, OpenDummyClientHistory, OpenMonitoringTargetHistory, RenderMonitoringHistoryModal, ShowStatusTimelineTooltip } from './07-monitoring';
import { OpenOSCDictionary, OpenOscHttpDebugTerminal } from './09-osc-feeds';
import { ApplyUpdateManagerButtonLocks, CloseAllModals, ExecuteScript, NewShow, OpenAboutModal, OpenClientEditor, OpenGroupCreationModal, OpenGroupManager, OpenShow, OpenUpdateManagerModal, RenderShowFileName, SaveShow, SaveShowAs, SetUpdateManagerDownloadProgress, TriggerIntegratedEvent } from './11-modals';
import { HandleNetworkDiscoveryEvent, OpenMonitoringTargetEditor, OpenNetworkDiscoveryModal, ResetNetworkDiscoveryState, SetNetworkDiscoveryStatus, StartNetworkDiscoveryScan, StopNetworkDiscoveryScan } from './12-monitoring-editor';
import { OpenAlertRuleManager, OpenCreateAlertRuleEditor } from './13-alert-rules';
import { ApplyIdentifyStateLocally, ConfirmationDialog, GetIdentifyTargetByUUID, GetIdentifyingUUIDs, HideExecutionToast, Notify, ShowExecutionToast, StopIdentifyingForUUIDs, UpdateIdentifyStatusBanner } from './14-selection-init';
import { OpenClientInfo } from './client-info-modal';
import { OpenScriptManager } from './15-script-manager';
import { OpenDummyClientEditor } from './16-dummy-clients';
import { ClearSelection, Select, SelectAll, SelectByGroup, ToggleSelection } from './selection';
import { wireAppUpdates } from './wire-app-updates';

// One row in the right-click / mobile context menu. `Type` selects how the row
// renders (informational label, divider, or actionable item); the remaining
// fields are only meaningful for `Action` (and `Info`) rows.
interface ContextMenuOption {
  Type: string;
  Title?: string;
  Class?: string;
  Shortcut?: string;
  Icon?: string;
  IconColour?: string;
  Action?: () => unknown;
}

// True when the UI is in the compact mobile layout (see InitMobileView in
// 02-mode.ts, which toggles `body.mobile-view`). Used to switch the context
// menu into its full-width, tap-to-confirm behaviour.
function IsMobileContextMenu(): boolean {
  return document.body.classList.contains('mobile-view');
}

// Put a context-menu row into its "Tap to confirm" armed state, reverting any
// other row that was previously armed. A second tap on the armed row runs the
// action (handled by the row's own click binding).
function ArmContextMenuRow($menu: JQuery, $row: JQuery) {
  $menu.find('a.context-confirm-pending').each(function (this: HTMLElement) {
    const $other = $(this);
    if ($other.is($row)) return;
    $other.removeClass('context-confirm-pending');
    const orig = $other.data('optionTitle');
    if (typeof orig === 'string') $other.find('.context-title').text(orig);
  });
  $row.addClass('context-confirm-pending');
  $row.find('.context-title').text('Tap to confirm');
}

// Global UI wiring: context menu, tile clicks, group keybinds, app-update
// modal and the identify banner. Body unchanged from the former jQuery
// document-ready IIFE.
export async function WireGlobalUI() {
  const $menu = $('#SHOWTRAK_CONTEXT_MENU');

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
  $(document).on('contextmenu', 'html', async function (e) {
    e.preventDefault();

    const $tile = $(e.target).closest('.SHOWTRAK_PC');
    if ($tile.length) {
      const TileUUID = $tile.attr('data-uuid');
      // Client, monitoring and dummy tiles are all selectable targets; groups
      // are not. Right-clicking a not-yet-selected tile narrows the selection
      // to just that tile before the menu is built.
      const IsSelectableTile = TileUUID && !$tile.hasClass('GROUP');
      if (IsSelectableTile && !Selected.includes(TileUUID)) {
        ClearSelection();
        Select(TileUUID);
      }
    }

    const Options: ContextMenuOption[] = [];

    if (Selected.length == 0) {
      Options.push({
        Type: 'Info',
        Title: 'No Selected Clients',
        Class: 'text-muted',
      });
    }

    if (Selected.length > 0) {
      // Actions are grouped into sections by the type of selected entity:
      //  - Scripts        -> remote (OS) clients, filtered to their platform.
      //  - Remote Events  -> integrated clients, from their declared actions.
      //  - Monitoring     -> monitoring targets (monitor: prefixed selection).
      //  - Dummy Clients  -> dummy clients (dummy: prefixed selection).
      // Every option offered by ANY selected type is displayed, but each action
      // only runs against the compatible subset of the selection. A section is
      // only rendered when it has at least one option.
      const CONTEXT_COLOUR_PALETTE = [
        '#e74c3c',
        '#e67e22',
        '#f1c40f',
        '#2ecc71',
        '#3498db',
        '#9b59b6',
        '#bdc3c7',
        '#7f8c8d',
      ];
      const ColourFromIndex = (Index: unknown) =>
        typeof Index === 'number' && Index >= 0 && Index <= 7
          ? CONTEXT_COLOUR_PALETTE[Index]
          : '#bdc3c7';

      setScriptList(ScriptList.sort((a, b) => (a.Weight || 0) - (b.Weight || 0)));

      const IsIntegratedClient = (Client: ClientView) =>
        !!(Client && (Client.Integrated || Client.OperatingSystem === 'Integrated'));

      // Partition the selection by entity type. Monitoring and dummy tiles carry
      // prefixed selection UUIDs (monitor:<TargetID> / dummy:<UUID>); everything
      // else is a plain adopted-client UUID.
      const MonitorTargetIDs: string[] = [];
      const DummyUUIDs: string[] = [];
      const ClientUUIDs: string[] = [];
      for (const UUID of Selected) {
        const Value = String(UUID);
        if (Value.startsWith('monitor:')) MonitorTargetIDs.push(Value.slice('monitor:'.length));
        else if (Value.startsWith('dummy:')) DummyUUIDs.push(Value.slice('dummy:'.length));
        else ClientUUIDs.push(UUID);
      }

      const SelectedClients = ClientUUIDs.map((UUID) =>
        AllClients.find((c) => c && c.UUID === UUID)
      ).filter((c): c is NonNullable<typeof c> => Boolean(c));
      const RemoteClients = SelectedClients.filter((Client) => !IsIntegratedClient(Client));
      const IntegratedClients = SelectedClients.filter((Client) => IsIntegratedClient(Client));

      // Sections are grouped by client type and separated by a divider; the
      // first section has no leading divider.
      let SectionsRendered = 0;
      const PushSection = (_Title: string) => {
        if (SectionsRendered > 0) Options.push({ Type: 'Divider' });
        SectionsRendered += 1;
      };

      // --- Scripts (remote clients) ---------------------------------------
      // A script is offered if it is compatible with ANY selected remote client;
      // running it targets only the remote clients whose OS it supports.
      if (RemoteClients.length > 0) {
        const ScriptOptions: ContextMenuOption[] = [];
        for (const Script of ScriptList) {
          const Compatible = Array.isArray(Script.CompatiblePlatforms)
            ? Script.CompatiblePlatforms
            : [];
          const Targets = RemoteClients.filter(
            (Client) => Client.OperatingSystem && Compatible.includes(Client.OperatingSystem)
          ).map((Client) => Client.UUID);
          if (!Targets.length) continue;
          // Each script carries a chosen Bootstrap Icons name (bare, no "bi-"),
          // set via the Script Manager's icon picker; fall back to the generic
          // terminal glyph for older scripts without one.
          const ScriptIconName =
            typeof Script.Icon === 'string' && Script.Icon.trim() ? Script.Icon.trim() : 'terminal';
          ScriptOptions.push({
            Type: 'Action',
            Title: `${Script.Name}`,
            Class: '',
            // Scripts show their chosen icon tinted with their assigned colour.
            Icon: `bi-${ScriptIconName}`,
            IconColour: ColourFromIndex(Script.Colour),
            Action: async function () {
              if (Script.Confirmation) {
                const Confirmation = await ConfirmationDialog(
                  `Are you sure you want to run "${Script.Name}" on ${Targets.length} ${
                    Targets.length == 1 ? 'Client' : 'Clients'
                  }?`
                );
                if (!Confirmation) return;
              }
              await ExecuteScript(Script.ID, Targets, true);
            },
          });
        }
        if (ScriptOptions.length > 0) {
          PushSection('Scripts');
          Options.push(...ScriptOptions);
        }
      }

      // --- Remote Events (integrated clients) -----------------------------
      // An event is offered if ANY selected integrated client declares it;
      // triggering it targets only the integrated clients that declare it.
      if (IntegratedClients.length > 0) {
        const EventCatalogue = new Map();
        const EventTargets = new Map();
        for (const Client of IntegratedClients) {
          const Actions = Array.isArray(Client.IntegratedActions) ? Client.IntegratedActions : [];
          for (const Action of Actions) {
            if (!Action || !Action.ID) continue;
            if (!EventCatalogue.has(Action.ID)) EventCatalogue.set(Action.ID, Action);
            if (!EventTargets.has(Action.ID)) EventTargets.set(Action.ID, []);
            EventTargets.get(Action.ID).push(Client.UUID);
          }
        }
        const EventOptions = [...EventCatalogue.values()]
          .sort((a, b) => String(a.Label || '').localeCompare(String(b.Label || '')))
          .map((Event) => ({
            Type: 'Action',
            Title: `${Event.Label || Event.ID}`,
            Class: '',
            // Events mirror scripts: a terminal icon tinted with the event's
            // colour, replacing the old colour dot.
            Icon: 'bi-terminal',
            IconColour: ColourFromIndex(Event.ColourIndex),
            Action: async function () {
              await TriggerIntegratedEvent(Event.ID, EventTargets.get(Event.ID) || []);
            },
          }));
        if (EventOptions.length > 0) {
          PushSection('Remote Events');
          Options.push(...EventOptions);
        }
      }

      // --- Monitoring targets --------------------------------------------
      if (MonitorTargetIDs.length > 0) {
        PushSection('Monitoring');
        Options.push({
          Type: 'Action',
          Title: 'Run Checks Now',
          Class: 'text-light',
          Icon: 'bi-arrow-repeat',
          IconColour: '#3498db',
          Action: async function () {
            Notify(
              MonitorTargetIDs.length === 1
                ? 'Running checks…'
                : `Running checks on ${MonitorTargetIDs.length} monitors…`,
              'info'
            );
            try {
              await Promise.all(
                MonitorTargetIDs.map((TargetID) =>
                  window.API.RunAllMonitoringChecksNow(String(TargetID))
                )
              );
            } catch (err) {
              HandleNonFatalError('SelectionInit:RunChecksNow', err);
            }
          },
        });
      }

      // --- Dummy clients --------------------------------------------------
      if (DummyUUIDs.length > 0) {
        PushSection('Dummy Clients');
        Options.push({
          Type: 'Action',
          Title: 'Reset to Idle',
          Class: 'text-light',
          Icon: 'bi-arrow-counterclockwise',
          IconColour: '#e67e22',
          Action: async function () {
            Notify(
              DummyUUIDs.length === 1
                ? 'Resetting to idle…'
                : `Resetting ${DummyUUIDs.length} dummy clients to idle…`,
              'info'
            );
            try {
              await Promise.all(
                DummyUUIDs.map((UUID) => window.API.ResetDummyClientToIdle(UUID))
              );
            } catch (err) {
              HandleNonFatalError('SelectionInit:ResetDummyToIdle', err);
            }
          },
        });
      }

      if (SectionsRendered > 0) {
        Options.push({ Type: 'Divider' });
      }

      // Identify / Stop Identifying for selected clients.
      const IdentifyTargets = Selected.map((UUID) => GetIdentifyTargetByUUID(UUID)).filter(
        (Target) => Target && Target.Eligible
      );
      const IdentifyStartTargets = IdentifyTargets.filter((Target) => !Target.IsIdentifying);
      const IdentifyStopTargets = IdentifyTargets.filter((Target) => Target.IsIdentifying);

      if (IdentifyStartTargets.length > 0) {
        Options.push({
          Type: 'Action',
          Title: IdentifyStartTargets.length === 1 ? 'Identify Client' : 'Identify Clients',
          Class: 'text-light',
          Icon: 'bi-broadcast-pin',
          IconColour: '#2ecc71',
          Action: async function () {
            try {
              const UUIDs = IdentifyStartTargets.map((Target) => Target.UUID);
              const Results = await Promise.all(
                UUIDs.map((UUID) => window.API.IdentifyClient(UUID))
              );
              const Succeeded: string[] = [];
              const Failed: { UUID: string; Error: unknown }[] = [];
              Results.forEach((Result, Index) => {
                const Err = Array.isArray(Result) ? Result[0] : null;
                if (Err) Failed.push({ UUID: UUIDs[Index], Error: Err });
                else Succeeded.push(UUIDs[Index]);
              });
              if (Succeeded.length) ApplyIdentifyStateLocally(Succeeded, true);
              const Errors = Failed.map((Entry) => Entry.Error).filter(Boolean);
              if (Errors.length) Notify(String(Errors[0]), 'danger');
            } catch (err) {
              HandleNonFatalError('SelectionInit:Identify', err);
            }
          },
        });
      }

      if (IdentifyStopTargets.length > 0) {
        Options.push({
          Type: 'Action',
          Title:
            IdentifyStopTargets.length === 1 ? 'Stop Identifying' : 'Stop Identifying Selected',
          Class: 'text-light',
          Icon: 'bi-slash-circle',
          IconColour: '#f1c40f',
          Action: async function () {
            try {
              await StopIdentifyingForUUIDs(IdentifyStopTargets.map((Target) => Target.UUID));
            } catch (err) {
              HandleNonFatalError('SelectionInit:StopIdentify', err);
            }
          },
        });
      }

      if (IdentifyStartTargets.length + IdentifyStopTargets.length > 0) {
        Options.push({ Type: 'Divider' });
      }
    }

    if (Selected.length > 0) {
      // Wake On LAN only applies to real adopted clients; monitoring and dummy
      // tiles carry prefixed selection UUIDs and are excluded.
      const WolTargets = Selected.filter(
        (UUID) => !String(UUID).startsWith('monitor:') && !String(UUID).startsWith('dummy:')
      );
      const SYSTEM_ALLOW_WOL = await GetSettingValue('SYSTEM_ALLOW_WOL');
      if (SYSTEM_ALLOW_WOL && WolTargets.length > 0) {
        Options.push({
          Type: 'Action',
          Title: 'Wake On LAN',
          Class: 'text-light',
          Icon: 'bi-power',
          IconColour: '#2ecc71',
          Action: async function () {
            window.API.WakeOnLan(WolTargets);
            ShowExecutionToast();
          },
        });
      }
      Options.push({
        Type: 'Action',
        Title: 'Clear Selection',
        Class: 'text-light',
        Shortcut: 'Ctrl+D',
        Icon: 'bi-x-circle',
        IconColour: '#e74c3c',
        Action: async function () {
          ClearSelection();
        },
      });
    }

    Options.push({
      Type: 'Action',
      Title: 'Select All',
      Class: 'text-light',
      Shortcut: 'Ctrl+A',
      Icon: 'bi-check-all',
      IconColour: '#3498db',
      Action: async function () {
        SelectAll();
      },
    });

    $menu.html('');
    $menu.append(
      `<div class="context-menu-header">` +
        `<span class="context-menu-close" role="button" aria-label="Dismiss menu" tabindex="-1">Dismiss</span>` +
        `</div>`
    );
    $menu.append(`<div class="context-menu-options"></div>`);
    const $options = $menu.find('.context-menu-options');

    Options.forEach((option) => {
      if (option.Type === 'Divider') {
        $options.append(`<hr>`);
      }
      if (option.Type === 'Info') {
        $options.append(
          `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(
            option.Class
          )}" role="menuitem" aria-disabled="true" tabindex="-1">` +
            `<span class="context-title">${Safe(option.Title)}</span>` +
            `<span class="context-shortcut">${Safe(option.Shortcut || '')}</span>` +
            `</a>`
        );
      }
      if (option.Type === 'Action') {
        // Every action renders a fixed-width icon slot so titles line up in a
        // single column regardless of glyph width. The icon colour is applied
        // inline; when absent the slot inherits the row's text colour.
        const iconClass = option.Icon || 'bi-dot';
        const iconStyle = option.IconColour ? ` style="color:${option.IconColour}"` : '';
        const iconHtml = `<span class="context-icon"><i class="bi ${Safe(
          iconClass
        )}"${iconStyle}></i></span>`;
        $options.append(
          `<a class="SHOWTRAK_CONTEXTMENU_BUTTON dropdown-item ${Safe(
            option.Class
          )}" role="menuitem" tabindex="-1">` +
            iconHtml +
            `<span class="context-title">${Safe(option.Title)}</span>` +
            `<span class="context-shortcut">${Safe(option.Shortcut || '')}</span>` +
            `</a>`
        );
        const $option = $options.find('a:last');
        // Stash the original title so a pending row can be restored (e.g. when
        // another row is tapped and this one reverts out of its confirm state).
        $option.data('optionTitle', String(option.Title || ''));
        $option.on('click', function (ev) {
          // On mobile the first tap arms the row ("Tap to confirm"); only the
          // second tap on the same, already-armed row runs the action. Desktop
          // (right-click) keeps single-click activation.
          if (IsMobileContextMenu()) {
            const $this = $(this);
            if (!$this.hasClass('context-confirm-pending')) {
              ev.preventDefault();
              ev.stopPropagation();
              ArmContextMenuRow($menu, $this);
              return;
            }
          }
          option.Action!();
        });
      }
    });

    // Calculate menu position to prevent overflow and keep it within viewport bounds
    const viewportWidth = window.innerWidth || $(window).width() || 0;
    const viewportHeight = window.innerHeight || $(window).height() || 0;
    const edgePadding = 8;
    const boundsEl =
      document.getElementById('APPLICATION_CONTAINER') ||
      document.getElementById('APPLICATION') ||
      document.documentElement;
    const boundsRect = boundsEl.getBoundingClientRect();
    const navbarEl = document.querySelector('.dragbar');
    const navbarRect = navbarEl ? navbarEl.getBoundingClientRect() : null;
    const minX = Math.max(edgePadding, Math.floor(boundsRect.left) + edgePadding);
    const containerMinY = Math.max(edgePadding, Math.floor(boundsRect.top) + edgePadding);
    const navbarMinY = navbarRect
      ? Math.min(viewportHeight - edgePadding, Math.floor(navbarRect.bottom) + edgePadding)
      : edgePadding;
    const minY = Math.max(containerMinY, navbarMinY);
    const maxX = Math.min(viewportWidth - edgePadding, Math.floor(boundsRect.right) - edgePadding);
    const isMobileMenu = IsMobileContextMenu();
    // On mobile the sheet must float above the fixed bottom bar, not overlap
    // it, so pull the usable bottom edge up by the bar's height plus a gap.
    const mobileBottomInset = isMobileMenu
      ? (() => {
          const barEl = document.getElementById('APP_BOTTOM_BAR');
          const barHeight = barEl ? barEl.getBoundingClientRect().height : 0;
          return barHeight + edgePadding;
        })()
      : 0;
    const maxY = Math.min(
      viewportHeight - edgePadding - mobileBottomInset,
      Math.floor(boundsRect.bottom) - edgePadding - mobileBottomInset
    );
    const availableHeight = Math.max(120, maxY - minY);
    // Allow the menu to use most of the available UI height while still
    // staying inside the viewport-clamped UI bounds.
    const maxMenuHeight = Math.max(220, Math.floor(availableHeight - edgePadding));

    // Measure with intended max height before final placement. Mobile uses
    // `display: flex` so the header stays pinned while .context-menu-options
    // scrolls internally; desktop uses `block`. We set this inline (rather than
    // leaning on a CSS rule) so the menu's default `display: none` holds until
    // it is actually opened — otherwise an empty menu floats on load.
    $menu.css({
      display: isMobileMenu ? 'flex' : 'block',
      visibility: 'hidden',
      left: 0,
      top: 0,
      'max-height': `${maxMenuHeight}px`,
    });

    const menuWidth = $menu.outerWidth() || 0;
    const menuHeight = Math.min($menu.outerHeight() || 0, maxMenuHeight);

    // Resolve the anchor point. A real mouse contextmenu carries clientX/clientY.
    // Synthetic triggers (keyboard shortcuts in 05-keyboard.ts, long-press on
    // touch) may only set pageX/pageY, so fall back to those (converting page ->
    // client for our position:fixed menu) and finally to the viewport centre.
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const hasClient = typeof e.clientX === 'number' && typeof e.clientY === 'number';
    const hasPage = typeof e.pageX === 'number' && typeof e.pageY === 'number';
    const clickX = hasClient
      ? e.clientX
      : hasPage
        ? e.pageX - scrollX
        : Math.floor(viewportWidth / 2);
    const clickY = hasClient
      ? e.clientY
      : hasPage
        ? e.pageY - scrollY
        : Math.floor(viewportHeight / 2);
    let left = clickX;
    let top = clickY;

    // Prefer opening toward available space first, then clamp to viewport
    if (left + menuWidth > maxX) {
      left = clickX - menuWidth;
    }
    if (top + menuHeight > maxY) {
      top = clickY - menuHeight;
    }

    const maxLeft = Math.max(minX, maxX - menuWidth);
    const maxTop = Math.max(minY, maxY - menuHeight);
    left = Math.min(Math.max(minX, left), maxLeft);
    top = Math.min(Math.max(minY, top), maxTop);

    if (isMobileMenu) {
      // Mobile: the menu is inset from the side edges (forced in CSS) and
      // anchored above the bottom bar so it reads as a floating sheet. Only
      // `top` needs setting here; left/right/width come from CSS. Keep the
      // inline `display: flex` set in the measurement pass so the flex layout
      // holds (and the menu's default `display: none` still governs load).
      const mobileTop = Math.max(minY, maxY - menuHeight);
      $menu.css({
        display: 'flex',
        visibility: 'visible',
        top: `${mobileTop}px`,
      });
    } else {
      $menu.css({
        display: 'block',
        visibility: 'visible',
        left: `${left}px`,
        top: `${top}px`,
      });
    }

    // A11y roles and initial focus
    $menu.attr('role', 'menu');
    const $focusable = $menu.find(
      'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
    );
    if ($focusable.length > 0) {
      setTimeout(() => {
        try {
          $focusable.first().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        } catch (err) {
          HandleNonFatalError('SelectionInit:NonFatal', err);
        }
      }, 0);
    }

    // Keyboard navigation within context menu
    $menu.off('keydown').on('keydown', function (ev) {
      const key = ev.key;
      const $items = $menu.find(
        'a.SHOWTRAK_CONTEXTMENU_BUTTON[role="menuitem"]:not([aria-disabled="true"])'
      );
      if ($items.length === 0) return;
      const activeEl = document.activeElement;
      let idx = $items.index(activeEl as Element);

      // Type-to-search (typeahead) for menu items by visible title
      const isChar =
        key && key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && key !== ' ';
      if (isChar) {
        ev.preventDefault();
        const now = Date.now();
        let buf = ($menu.data('typeaheadBuffer') || '').toString();
        const lastTime = $menu.data('typeaheadTime') || 0;
        let cycleSingle = false;
        const lower = key.toLowerCase();
        if (now - lastTime > 700) {
          buf = lower; // start new buffer after pause
        } else if (buf.length === 1 && buf === lower) {
          // repeating the same char cycles matches
          buf = lower;
          cycleSingle = true;
        } else {
          buf = (buf + lower).slice(0, 64);
        }
        $menu.data('typeaheadBuffer', buf);
        $menu.data('typeaheadTime', now);
        const prevTimer = $menu.data('typeaheadTimer');
        if (prevTimer) {
          try {
            clearTimeout(prevTimer);
          } catch (err) {
            HandleNonFatalError('SelectionInit:NonFatal', err);
          }
        }
        $menu.data(
          'typeaheadTimer',
          setTimeout(() => {
            $menu.removeData('typeaheadBuffer');
            $menu.removeData('typeaheadTimer');
            $menu.removeData('typeaheadTime');
          }, 900)
        );

        const titles = $items
          .map((i, el) => $(el).find('.context-title').text().trim().toLowerCase())
          .get();
        let start = (idx >= 0 ? idx + 1 : 0) % $items.length;
        if (cycleSingle) start = (idx >= 0 ? idx + 1 : 0) % $items.length;

        let found = -1;
        for (let k = 0; k < titles.length; k++) {
          const pos = (start + k) % titles.length;
          if (titles[pos].startsWith(buf)) {
            found = pos;
            break;
          }
        }
        if (found === -1) {
          for (let k = 0; k < titles.length; k++) {
            const pos = (start + k) % titles.length;
            if (titles[pos].includes(buf)) {
              found = pos;
              break;
            }
          }
        }
        if (found !== -1) {
          const $t = $items.eq(found);
          $t.trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      if (key === 'ArrowDown') {
        ev.preventDefault();
        idx = (idx + 1 + $items.length) % $items.length;
        $items.eq(idx).trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'ArrowUp') {
        ev.preventDefault();
        idx = (idx - 1 + $items.length) % $items.length;
        $items.eq(idx).trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'Home') {
        ev.preventDefault();
        $items.first().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'End') {
        ev.preventDefault();
        $items.last().trigger('focus')[0].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'Enter' || key === ' ') {
        ev.preventDefault();
        // Prevent bubbling to document-level handlers (e.g., confirmation toast)
        try {
          ev.stopImmediatePropagation();
        } catch (err) {
          HandleNonFatalError('SelectionInit:NonFatal', err);
        }
        try {
          ev.stopPropagation();
        } catch (err) {
          HandleNonFatalError('SelectionInit:NonFatal', err);
        }
        if (idx >= 0) {
          const $target = $items.eq(idx);
          // Defer the click so it occurs after keydown completes
          setTimeout(() => {
            try {
              $target.trigger('click');
            } catch (err) {
              HandleNonFatalError('SelectionInit:NonFatal', err);
            }
          }, 0);
        }
        return;
      }
      if (key === 'Escape') {
        ev.preventDefault();
        $menu.hide();
        return;
      }
    });

    // Hover-to-focus: hovering should take over keyboard control
    $menu
      .off('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON')
      .on('mouseenter', 'a.SHOWTRAK_CONTEXTMENU_BUTTON', function () {
        const $a = $(this);
        if ($a.attr('aria-disabled') === 'true') return;
        const prevTimer = $menu.data('typeaheadTimer');
        if (prevTimer) {
          try {
            clearTimeout(prevTimer);
          } catch (err) {
            HandleNonFatalError('SelectionInit:NonFatal', err);
          }
        }
        $menu.removeData('typeaheadBuffer');
        $menu.removeData('typeaheadTimer');
        $menu.removeData('typeaheadTime');
        $a.trigger('focus');
      });

    $menu.data('target', this);
    return;
  });
  $(document).on('click', function () {
    $menu.hide();
    return;
  });
  $menu.on('click', 'a', function (e) {
    e.stopPropagation();
    $menu.hide();
    return;
  });
  $menu.on('click', '.context-menu-close', function (e) {
    e.stopPropagation();
    $menu.hide();
    return;
  });

  // Mobile "Actions" button (bottom bar): open the context menu centred in the
  // UI. It reuses the exact same handler as a right-click by triggering a
  // synthetic `contextmenu` event with client coords at the viewport centre.
  $(document).on('click', '#MOBILE_ACTIONS_BTN', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const centerX = Math.floor((window.innerWidth || $(window).width() || 0) / 2);
    const centerY = Math.floor((window.innerHeight || $(window).height() || 0) / 2);
    const evt = $.Event('contextmenu');
    evt.pageX = centerX + (window.scrollX || window.pageXOffset || 0);
    evt.pageY = centerY + (window.scrollY || window.pageYOffset || 0);
    evt.clientX = centerX;
    evt.clientY = centerY;
    $('html').trigger(evt);
  });

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

