import { openModal, closeModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import {
  ALERT_TRIGGER_ALLOWLIST,
  AlertActionEditorIsCreating,
  AlertActionTypesCache,
  AlertEditingActionIndex,
  AlertRuleDraftActions,
  AlertRuleEditorRuleID,
  AlertRulesCache,
  AlertScopeGroups,
  AlertScopeSelected,
  AlertTriggerSelected,
  AlertTriggerTypesCache,
  AllClients,
  AudioAssetsCache,
  DummyClients,
  MonitoringTargets,
  setAlertActionEditorIsCreating,
  setAlertActionTypesCache,
  setAlertEditingActionIndex,
  setAlertRuleDraftActions,
  setAlertRuleEditorRuleID,
  setAlertScopeGroups,
  setAlertScopeOptions,
  setAlertScopeSelected,
  setAlertTriggerSelected,
  setAlertTriggerTypesCache,
} from './state';
import type { AlertScopeModel } from './state';
import type { AlertRuleActionView, AlertRuleScope, AlertRuleView } from '@showtrak/protocol';
import { PreviewSound } from './settings';
import { Safe } from './utils';
import {
  buildScopeModel,
  parseScopeSelection,
  resolveScopeTargetValues,
  scopeToSelectedValues,
  scopeClientValueToScopedID,
  summarizeScopeSelection,
  renderScopeDropdown,
  bindScopeDropdown,
  closeScopeDropdown,
} from './scope-dropdown';
import type { ScopeDropdownConfig } from './scope-dropdown';
import { CloseAllModals } from './modals';
import { ConfirmationDialog, Notify } from './selection-init';
import { LoadAudioAssets, PreviewAudioAsset } from './audio-assets';

/** Concrete scope shape produced by the editor (`Groups` numeric, `Clients` string IDs). */
interface ParsedAlertScope {
  Workspace: boolean;
  Groups: number[];
  Clients: string[];
}

/** Permissive scope shape accepted by read-only helpers (covers `{}`, rule scope, parsed scope). */
type AlertScopeInput = {
  Workspace?: boolean;
  Groups?: unknown[];
  Clients?: unknown[];
};
export async function EnsureAlertCatalogsLoaded() {
  if (!AlertTriggerTypesCache.length) {
    setAlertTriggerTypesCache(await window.API.GetAlertTriggers());
  }
  if (!AlertActionTypesCache.length) {
    setAlertActionTypesCache(await window.API.GetAlertActionTypes());
  }
}

export function ShowAlertListPanel() {
  $('#ALERT_MANAGER_LIST_PANEL').removeClass('d-none');
  $('#ALERT_MANAGER_EDITOR_PANEL').addClass('d-none');
}

export function ShowAlertEditorPanel() {
  $('#ALERT_MANAGER_LIST_PANEL').addClass('d-none');
  $('#ALERT_MANAGER_EDITOR_PANEL').removeClass('d-none');
}

// The Alert Rules scope picker is one instance of the shared scope-dropdown
// engine (see ./scope-dropdown). It shows every entity kind (clients, monitors,
// per-check, dummies) and stores its flat selection in the AlertScopeSelected
// global. The script-whitelist editor is a second instance with different
// options.
const AlertScopeConfig: ScopeDropdownConfig = {
  DropdownSelector: '#ALERT_SCOPE_DROPDOWN',
  MenuSelector: '#ALERT_SCOPE_MENU',
  ToggleSelector: '#ALERT_SCOPE_TOGGLE',
  Namespace: 'alertScope',
  Placeholder: 'Select targets',
  GetSelected: () => AlertScopeSelected,
  SetSelected: (values) => setAlertScopeSelected(values),
  BuildModel: () => buildScopeModel({ Groups: AlertScopeGroups }),
  ToggleRender: 'html',
};

export function CloseAllScopeDropdowns() {
  closeScopeDropdown(AlertScopeConfig);
}

export function ParseAlertScopeSelection(): ParsedAlertScope {
  return parseScopeSelection(AlertScopeSelected);
}

// Keep only allowed, deduped trigger IDs. Empty input yields an empty list; the
// editor supplies a sensible default separately (see DefaultAlertTriggerTypes).
export function NormalizeAlertTriggerTypes(TriggerTypes: unknown): string[] {
  const List = Array.isArray(TriggerTypes)
    ? TriggerTypes
    : TriggerTypes == null
      ? []
      : [TriggerTypes];
  const Out: string[] = [];
  const Seen = new Set<string>();
  for (const Raw of List) {
    const Normalized = `${Raw == null ? '' : Raw}`.trim().toUpperCase();
    if (!ALERT_TRIGGER_ALLOWLIST.has(Normalized) || Seen.has(Normalized)) continue;
    Seen.add(Normalized);
    Out.push(Normalized);
  }
  return Out;
}

// First allowed trigger from the catalog, falling back to CLIENT_OFFLINE. Used
// as the default selection for a brand-new rule so a trigger is always chosen.
export function DefaultAlertTriggerTypes(): string[] {
  const First = (AlertTriggerTypesCache || []).find((T) =>
    ALERT_TRIGGER_ALLOWLIST.has(`${T.ID || ''}`.toUpperCase())
  );
  return [First ? `${First.ID}`.toUpperCase() : 'CLIENT_OFFLINE'];
}

// Human-readable trigger names (from the loaded catalog) for a list of IDs.
function triggerNamesByIDs(TriggerTypes: string[]): string[] {
  return TriggerTypes.map((ID) => {
    const Match = (AlertTriggerTypesCache || []).find((T) => `${T.ID || ''}`.toUpperCase() === ID);
    return Match ? Match.Name : ID;
  });
}

export function CloseAlertTriggerDropdown() {
  $('#ALERT_RULE_TRIGGER_MENU').addClass('d-none');
}

// Render the trigger multiselect toggle text + checkbox menu from the current
// AlertTriggerSelected state, offering every allowlisted trigger in the catalog.
export function RenderAlertTriggerDropdown() {
  const Selected = new Set(NormalizeAlertTriggerTypes(AlertTriggerSelected));
  const SelectedNames = triggerNamesByIDs(Array.from(Selected));
  let ToggleText: string;
  if (!SelectedNames.length) ToggleText = 'Select triggers';
  else if (SelectedNames.length === 1)
    ToggleText = SelectedNames[0]!; // length === 1
  else ToggleText = `${SelectedNames[0]} +${SelectedNames.length - 1}`;

  $('#ALERT_RULE_TRIGGER_TOGGLE').html(
    `<span>${Safe(ToggleText)}</span><i class="bi bi-chevron-down ms-2" aria-hidden="true"></i>`
  );

  const OptionsHtml = (AlertTriggerTypesCache || [])
    .filter((T) => ALERT_TRIGGER_ALLOWLIST.has(`${T.ID || ''}`.toUpperCase()))
    .map((T) => {
      const ID = `${T.ID}`.toUpperCase();
      const Checked = Selected.has(ID) ? 'checked' : '';
      return `
        <label class="alert-multiselect-option">
          <input type="checkbox" value="${Safe(ID)}" ${Checked} />
          <span>${Safe(T.Name)}</span>
        </label>
      `;
    })
    .join('');

  $('#ALERT_RULE_TRIGGER_MENU').html(
    OptionsHtml || '<div class="text-muted text-sm p-2">No triggers available.</div>'
  );
}

export function BindAlertTriggerDropdown() {
  $('#ALERT_RULE_TRIGGER_TOGGLE')
    .off('click.alertTrigger')
    .on('click.alertTrigger', function (Event) {
      Event.preventDefault();
      Event.stopPropagation();
      const $menu = $('#ALERT_RULE_TRIGGER_MENU');
      $menu.toggleClass('d-none');
    });

  $('#ALERT_RULE_TRIGGER_MENU')
    .off('change.alertTrigger')
    .on('change.alertTrigger', 'input[type="checkbox"]', function () {
      const Value = `${$(this).val() || ''}`.toUpperCase();
      const Checked = $(this).is(':checked');
      const Next = new Set(NormalizeAlertTriggerTypes(AlertTriggerSelected));
      if (Checked) Next.add(Value);
      else Next.delete(Value);
      setAlertTriggerSelected(NormalizeAlertTriggerTypes(Array.from(Next)));
      RenderAlertTriggerDropdown();
      $('#ALERT_RULE_TRIGGER_MENU').removeClass('d-none');
    });

  $(document)
    .off('mousedown.alertTrigger touchstart.alertTrigger')
    .on('mousedown.alertTrigger touchstart.alertTrigger', function (Event) {
      const Inside = $(Event.target).closest('#ALERT_RULE_TRIGGER_DROPDOWN').length > 0;
      if (!Inside) CloseAlertTriggerDropdown();
    });
}

// The scope model/resolution/rendering now live in the shared ./scope-dropdown
// engine; these keep their historical names as thin adapters over it so the rest
// of this file (and its editor flow) is unchanged.
export function buildAlertScopeModel(): AlertScopeModel {
  return buildScopeModel({ Groups: AlertScopeGroups });
}

export function alertClientValueToScopedID(Value: string) {
  return scopeClientValueToScopedID(Value);
}

export function resolveAlertScopeTargetValues(
  Scope: AlertScopeInput,
  Model = buildAlertScopeModel()
) {
  return resolveScopeTargetValues(Scope, Model);
}

export function alertScopeToSelectedValues(Scope: AlertScopeInput) {
  return scopeToSelectedValues(Scope);
}

export function summarizeAlertScopeSelection(
  Model: AlertScopeModel,
  Scope: AlertScopeInput,
  Placeholder: string
) {
  return summarizeScopeSelection(Model, Scope, Placeholder);
}

// The action editor is a full-screen view: it replaces the entire rule-editor
// body (title, scope, trigger, actions list) rather than sitting beneath it, so
// only the action being edited is visible.
export function ShowAlertRuleMainContent() {
  $('#ALERT_RULE_EDITOR_BODY').removeClass('d-none');
  $('#ALERT_ACTION_EDITOR_PANEL').addClass('d-none');
}

export function ShowAlertActionEditorPanel() {
  $('#ALERT_RULE_EDITOR_BODY').addClass('d-none');
  $('#ALERT_ACTION_EDITOR_PANEL').removeClass('d-none');
}

export function RenderScopeDropdowns() {
  renderScopeDropdown(AlertScopeConfig);
}

export function BindScopeDropdownHandlers() {
  bindScopeDropdown(AlertScopeConfig);
}

export function RenderAlertRuleTriggerConfig(
  TriggerType: unknown,
  _Config: Record<string, unknown> = {}
) {
  const $host = $('#ALERT_RULE_TRIGGER_CONFIG');
  if (!$host.length) return;

  $host.empty().addClass('d-none');
}

export function CollectAlertTriggerConfig() {
  return {};
}

export function actionTypeByID(ID: string) {
  return AlertActionTypesCache.find((A) => A.ID === ID) || null;
}

// True when a play-custom-audio action points at an audio asset that no longer
// exists (deleted file or unknown ID). Drives the yellow warning indicators.
export function isAudioAssetActionMissing(Action: AlertRuleActionView) {
  if (!Action || Action.Type !== 'play-custom-audio') return false;
  const AssetID = Action.Settings && Action.Settings.AssetID ? Action.Settings.AssetID : '';
  if (!AssetID) return true;
  const Asset = (AudioAssetsCache || []).find((A) => A.ID === AssetID);
  return !Asset || !!Asset.Missing;
}

export function RenderAlertActionSettingsFields(
  ActionTypeID: string,
  ExistingSettings: Record<string, unknown> = {}
) {
  const ActionType = actionTypeByID(ActionTypeID);
  if (!ActionType) {
    return '<small class="text-muted">Unknown action type.</small>';
  }

  let Html = '';
  for (const Field of ActionType.Settings || []) {
    const Key = Field.Key;
    const Type = Field.Type || 'string';
    const Value = Object.prototype.hasOwnProperty.call(ExistingSettings, Key)
      ? ExistingSettings[Key]
      : Field.Default;

    if (Field.Hidden) {
      const HiddenType = Type === 'number' ? 'number' : Type === 'boolean' ? 'boolean' : 'string';
      Html += `<input type="hidden" data-key="${Safe(Key)}" data-type="${Safe(HiddenType)}" value="${Safe(String(Value == null ? '' : Value))}" />`;
      continue;
    }

    if (Type === 'boolean') {
      Html += `
        <div class="form-check form-switch ps-0 d-flex align-items-center justify-content-between bg-ghost rounded p-2">
          <label class="form-check-label mb-0 ms-2" for="alert-action-${Safe(Key)}-${Math.random().toString(36).slice(2)}">${Safe(Field.Label || Key)}</label>
          <input class="form-check-input ms-2 me-2" type="checkbox" data-key="${Safe(Key)}" data-type="boolean" ${Value ? 'checked' : ''} />
        </div>
      `;
    } else if (Type === 'number') {
      Html += `
        <div class="form-floating">
          <input
            type="number"
            class="form-control"
            data-key="${Safe(Key)}"
            data-type="number"
            value="${Safe(String(Value == null ? '' : Value))}"
            ${typeof Field.Min === 'number' ? `min="${Field.Min}"` : ''}
            ${typeof Field.Max === 'number' ? `max="${Field.Max}"` : ''}
            placeholder="${Safe(Field.Label || Key)}"
          />
          <label>${Safe(Field.Label || Key)}</label>
        </div>
      `;
    } else if (Type === 'select') {
      let Options: unknown[];
      if (Field.Source === 'audio-assets') {
        let AudioOptions = (AudioAssetsCache || []).map<{ Value: unknown; Label: unknown }>(
          (Asset) => ({
            Value: Asset.ID,
            Label: Asset.Missing ? `${Asset.Label} (missing)` : Asset.Label,
          })
        );
        // Ensure a previously-selected asset still shows even if it was deleted.
        if (Value && !AudioOptions.some((Option) => String(Option.Value) === String(Value))) {
          const ExistingLabel =
            ExistingSettings && ExistingSettings.AssetLabel ? ExistingSettings.AssetLabel : Value;
          AudioOptions.unshift({ Value, Label: `${ExistingLabel} (missing)` });
        }
        if (!AudioOptions.length) {
          AudioOptions = [{ Value: '', Label: 'No audio assets — import some first' }];
        }
        Options = AudioOptions;
      } else {
        Options = Array.isArray(Field.Options) ? Field.Options : [];
      }
      const OptionsHtml = Options.map((Option) => {
        const OptionRecord =
          Option && typeof Option === 'object'
            ? (Option as { Value?: unknown; Label?: unknown })
            : null;
        const OptionValue = OptionRecord ? OptionRecord.Value : Option;
        const OptionLabel = OptionRecord ? OptionRecord.Label || OptionRecord.Value : Option;
        const Selected = String(OptionValue) === String(Value) ? 'selected' : '';
        return `<option value="${Safe(String(OptionValue))}" ${Selected}>${Safe(String(OptionLabel))}</option>`;
      }).join('');
      let PreviewButton = '';
      if (Field.Preview === 'sound') {
        PreviewButton = `<button type="button" class="btn bg-ghost text-white" data-sound-preview title="Preview sound">
              <i class="bi bi-play-fill"></i> Preview
            </button>`;
      } else if (Field.Preview === 'audio-asset') {
        PreviewButton = `<button type="button" class="btn bg-ghost text-white" data-audio-asset-preview title="Preview audio asset">
              <i class="bi bi-play-fill"></i> Preview
            </button>`;
      }
      Html += `
        <div class="d-flex gap-2 align-items-stretch">
          <div class="form-floating flex-grow-1">
            <select class="form-select" data-key="${Safe(Key)}" data-type="select">${OptionsHtml}</select>
            <label>${Safe(Field.Label || Key)}</label>
          </div>
          ${PreviewButton}
        </div>
      `;
    } else {
      Html += `
        <div class="form-floating">
          <input
            type="text"
            class="form-control"
            data-key="${Safe(Key)}"
            data-type="string"
            value="${Safe(String(Value == null ? '' : Value))}"
            placeholder="${Safe(Field.Label || Key)}"
          />
          <label>${Safe(Field.Label || Key)}</label>
        </div>
      `;
    }
  }
  return Html || '<small class="text-muted">This action has no configurable settings.</small>';
}

export function RenderAlertActionTypeOptions(SelectedType: string | null = null) {
  return (AlertActionTypesCache || [])
    .map(
      (ActionType) =>
        `<option value="${Safe(ActionType.ID)}" ${ActionType.ID === SelectedType ? 'selected' : ''}>${Safe(ActionType.Name)}</option>`
    )
    .join('');
}

export function RenderAlertActionsList() {
  const $host = $('#ALERT_RULE_ACTIONS_LIST');
  if (!$host.length) return;
  if (!Array.isArray(AlertRuleDraftActions) || !AlertRuleDraftActions.length) {
    $host.html(
      '<div class="rounded bg-ghost p-2 text-muted text-center">No actions configured.</div>'
    );
    return;
  }

  let Html = '';
  AlertRuleDraftActions.forEach((Action, Index) => {
    const ActionType = actionTypeByID(Action.Type);
    const MissingAudio = isAudioAssetActionMissing(Action);
    const WarningIcon = MissingAudio
      ? '<i class="bi bi-exclamation-triangle-fill text-warning ms-2" title="The audio file for this action is missing" aria-label="Audio file missing"></i>'
      : '';
    Html += `
      <div class="rounded bg-ghost p-2 d-grid gap-1 text-start border-0 alert-action-open" data-action-index="${Index}" role="button" tabindex="0">
        <div class="d-flex align-items-center">
          <strong>${Safe(ActionType ? ActionType.Name : Action.Type || 'Action')}</strong>${WarningIcon}
        </div>
        <i class="bi bi-chevron-right alert-action-chevron" aria-hidden="true"></i>
      </div>
    `;
  });

  $host.html(Html);

  $host
    .find('.alert-action-open')
    .off('click keydown')
    .on('click', function () {
      const Index = parseInt($(this).attr('data-action-index') || '', 10);
      if (!Number.isFinite(Index)) return;
      OpenAlertActionEditor(Index);
    })
    .on('keydown', function (Event) {
      if (Event.key !== 'Enter' && Event.key !== ' ') return;
      Event.preventDefault();
      const Index = parseInt($(this).attr('data-action-index') || '', 10);
      if (!Number.isFinite(Index)) return;
      OpenAlertActionEditor(Index);
    });
}

export function CollectActionSettingsFromEditorHost() {
  const Settings: Record<string, unknown> = {};
  $('#ALERT_ACTION_EDITOR_SETTINGS')
    .find('[data-key]')
    .each(function () {
      const Key = ($(this).attr('data-key') || '').toString();
      const Type = ($(this).attr('data-type') || 'string').toString();
      if (!Key) return;
      if (Type === 'boolean') {
        Settings[Key] = $(this).is(':checked');
      } else if (Type === 'number') {
        const Parsed = Number($(this).val());
        Settings[Key] = Number.isFinite(Parsed) ? Parsed : 0;
      } else {
        Settings[Key] = ($(this).val() || '').toString();
      }
    });
  return Settings;
}

// Commit the action editor's current type + settings into the draft at the
// index being edited. Returns false when there is nothing to commit (no action
// type selected), leaving the draft untouched.
export function CommitAlertActionFromEditor() {
  if (!Number.isFinite(AlertEditingActionIndex)) return false;
  const Type = ($('#ALERT_ACTION_EDITOR_TYPE').val() || '').toString();
  if (!Type) return false;
  AlertRuleDraftActions[AlertEditingActionIndex!] = {
    Type,
    Settings: CollectActionSettingsFromEditorHost(),
  };
  return true;
}

export function CloseAlertActionEditor() {
  // "Back to Actions" commits the in-progress settings just like Save, so filling
  // in an action and clicking back no longer silently discards it. A freshly-added
  // action with no type selected has nothing to keep, so it is removed.
  const Committed = CommitAlertActionFromEditor();
  if (!Committed && AlertActionEditorIsCreating && Number.isFinite(AlertEditingActionIndex)) {
    AlertRuleDraftActions.splice(AlertEditingActionIndex!, 1);
  }
  setAlertActionEditorIsCreating(false);
  setAlertEditingActionIndex(null);
  RenderAlertActionsList();
  ShowAlertRuleMainContent();
}

export function OpenAlertActionEditor(Index: number, IsCreating = false) {
  if (!Array.isArray(AlertRuleDraftActions) || !AlertRuleDraftActions[Index]) return;
  setAlertEditingActionIndex(Index);
  setAlertActionEditorIsCreating(!!IsCreating);
  const Action = AlertRuleDraftActions[Index];
  const TypeID = Action.Type || (AlertActionTypesCache[0] && AlertActionTypesCache[0].ID) || '';

  ShowAlertActionEditorPanel();
  $('#ALERT_ACTION_EDITOR_TITLE').text(
    AlertActionEditorIsCreating ? `Create Action #${Index + 1}` : `Edit Action #${Index + 1}`
  );
  // There is no separate save button: the back button commits the action on the
  // way out (see CloseAlertActionEditor), and the red "Delete Action" button is the
  // explicit way to remove one. The back button's label/markup is static.
  $('#ALERT_ACTION_EDITOR_TYPE').html(RenderAlertActionTypeOptions(TypeID));
  $('#ALERT_ACTION_EDITOR_SETTINGS').html(
    RenderAlertActionSettingsFields(TypeID, Action.Settings || {})
  );
}

export function AddAlertActionAndEdit() {
  const DefaultType = (AlertActionTypesCache[0] && AlertActionTypesCache[0].ID) || '';
  AlertRuleDraftActions.push({
    Type: DefaultType,
    Settings: {},
  });
  RenderAlertActionsList();
  OpenAlertActionEditor(AlertRuleDraftActions.length - 1, true);
}

export async function PopulateAlertScopeOptions(Rule: AlertRuleView | null = null) {
  let Groups = await window.API.GetAllGroups();
  if (!Array.isArray(Groups)) Groups = [];
  setAlertScopeGroups(Groups);
  setAlertScopeOptions(buildAlertScopeModel());

  const Scope: AlertRuleScope =
    Rule && Rule.Scope ? Rule.Scope : { Workspace: false, Groups: [], Clients: [] };
  setAlertScopeSelected(alertScopeToSelectedValues(Scope));
  RenderScopeDropdowns();
}

export function ResetAlertRuleEditor() {
  setAlertRuleEditorRuleID(null);
  setAlertEditingActionIndex(null);
  setAlertActionEditorIsCreating(false);
  setAlertRuleDraftActions([]);
  $('#ALERT_RULE_EDITOR_TITLE').text('Create Alert Rule');
  $('#ALERT_RULE_TITLE').val('');
  $('#ALERT_RULE_DELETE').addClass('d-none');
  setAlertScopeSelected([]);
  RenderScopeDropdowns();

  const DefaultTriggers = DefaultAlertTriggerTypes();
  setAlertTriggerSelected(DefaultTriggers);
  RenderAlertTriggerDropdown();
  RenderAlertRuleTriggerConfig(DefaultTriggers[0], {});

  RenderAlertActionsList();
  ShowAlertRuleMainContent();
}

export function OpenAlertRuleEditor(Rule: AlertRuleView | null) {
  if (!Rule) {
    ResetAlertRuleEditor();
    return;
  }

  setAlertRuleEditorRuleID(Rule.RuleID);
  setAlertEditingActionIndex(null);
  setAlertActionEditorIsCreating(false);
  $('#ALERT_RULE_EDITOR_TITLE').text(`Edit Rule #${Rule.RuleID}`);
  $('#ALERT_RULE_TITLE').val(Rule.Title || '');
  $('#ALERT_RULE_DELETE').removeClass('d-none');

  PopulateAlertScopeOptions(Rule);

  const TriggerTypes = NormalizeAlertTriggerTypes(Rule.TriggerTypes);
  setAlertTriggerSelected(TriggerTypes.length ? TriggerTypes : DefaultAlertTriggerTypes());
  RenderAlertTriggerDropdown();
  RenderAlertRuleTriggerConfig(AlertTriggerSelected[0], Rule.TriggerConfig || {});

  const Actions = Array.isArray(Rule.Actions) ? Rule.Actions : [];
  setAlertRuleDraftActions(
    Actions.map((Action) => ({
      Type: Action.Type,
      Settings: Action.Settings || {},
    }))
  );
  RenderAlertActionsList();
  ShowAlertRuleMainContent();
  ShowAlertEditorPanel();
}

export function actionTypeNameByID(ID: string) {
  const ActionType = actionTypeByID(ID);
  return ActionType && ActionType.Name ? ActionType.Name : String(ID || 'action');
}

export function triggerSummaryText(TriggerType: string) {
  if (TriggerType === 'CLIENT_OFFLINE') return 'is offline';
  if (TriggerType === 'CLIENT_ONLINE') return 'is online';
  if (TriggerType === 'CLIENT_DEGRADED') return 'is degraded';
  if (TriggerType === 'SCRIPT_EXECUTION_FAILED') return 'fails to execute a script';
  if (TriggerType === 'USB_DEVICE_CONNECTED') return 'has a USB device connected';
  if (TriggerType === 'USB_DEVICE_DISCONNECTED') return 'has a USB device disconnected';
  if (TriggerType === 'NON_CRITICAL_USB_DEVICE_CONNECTED') {
    return 'has a non-critical USB device connected';
  }
  if (TriggerType === 'NON_CRITICAL_USB_DEVICE_DISCONNECTED') {
    return 'has a non-critical USB device disconnected';
  }
  if (TriggerType === 'CRITICAL_USB_DEVICE_CONNECTED') return 'has a critical USB device connected';
  if (TriggerType === 'CRITICAL_USB_DEVICE_DISCONNECTED') {
    return 'has a critical USB device disconnected';
  }
  if (TriggerType === 'APPLICATION_STARTED') return 'has an application started';
  if (TriggerType === 'APPLICATION_STOPPED') return 'has an application stopped';
  if (TriggerType === 'CRITICAL_APPLICATION_STARTED') return 'has a critical application started';
  if (TriggerType === 'CRITICAL_APPLICATION_STOPPED') return 'has a critical application stopped';
  if (TriggerType === 'NON_CRITICAL_APPLICATION_STARTED') {
    return 'has a non-critical application started';
  }
  if (TriggerType === 'NON_CRITICAL_APPLICATION_STOPPED') {
    return 'has a non-critical application stopped';
  }
  return 'triggers';
}

// Join several trigger phrases with "or" so a multi-trigger rule reads naturally
// (e.g. "is offline or is online"). Falls back to a generic phrase when empty.
export function triggersSummaryText(TriggerTypes: string[]) {
  const List = NormalizeAlertTriggerTypes(TriggerTypes);
  if (!List.length) return 'triggers';
  const Phrases = List.map((Type) => triggerSummaryText(Type));
  if (Phrases.length === 1) return Phrases[0];
  if (Phrases.length === 2) return `${Phrases[0]} or ${Phrases[1]}`;
  return `${Phrases.slice(0, -1).join(', ')}, or ${Phrases[Phrases.length - 1]}`;
}

export function summarizeActionType(Type: string, Count: number) {
  if (Type === 'osc-trigger') {
    return Count > 1 ? `send ${Count} OSC messages` : 'send an OSC message';
  }
  if (Type === 'discord-webhook') {
    return Count > 1 ? `send ${Count} messages on Discord` : 'send a message on Discord';
  }
  if (Type === 'slack-webhook') {
    return Count > 1 ? `send ${Count} messages on Slack` : 'send a message on Slack';
  }
  if (Type === 'teams-webhook') {
    return Count > 1 ? `send ${Count} messages on Teams` : 'send a message on Teams';
  }
  if (Type === 'telegram-bot') {
    return Count > 1 ? `send ${Count} messages on Telegram` : 'send a message on Telegram';
  }
  if (Type === 'http-api') {
    return Count > 1 ? `send ${Count} HTTP requests` : 'send an HTTP request';
  }
  if (Type === 'play-sound') {
    return Count > 1 ? `play ${Count} alert sounds` : 'play an alert sound';
  }
  if (Type === 'play-custom-audio') {
    return Count > 1 ? `play ${Count} custom audio assets` : 'play a custom audio asset';
  }
  if (Type === 'showtrak-alert') {
    return Count > 1 ? `create ${Count} ShowTrak alerts` : 'create a ShowTrak alert';
  }
  const Name = actionTypeNameByID(Type);
  return Count > 1 ? `run ${Count} ${Name} actions` : `run ${Name}`;
}

export function naturalJoin(Items: string[]) {
  if (!Array.isArray(Items) || !Items.length) return '';
  if (Items.length === 1) return Items[0];
  if (Items.length === 2) return `${Items[0]} and ${Items[1]}`;
  return `${Items.slice(0, -1).join(', ')}, and ${Items[Items.length - 1]}`;
}

export function targetNameFromScopedID(ScopedID: string) {
  const ID = String(ScopedID || '');
  if (!ID) return 'Target';

  if (ID.startsWith('monitor:')) {
    const TargetID = ID.slice('monitor:'.length);
    const Monitor = (MonitoringTargets || []).find((T) => String(T.TargetID) === TargetID);
    return Monitor
      ? Monitor.Nickname || Monitor.Address || `Target ${TargetID}`
      : `Target ${TargetID}`;
  }

  const Dummy = (DummyClients || []).find((Entry) => String(Entry.UUID) === ID);
  if (Dummy) return Dummy.Nickname || Dummy.DummyID || Dummy.UUID;

  const Client = (AllClients || []).find((C) => String(C.UUID) === ID);
  return Client ? Client.Nickname || Client.Hostname || Client.UUID : ID;
}

export function scopedTargetsInfo(Rule: AlertRuleView) {
  const Model = buildAlertScopeModel();
  const Scope: AlertScopeInput = Rule && Rule.Scope ? Rule.Scope : {};
  if (Scope.Workspace) {
    const WorkspaceTargets = Model.AllClientValues.map((Value) =>
      targetNameFromScopedID(alertClientValueToScopedID(Value))
    );
    return {
      Count: WorkspaceTargets.length,
      SingleName: WorkspaceTargets.length === 1 ? WorkspaceTargets[0] : null,
    };
  }

  const IDs = Array.from(resolveAlertScopeTargetValues(Scope, Model)).map((Value) =>
    alertClientValueToScopedID(Value)
  );
  return {
    Count: IDs.length,
    SingleName: IDs.length === 1 ? targetNameFromScopedID(IDs[0]!) : null, // length === 1
  };
}

export function buildRuleSummary(Rule: AlertRuleView) {
  const TriggerText = triggersSummaryText(Rule && Rule.TriggerTypes ? Rule.TriggerTypes : []);
  const ScopeInfo = scopedTargetsInfo(Rule);
  const Actions = Array.isArray(Rule && Rule.Actions) ? Rule.Actions : [];

  const CountsByType = new Map<string, number>();
  for (const Action of Actions) {
    const Type = String((Action && Action.Type) || 'action');
    CountsByType.set(Type, (CountsByType.get(Type) || 0) + 1);
  }

  const ActionPhrases: string[] = [];
  for (const [Type, Count] of CountsByType.entries()) {
    ActionPhrases.push(summarizeActionType(Type, Count));
  }

  const ActionText = ActionPhrases.length ? naturalJoin(ActionPhrases) : 'take no actions';
  const Subject = ScopeInfo.SingleName ? ScopeInfo.SingleName : `one of ${ScopeInfo.Count} targets`;
  return `When ${Subject} ${TriggerText}, ${ActionText}.`;
}

export function RenderAlertRuleManagerList() {
  const $host = $('#ALERT_RULE_MANAGER_LIST');
  if (!$host.length) return;
  if (!AlertRulesCache.length) {
    $host.html(
      '<div class="rounded bg-ghost p-2 text-center text-muted">No alert rules yet.</div>'
    );
    return;
  }

  let Html = '';
  for (const Rule of AlertRulesCache) {
    const Summary = buildRuleSummary(Rule);
    const HasMissingAudio = (Array.isArray(Rule.Actions) ? Rule.Actions : []).some((Action) =>
      isAudioAssetActionMissing(Action)
    );
    const WarningIcon = HasMissingAudio
      ? '<i class="bi bi-exclamation-triangle-fill text-warning ms-2" title="An audio file used by this alert is missing" aria-label="Audio file missing"></i>'
      : '';
    Html += `
      <div class="rounded bg-ghost p-2 d-grid gap-1 text-start border-0 alert-rule-open" data-ruleid="${Rule.RuleID}" role="button" tabindex="0">
        <div class="d-flex justify-content-between align-items-center gap-2">
          <strong>${Safe(Rule.Title || `Rule ${Rule.RuleID}`)}${WarningIcon}</strong>
        </div>
        <small class="text-muted">${Safe(Summary)}</small>
        <i class="bi bi-chevron-right alert-rule-chevron" aria-hidden="true"></i>
      </div>
    `;
  }

  $host.html(Html);

  $host
    .find('.alert-rule-open')
    .off('click')
    .on('click', function () {
      const RuleID = parseInt($(this).attr('data-ruleid') || '', 10);
      if (!Number.isFinite(RuleID)) return;
      const Rule = AlertRulesCache.find((R) => R.RuleID === RuleID);
      if (Rule) OpenAlertRuleEditor(Rule);
    });
}

export function BuildAlertRulePayloadFromEditor() {
  const Title = ($('#ALERT_RULE_TITLE').val() || '').toString().trim();
  const TriggerTypes = NormalizeAlertTriggerTypes(AlertTriggerSelected);
  const Scope = ParseAlertScopeSelection();

  return {
    Title,
    Scope,
    TriggerTypes,
    TriggerConfig: CollectAlertTriggerConfig(),
    Actions: AlertRuleDraftActions,
    Enabled: true,
  };
}

// The rule editor has no explicit save button: leaving it (Back) persists the
// current draft automatically. A brand-new rule the user never filled in is
// discarded, and an incomplete rule is left unsaved with an explanation rather
// than blocking navigation. The rules list refreshes itself via the server's
// SetFullAlertRuleList push, so no manual re-render is needed here.
export async function AutoSaveAlertRuleFromEditor() {
  const Payload = BuildAlertRulePayloadFromEditor();
  const IsExisting = !!AlertRuleEditorRuleID;
  const HasContent =
    !!Payload.Title || (Array.isArray(Payload.Actions) && Payload.Actions.length > 0);

  // Nothing entered for a new rule — don't create an empty record.
  if (!IsExisting && !HasContent) return;

  const Problem = !Payload.Title
    ? 'Rule not saved — a title is required'
    : !Array.isArray(Payload.TriggerTypes) || !Payload.TriggerTypes.length
      ? 'Rule not saved — select at least one trigger'
      : !Array.isArray(Payload.Actions) || !Payload.Actions.length
        ? 'Rule not saved — add at least one action'
        : null;

  if (Problem) {
    Notify(Problem, 'error', 3000);
    return;
  }

  if (IsExisting) {
    const [Err] = await window.API.UpdateAlertRule(String(AlertRuleEditorRuleID), Payload);
    if (Err) return Notify(Err, 'error');
    Notify('Alert rule saved', 'success', 1200);
  } else {
    const [Err] = await window.API.CreateAlertRule(Payload);
    if (Err) return Notify(Err, 'error');
    Notify('Alert rule created', 'success', 1200);
  }
}

// Leaving the rule editor (Back) autosaves the draft and returns to the list;
// see AutoSaveAlertRuleFromEditor for why there is no explicit save button.
export async function BackToAlertRuleList() {
  await AutoSaveAlertRuleFromEditor();
  ShowAlertListPanel();
  setAlertActionEditorIsCreating(false);
  setAlertEditingActionIndex(null);
  ShowAlertRuleMainContent();
}

// The header close (X) dismisses the whole modal. Whatever panel is showing, the
// in-progress work is committed first: an open action editor commits its action,
// then the rule autosaves, matching the Back-button semantics.
export async function CloseAlertRuleManagerFromEditor() {
  if (!$('#ALERT_ACTION_EDITOR_PANEL').hasClass('d-none')) {
    CloseAlertActionEditor();
  }
  await AutoSaveAlertRuleFromEditor();
  closeModal('SHOWTRAK_MODAL_ALERT_MANAGER');
}

// Both editor panels share the standard modal titlebar (back + title + close).
// The title elements keep their historical ids so the rest of this file can
// still update them with $('#...TITLE').text(...).
export function RenderAlertModalHeaders() {
  // Top-level list panel: title + close (the New Alert / Audio Assets buttons
  // sit in the toolbar row beneath this header).
  $('#ALERT_MANAGER_LIST_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Alerts',
        onClose: () => closeModal('SHOWTRAK_MODAL_ALERT_MANAGER'),
      }).$el
    );

  $('#ALERT_RULE_EDITOR_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Create Alert Rule',
        titleId: 'ALERT_RULE_EDITOR_TITLE',
        onBack: () => {
          void BackToAlertRuleList();
        },
        onClose: () => {
          void CloseAlertRuleManagerFromEditor();
        },
      }).$el
    );

  $('#ALERT_ACTION_EDITOR_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Edit Action',
        titleId: 'ALERT_ACTION_EDITOR_TITLE',
        backLabel: 'Back',
        onBack: () => CloseAlertActionEditor(),
        onClose: () => {
          void CloseAlertRuleManagerFromEditor();
        },
      }).$el
    );
}

