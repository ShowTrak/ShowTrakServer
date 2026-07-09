import { openModal } from './lib/modal';
import { ALERT_TRIGGER_ALLOWLIST, AlertActionEditorIsCreating, AlertActionTypesCache, AlertEditingActionIndex, AlertRuleDraftActions, AlertRuleEditorRuleID, AlertRulesCache, AlertScopeGroups, AlertScopeOptions, AlertScopeSelected, AlertTriggerTypesCache, AllClients, AudioAssetsCache, DummyClients, MonitoringTargets, setAlertActionEditorIsCreating, setAlertActionTypesCache, setAlertEditingActionIndex, setAlertRuleDraftActions, setAlertRuleEditorRuleID, setAlertScopeGroups, setAlertScopeOptions, setAlertScopeSelected, setAlertTriggerTypesCache } from './01-state';
import type { AlertScopeEntity, AlertScopeGroupNode, AlertScopeModel } from './01-state';
import type { AlertRuleActionView, AlertRuleScope, AlertRuleView } from '@showtrak/protocol';
import { PreviewSound } from './03-settings';
import { Safe } from './04-utils';
import { CloseAllModals } from './11-modals';
import { ConfirmationDialog, Notify } from './14-selection-init';
import { LoadAudioAssets, PreviewAudioAsset } from './17-audio-assets';

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

export function CloseAllScopeDropdowns() {
  $('#ALERT_SCOPE_MENU').addClass('d-none');
}

export function ParseAlertScopeSelection() {
  const Scope: ParsedAlertScope = {
    Workspace: false,
    Groups: [],
    Clients: [],
  };

  for (const RawValue of AlertScopeSelected || []) {
    const Value = `${RawValue}`;
    if (Value === 'workspace:*') {
      Scope.Workspace = true;
      continue;
    }
    if (Value.startsWith('group:')) {
      const GroupID = parseInt(Value.slice(6), 10);
      if (Number.isFinite(GroupID)) Scope.Groups.push(GroupID);
      continue;
    }
    if (Value.startsWith('client:')) {
      Scope.Clients.push(Value.slice(7));
    }
  }

  return Scope;
}

export function NormalizeAlertTriggerType(TriggerType: string) {
  const Normalized = `${TriggerType || ''}`.trim().toUpperCase();
  if (ALERT_TRIGGER_ALLOWLIST.has(Normalized)) return Normalized;
  return 'CLIENT_OFFLINE';
}

export function ScopeSummaryText(Selected: Array<{ Label: string }>, Placeholder: string) {
  if (!Array.isArray(Selected) || !Selected.length) return Placeholder;
  if (Selected.length === 1) return Selected[0].Label;
  return `${Selected[0].Label} +${Selected.length - 1}`;
}

export function alertScopeGroupsSorted() {
  return (Array.isArray(AlertScopeGroups) ? AlertScopeGroups.slice() : []).sort((A, B) => {
    const WeightDelta = (A && A.Weight ? A.Weight : 0) - (B && B.Weight ? B.Weight : 0);
    if (WeightDelta !== 0) return WeightDelta;
    return String((A && A.Title) || '').localeCompare(String((B && B.Title) || ''));
  });
}

export function buildAlertEntityLabel(
  Primary: string | null | undefined,
  Secondary: string | null | undefined,
  Fallback: string | null | undefined
) {
  const Base = `${Primary || Secondary || Fallback || 'Unknown Target'}`.trim();
  const Detail =
    Secondary && Primary && String(Secondary).trim() && String(Secondary).trim() !== Base
      ? ` (${String(Secondary).trim()})`
      : '';
  return `${Base}${Detail}`;
}

export function alertEntityIconClass(Kind: string) {
  if (Kind === 'showtrak') return 'bi-display';
  if (Kind === 'monitor') return 'bi-diagram-3';
  if (Kind === 'dummy') return 'bi-cpu';
  return '';
}

export function compareAlertScopeEntities(A: AlertScopeEntity, B: AlertScopeEntity) {
  const WeightDelta = (A && A.Weight ? A.Weight : 0) - (B && B.Weight ? B.Weight : 0);
  if (WeightDelta !== 0) return WeightDelta;
  return String((A && A.Label) || '').localeCompare(String((B && B.Label) || ''));
}

