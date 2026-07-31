// Workflow Manager UI.
//
// Four panels swapped by toggling d-none, mirroring the Alert Manager:
// List -> Workflow editor -> Step editor -> Run/debug.
//
// The decision logic (summaries, tree flattening, step mutation, payload
// building) is exported as pure functions so it can be unit-tested without
// jsdom, per the house convention. Anything touching the DOM sits behind a
// `$('#…').length` guard so the chainable jQuery stub short-circuits it.
import type {
  WorkflowView,
  WorkflowStepView,
  WorkflowRunView,
  WorkflowRunStepView,
  MonitoringMethodActionView,
  AlertActionType,
} from '@showtrak/protocol';

import {
  WorkflowsCache,
  setWorkflowsCache,
  WorkflowStepKindsCache,
  setWorkflowStepKindsCache,
  ActiveWorkflowRun,
  setActiveWorkflowRun,
  WorkflowDraft,
  setWorkflowDraft,
  WorkflowEditorID,
  setWorkflowEditorID,
  WorkflowEditingStepID,
  setWorkflowEditingStepID,
  AlertActionTypesCache,
  setAlertActionTypesCache,
  AlertTriggerTypesCache,
  setAlertTriggerTypesCache,
  MonitoringMethodsCache,
  AlertScopeGroups,
  Tags,
} from './state';
import { Safe } from './utils';
import { openModal, closeAllModals } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { Notify, ConfirmationDialog } from './lib/toasts';
import { bindScopeButton, renderScopeButton, type ScopePickerConfig } from './scope-picker';
import {
  buildScopeModel,
  scopeToSelectedValues,
  parseScopeSelection,
  type ScopeInput,
} from './lib/scope-model';

// --- Scope picker instance ---------------------------------------------------

let WorkflowScopeSelected: string[] = [];

const WorkflowScopeConfig: ScopePickerConfig = {
  ButtonSelector: '#WORKFLOW_SCOPE_TOGGLE',
  Namespace: 'workflowScope',
  Title: 'Workflow Targets',
  Placeholder: 'Select targets',
  Hint: 'Where this workflow is offered. Steps act on whatever the workflow was run against, so one workflow covers every machine listed here.',
  GetSelected: () => WorkflowScopeSelected,
  SetSelected: (values) => {
    WorkflowScopeSelected = values;
  },
  GetTags: () => Tags,
  BuildModel: () => buildScopeModel({ Groups: AlertScopeGroups, Tags }),
  ToggleRender: 'html',
  OnCommit: () => {
    if (WorkflowDraft) {
      WorkflowDraft.Triggers.Scope = scopeFromSelection(WorkflowScopeSelected);
    }
  },
};

function scopeFromSelection(Values: string[]): WorkflowView['Triggers']['Scope'] {
  const Parsed = parseScopeSelection(Values);
  return {
    Workspace: !!Parsed.Workspace,
    Groups: Parsed.Groups || [],
    Clients: Parsed.Clients || [],
    Tags: Parsed.Tags || [],
  };
}

// --- Pure helpers (exported for tests) --------------------------------------

/** Count every step in a tree, including those nested inside If branches. */
export function countSteps(Steps: readonly WorkflowStepView[]): number {
  let Total = 0;
  for (const Step of Steps) {
    Total++;
    if (Step.Kind === 'if') {
      Total += countSteps(Step.Then || []);
      Total += countSteps(Step.Else || []);
    }
  }
  return Total;
}

export interface FlatStep {
  Step: WorkflowStepView;
  Depth: number;
  Branch: 'then' | 'else' | null;
  /** The array this step lives in, so reorder/remove can act on it directly. */
  Parent: WorkflowStepView[];
  Index: number;
}

/**
 * Flatten the tree into display rows. Preserves the nesting as a Depth so the
 * renderer draws an indented list rather than re-walking the tree, and carries
 * the owning array so a row's controls can mutate in place.
 */
export function flattenSteps(
  Steps: WorkflowStepView[],
  Depth = 0,
  Branch: 'then' | 'else' | null = null,
  Out: FlatStep[] = []
): FlatStep[] {
  Steps.forEach((Step, Index) => {
    Out.push({ Step, Depth, Branch, Parent: Steps, Index });
    if (Step.Kind === 'if') {
      if (!Array.isArray(Step.Then)) Step.Then = [];
      if (!Array.isArray(Step.Else)) Step.Else = [];
      flattenSteps(Step.Then, Depth + 1, 'then', Out);
      flattenSteps(Step.Else, Depth + 1, 'else', Out);
    }
  });
  return Out;
}

export function findFlatStep(Steps: WorkflowStepView[], StepID: string): FlatStep | null {
  return flattenSteps(Steps).find((F) => F.Step.StepID === StepID) || null;
}

/** A short human summary of a step, for the tree row. */
export function describeStep(Step: WorkflowStepView): string {
  if (Step.Label) return Step.Label;
  switch (Step.Kind) {
    case 'action':
      return Step.ActionID || 'Action';
    case 'if':
      return `If ${Step.Condition ? Step.Condition.Left || 'value' : 'value'} ${
        Step.Condition ? Step.Condition.Operator : 'is'
      } ${Step.Condition ? String(Step.Condition.Right ?? '') : ''}`.trim();
    case 'delay':
      return `Wait ${Math.round(Number(Step.Ms || 0) / 100) / 10}s`;
    case 'prompt':
      return `Ask: ${Step.Message || 'Continue?'}`;
    case 'call':
      return 'Run another workflow';
    default:
      return Step.Reason ? `Stop — ${Step.Reason}` : 'Stop';
  }
}

