// Right-click / mobile context-menu wiring, extracted verbatim from the
// ~700-line block that used to live inline in init.ts WireGlobalUI. It owns
// the `#SHOWTRAK_CONTEXT_MENU` element and everything scoped to it: option
// construction, positioning, keyboard/type-ahead navigation, the mobile
// tap-to-confirm arming, and the outside-click / Escape close paths. init.ts
// calls wireContextMenu() from WireGlobalUI in place of the old inline block.
import type { ClientView, ScriptWhitelistScope } from '@showtrak/protocol';
import { AllClients, ScriptList, Selected, setScriptList } from './01-state';
import { GetSettingValue } from './03-settings';
import { HandleNonFatalError, Safe } from './04-utils';
import { ExecuteScript, TriggerIntegratedEvent } from './11-modals';
import { ApplyIdentifyStateLocally, ConfirmationDialog, GetIdentifyTargetByUUID, Notify, ShowExecutionToast, StopIdentifyingForUUIDs } from './14-selection-init';
import { ClearSelection, Select, SelectAll } from './selection';

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

// True when a client is permitted to run a script under that script's per-show
// whitelist. A null/absent scope or Workspace:true means unrestricted (all
// clients) — the default. Otherwise the client must be a whitelisted UUID or
// belong to a whitelisted group. Mirrors the server-side gate in
// ScriptWhitelistManager.IsClientAllowed (the authoritative check); this copy
// just keeps non-whitelisted clients out of the menu in the first place.
function IsClientWhitelisted(
  Scope: ScriptWhitelistScope | null | undefined,
  Client: ClientView
): boolean {
  if (!Scope || Scope.Workspace) return true;
  if (!Client || !Client.UUID) return false;
  if (Array.isArray(Scope.Clients) && Scope.Clients.includes(Client.UUID)) return true;
  if (
    Client.GroupID != null &&
    Array.isArray(Scope.Groups) &&
    Scope.Groups.includes(Number(Client.GroupID))
  ) {
    return true;
  }
  return false;
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

export function wireContextMenu() {
  const $menu = $('#SHOWTRAK_CONTEXT_MENU');
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
          // A client is a valid target only if the script supports its OS AND
          // the script's whitelist admits it. A script with zero admitted
          // clients in the current selection is skipped entirely (not shown);
          // with a mix, it shows once and runs only for the admitted subset.
          const Targets = RemoteClients.filter(
            (Client) =>
              Client.OperatingSystem &&
              Compatible.includes(Client.OperatingSystem) &&
              IsClientWhitelisted(Script.Whitelist, Client)
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
                // Results is mapped 1:1 from UUIDs, so Index is always in range
                if (Err) Failed.push({ UUID: UUIDs[Index]!, Error: Err });
                else Succeeded.push(UUIDs[Index]!);
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
          // $focusable.length > 0 guarded above, so first() has an element
          $focusable.first().trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
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
          // pos is (start + k) % titles.length, always in range
          if (titles[pos]!.startsWith(buf)) {
            found = pos;
            break;
          }
        }
        if (found === -1) {
          for (let k = 0; k < titles.length; k++) {
            const pos = (start + k) % titles.length;
            if (titles[pos]!.includes(buf)) {
              found = pos;
              break;
            }
          }
        }
        if (found !== -1) {
          const $t = $items.eq(found);
          // found is a valid index into $items
          $t.trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      if (key === 'ArrowDown') {
        ev.preventDefault();
        idx = (idx + 1 + $items.length) % $items.length;
        // idx wrapped into $items range above
        $items.eq(idx).trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'ArrowUp') {
        ev.preventDefault();
        idx = (idx - 1 + $items.length) % $items.length;
        $items.eq(idx).trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'Home') {
        ev.preventDefault();
        // $items.length !== 0 guarded above
        $items.first().trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (key === 'End') {
        ev.preventDefault();
        $items.last().trigger('focus')[0]!.scrollIntoView({ block: 'nearest' });
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
}
