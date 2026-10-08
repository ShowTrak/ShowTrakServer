// Check-action controls: the ⋯ menu on the end of each check's timeline in the
// monitor view modal, and the shared helpers the right-click menu uses to offer starred
// actions across a selection.
//
// Nothing here knows what a projector is. A method declares its actions in the
// server-side catalogue (MonitoringMethodView.Actions) and they arrive with the
// method schema the editor already loads, so a check type that gains a control
// surface grows one here with no renderer change.
//
// Parameter values live in a module-level draft map rather than in the DOM,
// because this menu is re-rendered from scratch on every target push (once per
// check interval). Reading them back out of the inputs would mean a half-typed
// input code vanished the moment the check ticked.
import type {
  MonitoringActionDef,
  MonitoringActionFavouriteView,
  MonitoringCheckView,
  MonitoringTargetView,
} from '@showtrak/protocol';
import { MonitoringActionFavourites, MonitoringMethodsCache, MonitoringTargets } from './state';
import { ConfirmationDialog, Notify } from './selection-init';
import { HandleNonFatalError, Safe } from './utils';

/** Draft parameter values, keyed `<CheckID>|<ActionID>|<ParamKey>`. */
const ActionParamDrafts = new Map<string, string>();

function DraftKey(CheckID: number | string, ActionID: string, ParamKey: string): string {
  return `${CheckID}|${ActionID}|${ParamKey}`;
}

/** The actions a method declares, or an empty list for a read-only check type. */
export function GetMethodActions(Method: string): MonitoringActionDef[] {
  const Meta = MonitoringMethodsCache.find((Entry) => Entry.ID === Method);
  return Meta && Array.isArray(Meta.Actions) ? Meta.Actions : [];
}

export function GetMethodAction(Method: string, ActionID: string): MonitoringActionDef | null {
  return GetMethodActions(Method).find((Action) => Action.ID === ActionID) || null;
}

/**
 * The choices offered for one action parameter on one check: whatever the device
 * itself reported this probe (ActionOptions), else the field's own static
 * Options, else none — in which case the field renders as free text.
 */
function ResolveParamOptions(
  Check: MonitoringCheckView,
  ParamKey: string,
  Field: { Options?: Array<string | { value: string; label?: string }> }
): Array<{ value: string; label: string }> {
  const Dynamic = Check.ActionOptions && Check.ActionOptions[ParamKey];
  if (Array.isArray(Dynamic) && Dynamic.length) return Dynamic;
  const Static = Array.isArray(Field.Options) ? Field.Options : [];
  return Static.map((Option) =>
    typeof Option === 'object'
      ? { value: String(Option.value), label: String(Option.label ?? Option.value) }
      : { value: String(Option), label: String(Option) }
  );
}

/** Current parameter values for one action on one check, as the server wants them. */
export function GetActionParams(
  Check: MonitoringCheckView,
  Action: MonitoringActionDef
): Record<string, unknown> {
  const Params: Record<string, unknown> = {};
  for (const Field of Action.Params || []) {
    const Draft = ActionParamDrafts.get(DraftKey(Check.CheckID, Action.ID, Field.Key));
    if (Draft != null) {
      Params[Field.Key] = Draft;
      continue;
    }
    // No draft yet: fall back to the device's first reported choice, then the
    // field's declared default. Preferring the device means Set Input opens on
    // an input the projector actually has rather than on an empty box.
    const Options = ResolveParamOptions(Check, Field.Key, Field);
    if (Options.length) Params[Field.Key] = Options[0]!.value;
    else Params[Field.Key] = Field.Default == null ? '' : Field.Default;
  }
  return Params;
}

/**
 * Whether two parameter sets name the same favourite, compared the way the
 * server's canonical key does — per declared field, coerced to a string.
 *
 * This only decides whether the star draws lit. The server re-derives the
 * identity when the star is pressed, so a disagreement here can at worst show a
 * stale star until the favourite list pushes back, never create a duplicate.
 */
function SameParams(
  Action: MonitoringActionDef,
  A: Record<string, unknown>,
  B: Record<string, unknown>
): boolean {
  for (const Field of Action.Params || []) {
    const Left = A[Field.Key];
    const Right = B[Field.Key];
    if (String(Left == null ? '' : Left) !== String(Right == null ? '' : Right)) return false;
  }
  return true;
}