/** One-line summary for the workflow list row. */
export function buildWorkflowSummary(Workflow: WorkflowView): string {
  const Parts: string[] = [];
  const Count = countSteps(Workflow.Steps || []);
  Parts.push(`${Count} step${Count === 1 ? '' : 's'}`);

  const Triggers = Workflow.Triggers;
  const How: string[] = [];
  if (Triggers.Manual) How.push('manually');
  if (Triggers.Events && Triggers.Events.length) {
    How.push(`on ${Triggers.Events.length} event${Triggers.Events.length === 1 ? '' : 's'}`);
  }
  if (Triggers.Callable) How.push('when called');
  // A workflow nothing can start is the one mistake worth calling out here.
  Parts.push(How.length ? `runs ${How.join(', ')}` : 'nothing can start it');

  if (Workflow.Return && Workflow.Return.From) {
    Parts.push(`returns ${Workflow.Return.Name || 'a value'}`);
  }
  return Parts.join(' · ');
}

/** True when the workflow could never be started by anything. */
export function isUnreachable(Workflow: WorkflowView): boolean {
  const T = Workflow.Triggers;
  return !T.Manual && !T.Callable && !(T.Events && T.Events.length);
}

/** The payload sent to the server. Mirrors the create/update validator shape. */
export function buildWorkflowPayload(Draft: WorkflowView): Record<string, unknown> {
  return {
    Name: Draft.Name,
    Description: Draft.Description,
    Icon: Draft.Icon,
    Colour: Draft.Colour,
    Triggers: Draft.Triggers,
    Steps: Draft.Steps,
    Return: Draft.Return,
    Enabled: Draft.Enabled,
  };
}

/** A blank step of the given kind, for the Add Step flow. */
export function makeStep(Kind: WorkflowStepView['Kind']): WorkflowStepView {
  const Base: WorkflowStepView = {
    // The server mints the authoritative ID on save; this only has to be unique
    // within the draft so the editor can address the row.
    StepID: `new-${Math.random().toString(36).slice(2, 10)}`,
    Kind,
    Enabled: true,
    ContinueOnError: false,
  };
  if (Kind === 'action') {
    return { ...Base, ActionKind: 'method', ActionID: '', Params: {}, Target: { Mode: 'context' } };
  }
  if (Kind === 'if') {
    return { ...Base, Condition: { Left: '', Operator: 'is', Right: '' }, Then: [], Else: [] };
  }
  if (Kind === 'delay') return { ...Base, Ms: 5000 };
  if (Kind === 'prompt') {
    return {
      ...Base,
      Message: 'Continue?',
      Buttons: [
        { Value: 'yes', Label: 'Yes', Style: 'primary' },
        { Value: 'no', Label: 'No', Style: 'secondary' },
      ],
      TimeoutMs: 60000,
      DefaultValue: 'no',
      StoreAs: 'answer',
    };
  }
  if (Kind === 'call') return { ...Base, WorkflowID: 0 };
  return { ...Base, Reason: '' };
}

/** Move a step up or down within its own branch. */
export function moveStep(Flat: FlatStep, Delta: number): boolean {
  const Target = Flat.Index + Delta;
  if (Target < 0 || Target >= Flat.Parent.length) return false;
  const [Moved] = Flat.Parent.splice(Flat.Index, 1);
  Flat.Parent.splice(Target, 0, Moved as WorkflowStepView);
  return true;
}

/** Every method control action, flattened for the step editor's picker. */
export function collectMethodActions(): Array<{ Value: string; Label: string; Group: string }> {
  const Out: Array<{ Value: string; Label: string; Group: string }> = [];
  for (const Method of MonitoringMethodsCache || []) {
    for (const Action of (Method as { Actions?: MonitoringMethodActionView[] }).Actions || []) {
      Out.push({
        Value: `${Method.ID}/${Action.ID}`,
        Label: `${Method.Name} — ${Action.Label}`,
        Group: Action.Group || 'Control',
      });
    }
  }
  return Out;
}

export function findMethodAction(ActionID: string): MonitoringMethodActionView | null {
  const Slash = String(ActionID || '').indexOf('/');
  if (Slash < 0) return null;
  const MethodID = ActionID.slice(0, Slash);
  const ID = ActionID.slice(Slash + 1);
  const Method = (MonitoringMethodsCache || []).find((M) => M.ID === MethodID) as
    { Actions?: MonitoringMethodActionView[] } | undefined;
  if (!Method) return null;
  return (Method.Actions || []).find((A) => A.ID === ID) || null;
}

// --- Panels ------------------------------------------------------------------

function ShowListPanel(): void {
  $('#WORKFLOW_MANAGER_LIST_PANEL').removeClass('d-none');
  $('#WORKFLOW_MANAGER_EDITOR_PANEL').addClass('d-none');
  $('#WORKFLOW_RUN_PANEL').addClass('d-none');
}

function ShowEditorPanel(): void {
  $('#WORKFLOW_MANAGER_LIST_PANEL').addClass('d-none');
  $('#WORKFLOW_MANAGER_EDITOR_PANEL').removeClass('d-none');
  $('#WORKFLOW_RUN_PANEL').addClass('d-none');
  $('#WORKFLOW_EDITOR_BODY').removeClass('d-none');
  $('#WORKFLOW_STEP_EDITOR_PANEL').addClass('d-none');
}

function ShowStepEditor(): void {
  $('#WORKFLOW_EDITOR_BODY').addClass('d-none');
  $('#WORKFLOW_STEP_EDITOR_PANEL').removeClass('d-none');
}

function ShowRunPanel(): void {
  $('#WORKFLOW_MANAGER_LIST_PANEL').addClass('d-none');
  $('#WORKFLOW_MANAGER_EDITOR_PANEL').addClass('d-none');
  $('#WORKFLOW_RUN_PANEL').removeClass('d-none');
}

