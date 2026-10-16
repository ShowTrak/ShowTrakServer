// The rows of the right-click / mobile context menu for the current selection.
//
// Split out of wire-context-menu.ts, which keeps the menu's mechanics
// (rendering, placement, keyboard navigation, tap-to-confirm). What the menu
// OFFERS for a selection lives here: one section per kind of selected entity,
// each action running against the compatible subset of the selection.
import type { ClientView } from '@showtrak/protocol';
import {
  AllClients,
  FreeKioskCommandsCache,
  FreeKioskTerminals,
  MonitoringTargets,
  ScriptList,
  Selected,
  Settings,
  Tags,
  setScriptList,
} from './state';
import { GetFreeKioskDisplayMode } from './freekiosk';
import { GetSettingValue } from './settings';
import { HandleNonFatalError } from './utils';
import { ExecuteScript, TriggerIntegratedEvent } from './modals';
import {
  ApplyIdentifyStateLocally,
  ConfirmationDialog,
  CriticalConfirmationDialog,
  GetIdentifyTargetByUUID,
  Notify,
  ShowExecutionToast,
  StopIdentifyingForUUIDs,
} from './selection-init';
import { ClearSelection, SelectAll } from './selection';
import {
  GetFavouritesForChecks,
  GetFavouritesForSelection,
  GetMethodAction,
  RunMonitoringAction,
} from './monitoring-actions';
import { ResolveScriptTargets } from './lib/script-targeting';
import {
  FREEKIOSK_MENU_POLL_SETTING_KEY,
  FreeKioskMenuSettingKey,
  IsFreeKioskMenuActionEnabled,
} from './lib/freekiosk-menu';

export // One row in the right-click / mobile context menu. `Type` selects how the row
// renders (informational label, divider, or actionable item); the remaining
// fields are only meaningful for `Action` (and `Info`) rows.
interface ContextMenuOption {
  Type: string;
  Title?: string;
  Class?: string;
  Shortcut?: string;
  Icon?: string;
  IconColour?: string;
  // Resolves to `false` when the user backed out of a confirmation.
  Action?: () => unknown;
  // Runs something against the selected entities, so it may clear the
  // selection afterwards (see UI_CLEAR_SELECTION_AFTER_ACTION).
  ActsOnSelection?: boolean;
}