export function alertClientValueToScopedID(Value: string) {
  const Text = String(Value || '');
  if (!Text.startsWith('client:')) return '';
  return Text.slice(7);
}

export function buildAlertScopeModel(): AlertScopeModel {
  const LabelByValue = new Map<string, string>();
  const GroupNodes: AlertScopeGroupNode[] = alertScopeGroupsSorted().map((Group) => ({
    Kind: 'group' as const,
    Value: `group:${Group.GroupID}`,
    GroupID: Group.GroupID,
    Label: Group.Title || `Group ${Group.GroupID}`,
    Children: [] as AlertScopeEntity[],
    ChildValues: [] as string[],
  }));
  const GroupByID = new Map<string, AlertScopeGroupNode>(
    GroupNodes.map((Group) => [String(Group.GroupID), Group] as [string, AlertScopeGroupNode])
  );
  const Ungrouped: AlertScopeEntity[] = [];

  const Entities: AlertScopeEntity[] = [];
  for (const Client of AllClients || []) {
    if (!Client || !Client.UUID) continue;
    Entities.push({
      Kind: 'showtrak',
      Value: `client:${Client.UUID}`,
      ScopedID: String(Client.UUID),
      GroupID: Client.GroupID == null ? null : Client.GroupID,
      Label: buildAlertEntityLabel(
        Client.Nickname || Client.Hostname || Client.UUID,
        Client.Nickname ? Client.Hostname || '' : '',
        Client.UUID
      ),
      IconClass: alertEntityIconClass('showtrak'),
      Weight: Client.Weight || 0,
    });
  }

  for (const Target of MonitoringTargets || []) {
    if (!Target || Target.TargetID == null) continue;
    const ScopedID = `monitor:${Target.TargetID}`;
    Entities.push({
      Kind: 'monitor',
      Value: `client:${ScopedID}`,
      ScopedID,
      GroupID: Target.GroupID == null ? null : Target.GroupID,
      Label: buildAlertEntityLabel(
        Target.Nickname || Target.Address || `Target ${Target.TargetID}`,
        Target.Nickname ? Target.Address || '' : '',
        `Target ${Target.TargetID}`
      ),
      IconClass: alertEntityIconClass('monitor'),
      Weight: Target.Weight || 0,
    });

    // Per-check entities let a rule target an individual check within a target.
    const TargetTitle = Target.Nickname || Target.Address || `Target ${Target.TargetID}`;
    for (const Check of Array.isArray(Target.Checks) ? Target.Checks : []) {
      if (!Check || Check.CheckID == null) continue;
      const CheckScopedID = `check:${Check.CheckID}`;
      const CheckLabel =
        Check.Name || Check.Address || `${String(Check.Method || '').toUpperCase()} check`;
      Entities.push({
        Kind: 'monitor-check',
        Value: `client:${CheckScopedID}`,
        ScopedID: CheckScopedID,
        GroupID: Target.GroupID == null ? null : Target.GroupID,
        Label: buildAlertEntityLabel(
          `${TargetTitle} · ${CheckLabel}`,
          Check.Name ? Check.Address || '' : '',
          `Check ${Check.CheckID}`
        ),
        IconClass: alertEntityIconClass('monitor'),
        Weight: Target.Weight || 0,
      });
    }
  }

  for (const Dummy of DummyClients || []) {
    if (!Dummy || !Dummy.UUID) continue;
    Entities.push({
      Kind: 'dummy',
      Value: `client:${Dummy.UUID}`,
      ScopedID: String(Dummy.UUID),
      GroupID: Dummy.GroupID == null ? null : Dummy.GroupID,
      Label: buildAlertEntityLabel(
        Dummy.Nickname || Dummy.DummyID || Dummy.UUID,
        Dummy.Nickname ? Dummy.DummyID || '' : '',
        Dummy.UUID
      ),
      IconClass: alertEntityIconClass('dummy'),
      Weight: Dummy.Weight || 0,
    });
  }

  Entities.sort(compareAlertScopeEntities);

  for (const Entity of Entities) {
    LabelByValue.set(Entity.Value, Entity.Label);
    const Group = Entity.GroupID == null ? null : GroupByID.get(String(Entity.GroupID));
    if (!Group) {
      Ungrouped.push(Entity);
      continue;
    }
    Group.Children.push(Entity);
    Group.ChildValues.push(Entity.Value);
  }

  for (const Group of GroupNodes) {
    LabelByValue.set(Group.Value, Group.Label);
  }
  LabelByValue.set('workspace:*', 'All Clients');

  const AllClientValues: string[] = [];
  for (const Group of GroupNodes) {
    AllClientValues.push(...Group.ChildValues);
  }
  for (const Entity of Ungrouped) {
    AllClientValues.push(Entity.Value);
  }

  return {
    Workspace: {
      Kind: 'workspace',
      Value: 'workspace:*',
      Label: 'All Clients',
    },
    Groups: GroupNodes,
    Ungrouped,
    AllClientValues,
    AllClientValueSet: new Set(AllClientValues),
    LabelByValue,
  };
}