// --- List --------------------------------------------------------------------

export function RenderWorkflowList(): void {
  const $Host = $('#WORKFLOW_MANAGER_LIST');
  if (!$Host.length) return;

  if (!WorkflowsCache.length) {
    $Host.html(
      '<div class="bg-ghost rounded p-3 text-center text-muted">No workflows yet. Create one to automate a response — power a projector back on, fire a cue, or ask an operator what to do.</div>'
    );
    return;
  }

  const Rows = WorkflowsCache.map((Workflow) => {
    const Warning = isUnreachable(Workflow)
      ? '<i class="bi bi-exclamation-triangle-fill text-warning ms-1" title="Nothing can start this workflow"></i>'
      : '';
    const Disabled = Workflow.Enabled ? '' : ' opacity-50';
    return `
      <div class="rounded bg-ghost p-2 d-flex align-items-center gap-2 workflow-open${Disabled}"
           data-workflowid="${Workflow.WorkflowID}" role="button" tabindex="0">
        <i class="bi bi-${Safe(Workflow.Icon || 'diagram-3')}"></i>
        <div class="flex-grow-1">
          <div><strong>${Safe(Workflow.Name)}</strong>${Warning}</div>
          <small class="text-muted">${Safe(buildWorkflowSummary(Workflow))}</small>
        </div>
        <i class="bi bi-chevron-right workflow-chevron"></i>
      </div>`;
  }).join('');

  $Host.html(Rows);
  $Host
    .find('.workflow-open')
    .off('click.workflow')
    .on('click.workflow', function () {
      const ID = Number($(this).data('workflowid'));
      const Workflow = WorkflowsCache.find((W) => W.WorkflowID === ID);
      if (Workflow) OpenWorkflowEditor(Workflow);
    });
}

// --- Editor ------------------------------------------------------------------

export function OpenWorkflowEditor(Workflow: WorkflowView | null): void {
  // Deep clone so an abandoned edit leaves the cached copy untouched.
  const Draft: WorkflowView = Workflow
    ? (JSON.parse(JSON.stringify(Workflow)) as WorkflowView)
    : ({
        WorkflowID: 0,
        Slug: null,
        Name: '',
        Description: '',
        Icon: 'diagram-3',
        Colour: 6,
        Triggers: {
          Manual: true,
          Callable: true,
          Events: [],
          EventConfig: {},
          Scope: { Workspace: false, Groups: [], Clients: [], Tags: [] },
        },
        Steps: [],
        Return: { Name: 'Result', Type: 'boolean', From: '', Fallback: false },
        Enabled: true,
        Weight: 100,
        Timestamp: 0,
        UpdatedAt: 0,
      } as WorkflowView);

  setWorkflowDraft(Draft);
  setWorkflowEditorID(Workflow ? Workflow.WorkflowID : null);
  WorkflowScopeSelected = scopeToSelectedValues(Draft.Triggers.Scope as ScopeInput);

  $('#WORKFLOW_NAME').val(Draft.Name);
  $('#WORKFLOW_DESCRIPTION').val(Draft.Description);
  $('#WORKFLOW_TRIGGER_MANUAL').prop('checked', !!Draft.Triggers.Manual);
  $('#WORKFLOW_TRIGGER_CALLABLE').prop('checked', !!Draft.Triggers.Callable);
  $('#WORKFLOW_RETURN_NAME').val(Draft.Return.Name);
  $('#WORKFLOW_RETURN_TYPE').val(Draft.Return.Type);
  $('#WORKFLOW_RETURN_FROM').val(Draft.Return.From);
  $('#WORKFLOW_RETURN_FALLBACK').val(String(Draft.Return.Fallback ?? ''));
  $('#WORKFLOW_DELETE_BUTTON').toggleClass('d-none', !Workflow);
  $('#WORKFLOW_TEST_BUTTON').toggleClass('d-none', !Workflow);

  renderScopeButton(WorkflowScopeConfig);
  RenderEventPicker();
  RenderStepTree();
  RenderEditorHeader(Draft);
  ShowEditorPanel();
}

function RenderEditorHeader(Draft: WorkflowView): void {
  const $Host = $('#WORKFLOW_EDITOR_HEADER');
  if (!$Host.length) return;
  $Host.empty().append(
    buildModalHeader({
      title: Draft.Name || 'New Workflow',
      backLabel: 'Back',
      onBack: () => void SaveAndReturnToList(),
      onClose: () => void SaveAndClose(),
    }).$el
  );
}

function RenderEventPicker(): void {
  const $Menu = $('#WORKFLOW_EVENT_MENU');
  if (!$Menu.length || !WorkflowDraft) return;
  const Selected = new Set(WorkflowDraft.Triggers.Events || []);

  $Menu.html(
    (AlertTriggerTypesCache || [])
      .map(
        (T) => `
        <label class="alert-multiselect-option d-flex align-items-center gap-2">
          <input type="checkbox" class="form-check-input workflow-event" value="${Safe(T.ID)}" ${
            Selected.has(T.ID) ? 'checked' : ''
          } />
          <span>${Safe(T.Name)}</span>
        </label>`
      )
      .join('')
  );

  const Count = Selected.size;
  $('#WORKFLOW_EVENT_SUMMARY').text(
    Count ? `${Count} event${Count === 1 ? '' : 's'}` : 'No events'
  );

  $Menu
    .find('.workflow-event')
    .off('change.workflow')
    .on('change.workflow', function () {
      if (!WorkflowDraft) return;
      const Value = String($(this).val());
      const Events = new Set(WorkflowDraft.Triggers.Events || []);
      if ($(this).is(':checked')) Events.add(Value);
      else Events.delete(Value);
      WorkflowDraft.Triggers.Events = Array.from(Events);
      RenderEventPicker();
    });
}