export async function OpenAlertRuleManager() {
  await CloseAllModals();
  await EnsureAlertCatalogsLoaded();
  await LoadAudioAssets();
  await PopulateAlertScopeOptions();

  RenderAlertModalHeaders();
  BindScopeDropdownHandlers();
  BindAlertTriggerDropdown();
  ResetAlertRuleEditor();
  RenderAlertRuleManagerList();
  ShowAlertListPanel();

  $('#ALERT_RULE_CREATE_BUTTON')
    .off('click.alertRule')
    .on('click.alertRule', () => {
      ResetAlertRuleEditor();
      ShowAlertEditorPanel();
    });

  $('#ALERT_RULE_ADD_ACTION')
    .off('click.alertRule')
    .on('click.alertRule', () => {
      AddAlertActionAndEdit();
    });

  $('#ALERT_ACTION_EDITOR_TYPE')
    .off('change.alertRule')
    .on('change.alertRule', function () {
      const TypeID = ($(this).val() || '').toString();
      const Existing =
        Number.isFinite(AlertEditingActionIndex) && AlertRuleDraftActions[AlertEditingActionIndex!]
          ? AlertRuleDraftActions[AlertEditingActionIndex!]!.Settings || {} // truthiness checked above
          : {};
      $('#ALERT_ACTION_EDITOR_SETTINGS').html(RenderAlertActionSettingsFields(TypeID, Existing));
    });

  $('#ALERT_ACTION_EDITOR_SETTINGS')
    .off('click.alertSoundPreview')
    .on('click.alertSoundPreview', '[data-sound-preview]', function (Event) {
      Event.preventDefault();
      const SoundName = (
        $('#ALERT_ACTION_EDITOR_SETTINGS [data-key="Sound"]').val() || 'Notification'
      ).toString();
      PreviewSound(SoundName);
    });

  $('#ALERT_ACTION_EDITOR_SETTINGS')
    .off('click.alertAudioPreview')
    .on('click.alertAudioPreview', '[data-audio-asset-preview]', function (Event) {
      Event.preventDefault();
      const AssetID = (
        $('#ALERT_ACTION_EDITOR_SETTINGS [data-key="AssetID"]').val() || ''
      ).toString();
      if (!AssetID) return Notify('Please choose an audio asset', 'error');
      PreviewAudioAsset(AssetID);
    });

  // Keep the hidden AssetLabel in sync so a friendly name survives even if the
  // asset is later deleted (used for the missing-asset warning text).
  $('#ALERT_ACTION_EDITOR_SETTINGS')
    .off('change.alertAudioAsset')
    .on('change.alertAudioAsset', '[data-key="AssetID"]', function () {
      const AssetID = ($(this).val() || '').toString();
      const Asset = (AudioAssetsCache || []).find((A) => A.ID === AssetID);
      $('#ALERT_ACTION_EDITOR_SETTINGS [data-key="AssetLabel"]').val(Asset ? Asset.Label : '');
    });

  $('#ALERT_ACTION_EDITOR_DELETE')
    .off('click.alertRule')
    .on('click.alertRule', () => {
      if (!Number.isFinite(AlertEditingActionIndex)) return;
      AlertRuleDraftActions.splice(AlertEditingActionIndex!, 1);
      setAlertActionEditorIsCreating(false);
      RenderAlertActionsList();
      setAlertEditingActionIndex(null);
      ShowAlertRuleMainContent();
    });

  $('#ALERT_RULE_DELETE')
    .off('click.alertRule')
    .on('click.alertRule', async () => {
      if (!AlertRuleEditorRuleID) return;
      const Confirmed = await ConfirmationDialog('Delete this alert rule? This cannot be undone.');
      if (!Confirmed) return;
      const [Err] = await window.API.DeleteAlertRule(String(AlertRuleEditorRuleID));
      if (Err) return Notify(Err, 'error');
      Notify('Alert rule deleted', 'success', 1500);
      ResetAlertRuleEditor();
      ShowAlertListPanel();
    });

  openModal('SHOWTRAK_MODAL_ALERT_MANAGER');
}

export async function OpenCreateAlertRuleEditor() {
  await OpenAlertRuleManager();
  ResetAlertRuleEditor();
  ShowAlertEditorPanel();
}