/** Build the menu rows for the current selection (`Selected`). */
export async function BuildContextMenuOptions(): Promise<ContextMenuOption[]> {
  const Options: ContextMenuOption[] = [];

  if (Selected.length == 0) {
    Options.push({
      Type: 'Info',
      Title: 'No Targets Selected',
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

    // Partition the selection by entity type. Monitoring, dummy and FreeKiosk
    // tiles carry prefixed selection UUIDs (monitor:<TargetID>, dummy:<UUID>,
    // kiosk:<UUID>); everything else is a plain adopted-client UUID.
    const MonitorTargetIDs: string[] = [];
    // The list view's check rows (check:<CheckID>).
    const CheckIDs: string[] = [];
    const DummyUUIDs: string[] = [];
    const KioskUUIDs: string[] = [];
    const ClientUUIDs: string[] = [];
    for (const UUID of Selected) {
      const Value = String(UUID);
      if (Value.startsWith('monitor:')) MonitorTargetIDs.push(Value.slice('monitor:'.length));
      else if (Value.startsWith('check:')) CheckIDs.push(Value.slice('check:'.length));
      else if (Value.startsWith('dummy:')) DummyUUIDs.push(Value.slice('dummy:'.length));
      else if (Value.startsWith('kiosk:')) KioskUUIDs.push(Value.slice('kiosk:'.length));
      else ClientUUIDs.push(UUID);
    }
    // A check whose target is also selected is already covered by the
    // target's actions; offering it again would run it twice.
    const SelectedTargetIDs = new Set(MonitorTargetIDs.map(String));
    for (let Index = CheckIDs.length - 1; Index >= 0; Index--) {
      const Parent = MonitoringTargets.find((Target) =>
        (Target.Checks || []).some((Check) => String(Check.CheckID) === CheckIDs[Index])
      );
      if (Parent && SelectedTargetIDs.has(String(Parent.TargetID))) CheckIDs.splice(Index, 1);
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
        // A client is a valid target only if the script is enabled, supports
        // its OS AND the script's whitelist admits it. A script with zero
        // admitted clients in the current selection is skipped entirely (not shown);
        // with a mix, it shows once and runs only for the admitted subset.
        // (Rules live in ./lib/script-targeting, which is pure and tested.)
        // Tags are passed so a tag-restricted script is offered on the
        // machines that tag covers, not just the ones named outright.
        const Targets = ResolveScriptTargets(Script, RemoteClients, Tags);
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
          ActsOnSelection: true,
          Action: async function () {
            const Plural = Targets.length == 1 ? '' : 's';
            // Servers predating levels only send the boolean.
            const Level = Script.ConfirmationLevel || (Script.Confirmation ? 'Standard' : 'None');
            if (Level === 'Critical') {
              const Confirmation = await CriticalConfirmationDialog({
                title: Script.Name,
                message: `Are you sure you want to run "${Script.Name}" on ${Targets.length} client${Plural}?`,
                items: Targets.map((UUID) => {
                  const Client = RemoteClients.find((c) => c.UUID === UUID);
                  return (Client && (Client.Nickname || Client.Hostname)) || UUID;
                }),
                confirmLabel: 'Run Script',
              });
              if (!Confirmation) return false;
            } else if (Level === 'Standard') {
              const Confirmation = await ConfirmationDialog(
                `Are you sure you want to run "${Script.Name}" on ${Targets.length} client${Plural}?`,
                { ConfirmLabel: 'Run Script' }
              );
              if (!Confirmation) return false;
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
          // Events mirror scripts: the icon the integrated client declared,
          // tinted with the event's colour. Clients on an SDK that predates
          // icons send none, and the server defaults them to the terminal
          // glyph; the fallback here covers anything that slipped through.
          Icon: `bi-${
            typeof Event.Icon === 'string' && Event.Icon.trim() ? Event.Icon.trim() : 'terminal'
          }`,
          IconColour: ColourFromIndex(Event.ColourIndex),
          ActsOnSelection: true,
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

      // Starred check actions first: they are the things an operator reaches
      // for mid-show (power a row of projectors on, close their shutters),
      // whereas Run Checks Now is a diagnostic. A favourite is offered when
      // ANY selected monitor has a check of its method and runs only on those
      // — the same rule the script and remote-event sections above follow.
      for (const { Favourite, TargetIDs } of GetFavouritesForSelection(MonitorTargetIDs)) {
        const Action = GetMethodAction(Favourite.Method, Favourite.ActionID);
        Options.push({
          Type: 'Action',
          Title: Favourite.Label,
          Class: Action && Action.Destructive ? 'text-warning' : 'text-light',
          Icon: `bi-${Favourite.Icon || 'lightning'}`,
          IconColour: Action && Action.Destructive ? '#e74c3c' : '#9b59b6',
          ActsOnSelection: true,
          Action: async function () {
            if (Action && Action.Destructive) {
              const Confirmed = await ConfirmationDialog(
                `${Favourite.Label} on ${
                  TargetIDs.length === 1 ? 'this monitor' : `${TargetIDs.length} monitors`
                }?`,
                { ConfirmLabel: Favourite.Label }
              );
              if (!Confirmed) return false;
            }
            await RunMonitoringAction(
              TargetIDs,
              Favourite.Method,
              Favourite.ActionID,
              Favourite.Params || {},
              Favourite.Label
            );
          },
        });
      }

      Options.push({
        Type: 'Action',
        Title: 'Run Checks Now',
        Class: 'text-light',
        Icon: 'bi-arrow-repeat',
        IconColour: '#3498db',
        ActsOnSelection: true,
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

    // --- Individual checks (list view) -----------------------------------
    // The same actions as a target's, narrowed to exactly the checks that are
    // selected: a starred action runs on the selected checks of its method
    // and on no other check of their targets.
    if (CheckIDs.length > 0) {
      PushSection('Checks');
      const CheckWord = (Count: number) => (Count === 1 ? 'this check' : `${Count} checks`);

      for (const { Favourite, TargetIDs, CheckIDs: ForChecks } of GetFavouritesForChecks(
        CheckIDs
      )) {
        const Action = GetMethodAction(Favourite.Method, Favourite.ActionID);
        Options.push({
          Type: 'Action',
          Title: Favourite.Label,
          Class: Action && Action.Destructive ? 'text-warning' : 'text-light',
          Icon: `bi-${Favourite.Icon || 'lightning'}`,
          IconColour: Action && Action.Destructive ? '#e74c3c' : '#9b59b6',
          ActsOnSelection: true,
          Action: async function () {
            if (Action && Action.Destructive) {
              const Confirmed = await ConfirmationDialog(
                `${Favourite.Label} on ${CheckWord(ForChecks.length)}?`,
                { ConfirmLabel: Favourite.Label }
              );
              if (!Confirmed) return false;
            }
            await RunMonitoringAction(
              TargetIDs,
              Favourite.Method,
              Favourite.ActionID,
              Favourite.Params || {},
              Favourite.Label,
              ForChecks
            );
          },
        });
      }

      Options.push({
        Type: 'Action',
        Title: CheckIDs.length === 1 ? 'Run Check Now' : 'Run Checks Now',
        Class: 'text-light',
        Icon: 'bi-arrow-repeat',
        IconColour: '#3498db',
        ActsOnSelection: true,
        Action: async function () {
          Notify(
            CheckIDs.length === 1 ? 'Running check…' : `Running ${CheckIDs.length} checks…`,
            'info'
          );
          try {
            await Promise.all(
              CheckIDs.map((CheckID) => window.API.RunMonitoringCheckNow(Number(CheckID)))
            );
          } catch (err) {
            HandleNonFatalError('SelectionInit:RunCheckNow', err);
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
        ActsOnSelection: true,
        Action: async function () {
          Notify(
            DummyUUIDs.length === 1
              ? 'Resetting to idle…'
              : `Resetting ${DummyUUIDs.length} dummy clients to idle…`,
            'info'
          );
          try {
            await Promise.all(DummyUUIDs.map((UUID) => window.API.ResetDummyClientToIdle(UUID)));
          } catch (err) {
            HandleNonFatalError('SelectionInit:ResetDummyToIdle', err);
          }
        },
      });
    }

    // --- FreeKiosk terminals ---------------------------------------------
    if (KioskUUIDs.length > 0) {
      const Plural = KioskUUIDs.length === 1 ? 'terminal' : `${KioskUUIDs.length} terminals`;
      // Collected first so that with every action switched off in the FreeKiosk
      // preferences the section, divider included, is left out entirely.
      const KioskOptions: ContextMenuOption[] = [];

      if (IsFreeKioskMenuActionEnabled(Settings, FREEKIOSK_MENU_POLL_SETTING_KEY)) {
        KioskOptions.push({
          Type: 'Action',
          Title: 'Poll Now',
          Class: 'text-light',
          Icon: 'bi-arrow-repeat',
          IconColour: '#3498db',
          ActsOnSelection: true,
          Action: async function () {
            const [Err, Summary] = await window.API.RunFreeKioskTerminalsNow(KioskUUIDs);
            if (Err) return Notify(Err, 'error');
            Notify(`Polled ${Summary?.Succeeded ?? 0}/${Summary?.Total ?? 0} ${Plural}.`, 'info');
          },
        });
      }

      // Every bulk-capable command the server declares. Sourcing the list from
      // the server's command map means a command added there appears here
      // with no renderer change — and, more importantly, that nothing appears
      // here which the server would refuse.
      // A selection can span terminals in different display modes, so a
      // mode-specific command is offered only when it applies to EVERY one of
      // them. Offering it for the majority would put an action on the menu
      // that silently does nothing on the rest — and the server refuses those
      // anyway, so the menu would be promising a partial failure.
      const KioskModes = KioskUUIDs.map((UUID) =>
        GetFreeKioskDisplayMode(
          FreeKioskTerminals.find((Entry) => String(Entry.UUID) === UUID)?.Settings
        )
      );

      for (const Command of FreeKioskCommandsCache) {
        if (!Command.Bulk) continue;
        if (Command.Params && Command.Params.length) continue; // needs a form
        if (Command.Modes && !KioskModes.every((Mode) => Command.Modes!.includes(Mode))) continue;
        if (!IsFreeKioskMenuActionEnabled(Settings, FreeKioskMenuSettingKey(Command.ID))) continue;
        KioskOptions.push({
          Type: 'Action',
          Title: Command.Label,
          Class: Command.Destructive ? 'text-warning' : 'text-light',
          Icon: `bi-${Command.Icon}`,
          IconColour: Command.Destructive ? '#e74c3c' : '#9b59b6',
          ActsOnSelection: true,
          Action: async function () {
            if (Command.Destructive) {
              const Confirmed = await ConfirmationDialog(
                `${Command.Label} on ${KioskUUIDs.length === 1 ? 'this terminal' : Plural}?`,
                { ConfirmLabel: Command.Label }
              );
              if (!Confirmed) return false;
            }
            const [Err, Summary] = await window.API.SendFreeKioskCommand(KioskUUIDs, Command.ID);
            if (Err) return Notify(Err, 'error');
            if (Summary && Summary.Failed) {
              const Reason = Summary.Results.find((Entry) => !Entry.Success)?.Error;
              return Notify(
                `${Command.Label}: ${Summary.Succeeded}/${Summary.Total} — ${Reason || 'failed'}`,
                'error'
              );
            }
            Notify(`${Command.Label} sent to ${Plural}.`, 'success');
          },
        });
      }

      if (KioskOptions.length > 0) {
        PushSection('FreeKiosk Terminals');
        Options.push(...KioskOptions);
      }
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
        ActsOnSelection: true,
        Action: async function () {
          try {
            const UUIDs = IdentifyStartTargets.map((Target) => Target.UUID);
            const Results = await Promise.all(UUIDs.map((UUID) => window.API.IdentifyClient(UUID)));
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
            if (Errors.length) Notify(String(Errors[0]), 'error');
          } catch (err) {
            HandleNonFatalError('SelectionInit:Identify', err);
          }
        },
      });
    }

    if (IdentifyStopTargets.length > 0) {
      Options.push({
        Type: 'Action',
        Title: IdentifyStopTargets.length === 1 ? 'Stop Identifying' : 'Stop Identifying Selected',
        Class: 'text-light',
        Icon: 'bi-slash-circle',
        IconColour: '#f1c40f',
        ActsOnSelection: true,
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
    // Wake on LAN only applies to real adopted clients; monitoring, check,
    // dummy and FreeKiosk rows carry prefixed selection UUIDs and are excluded.
    const WolTargets = Selected.filter(
      (UUID) =>
        !String(UUID).startsWith('monitor:') &&
        !String(UUID).startsWith('check:') &&
        !String(UUID).startsWith('dummy:') &&
        !String(UUID).startsWith('kiosk:')
    );
    const SYSTEM_ALLOW_WOL = await GetSettingValue('SYSTEM_ALLOW_WOL');
    if (SYSTEM_ALLOW_WOL && WolTargets.length > 0) {
      Options.push({
        Type: 'Action',
        Title: 'Wake on LAN',
        Class: 'text-light',
        Icon: 'bi-power',
        IconColour: '#2ecc71',
        ActsOnSelection: true,
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
      Shortcut: 'Ctrl/Cmd+D',
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
    Shortcut: 'Ctrl/Cmd+A',
    Icon: 'bi-check-all',
    IconColour: '#3498db',
    Action: async function () {
      SelectAll();
    },
  });

  return Options;
}