// --- Step tree ---------------------------------------------------------------

export function RenderStepTree(): void {
  const $Host = $('#WORKFLOW_STEP_LIST');
  if (!$Host.length || !WorkflowDraft) return;

  const Flat = flattenSteps(WorkflowDraft.Steps);
  if (!Flat.length) {
    $Host.html('<div class="text-muted small p-2">No steps yet.</div>');
    return;
  }

  $Host.html(
    Flat.map((F) => {
      const Kind = WorkflowStepKindsCache.find((K) => K.Kind === F.Step.Kind);
      const Branch =
        F.Branch === 'then'
          ? '<span class="badge bg-success-subtle text-success-emphasis me-1">then</span>'
          : F.Branch === 'else'
            ? '<span class="badge bg-secondary-subtle text-secondary-emphasis me-1">else</span>'
            : '';
      const Muted = F.Step.Enabled === false ? ' opacity-50' : '';
      return `
        <div class="d-flex align-items-center gap-2 bg-ghost rounded p-2 workflow-step-row${Muted}"
             data-stepid="${Safe(F.Step.StepID)}"
             style="margin-left:${F.Depth * 1.5}rem">
          <i class="bi bi-${Safe(Kind ? Kind.Icon : 'dot')}"></i>
          <div class="flex-grow-1 text-truncate">${Branch}${Safe(describeStep(F.Step))}</div>
          <button type="button" class="btn btn-sm btn-light workflow-step-up" title="Move up">
            <i class="bi bi-arrow-up"></i>
          </button>
          <button type="button" class="btn btn-sm btn-light workflow-step-down" title="Move down">
            <i class="bi bi-arrow-down"></i>
          </button>
          <i class="bi bi-chevron-right workflow-step-edit" role="button"></i>
        </div>`;
    }).join('')
  );

  const byRow = (El: HTMLElement): FlatStep | null => {
    const ID = String($(El).closest('.workflow-step-row').data('stepid'));
    return WorkflowDraft ? findFlatStep(WorkflowDraft.Steps, ID) : null;
  };

  $Host
    .find('.workflow-step-up')
    .off('click.workflow')
    .on('click.workflow', function (Event) {
      Event.stopPropagation();
      const F = byRow(this);
      if (F && moveStep(F, -1)) RenderStepTree();
    });

  $Host
    .find('.workflow-step-down')
    .off('click.workflow')
    .on('click.workflow', function (Event) {
      Event.stopPropagation();
      const F = byRow(this);
      if (F && moveStep(F, 1)) RenderStepTree();
    });

  $Host
    .find('.workflow-step-row')
    .off('click.workflow')
    .on('click.workflow', function () {
      const ID = String($(this).data('stepid'));
      OpenStepEditor(ID);
    });
}

// --- Step editor -------------------------------------------------------------

export function OpenStepEditor(StepID: string): void {
  if (!WorkflowDraft) return;
  const Flat = findFlatStep(WorkflowDraft.Steps, StepID);
  if (!Flat) return;
  setWorkflowEditingStepID(StepID);

  $('#WORKFLOW_STEP_KIND').html(
    WorkflowStepKindsCache.map(
      (K) =>
        `<option value="${Safe(K.Kind)}"${K.Kind === Flat.Step.Kind ? ' selected' : ''}>${Safe(
          K.Label
        )}</option>`
    ).join('')
  );
  const Kind = WorkflowStepKindsCache.find((K) => K.Kind === Flat.Step.Kind);
  $('#WORKFLOW_STEP_KIND_NOTE').text(Kind ? Kind.Description : '');
  $('#WORKFLOW_STEP_CONTINUE_ON_ERROR').prop('checked', !!Flat.Step.ContinueOnError);

  RenderStepFields(Flat.Step);

  const $Host = $('#WORKFLOW_STEP_EDITOR_HEADER');
  if ($Host.length) {
    $Host.empty().append(
      buildModalHeader({
        title: describeStep(Flat.Step),
        backLabel: 'Back',
        onBack: () => {
          CommitStepEditor();
          setWorkflowEditingStepID(null);
          RenderStepTree();
          ShowEditorPanel();
        },
        onClose: () => void SaveAndClose(),
      }).$el
    );
  }
  ShowStepEditor();
}

function field(Label: string, Inner: string): string {
  return `<div class="form-floating">${Inner}<label>${Safe(Label)}</label></div>`;
}