export function IsActionFavourited(
  Method: string,
  Action: MonitoringActionDef,
  Params: Record<string, unknown>
): boolean {
  return MonitoringActionFavourites.some(
    (Favourite) =>
      Favourite.Method === Method &&
      Favourite.ActionID === Action.ID &&
      SameParams(Action, Favourite.Params || {}, Params)
  );
}

// ---- Rendering --------------------------------------------------------------

/**
 * Which check's menu is open, if any. Module state rather than DOM state for the
 * same reason as the drafts above: the whole timeline list is rebuilt on every
 * target push, and an open menu should not snap shut each time a check ticks.
 */
let OpenMenuCheckID: string | null = null;

function RenderParamField(
  Check: MonitoringCheckView,
  Action: MonitoringActionDef,
  Field: NonNullable<MonitoringActionDef['Params']>[number],
  Params: Record<string, unknown>,
  Disabled: string
): string {
  const Value = String(Params[Field.Key] == null ? '' : Params[Field.Key]);
  const Attrs =
    `data-check-id="${Safe(String(Check.CheckID))}" data-action-id="${Safe(Action.ID)}" ` +
    `data-param-key="${Safe(Field.Key)}"`;
  const Options = ResolveParamOptions(Check, Field.Key, Field);

  if (Options.length) {
    // A value the device no longer offers is kept as its own option rather than
    // silently snapping to the first one — a starred "Set Input - Digital 2"
    // should still read as Digital 2 when the projector stops listing it.
    const Known = Options.some((Option) => Option.value === Value);
    const All =
      Known || !Value ? Options : [{ value: Value, label: `${Value} (not reported)` }, ...Options];
    const Rendered = All.map(
      (Option) =>
        `<option value="${Safe(Option.value)}"${Option.value === Value ? ' selected' : ''}>${Safe(
          Option.label
        )}</option>`
    ).join('');
    return `<select class="form-select form-select-sm monitor-action-param" ${Attrs} ${Disabled}
      aria-label="${Safe(Field.Label)}">${Rendered}</select>`;
  }

  const Type = Field.Type === 'number' ? 'number' : 'text';
  return `<input type="${Type}" class="form-control form-control-sm monitor-action-param" ${Attrs}
    value="${Safe(Value)}" placeholder="${Safe(Field.Label)}" aria-label="${Safe(Field.Label)}" ${Disabled}/>`;
}

function RenderStar(Ids: string, Favourited: boolean): string {
  return `<button type="button" class="monitor-action-star${Favourited ? ' is-on' : ''}" ${Ids}
      aria-pressed="${Favourited ? 'true' : 'false'}"
      title="${
        Favourited
          ? 'Starred — shown in the right-click menu for selected monitors'
          : 'Star this action so it appears in the right-click menu'
      }">
      <i class="bi bi-star${Favourited ? '-fill' : ''}"></i>
    </button>`;
}

/**
 * One menu row. A plain action is a single clickable row with its star at the
 * end. A parameterised one keeps its label, then its picker, then a small run
 * button — the row itself can't be the trigger, or choosing an input from the
 * picker would fire it.
 */
function RenderAction(
  Check: MonitoringCheckView,
  Action: MonitoringActionDef,
  Blocked: boolean,
  BlockedReason: string
): string {
  const Params = GetActionParams(Check, Action);
  const Favourited = IsActionFavourited(Check.Method, Action, Params);
  const Disabled = Blocked ? 'disabled' : '';
  const Ids = `data-check-id="${Safe(String(Check.CheckID))}" data-action-id="${Safe(Action.ID)}"`;
  const Title = Blocked ? BlockedReason : Action.Note || Action.Label;
  const Destructive = Action.Destructive ? ' is-destructive' : '';
  const Label = `<i class="bi bi-${Safe(Action.Icon)}"></i><span>${Safe(Action.Label)}</span>`;

  if (Action.Params && Action.Params.length) {
    const Fields = Action.Params.map((Field) =>
      RenderParamField(Check, Action, Field, Params, Disabled)
    ).join('');
    return `
      <div class="monitor-action has-params">
        <span class="monitor-action-label">${Label}</span>
        ${Fields}
        <button type="button" class="monitor-action-btn monitor-action-go${Destructive}" ${Ids}
          title="${Safe(Title)}" aria-label="${Safe(Action.Label)}" ${Disabled}>
          <i class="bi bi-play-fill"></i>
        </button>
        ${RenderStar(Ids, Favourited)}
      </div>`;
  }

  return `
    <div class="monitor-action">
      <button type="button" class="monitor-action-btn monitor-action-label${Destructive}" ${Ids}
        role="menuitem" title="${Safe(Title)}" ${Disabled}>${Label}</button>
      ${RenderStar(Ids, Favourited)}
    </div>`;
}