export function resolveAlertScopeTargetValues(Scope: AlertScopeInput, Model = buildAlertScopeModel()) {
  const Selected = new Set<string>();
  if (!Scope || !Model) return Selected;

  if (Scope.Workspace) {
    for (const Value of Model.AllClientValues) Selected.add(Value);
    return Selected;
  }

  const Groups = new Set((Scope.Groups || []).map((GroupID) => String(GroupID)));
  for (const Group of Model.Groups || []) {
    if (!Groups.has(String(Group.GroupID))) continue;
    for (const Value of Group.ChildValues || []) Selected.add(Value);
  }

  for (const ScopedID of Scope.Clients || []) {
    const Value = `client:${ScopedID}`;
    if (Model.AllClientValueSet.has(Value)) Selected.add(Value);
  }

  return Selected;
}

export function buildAlertScopeFromTargetValues(TargetValues: string[], Model = buildAlertScopeModel()) {
  const Selected = new Set((TargetValues || []).map((Value) => String(Value)));
  if (Model.AllClientValues.length && Model.AllClientValues.every((Value) => Selected.has(Value))) {
    return {
      Workspace: true,
      Groups: [],
      Clients: [],
    };
  }

  const Scope: ParsedAlertScope = {
    Workspace: false,
    Groups: [],
    Clients: [],
  };
  const Covered = new Set<string>();

  for (const Group of Model.Groups || []) {
    if (!Group.ChildValues.length) continue;
    if (!Group.ChildValues.every((Value) => Selected.has(Value))) continue;
    Scope.Groups.push(Group.GroupID);
    for (const Value of Group.ChildValues) Covered.add(Value);
  }

  for (const Value of Model.AllClientValues) {
    if (!Selected.has(Value) || Covered.has(Value)) continue;
    const ScopedID = alertClientValueToScopedID(Value);
    if (ScopedID) Scope.Clients.push(ScopedID);
  }

  return Scope;
}

export function alertScopeToSelectedValues(Scope: AlertScopeInput) {
  const Selected: string[] = [];
  if (Scope && Scope.Workspace) Selected.push('workspace:*');
  for (const GroupID of (Scope && Scope.Groups) || []) {
    Selected.push(`group:${GroupID}`);
  }
  for (const ClientID of (Scope && Scope.Clients) || []) {
    Selected.push(`client:${ClientID}`);
  }
  return Selected;
}

export function summarizeAlertScopeSelection(
  Model: AlertScopeModel,
  Scope: AlertScopeInput,
  Placeholder: string
) {
  if (!Scope) return Placeholder;
  if (Scope.Workspace) return 'All Clients';

  const Selected: Array<{ Label: string }> = [];
  for (const GroupID of Scope.Groups || []) {
    const Value = `group:${GroupID}`;
    Selected.push({ Label: Model.LabelByValue.get(Value) || `Group ${GroupID}` });
  }
  for (const ClientID of Scope.Clients || []) {
    const Value = `client:${ClientID}`;
    Selected.push({ Label: Model.LabelByValue.get(Value) || String(ClientID) });
  }
  return ScopeSummaryText(Selected, Placeholder);
}