function RenderStepFields(Step: WorkflowStepView): void {
  const $Host = $('#WORKFLOW_STEP_EDITOR_FIELDS');
  if (!$Host.length) return;
  const Html: string[] = [];

  Html.push(
    field(
      'Step label (optional)',
      `<input type="text" class="form-control" data-step-key="Label" value="${Safe(
        Step.Label || ''
      )}" placeholder="Label" />`
    )
  );

  if (Step.Kind === 'action') {
    const Kinds = [
      { Value: 'method', Label: 'Device command' },
      { Value: 'alert', Label: 'Notification / alert action' },
    ];
    Html.push(
      field(
        'What kind of action',
        `<select class="form-select" data-step-key="ActionKind">${Kinds.map(
          (K) =>
            `<option value="${K.Value}"${Step.ActionKind === K.Value ? ' selected' : ''}>${Safe(
              K.Label
            )}</option>`
        ).join('')}</select>`
      )
    );

    if (Step.ActionKind === 'alert') {
      Html.push(
        field(
          'Action',
          `<select class="form-select" data-step-key="ActionID">${(AlertActionTypesCache || [])
            .map(
              (A: AlertActionType) =>
                `<option value="${Safe(A.ID)}"${Step.ActionID === A.ID ? ' selected' : ''}>${Safe(
                  A.Name
                )}</option>`
            )
            .join('')}</select>`
        )
      );
    } else {
      const Actions = collectMethodActions();
      Html.push(
        field(
          'Command',
          `<select class="form-select" data-step-key="ActionID">
            <option value="">Choose a command…</option>
            ${Actions.map(
              (A) =>
                `<option value="${Safe(A.Value)}"${
                  Step.ActionID === A.Value ? ' selected' : ''
                }>${Safe(A.Label)}</option>`
            ).join('')}
          </select>`
        )
      );

      const Action = findMethodAction(Step.ActionID || '');
      if (Action) {
        if (Action.FireAndForget) {
          // Say so plainly: the run log will report "sent", not "done".
          Html.push(
            '<div class="text-muted small"><i class="bi bi-info-circle me-1"></i>This device cannot confirm it acted, so the run will record the command as sent rather than confirmed.</div>'
          );
        }
        for (const Param of Action.Params || []) {
          const Value = (Step.Params || {})[Param.Key];
          const Current = Value === undefined ? (Param.Default ?? '') : Value;
          if (Param.Type === 'boolean') {
            Html.push(
              `<div class="form-check form-switch"><input class="form-check-input" type="checkbox" data-param-key="${Safe(
                Param.Key
              )}" data-param-type="boolean" ${Current ? 'checked' : ''} /><label class="form-check-label">${Safe(
                Param.Label
              )}</label></div>`
            );
          } else if (Param.Type === 'number') {
            Html.push(
              field(
                Param.Label + (Param.Required ? ' *' : ''),
                `<input type="number" class="form-control" data-param-key="${Safe(
                  Param.Key
                )}" data-param-type="number" value="${Safe(String(Current))}" />`
              )
            );
          } else {
            Html.push(
              field(
                Param.Label + (Param.Required ? ' *' : ''),
                `<input type="text" class="form-control" data-param-key="${Safe(
                  Param.Key
                )}" data-param-type="string" value="${Safe(String(Current))}" />`
              )
            );
          }
          if (Param.Note) {
            Html.push(`<div class="text-muted small">${Safe(String(Param.Note))}</div>`);
          }
        }
      }
    }

    Html.push(
      field(
        'Store the result as (optional)',
        `<input type="text" class="form-control" data-step-key="StoreAs" value="${Safe(
          Step.StoreAs || ''
        )}" placeholder="ok" />`
      )
    );
  }

  if (Step.Kind === 'if') {
    const C = Step.Condition || { Left: '', Operator: 'is', Right: '' };
    const Operators = [
      ['is', 'is'],
      ['isNot', 'is not'],
      ['above', 'is above'],
      ['below', 'is below'],
      ['inside', 'is between'],
      ['outside', 'is outside'],
      ['contains', 'contains'],
      ['notContains', 'does not contain'],
    ];
    Html.push(
      field(
        'Value to test',
        `<input type="text" class="form-control" data-cond-key="Left" value="${Safe(
          C.Left
        )}" placeholder="check.Online" />`
      )
    );
    Html.push(
      '<div class="text-muted small">Examples: <code>check.Online</code>, <code>check.LastLatencyMs</code>, <code>vars.answer</code>. A value with no reading never matches.</div>'
    );
    Html.push(
      field(
        'Test',
        `<select class="form-select" data-cond-key="Operator">${Operators.map(
          ([V, L]) =>
            `<option value="${V}"${C.Operator === V ? ' selected' : ''}>${Safe(L!)}</option>`
        ).join('')}</select>`
      )
    );
    Html.push(
      field(
        'Compared with',
        `<input type="text" class="form-control" data-cond-key="Right" value="${Safe(
          String(C.Right ?? '')
        )}" />`
      )
    );
    if (C.Operator === 'inside' || C.Operator === 'outside') {
      Html.push(
        field(
          'and',
          `<input type="text" class="form-control" data-cond-key="Right2" value="${Safe(
            String(C.Right2 ?? '')
          )}" />`
        )
      );
    }
  }

  if (Step.Kind === 'delay') {
    Html.push(
      field(
        'Wait for (seconds)',
        `<input type="number" min="0" class="form-control" data-step-key="Seconds" value="${
          Number(Step.Ms || 0) / 1000
        }" />`
      )
    );
  }

  if (Step.Kind === 'prompt') {
    Html.push(
      field(
        'Question',
        `<input type="text" class="form-control" data-step-key="Message" value="${Safe(
          Step.Message || ''
        )}" />`
      )
    );
    Html.push(
      field(
        'Store the answer as',
        `<input type="text" class="form-control" data-step-key="StoreAs" value="${Safe(
          Step.StoreAs || 'answer'
        )}" />`
      )
    );
    Html.push(
      field(
        'Give up after (seconds)',
        `<input type="number" min="1" class="form-control" data-step-key="TimeoutSeconds" value="${
          Number(Step.TimeoutMs || 60000) / 1000
        }" />`
      )
    );
    Html.push(
      field(
        'Answer to assume on timeout',
        `<select class="form-select" data-step-key="DefaultValue">${(Step.Buttons || [])
          .map(
            (B) =>
              `<option value="${Safe(B.Value)}"${
                Step.DefaultValue === B.Value ? ' selected' : ''
              }>${Safe(B.Label)}</option>`
          )
          .join('')}</select>`
      )
    );
    Html.push(
      '<div class="text-muted small">Prompts only appear on the desktop app. Nobody may be watching, so the timeout decides for you rather than leaving the run stuck.</div>'
    );
  }

  if (Step.Kind === 'call') {
    Html.push(
      field(
        'Workflow to run',
        `<select class="form-select" data-step-key="WorkflowID">
          <option value="0">Choose a workflow…</option>
          ${WorkflowsCache.filter(
            (W) => W.WorkflowID !== (WorkflowEditorID || 0) && W.Triggers.Callable
          )
            .map(
              (W) =>
                `<option value="${W.WorkflowID}"${
                  Step.WorkflowID === W.WorkflowID ? ' selected' : ''
                }>${Safe(W.Name)}</option>`
            )
            .join('')}
        </select>`
      )
    );
    Html.push(
      field(
        'Store its Return as (optional)',
        `<input type="text" class="form-control" data-step-key="StoreAs" value="${Safe(
          Step.StoreAs || ''
        )}" />`
      )
    );
  }

  if (Step.Kind === 'stop') {
    Html.push(
      field(
        'Reason (optional)',
        `<input type="text" class="form-control" data-step-key="Reason" value="${Safe(
          Step.Reason || ''
        )}" />`
      )
    );
  }

  $Host.html(Html.join(''));

  // Re-render on any change that alters which fields apply.
  $Host
    .find('[data-step-key="ActionKind"], [data-step-key="ActionID"], [data-cond-key="Operator"]')
    .off('change.workflow')
    .on('change.workflow', () => {
      CommitStepEditor();
      const ID = WorkflowEditingStepID;
      if (ID) OpenStepEditor(ID);
    });
}