/**
 * The status timeline for one check, with a ⋯ button on its end that opens the
 * check's controls as a compact menu. A method that declares no actions gets the
 * bare timeline back, unchanged.
 */
export function RenderTimelineWithActions(Check: MonitoringCheckView, Timeline: string): string {
  const Menu = RenderCheckActionsMenu(Check);
  if (!Menu) return Timeline;
  const CheckID = Safe(String(Check.CheckID));
  const Open = OpenMenuCheckID === String(Check.CheckID);
  return `<div class="status-timeline-with-actions">
      ${Timeline}
      <button type="button" class="monitor-actions-toggle${Open ? ' is-open' : ''}"
        data-check-id="${CheckID}" title="Controls" aria-label="Controls"
        aria-haspopup="menu" aria-expanded="${Open ? 'true' : 'false'}">
        <i class="bi bi-three-dots"></i>
      </button>
      ${Menu}
    </div>`;
}

/**
 * The controls menu for one check, or '' when its method declares no actions.
 * Always rendered (so its contents stay current), shown only while open.
 */
export function RenderCheckActionsMenu(Check: MonitoringCheckView): string {
  const Actions = GetMethodActions(Check.Method);
  if (!Actions.length) return '';

  // An offline check means ShowTrak cannot reach the device at all, so every
  // button would fail the same way. Degraded is left enabled on purpose: a
  // projector sitting in standby reads as degraded, and powering it on is
  // exactly what the operator opened this menu to do.
  const Blocked = Check.LastChecked != null && !Check.Online;
  const BlockedReason = 'This check is offline — ShowTrak cannot reach the device';

  const Groups = new Map<string, MonitoringActionDef[]>();
  for (const Action of Actions) {
    const List = Groups.get(Action.Group) || [];
    List.push(Action);
    Groups.set(Action.Group, List);
  }

  const Body = [...Groups.entries()]
    .map(
      ([Group, List]) =>
        `<div class="monitor-actions-menu-group">${Safe(Group)}</div>${List.map((Action) =>
          RenderAction(Check, Action, Blocked, BlockedReason)
        ).join('')}`
    )
    .join('');

  const Banner = Blocked
    ? `<div class="monitor-actions-menu-note"><i class="bi bi-exclamation-triangle"></i><span>${Safe(
        BlockedReason
      )}</span></div>`
    : '';

  const Open = OpenMenuCheckID === String(Check.CheckID);
  return `<div class="monitor-actions-menu${Open ? ' is-open' : ''}" role="menu"
      data-check-id="${Safe(String(Check.CheckID))}">${Banner}${Body}</div>`;
}

/**
 * Pin the open menu under its ⋯ button, flipping above it when there is no room
 * below. Fixed rather than absolute so the modal's scroll area can't clip it.
 * Called after every render, since a render replaces the menu element.
 */