export function renderAlertScopeClientNode(Entity: AlertScopeEntity, SelectedValues: Set<string>) {
  const Checked = SelectedValues.has(Entity.Value);
  return `
    <label class="alert-multiselect-option alert-scope-node alert-scope-node-client">
      <input type="checkbox" data-kind="client" value="${Safe(Entity.Value)}" ${Checked ? 'checked' : ''} />
      <span class="alert-scope-prefix" aria-hidden="true"></span>
      <span class="alert-scope-label-wrap"><i class="bi ${Safe(Entity.IconClass || '')} alert-scope-entity-icon" aria-hidden="true"></i><span>${Safe(Entity.Label)}</span></span>
    </label>
  `;
}

export function renderAlertScopeGroupNode(
  Group: AlertScopeGroupNode,
  SelectedValues: Set<string>,
  Scope: AlertScopeInput
) {
  const ExplicitlySelected = (Scope.Groups || []).some(
    (GroupID) => Number(GroupID) === Number(Group.GroupID)
  );
  const SelectedCount = Group.ChildValues.filter((Value) => SelectedValues.has(Value)).length;
  const FullySelected =
    ExplicitlySelected ||
    (Group.ChildValues.length > 0 && SelectedCount === Group.ChildValues.length);
  const Indeterminate = !FullySelected && SelectedCount > 0;
  const ChildrenHtml = Group.Children.map((Entity) =>
    renderAlertScopeClientNode(Entity, SelectedValues)
  ).join('');

  return `
    <div class="alert-scope-branch">
      <label class="alert-multiselect-option alert-scope-node alert-scope-node-group">
        <input
          type="checkbox"
          data-kind="group"
          value="${Safe(Group.Value)}"
          ${FullySelected ? 'checked' : ''}
          ${Indeterminate ? 'data-indeterminate="true"' : ''}
        />
        <span class="alert-scope-prefix" aria-hidden="true"></span>
        <span>${Safe(Group.Label)}</span>
      </label>
      ${ChildrenHtml ? `<div class="alert-scope-children">${ChildrenHtml}</div>` : ''}
    </div>
  `;
}

export function ShowAlertRuleMainContent() {
  $('#ALERT_RULE_MAIN_CONTENT').removeClass('d-none');
  $('#ALERT_ACTION_EDITOR_PANEL').addClass('d-none');
}

export function ShowAlertActionEditorPanel() {
  $('#ALERT_RULE_MAIN_CONTENT').addClass('d-none');
  $('#ALERT_ACTION_EDITOR_PANEL').removeClass('d-none');
}

export function RenderScopeDropdown(
  MenuSelector: string,
  ToggleSelector: string,
  Options: AlertScopeModel | null,
  SelectedValues: string[],
  Placeholder: string
) {
  const Model = buildAlertScopeModel();
  const Scope = ParseAlertScopeSelection();
  const EffectiveSelectedValues = resolveAlertScopeTargetValues(Scope, Model);
  const ToggleText = summarizeAlertScopeSelection(Model, Scope, Placeholder);

  if (ToggleSelector === '#ALERT_SCOPE_TOGGLE') {
    $(ToggleSelector).html(
      `<span>${Safe(ToggleText)}</span><i class="bi bi-chevron-down ms-2" aria-hidden="true"></i>`
    );
  } else {
    $(ToggleSelector).text(ToggleText);
  }

  const WorkspaceChecked =
    !!Scope.Workspace ||
    (Model.AllClientValues.length > 0 &&
      EffectiveSelectedValues.size === Model.AllClientValues.length);
  const WorkspaceIndeterminate = !WorkspaceChecked && EffectiveSelectedValues.size > 0;
  const GroupHtml = Model.Groups.map((Group) =>
    renderAlertScopeGroupNode(Group, EffectiveSelectedValues, Scope)
  ).join('');
  const UngroupedHtml = Model.Ungrouped.map((Entity) =>
    renderAlertScopeClientNode(Entity, EffectiveSelectedValues)
  ).join('');
  const Html = `
    <div class="alert-scope-tree">
      <label class="alert-multiselect-option alert-scope-node alert-scope-node-root">
        <input
          type="checkbox"
          data-kind="workspace"
          value="workspace:*"
          ${WorkspaceChecked ? 'checked' : ''}
          ${WorkspaceIndeterminate ? 'data-indeterminate="true"' : ''}
        />
        <span class="alert-scope-prefix" aria-hidden="true"></span>
        <span>All Clients</span>
      </label>
      <div class="alert-scope-children">
        ${GroupHtml}
        ${UngroupedHtml}
      </div>
    </div>
  `;

  $(MenuSelector).html(Html || '<div class="text-muted text-sm p-2">No options available.</div>');
  $(MenuSelector)
    .find('input[data-indeterminate="true"]')
    .each(function () {
      (this as HTMLInputElement).indeterminate = true;
    });
}