/** Read the step editor's inputs back into the draft. */
export function CommitStepEditor(): void {
  if (!WorkflowDraft || !WorkflowEditingStepID) return;
  const Flat = findFlatStep(WorkflowDraft.Steps, WorkflowEditingStepID);
  if (!Flat) return;
  const Step = Flat.Step;

  const NewKind = String($('#WORKFLOW_STEP_KIND').val() || Step.Kind);
  if (NewKind !== Step.Kind) {
    // Changing kind replaces the step in place, keeping its ID so the debugger
    // and any conditions referencing it stay pointed at the same row.
    const Replacement = makeStep(NewKind as WorkflowStepView['Kind']);
    Replacement.StepID = Step.StepID;
    Replacement.Label = Step.Label;
    Flat.Parent[Flat.Index] = Replacement;
    return;
  }

  Step.ContinueOnError = $('#WORKFLOW_STEP_CONTINUE_ON_ERROR').is(':checked');

  $('#WORKFLOW_STEP_EDITOR_FIELDS')
    .find('[data-step-key]')
    .each(function () {
      const Key = String($(this).data('step-key'));
      const Value = $(this).val();
      const Target = Step as unknown as Record<string, unknown>;
      if (Key === 'Seconds') Target.Ms = Math.max(0, Number(Value) || 0) * 1000;
      else if (Key === 'TimeoutSeconds') Target.TimeoutMs = Math.max(1, Number(Value) || 60) * 1000;
      else if (Key === 'WorkflowID') Target.WorkflowID = Number(Value) || 0;
      else Target[Key] = String(Value ?? '');
    });

  if (Step.Kind === 'if') {
    const Condition = Step.Condition || { Left: '', Operator: 'is' };
    $('#WORKFLOW_STEP_EDITOR_FIELDS')
      .find('[data-cond-key]')
      .each(function () {
        const Key = String($(this).data('cond-key'));
        (Condition as unknown as Record<string, unknown>)[Key] = String($(this).val() ?? '');
      });
    Step.Condition = Condition;
  }

  if (Step.Kind === 'action') {
    const Params: Record<string, unknown> = {};
    $('#WORKFLOW_STEP_EDITOR_FIELDS')
      .find('[data-param-key]')
      .each(function () {
        const Key = String($(this).data('param-key'));
        const Type = String($(this).data('param-type'));
        if (Type === 'boolean') Params[Key] = $(this).is(':checked');
        else if (Type === 'number') {
          const N = Number($(this).val());
          Params[Key] = Number.isFinite(N) ? N : 0;
        } else Params[Key] = String($(this).val() ?? '');
      });
    Step.Params = Params;
  }
}

// --- Saving ------------------------------------------------------------------

function ReadEditorFields(): void {
  if (!WorkflowDraft) return;
  WorkflowDraft.Name = String($('#WORKFLOW_NAME').val() || '').trim();
  WorkflowDraft.Description = String($('#WORKFLOW_DESCRIPTION').val() || '');
  WorkflowDraft.Triggers.Manual = $('#WORKFLOW_TRIGGER_MANUAL').is(':checked');
  WorkflowDraft.Triggers.Callable = $('#WORKFLOW_TRIGGER_CALLABLE').is(':checked');
  WorkflowDraft.Triggers.Scope = scopeFromSelection(WorkflowScopeSelected);
  WorkflowDraft.Return.Name = String($('#WORKFLOW_RETURN_NAME').val() || 'Result');
  WorkflowDraft.Return.Type = String(
    $('#WORKFLOW_RETURN_TYPE').val() || 'boolean'
  ) as WorkflowView['Return']['Type'];
  WorkflowDraft.Return.From = String($('#WORKFLOW_RETURN_FROM').val() || '');
  WorkflowDraft.Return.Fallback = String($('#WORKFLOW_RETURN_FALLBACK').val() || '');
}

export async function SaveWorkflowFromEditor(): Promise<boolean> {
  if (!WorkflowDraft) return true;
  ReadEditorFields();

  // A brand-new workflow with nothing in it is a cancelled create, not an error.
  if (!WorkflowEditorID && !WorkflowDraft.Name && !WorkflowDraft.Steps.length) return true;

  if (!WorkflowDraft.Name) {
    void Notify('Give the workflow a name before leaving', 'error', 3000);
    return false;
  }

  const Payload = buildWorkflowPayload(WorkflowDraft);
  if (WorkflowEditorID) {
    const [Err] = await window.API.UpdateWorkflow(WorkflowEditorID, Payload);
    if (Err) {
      void Notify(String(Err), 'error', 4000);
      return false;
    }
  } else {
    const [Err] = await window.API.CreateWorkflow(Payload);
    if (Err) {
      void Notify(String(Err), 'error', 4000);
      return false;
    }
  }
  return true;
}