export function PositionOpenActionsMenu(): void {
  if (OpenMenuCheckID == null) return;
  const Selector = `[data-check-id="${CSS.escape(OpenMenuCheckID)}"]`;
  const Menu = document.querySelector<HTMLElement>(`.monitor-actions-menu${Selector}`);
  const Toggle = document.querySelector<HTMLElement>(`.monitor-actions-toggle${Selector}`);
  if (!Menu || !Toggle) {
    // The check went away (deleted, or the modal moved on) — nothing to anchor to.
    OpenMenuCheckID = null;
    return;
  }
  const Gap = 4;
  const Edge = 8;
  const Anchor = Toggle.getBoundingClientRect();
  const Width = Menu.offsetWidth;
  const Height = Menu.offsetHeight;
  const Left = Math.min(Math.max(Edge, Anchor.right - Width), window.innerWidth - Width - Edge);
  const Below = Anchor.bottom + Gap;
  const Top =
    Below + Height > window.innerHeight - Edge ? Math.max(Edge, Anchor.top - Height - Gap) : Below;
  Menu.style.left = `${Left}px`;
  Menu.style.top = `${Top}px`;
}

/** Close whichever menu is open, without a full re-render. */
export function CloseActionsMenu(): void {
  if (OpenMenuCheckID == null) return;
  OpenMenuCheckID = null;
  $('.monitor-actions-menu.is-open').removeClass('is-open');
  $('.monitor-actions-toggle.is-open').removeClass('is-open').attr('aria-expanded', 'false');
}

// ---- Selection helpers (right-click menu) -----------------------------------

/** A starred action paired with the selected targets it can actually run on. */
export interface FavouriteForSelection {
  Favourite: MonitoringActionFavouriteView;
  TargetIDs: number[];
}

/**
 * Which starred actions apply to a selection, and to which of its targets.
 *
 * Same rule the script and remote-event menus follow: an action is offered when
 * ANY selected target can take it, and running it touches only those that can.
 * A favourite no selected target can take is left off the menu entirely rather
 * than shown as an entry that would report failures for everything.
 */
export function GetFavouritesForSelection(TargetIDs: string[]): FavouriteForSelection[] {
  const Selected: MonitoringTargetView[] = TargetIDs.map((ID) =>
    MonitoringTargets.find((Target) => String(Target.TargetID) === String(ID))
  ).filter((Target): Target is MonitoringTargetView => Boolean(Target));

  const Out: FavouriteForSelection[] = [];
  for (const Favourite of MonitoringActionFavourites) {
    const Applicable = Selected.filter((Target) =>
      (Target.Checks || []).some((Check) => Check.Method === Favourite.Method)
    ).map((Target) => Number(Target.TargetID));
    if (Applicable.length) Out.push({ Favourite, TargetIDs: Applicable });
  }
  return Out;
}

/** Record a parameter edit so it survives the panel's next re-render. */
export function SetActionParamDraft(
  CheckID: string,
  ActionID: string,
  ParamKey: string,
  Value: string
): void {
  ActionParamDrafts.set(DraftKey(CheckID, ActionID, ParamKey), Value);
}

/** Drop every draft and close the menu. Called when the view modal closes. */
export function ResetActionParamDrafts(): void {
  ActionParamDrafts.clear();
  OpenMenuCheckID = null;
}

// ---- Running ----------------------------------------------------------------

/**
 * Fire one action across the given targets and report what happened.
 *
 * A mixed result is reported as a mixed result: "3/6 — the projector is busy"
 * rather than a bare failure, because when five projectors took the command and
 * one refused, the operator needs to know which half of that they are looking at.
 */
export async function RunMonitoringAction(
  TargetIDs: number[],
  Method: string,
  ActionID: string,
  Params: Record<string, unknown>,
  Label: string
): Promise<void> {
  try {
    const [Err, Summary] = await window.API.RunMonitoringAction(
      TargetIDs,
      Method,
      ActionID,
      Params
    );
    if (Err) return Notify(String(Err), 'error');
    if (!Summary) return Notify(`${Label}: no response`, 'error');
    if (Summary.Failed) {
      const Reason = Summary.Results.find((Entry) => !Entry.Success)?.Error || 'failed';
      return Notify(
        `${Label}: ${Summary.Succeeded}/${Summary.Total} — ${Reason}`,
        Summary.Succeeded ? 'warning' : 'error'
      );
    }
    const Where =
      Summary.Total === 1
        ? Summary.Results[0]?.Detail || Label
        : `${Label} sent to ${Summary.Total} monitors`;
    Notify(Where, 'success');
  } catch (err) {
    HandleNonFatalError('MonitoringActions:Run', err);
  }
}

