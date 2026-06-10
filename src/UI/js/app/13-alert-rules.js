async function EnsureAlertCatalogsLoaded() {
  if (!AlertTriggerTypesCache.length) {
    AlertTriggerTypesCache = await window.API.GetAlertTriggers();
  }
  if (!AlertActionTypesCache.length) {
    AlertActionTypesCache = await window.API.GetAlertActionTypes();
  }
}

function ShowAlertListPanel() {
  $('#ALERT_MANAGER_LIST_PANEL').removeClass('d-none');
  $('#ALERT_MANAGER_EDITOR_PANEL').addClass('d-none');
}

function ShowAlertEditorPanel() {
  $('#ALERT_MANAGER_LIST_PANEL').addClass('d-none');
  $('#ALERT_MANAGER_EDITOR_PANEL').removeClass('d-none');
}

function CloseAllScopeDropdowns() {
  $('#ALERT_SCOPE_MENU').addClass('d-none');
}

function ParseAlertScopeSelection() {
  const Scope = {
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

function NormalizeAlertTriggerType(TriggerType) {
  const Normalized = `${TriggerType || ''}`.trim().toUpperCase();
  if (ALERT_TRIGGER_ALLOWLIST.has(Normalized)) return Normalized;
  return 'CLIENT_OFFLINE';
}

function ScopeSummaryText(Selected, Placeholder) {
  if (!Array.isArray(Selected) || !Selected.length) return Placeholder;
  if (Selected.length === 1) return Selected[0].Label;
  return `${Selected[0].Label} +${Selected.length - 1}`;
}

function ShowAlertRuleMainContent() {
  $('#ALERT_RULE_MAIN_CONTENT').removeClass('d-none');
  $('#ALERT_ACTION_EDITOR_PANEL').addClass('d-none');
}

function ShowAlertActionEditorPanel() {
  $('#ALERT_RULE_MAIN_CONTENT').addClass('d-none');
  $('#ALERT_ACTION_EDITOR_PANEL').removeClass('d-none');
}

function RenderScopeDropdown(MenuSelector, ToggleSelector, Options, SelectedValues, Placeholder) {
  const SelectedSet = new Set((SelectedValues || []).map((x) => `${x}`));
  const SelectedObjects = (Options || []).filter((Opt) => SelectedSet.has(`${Opt.Value}`));
  const ToggleText = ScopeSummaryText(SelectedObjects, Placeholder);

  if (ToggleSelector === '#ALERT_SCOPE_TOGGLE') {
    $(ToggleSelector).html(
      `<span>${Safe(ToggleText)}</span><i class="bi bi-chevron-down ms-2" aria-hidden="true"></i>`
    );
  } else {
    $(ToggleSelector).text(ToggleText);
  }

  const Html = (Options || [])
    .map(
      (Opt) => `
      <label class="alert-multiselect-option">
        <input type="checkbox" value="${Safe(`${Opt.Value}`)}" ${SelectedSet.has(`${Opt.Value}`) ? 'checked' : ''} />
        <span>${Safe(Opt.Label)}</span>
      </label>
    `
    )
    .join('');

  $(MenuSelector).html(Html || '<div class="text-muted text-sm p-2">No options available.</div>');
}

function RenderScopeDropdowns() {
  RenderScopeDropdown(
    '#ALERT_SCOPE_MENU',
    '#ALERT_SCOPE_TOGGLE',
    AlertScopeOptions,
    AlertScopeSelected,
    'Select targets'
  );
}

function BindScopeDropdownHandlers() {
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
      const values = [];
      $('#ALERT_SCOPE_MENU input[type="checkbox"]:checked').each(function () {
        values.push($(this).val());
      });
      AlertScopeSelected = values;
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

function RenderAlertRuleTriggerConfig(TriggerType, Config = {}) {
  const $host = $('#ALERT_RULE_TRIGGER_CONFIG');
  if (!$host.length) return;

  $host.empty().addClass('d-none');
}

function CollectAlertTriggerConfig() {
  return {};
}

function actionTypeByID(ID) {
  return AlertActionTypesCache.find((A) => A.ID === ID) || null;
}

function RenderAlertActionSettingsFields(ActionTypeID, ExistingSettings = {}) {
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
      const Options = Array.isArray(Field.Options) ? Field.Options : [];
      const OptionsHtml = Options.map((Option) => {
        const OptionValue = Option && typeof Option === 'object' ? Option.Value : Option;
        const OptionLabel =
          Option && typeof Option === 'object' ? Option.Label || Option.Value : Option;
        const Selected = String(OptionValue) === String(Value) ? 'selected' : '';
        return `<option value="${Safe(String(OptionValue))}" ${Selected}>${Safe(String(OptionLabel))}</option>`;
      }).join('');
      const PreviewButton =
        Field.Preview === 'sound'
            ? `<button type="button" class="btn bg-ghost text-white" data-sound-preview title="Preview sound">
              <i class="bi bi-play-fill"></i> Preview
            </button>`
          : '';
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

function RenderAlertActionTypeOptions(SelectedType = null) {
  return (AlertActionTypesCache || [])
    .map(
      (ActionType) =>
        `<option value="${Safe(ActionType.ID)}" ${ActionType.ID === SelectedType ? 'selected' : ''}>${Safe(ActionType.Name)}</option>`
    )
    .join('');
}

function RenderAlertActionsList() {
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
    Html += `
      <div class="rounded bg-ghost p-2 d-grid gap-1 text-start border-0 alert-action-open" data-action-index="${Index}" role="button" tabindex="0">
        <div class="d-flex align-items-center">
          <strong>${Safe(ActionType ? ActionType.Name : Action.Type || 'Action')}</strong>
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
      const Index = parseInt($(this).attr('data-action-index'), 10);
      if (!Number.isFinite(Index)) return;
      OpenAlertActionEditor(Index);
    })
    .on('keydown', function (Event) {
      if (Event.key !== 'Enter' && Event.key !== ' ') return;
      Event.preventDefault();
      const Index = parseInt($(this).attr('data-action-index'), 10);
      if (!Number.isFinite(Index)) return;
      OpenAlertActionEditor(Index);
    });
}

function CollectActionSettingsFromEditorHost() {
  const Settings = {};
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

function CloseAlertActionEditor() {
  if (AlertActionEditorIsCreating && Number.isFinite(AlertEditingActionIndex)) {
    AlertRuleDraftActions.splice(AlertEditingActionIndex, 1);
    RenderAlertActionsList();
  }
  AlertActionEditorIsCreating = false;
  AlertEditingActionIndex = null;
  ShowAlertRuleMainContent();
}

function OpenAlertActionEditor(Index, IsCreating = false) {
  if (!Array.isArray(AlertRuleDraftActions) || !AlertRuleDraftActions[Index]) return;
  AlertEditingActionIndex = Index;
  AlertActionEditorIsCreating = !!IsCreating;
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

function AddAlertActionAndEdit() {
  const DefaultType = (AlertActionTypesCache[0] && AlertActionTypesCache[0].ID) || '';
  AlertRuleDraftActions.push({
    Type: DefaultType,
    Settings: {},
  });
  RenderAlertActionsList();
  OpenAlertActionEditor(AlertRuleDraftActions.length - 1, true);
}

async function PopulateAlertScopeOptions(Rule = null) {
  let Groups = await window.API.GetAllGroups();
  if (!Array.isArray(Groups)) Groups = [];

  const ScopeOptions = [
    {
      Value: 'workspace:*',
      Label: 'Workspace (All Clients)',
    },
  ];

  for (const G of Groups) {
    ScopeOptions.push({
      Value: `group:${G.GroupID}`,
      Label: `[Group] ${G.Title || `Group ${G.GroupID}`}`,
    });
  }

  for (const C of AllClients || []) {
    ScopeOptions.push({
      Value: `client:${C.UUID}`,
      Label: `${C.Nickname || C.Hostname || C.UUID} (${C.UUID})`,
    });
  }
  for (const T of MonitoringTargets || []) {
    ScopeOptions.push({
      Value: `client:monitor:${T.TargetID}`,
      Label: `[Monitor] ${T.Nickname || T.Address || `Target ${T.TargetID}`}`,
    });
  }

  AlertScopeOptions = ScopeOptions;

  const Scope = Rule && Rule.Scope ? Rule.Scope : { Workspace: false, Groups: [], Clients: [] };
  const Selected = [];
  if (Scope.Workspace) Selected.push('workspace:*');
  for (const GroupID of Scope.Groups || []) Selected.push(`group:${GroupID}`);
  for (const ClientID of Scope.Clients || []) Selected.push(`client:${ClientID}`);
  AlertScopeSelected = Selected;
  RenderScopeDropdowns();
}

function ResetAlertRuleEditor() {
  AlertRuleEditorRuleID = null;
  AlertEditingActionIndex = null;
  AlertActionEditorIsCreating = false;
  AlertRuleDraftActions = [];
  $('#ALERT_RULE_EDITOR_TITLE').text('Create Alert Rule');
  $('#ALERT_RULE_TITLE').val('');
  $('#ALERT_RULE_DELETE').addClass('d-none');
  AlertScopeSelected = [];
  RenderScopeDropdowns();

  const DefaultTrigger = AlertTriggerTypesCache.length
    ? NormalizeAlertTriggerType(AlertTriggerTypesCache[0].ID)
    : 'CLIENT_OFFLINE';
  $('#ALERT_RULE_TRIGGER_TYPE').val(DefaultTrigger);
  RenderAlertRuleTriggerConfig(DefaultTrigger, {});

  RenderAlertActionsList();
  ShowAlertRuleMainContent();
}

function OpenAlertRuleEditor(Rule) {
  if (!Rule) {
    ResetAlertRuleEditor();
    return;
  }

  AlertRuleEditorRuleID = Rule.RuleID;
  AlertEditingActionIndex = null;
  AlertActionEditorIsCreating = false;
  $('#ALERT_RULE_EDITOR_TITLE').text(`Edit Rule #${Rule.RuleID}`);
  $('#ALERT_RULE_TITLE').val(Rule.Title || '');
  $('#ALERT_RULE_DELETE').removeClass('d-none');

  PopulateAlertScopeOptions(Rule);

  const TriggerType = NormalizeAlertTriggerType(Rule.TriggerType || 'CLIENT_OFFLINE');
  $('#ALERT_RULE_TRIGGER_TYPE').val(TriggerType);
  RenderAlertRuleTriggerConfig(TriggerType, Rule.TriggerConfig || {});

  const Actions = Array.isArray(Rule.Actions) ? Rule.Actions : [];
  AlertRuleDraftActions = Actions.map((Action) => ({
    Type: Action.Type,
    Settings: Action.Settings || {},
  }));
  RenderAlertActionsList();
  ShowAlertRuleMainContent();
  ShowAlertEditorPanel();
}

function actionTypeNameByID(ID) {
  const ActionType = actionTypeByID(ID);
  return ActionType && ActionType.Name ? ActionType.Name : String(ID || 'action');
}

function triggerSummaryText(TriggerType) {
  if (TriggerType === 'CLIENT_OFFLINE') return 'is offline';
  if (TriggerType === 'CLIENT_ONLINE') return 'is online';
  if (TriggerType === 'SCRIPT_EXECUTION_FAILED') return 'fails to execute a script';
  if (TriggerType === 'USB_DEVICE_CONNECTED') return 'has a USB device connected';
  if (TriggerType === 'USB_DEVICE_DISCONNECTED') return 'has a USB device disconnected';
    if (TriggerType === 'CRITICAL_USB_DEVICE_CONNECTED') return 'has a critical USB device connected';
    if (TriggerType === 'CRITICAL_USB_DEVICE_DISCONNECTED') return 'has a critical USB device disconnected';
  return 'triggers';
}

function summarizeActionType(Type, Count) {
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
  if (Type === 'showtrak-alert') {
    return Count > 1 ? `create ${Count} ShowTrak alerts` : 'create a ShowTrak alert';
  }
  const Name = actionTypeNameByID(Type);
  return Count > 1 ? `run ${Count} ${Name} actions` : `run ${Name}`;
}

function naturalJoin(Items) {
  if (!Array.isArray(Items) || !Items.length) return '';
  if (Items.length === 1) return Items[0];
  if (Items.length === 2) return `${Items[0]} and ${Items[1]}`;
  return `${Items.slice(0, -1).join(', ')}, and ${Items[Items.length - 1]}`;
}

function targetNameFromScopedID(ScopedID) {
  const ID = String(ScopedID || '');
  if (!ID) return 'Target';

  if (ID.startsWith('monitor:')) {
    const TargetID = ID.slice('monitor:'.length);
    const Monitor = (MonitoringTargets || []).find((T) => String(T.TargetID) === TargetID);
    return Monitor
      ? Monitor.Nickname || Monitor.Address || `Target ${TargetID}`
      : `Target ${TargetID}`;
  }

  const Client = (AllClients || []).find((C) => String(C.UUID) === ID);
  return Client ? Client.Nickname || Client.Hostname || Client.UUID : ID;
}

function scopedTargetsInfo(Rule) {
  const Scope = Rule && Rule.Scope ? Rule.Scope : {};
  if (Scope.Workspace) {
    const WorkspaceTargets = [];
    for (const Client of AllClients || []) {
      WorkspaceTargets.push(Client.Nickname || Client.Hostname || Client.UUID);
    }
    for (const Monitor of MonitoringTargets || []) {
      WorkspaceTargets.push(Monitor.Nickname || Monitor.Address || `Target ${Monitor.TargetID}`);
    }
    return {
      Count: WorkspaceTargets.length,
      SingleName: WorkspaceTargets.length === 1 ? WorkspaceTargets[0] : null,
    };
  }

  const Selected = new Set((Scope.Clients || []).map((ClientID) => String(ClientID)));

  for (const GroupID of Scope.Groups || []) {
    const UUIDs = GroupUUIDCache.get(String(GroupID));
    if (!Array.isArray(UUIDs)) continue;
    for (const UUID of UUIDs) Selected.add(String(UUID));
  }

  const IDs = Array.from(Selected);
  return {
    Count: IDs.length,
    SingleName: IDs.length === 1 ? targetNameFromScopedID(IDs[0]) : null,
  };
}

function buildRuleSummary(Rule) {
  const TriggerText = triggerSummaryText(Rule && Rule.TriggerType ? Rule.TriggerType : '');
  const ScopeInfo = scopedTargetsInfo(Rule);
  const Actions = Array.isArray(Rule && Rule.Actions) ? Rule.Actions : [];

  const CountsByType = new Map();
  for (const Action of Actions) {
    const Type = String((Action && Action.Type) || 'action');
    CountsByType.set(Type, (CountsByType.get(Type) || 0) + 1);
  }

  const ActionPhrases = [];
  for (const [Type, Count] of CountsByType.entries()) {
    ActionPhrases.push(summarizeActionType(Type, Count));
  }

  const ActionText = ActionPhrases.length ? naturalJoin(ActionPhrases) : 'take no actions';
  const Subject = ScopeInfo.SingleName ? ScopeInfo.SingleName : `one of ${ScopeInfo.Count} clients`;
  return `When ${Subject} ${TriggerText}, ${ActionText}.`;
}

function RenderAlertRuleManagerList() {
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
    Html += `
      <div class="rounded bg-ghost p-2 d-grid gap-1 text-start border-0 alert-rule-open" data-ruleid="${Rule.RuleID}" role="button" tabindex="0">
        <div class="d-flex justify-content-between align-items-center gap-2">
          <strong>${Safe(Rule.Title || `Rule ${Rule.RuleID}`)}</strong>
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
      const RuleID = parseInt($(this).attr('data-ruleid'), 10);
      if (!Number.isFinite(RuleID)) return;
      const Rule = AlertRulesCache.find((R) => R.RuleID === RuleID);
      if (Rule) OpenAlertRuleEditor(Rule);
    });
}

function BuildAlertRulePayloadFromEditor() {
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

async function OpenAlertRuleManager() {
  await CloseAllModals();
  await EnsureAlertCatalogsLoaded();
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
      AlertActionEditorIsCreating = false;
      AlertEditingActionIndex = null;
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
        Number.isFinite(AlertEditingActionIndex) && AlertRuleDraftActions[AlertEditingActionIndex]
          ? AlertRuleDraftActions[AlertEditingActionIndex].Settings || {}
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
      if (typeof PreviewSound === 'function') PreviewSound(SoundName);
    });

  $('#ALERT_ACTION_EDITOR_CLOSE')
    .off('click.alertRule')
    .on('click.alertRule', () => CloseAlertActionEditor());

  $('#ALERT_ACTION_EDITOR_DELETE')
    .off('click.alertRule')
    .on('click.alertRule', () => {
      if (!Number.isFinite(AlertEditingActionIndex)) return;
      AlertRuleDraftActions.splice(AlertEditingActionIndex, 1);
      AlertActionEditorIsCreating = false;
      RenderAlertActionsList();
      AlertEditingActionIndex = null;
      ShowAlertRuleMainContent();
    });

  $('#ALERT_ACTION_EDITOR_SAVE')
    .off('click.alertRule')
    .on('click.alertRule', () => {
      if (!Number.isFinite(AlertEditingActionIndex)) return;
      const Type = ($('#ALERT_ACTION_EDITOR_TYPE').val() || '').toString();
      if (!Type) return Notify('Please choose an action type', 'error');
      AlertRuleDraftActions[AlertEditingActionIndex] = {
        Type,
        Settings: CollectActionSettingsFromEditorHost(),
      };
      AlertActionEditorIsCreating = false;
      RenderAlertActionsList();
      AlertEditingActionIndex = null;
      ShowAlertRuleMainContent();
    });

  $('#ALERT_RULE_DELETE')
    .off('click.alertRule')
    .on('click.alertRule', async () => {
      if (!AlertRuleEditorRuleID) return;
      const Confirmed = await ConfirmationDialog('Delete this alert rule? This cannot be undone.');
      if (!Confirmed) return;
      const [Err] = await window.API.DeleteAlertRule(AlertRuleEditorRuleID);
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
        const [Err] = await window.API.UpdateAlertRule(AlertRuleEditorRuleID, Payload);
        if (Err) return Notify(Err, 'error');
        Notify('Alert rule updated', 'success', 1500);
      } else {
        const [Err] = await window.API.CreateAlertRule(Payload);
        if (Err) return Notify(Err, 'error');
        Notify('Alert rule created', 'success', 1500);
      }
      ShowAlertListPanel();
    });

  $('#SHOWTRAK_MODAL_ALERT_MANAGER').modal('show');
}

async function OpenCreateAlertRuleEditor() {
  await OpenAlertRuleManager();
  ResetAlertRuleEditor();
  ShowAlertEditorPanel();
}