async function SaveAndReturnToList(): Promise<void> {
  if (!(await SaveWorkflowFromEditor())) return;
  setWorkflowDraft(null);
  setWorkflowEditorID(null);
  RenderWorkflowList();
  ShowListPanel();
}

async function SaveAndClose(): Promise<void> {
  if (!(await SaveWorkflowFromEditor())) return;
  setWorkflowDraft(null);
  setWorkflowEditorID(null);
  closeAllModals();
}

// --- Run / debug panel -------------------------------------------------------

export function RenderRunPanel(): void {
  const Run = ActiveWorkflowRun;
  const $Steps = $('#WORKFLOW_RUN_STEPS');
  if (!$Steps.length || !Run) return;

  const StatusClass =
    Run.Status === 'failed'
      ? 'text-danger'
      : Run.Status === 'completed'
        ? 'text-success'
        : Run.Status === 'aborted'
          ? 'text-warning'
          : '';

  $('#WORKFLOW_RUN_STATUS').html(
    `<div class="d-flex justify-content-between align-items-center">
       <strong>${Safe(Run.WorkflowName)}</strong>
       <span class="${StatusClass}">${Safe(Run.Status.toUpperCase())}</span>
     </div>
     ${Run.Error ? `<div class="text-danger small mt-1">${Safe(Run.Error)}</div>` : ''}
     ${
       Run.FinishedAt
         ? `<div class="text-muted small mt-1">Returned <code>${Safe(
             JSON.stringify(Run.ReturnValue)
           )}</code></div>`
         : ''
     }`
  );

  $Steps.html(
    Run.Steps.map((S: WorkflowRunStepView) => {
      const Icon =
        S.Status === 'ok'
          ? '<i class="bi bi-check-circle-fill text-success"></i>'
          : S.Status === 'failed'
            ? '<i class="bi bi-x-circle-fill text-danger"></i>'
            : S.Status === 'running'
              ? '<i class="bi bi-arrow-repeat text-primary"></i>'
              : S.Status === 'skipped'
                ? '<i class="bi bi-dash-circle text-muted"></i>'
                : '<i class="bi bi-circle text-muted"></i>';
      // The live position indicator: the row the run is sitting on.
      const Current = Run.CurrentStepID === S.StepID ? ' border border-primary' : '';
      const Detail = S.Error
        ? `<div class="small text-danger">${Safe(S.Error)}</div>`
        : S.Detail
          ? `<div class="small text-muted">${Safe(S.Detail)}</div>`
          : '';
      const Took =
        S.DurationMs != null
          ? `<small class="text-muted ms-2">${Math.round(S.DurationMs)}ms</small>`
          : '';
      return `
        <div class="d-flex align-items-start gap-2 bg-ghost rounded p-2${Current}"
             style="margin-left:${S.Depth * 1.5}rem">
          ${Icon}
          <div class="flex-grow-1">
            <div>${Safe(S.Label)}${Took}</div>
            ${Detail}
          </div>
        </div>`;
    }).join('')
  );

  // A pending question takes over the controls — it is the only thing the
  // operator can usefully do, and the run is blocked until it is answered or
  // times out.
  if (Run.Prompt) {
    const P = Run.Prompt;
    $('#WORKFLOW_RUN_CONTROLS').html(
      `<div class="w-100 bg-ghost rounded p-2">
         <div class="mb-2"><strong>${Safe(P.Message)}</strong></div>
         <div class="d-flex gap-2 justify-content-end">
           ${P.Buttons.map(
             (B) =>
               `<button type="button" class="btn btn-sm btn-${Safe(
                 B.Style || 'secondary'
               )} workflow-prompt-answer" data-value="${Safe(B.Value)}">${Safe(B.Label)}</button>`
           ).join('')}
         </div>
       </div>`
    );
    $('#WORKFLOW_RUN_CONTROLS')
      .find('.workflow-prompt-answer')
      .off('click.workflow')
      .on('click.workflow', function () {
        void window.API.AnswerWorkflowPrompt({
          RunKey: P.RunKey,
          StepID: P.StepID,
          Value: String($(this).data('value')),
        });
      });
    return;
  }

  const Live = !Run.FinishedAt;
  $('#WORKFLOW_RUN_CONTROLS').html(
    Live
      ? `<button type="button" class="btn btn-sm btn-light" id="WORKFLOW_RUN_STEP">Step</button>
         <button type="button" class="btn btn-sm btn-primary" id="WORKFLOW_RUN_CONTINUE">Continue</button>
         <button type="button" class="btn btn-sm btn-danger" id="WORKFLOW_RUN_ABORT">Abort</button>`
      : '<button type="button" class="btn btn-sm btn-light" id="WORKFLOW_RUN_BACK">Back</button>'
  );

  $('#WORKFLOW_RUN_STEP')
    .off('click.workflow')
    .on('click.workflow', () => void window.API.StepWorkflowRun(Run.RunKey));
  $('#WORKFLOW_RUN_CONTINUE')
    .off('click.workflow')
    .on('click.workflow', () => void window.API.ContinueWorkflowRun(Run.RunKey));
  $('#WORKFLOW_RUN_ABORT')
    .off('click.workflow')
    .on('click.workflow', () => void window.API.AbortWorkflowRun(Run.RunKey));
  $('#WORKFLOW_RUN_BACK')
    .off('click.workflow')
    .on('click.workflow', () => {
      setActiveWorkflowRun(null);
      ShowEditorPanel();
    });
}

export async function RunWorkflowFromEditor(Mode: 'normal' | 'step'): Promise<void> {
  if (!WorkflowEditorID) return;
  if (!(await SaveWorkflowFromEditor())) return;

  const $Host = $('#WORKFLOW_RUN_HEADER');
  if ($Host.length) {
    $Host.empty().append(
      buildModalHeader({
        title: 'Test Run',
        backLabel: 'Back',
        onBack: () => {
          setActiveWorkflowRun(null);
          ShowEditorPanel();
        },
        onClose: () => closeAllModals(),
      }).$el
    );
  }
  ShowRunPanel();

  // Scope is left null here: a test run from the editor has no entity context
  // unless the workflow's steps name their own targets. Running it against a
  // specific check is what the check's workflows row is for.
  const [Err] = await window.API.RunWorkflow(WorkflowEditorID, null, Mode);
  if (Err) void Notify(String(Err), 'error', 4000);
}

// --- Entry points ------------------------------------------------------------

async function EnsureCatalogsLoaded(): Promise<void> {
  if (!WorkflowStepKindsCache.length) {
    setWorkflowStepKindsCache(await window.API.GetWorkflowStepKinds());
  }
  if (!AlertTriggerTypesCache.length) {
    setAlertTriggerTypesCache(await window.API.GetWorkflowTriggerTypes());
  }
  if (!AlertActionTypesCache.length) {
    setAlertActionTypesCache(await window.API.GetAlertActionTypes());
  }
}

export async function OpenWorkflowManager(): Promise<void> {
  closeAllModals();
  await EnsureCatalogsLoaded();
  setWorkflowsCache(await window.API.GetAllWorkflows());

  const $Host = $('#WORKFLOW_MANAGER_LIST_HEADER');
  if ($Host.length) {
    $Host.empty().append(
      buildModalHeader({
        title: 'Workflows',
        closeLabel: 'Close',
        onClose: () => closeAllModals(),
      }).$el
    );
  }

  RenderWorkflowList();
  ShowListPanel();
  bindScopeButton(WorkflowScopeConfig);

  $('#WORKFLOW_CREATE_BUTTON')
    .off('click.workflow')
    .on('click.workflow', () => OpenWorkflowEditor(null));

  $('#WORKFLOW_ADD_STEP')
    .off('click.workflow')
    .on('click.workflow', () => {
      if (!WorkflowDraft) return;
      const Step = makeStep('action');
      WorkflowDraft.Steps.push(Step);
      RenderStepTree();
      OpenStepEditor(Step.StepID);
    });

  $('#WORKFLOW_STEP_DELETE')
    .off('click.workflow')
    .on('click.workflow', () => {
      if (!WorkflowDraft || !WorkflowEditingStepID) return;
      const Flat = findFlatStep(WorkflowDraft.Steps, WorkflowEditingStepID);
      if (!Flat) return;
      Flat.Parent.splice(Flat.Index, 1);
      setWorkflowEditingStepID(null);
      RenderStepTree();
      ShowEditorPanel();
    });

  $('#WORKFLOW_DELETE_BUTTON')
    .off('click.workflow')
    .on('click.workflow', async () => {
      if (!WorkflowEditorID) return;
      const Confirmed = await ConfirmationDialog('Delete this workflow? This cannot be undone.');
      if (!Confirmed) return;
      const [Err] = await window.API.DeleteWorkflow(WorkflowEditorID);
      // The server refuses when another workflow calls this one, and says which.
      if (Err) return void Notify(String(Err), 'error', 5000);
      setWorkflowDraft(null);
      setWorkflowEditorID(null);
      void Notify('Workflow deleted', 'success', 1500);
      RenderWorkflowList();
      ShowListPanel();
    });

  $('#WORKFLOW_TEST_BUTTON')
    .off('click.workflow')
    .on('click.workflow', () => void RunWorkflowFromEditor('step'));

  openModal('SHOWTRAK_MODAL_WORKFLOW_MANAGER');
}

/** Run a workflow against one entity, from a context menu or a check row. */
export async function RunWorkflowForEntity(WorkflowID: number, ScopedID: string): Promise<void> {
  const [Err] = await window.API.RunWorkflow(WorkflowID, ScopedID, 'normal');
  if (Err) return void Notify(String(Err), 'error', 4000);
  void Notify('Workflow started', 'success', 1500);
}

// --- Push subscriptions ------------------------------------------------------

export function InitWorkflows(): void {
  window.API.SetFullWorkflowList((List: WorkflowView[]) => {
    setWorkflowsCache(Array.isArray(List) ? List : []);
    RenderWorkflowList();
  });

  window.API.OnWorkflowRunUpdated((Run: WorkflowRunView) => {
    // Only follow the run the debugger is already watching, or adopt one if it
    // is not watching anything — a second concurrent run has nowhere to draw.
    const Current = ActiveWorkflowRun;
    if (Current && Current.RunKey !== Run.RunKey) return;
    setActiveWorkflowRun(Run);
    RenderRunPanel();
  });

  // A workflow started by an alert or over OSC can stop and ask a question with
  // nobody watching. Surface it by opening the run panel on that run, rather
  // than letting it sit invisible until it times out.
  window.API.OnWorkflowPromptRequested((Prompt) => {
    if (!Prompt) return;
    if (ActiveWorkflowRun && ActiveWorkflowRun.RunKey === Prompt.RunKey) {
      RenderRunPanel();
      return;
    }
    void Notify(Prompt.Message, 'info', 6000);
  });
}