export function RenderScopeDropdowns() {
  RenderScopeDropdown(
    '#ALERT_SCOPE_MENU',
    '#ALERT_SCOPE_TOGGLE',
    AlertScopeOptions,
    AlertScopeSelected,
    'Select targets'
  );
}

export function BindScopeDropdownHandlers() {
  $('#ALERT_SCOPE_TOGGLE')
    .off('click.alertScope')
    .on('click.alertScope', function (Event) {
      Event.preventDefault();
      Event.stopPropagation();
      const $menu = $('#ALERT_SCOPE_MENU');
      const isOpen = !$menu.hasClass('d-none');
      CloseAllScopeDropdowns();
      if (!isOpen) $menu.removeClass('d-none');
    });

  $('#ALERT_SCOPE_MENU')
    .off('change.alertScope')
    .on('change.alertScope', 'input[type="checkbox"]', function () {
      const Kind = String($(this).attr('data-kind') || '');
      const Value = String($(this).val() || '');
      const Checked = $(this).is(':checked');
      const Model = buildAlertScopeModel();

      if (Kind === 'workspace') {
                setAlertScopeSelected(Checked ? ['workspace:*'] : []);
      } else {
        const Scope = ParseAlertScopeSelection();
        const SelectedTargets = resolveAlertScopeTargetValues(Scope, Model);
        if (Kind === 'group') {
          const Group = Model.Groups.find((Entry) => Entry.Value === Value);
          if (Group) {
            for (const ChildValue of Group.ChildValues) {
              if (Checked) SelectedTargets.add(ChildValue);
              else SelectedTargets.delete(ChildValue);
            }
          }
        } else if (Kind === 'client') {
          if (Checked) SelectedTargets.add(Value);
          else SelectedTargets.delete(Value);
        }
                setAlertScopeSelected(alertScopeToSelectedValues(
          buildAlertScopeFromTargetValues(Array.from(SelectedTargets), Model)
        ));
      }
      RenderScopeDropdowns();
      $('#ALERT_SCOPE_MENU').removeClass('d-none');
    });

  $(document)
    .off('mousedown.alertScopeDropdown touchstart.alertScopeDropdown')
    .on('mousedown.alertScopeDropdown touchstart.alertScopeDropdown', function (Event) {
      const inside = $(Event.target).closest('#ALERT_SCOPE_DROPDOWN').length > 0;
      if (!inside) CloseAllScopeDropdowns();
    });
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

export function CloseAlertActionEditor() {
  if (AlertActionEditorIsCreating && Number.isFinite(AlertEditingActionIndex)) {
    AlertRuleDraftActions.splice(AlertEditingActionIndex!, 1);
    RenderAlertActionsList();
  }
    setAlertActionEditorIsCreating(false);
    setAlertEditingActionIndex(null);
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
  $('#ALERT_ACTION_EDITOR_CLOSE').text(
    AlertActionEditorIsCreating ? 'Cancel New Action' : 'Back to Actions'
  );
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

  const DefaultTrigger = AlertTriggerTypesCache.length
    ? NormalizeAlertTriggerType(AlertTriggerTypesCache[0].ID)
    : 'CLIENT_OFFLINE';
  $('#ALERT_RULE_TRIGGER_TYPE').val(DefaultTrigger);
  RenderAlertRuleTriggerConfig(DefaultTrigger, {});

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

  const TriggerType = NormalizeAlertTriggerType(Rule.TriggerType || 'CLIENT_OFFLINE');
  $('#ALERT_RULE_TRIGGER_TYPE').val(TriggerType);
  RenderAlertRuleTriggerConfig(TriggerType, Rule.TriggerConfig || {});

  const Actions = Array.isArray(Rule.Actions) ? Rule.Actions : [];
    setAlertRuleDraftActions(Actions.map((Action) => ({
    Type: Action.Type,
    Settings: Action.Settings || {},
  })));
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

export function summarizeActionType(Type: string, Count: number) {
  if (Type === 'osc-trigger') {
    return Count > 1 ? `send ${Count} OSC messages` : 'send an OSC message';
  }
  if (Type === 'discord-webhook') {
    return Count > 1 ? `send ${Count} messages on Discord` : 'send a message on Discord';
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
    SingleName: IDs.length === 1 ? targetNameFromScopedID(IDs[0]) : null,
  };
}

export function buildRuleSummary(Rule: AlertRuleView) {
  const TriggerText = triggerSummaryText(Rule && Rule.TriggerType ? Rule.TriggerType : '');
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
  const TriggerType = NormalizeAlertTriggerType(
    ($('#ALERT_RULE_TRIGGER_TYPE').val() || '').toString().trim()
  );
  const Scope = ParseAlertScopeSelection();

  return {
    Title,
    Scope,
    TriggerType,
    TriggerConfig: CollectAlertTriggerConfig(),
    Actions: AlertRuleDraftActions,
    Enabled: true,
  };
}

export async function OpenAlertRuleManager() {
  await CloseAllModals();
  await EnsureAlertCatalogsLoaded();
  await LoadAudioAssets();
  await PopulateAlertScopeOptions();

  const TriggerOptions = (AlertTriggerTypesCache || [])
    .filter((T) => ALERT_TRIGGER_ALLOWLIST.has(`${T.ID || ''}`.toUpperCase()))
    .map((T) => `<option value="${Safe(T.ID)}">${Safe(T.Name)}</option>`)
    .join('');
  $('#ALERT_RULE_TRIGGER_TYPE').html(TriggerOptions);

  BindScopeDropdownHandlers();
  ResetAlertRuleEditor();
  RenderAlertRuleManagerList();
  ShowAlertListPanel();

  $('#ALERT_RULE_TRIGGER_TYPE')
    .off('change.alertRule')
    .on('change.alertRule', function () {
      RenderAlertRuleTriggerConfig($(this).val(), {});
    });

  $('#ALERT_RULE_BACK_TO_LIST')
    .off('click.alertRule')
    .on('click.alertRule', () => {
      ShowAlertListPanel();
            setAlertActionEditorIsCreating(false);
            setAlertEditingActionIndex(null);
      ShowAlertRuleMainContent();
    });

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
          ? AlertRuleDraftActions[AlertEditingActionIndex!].Settings || {}
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

  $('#ALERT_ACTION_EDITOR_CLOSE')
    .off('click.alertRule')
    .on('click.alertRule', () => CloseAlertActionEditor());

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

  $('#ALERT_ACTION_EDITOR_SAVE')
    .off('click.alertRule')
    .on('click.alertRule', () => {
      if (!Number.isFinite(AlertEditingActionIndex)) return;
      const Type = ($('#ALERT_ACTION_EDITOR_TYPE').val() || '').toString();
      if (!Type) return Notify('Please choose an action type', 'error');
      AlertRuleDraftActions[AlertEditingActionIndex!] = {
        Type,
        Settings: CollectActionSettingsFromEditorHost(),
      };
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

  $('#ALERT_RULE_SAVE')
    .off('click.alertRule')
    .on('click.alertRule', async () => {
      const Payload = BuildAlertRulePayloadFromEditor();
      if (!Payload.Title) return Notify('Please enter a rule title', 'error');
      if (!Payload.TriggerType) return Notify('Please choose a trigger', 'error');
      if (!Array.isArray(Payload.Actions) || !Payload.Actions.length) {
        return Notify('Please add at least one action', 'error');
      }

      if (AlertRuleEditorRuleID) {
        const [Err] = await window.API.UpdateAlertRule(String(AlertRuleEditorRuleID), Payload);
        if (Err) return Notify(Err, 'error');
        Notify('Alert rule updated', 'success', 1500);
      } else {
        const [Err] = await window.API.CreateAlertRule(Payload);
        if (Err) return Notify(Err, 'error');
        Notify('Alert rule created', 'success', 1500);
      }
      ShowAlertListPanel();
    });

  openModal('SHOWTRAK_MODAL_ALERT_MANAGER');
}

export async function OpenCreateAlertRuleEditor() {
  await OpenAlertRuleManager();
  ResetAlertRuleEditor();
  ShowAlertEditorPanel();
}