// ---- Wiring -----------------------------------------------------------------

function FindCheck(
  CheckID: string
): { Target: MonitoringTargetView; Check: MonitoringCheckView } | null {
  for (const Target of MonitoringTargets) {
    const Check = (Target.Checks || []).find((Entry) => String(Entry.CheckID) === CheckID);
    if (Check) return { Target, Check };
  }
  return null;
}

/**
 * Delegated handlers for the controls menu. Delegated rather than bound because
 * the menu is replaced wholesale on every target push, so anything bound to the
 * elements themselves would be thrown away with them.
 */
export function WireMonitoringActions(Rerender: () => void): void {
  const Host = '#MONITOR_HISTORY_TIMELINES';

  $(document).on('click', `${Host} .monitor-actions-toggle`, function (e) {
    e.stopPropagation();
    const CheckID = String($(this).attr('data-check-id') || '');
    OpenMenuCheckID = OpenMenuCheckID === CheckID ? null : CheckID;
    Rerender();
  });

  // Clicking anywhere outside the open menu, or Escape, dismisses it — the same
  // as the right-click menu. Escape is stopped so it doesn't close the modal too.
  $(document).on('mousedown', (e) => {
    if (OpenMenuCheckID == null) return;
    if ($(e.target).closest('.monitor-actions-menu, .monitor-actions-toggle').length) return;
    CloseActionsMenu();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || OpenMenuCheckID == null) return;
      e.stopPropagation();
      CloseActionsMenu();
    },
    true
  );
  // The menu is fixed-position, so it has to follow its button when the modal
  // scrolls or the window resizes.
  document.addEventListener('scroll', PositionOpenActionsMenu, true);
  window.addEventListener('resize', PositionOpenActionsMenu);

  // Parameter edits go to the draft map, not the DOM, so they survive the next
  // re-render. The star has to redraw too: which favourite it represents changes
  // the moment the parameter does.
  $(document).on('input change', `${Host} .monitor-action-param`, function () {
    const $El = $(this);
    SetActionParamDraft(
      String($El.attr('data-check-id') || ''),
      String($El.attr('data-action-id') || ''),
      String($El.attr('data-param-key') || ''),
      String($El.val() ?? '')
    );
    Rerender();
  });

  $(document).on('click', `${Host} .monitor-action-btn`, async function () {
    const Found = FindCheck(String($(this).attr('data-check-id') || ''));
    if (!Found) return;
    const ActionID = String($(this).attr('data-action-id') || '');
    const Action = GetMethodAction(Found.Check.Method, ActionID);
    if (!Action) return;

    if (Action.Destructive) {
      const Confirmed = await ConfirmationDialog(
        `${Action.Label} on "${Found.Target.Nickname || Found.Check.Address}"?`
      );
      if (!Confirmed) return;
    }

    // Like any menu, running an item dismisses it.
    CloseActionsMenu();
    await RunMonitoringAction(
      [Number(Found.Target.TargetID)],
      Found.Check.Method,
      ActionID,
      GetActionParams(Found.Check, Action),
      Action.Label
    );
  });

  $(document).on('click', `${Host} .monitor-action-star`, async function () {
    const Found = FindCheck(String($(this).attr('data-check-id') || ''));
    if (!Found) return;
    const ActionID = String($(this).attr('data-action-id') || '');
    const Action = GetMethodAction(Found.Check.Method, ActionID);
    if (!Action) return;

    const Params = GetActionParams(Found.Check, Action);
    const Next = !IsActionFavourited(Found.Check.Method, Action, Params);
    try {
      const [Err] = await window.API.SetMonitoringActionFavourite(
        Found.Check.Method,
        ActionID,
        Params,
        Next
      );
      if (Err) return Notify(String(Err), 'error');
      // The server pushes the authoritative list back, which redraws this panel
      // and the context menu together; the toast just confirms which way it went.
      Notify(
        Next
          ? 'Starred — it is now in the right-click menu for selected monitors'
          : 'Removed from the right-click menu',
        'success',
        2000
      );
    } catch (err) {
      HandleNonFatalError('MonitoringActions:Star', err);
    }
  });
}
