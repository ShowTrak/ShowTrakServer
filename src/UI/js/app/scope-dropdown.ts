// Reusable client/group multiselect ("scope") dropdown.
//
// This is the generic engine extracted from the Alert Rules scope picker so the
// same tree UI can be reused elsewhere (e.g. the per-script whitelist editor).
// Callers drive it entirely through an options object describing WHICH entities
// may be displayed — so a consumer can show only real clients, hide
// dummy/integrated/monitoring targets, restrict to a specific group, filter by
// client type, etc. The UI therefore only ever offers valid choices.
//
// The persisted/selection value formats are stable and shared with alerts:
//   workspace:*            → all clients
//   group:<GroupID>        → a whole group
//   client:<ScopedID>      → a single entity (plain UUID, or monitor:/check:…)
// and the resolved scope object is { Workspace, Groups:number[], Clients:string[] }.
import { AllClients, DummyClients, MonitoringTargets, IsIntegratedClientEntity } from './01-state';
import type { AlertScopeEntity, AlertScopeGroupNode, AlertScopeModel } from './01-state';
import { Safe } from './04-utils';
import type { GroupView } from '@showtrak/protocol';

export type ScopeEntityKind = 'showtrak' | 'monitor' | 'monitor-check' | 'dummy';

// Which entities the dropdown may display. Every field is optional; the
// defaults reproduce the original alert behaviour (all kinds, grouped).
export interface ScopeSourceOptions {
  /** Groups to nest entities under (usually from window.API.GetAllGroups()). */
  Groups: GroupView[];
  /** Entity kinds to include. Defaults to all four. */
  IncludeKinds?: ScopeEntityKind[];
  /** Drop integrated (SDK) clients from the 'showtrak' set. */
  ExcludeIntegrated?: boolean;
  /** Render group headers (true) or a single flat list (false). Default true. */
  ShowGroups?: boolean;
  /** Extra predicate applied to real (showtrak) clients. */
  ClientFilter?: (Client: (typeof AllClients)[number]) => boolean;
  /** Restrict which groups appear as nodes; excluded groups' members fall to the flat list. */
  GroupFilter?: (Group: GroupView) => boolean;
}

// Concrete scope shape produced by the editor.
export interface ParsedScope {
  Workspace: boolean;
  Groups: number[];
  Clients: string[];
}

// Permissive scope shape accepted by read-only helpers.
export type ScopeInput = {
  Workspace?: boolean;
  Groups?: unknown[];
  Clients?: unknown[];
};

export function scopeIconClass(Kind: string): string {
  if (Kind === 'showtrak') return 'bi-display';
  if (Kind === 'monitor' || Kind === 'monitor-check') return 'bi-diagram-3';
  if (Kind === 'dummy') return 'bi-cpu';
  return '';
}

export function buildScopeEntityLabel(
  Primary: string | null | undefined,
  Secondary: string | null | undefined,
  Fallback: string | null | undefined
): string {
  const Base = `${Primary || Secondary || Fallback || 'Unknown Target'}`.trim();
  const Detail =
    Secondary && Primary && String(Secondary).trim() && String(Secondary).trim() !== Base
      ? ` (${String(Secondary).trim()})`
      : '';
  return `${Base}${Detail}`;
}

function compareScopeEntities(A: AlertScopeEntity, B: AlertScopeEntity): number {
  const WeightDelta = (A && A.Weight ? A.Weight : 0) - (B && B.Weight ? B.Weight : 0);
  if (WeightDelta !== 0) return WeightDelta;
  return String((A && A.Label) || '').localeCompare(String((B && B.Label) || ''));
}

export function scopeClientValueToScopedID(Value: string): string {
  const Text = String(Value || '');
  if (!Text.startsWith('client:')) return '';
  return Text.slice(7);
}

function sortedGroups(Groups: GroupView[]): GroupView[] {
  return (Array.isArray(Groups) ? Groups.slice() : []).sort((A, B) => {
    const WeightDelta = (A && A.Weight ? A.Weight : 0) - (B && B.Weight ? B.Weight : 0);
    if (WeightDelta !== 0) return WeightDelta;
    return String((A && A.Title) || '').localeCompare(String((B && B.Title) || ''));
  });
}

// Build the full tree model from the shared entity caches, filtered by options.
export function buildScopeModel(Options: ScopeSourceOptions): AlertScopeModel {
  const IncludeKinds = new Set<ScopeEntityKind>(
    Options.IncludeKinds && Options.IncludeKinds.length
      ? Options.IncludeKinds
      : ['showtrak', 'monitor', 'monitor-check', 'dummy']
  );
  const ShowGroups = Options.ShowGroups !== false;

  const VisibleGroups = sortedGroups(Options.Groups).filter((Group) =>
    Options.GroupFilter ? Options.GroupFilter(Group) : true
  );
  const LabelByValue = new Map<string, string>();
  const GroupNodes: AlertScopeGroupNode[] = ShowGroups
    ? VisibleGroups.map((Group) => ({
        Kind: 'group' as const,
        Value: `group:${Group.GroupID}`,
        GroupID: Group.GroupID,
        Label: Group.Title || `Group ${Group.GroupID}`,
        Children: [] as AlertScopeEntity[],
        ChildValues: [] as string[],
      }))
    : [];
  const GroupByID = new Map<string, AlertScopeGroupNode>(
    GroupNodes.map((Group) => [String(Group.GroupID), Group] as [string, AlertScopeGroupNode])
  );
  const Ungrouped: AlertScopeEntity[] = [];
  const Entities: AlertScopeEntity[] = [];

  if (IncludeKinds.has('showtrak')) {
    for (const Client of AllClients || []) {
      if (!Client || !Client.UUID) continue;
      if (Options.ExcludeIntegrated && IsIntegratedClientEntity(Client)) continue;
      if (Options.ClientFilter && !Options.ClientFilter(Client)) continue;
      Entities.push({
        Kind: 'showtrak',
        Value: `client:${Client.UUID}`,
        ScopedID: String(Client.UUID),
        GroupID: Client.GroupID == null ? null : Client.GroupID,
        Label: buildScopeEntityLabel(
          Client.Nickname || Client.Hostname || Client.UUID,
          Client.Nickname ? Client.Hostname || '' : '',
          Client.UUID
        ),
        IconClass: scopeIconClass('showtrak'),
        Weight: Client.Weight || 0,
      });
    }
  }

  if (IncludeKinds.has('monitor') || IncludeKinds.has('monitor-check')) {
    for (const Target of MonitoringTargets || []) {
      if (!Target || Target.TargetID == null) continue;
      const ScopedID = `monitor:${Target.TargetID}`;
      if (IncludeKinds.has('monitor')) {
        Entities.push({
          Kind: 'monitor',
          Value: `client:${ScopedID}`,
          ScopedID,
          GroupID: Target.GroupID == null ? null : Target.GroupID,
          Label: buildScopeEntityLabel(
            Target.Nickname || Target.Address || `Target ${Target.TargetID}`,
            Target.Nickname ? Target.Address || '' : '',
            `Target ${Target.TargetID}`
          ),
          IconClass: scopeIconClass('monitor'),
          Weight: Target.Weight || 0,
        });
      }
      if (IncludeKinds.has('monitor-check')) {
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
            Label: buildScopeEntityLabel(
              `${TargetTitle} · ${CheckLabel}`,
              Check.Name ? Check.Address || '' : '',
              `Check ${Check.CheckID}`
            ),
            IconClass: scopeIconClass('monitor'),
            Weight: Target.Weight || 0,
          });
        }
      }
    }
  }

  if (IncludeKinds.has('dummy')) {
    for (const Dummy of DummyClients || []) {
      if (!Dummy || !Dummy.UUID) continue;
      Entities.push({
        Kind: 'dummy',
        Value: `client:${Dummy.UUID}`,
        ScopedID: String(Dummy.UUID),
        GroupID: Dummy.GroupID == null ? null : Dummy.GroupID,
        Label: buildScopeEntityLabel(
          Dummy.Nickname || Dummy.DummyID || Dummy.UUID,
          Dummy.Nickname ? Dummy.DummyID || '' : '',
          Dummy.UUID
        ),
        IconClass: scopeIconClass('dummy'),
        Weight: Dummy.Weight || 0,
      });
    }
  }

  Entities.sort(compareScopeEntities);

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
  for (const Group of GroupNodes) AllClientValues.push(...Group.ChildValues);
  for (const Entity of Ungrouped) AllClientValues.push(Entity.Value);

  return {
    Workspace: { Kind: 'workspace', Value: 'workspace:*', Label: 'All Clients' },
    Groups: GroupNodes,
    Ungrouped,
    AllClientValues,
    AllClientValueSet: new Set(AllClientValues),
    LabelByValue,
  };
}

export function parseScopeSelection(Selected: string[]): ParsedScope {
  const Scope: ParsedScope = { Workspace: false, Groups: [], Clients: [] };
  for (const RawValue of Selected || []) {
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

export function resolveScopeTargetValues(Scope: ScopeInput, Model: AlertScopeModel): Set<string> {
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

export function buildScopeFromTargetValues(
  TargetValues: string[],
  Model: AlertScopeModel
): ParsedScope {
  const Selected = new Set((TargetValues || []).map((Value) => String(Value)));
  if (Model.AllClientValues.length && Model.AllClientValues.every((Value) => Selected.has(Value))) {
    return { Workspace: true, Groups: [], Clients: [] };
  }
  const Scope: ParsedScope = { Workspace: false, Groups: [], Clients: [] };
  const Covered = new Set<string>();
  for (const Group of Model.Groups || []) {
    if (!Group.ChildValues.length) continue;
    if (!Group.ChildValues.every((Value) => Selected.has(Value))) continue;
    Scope.Groups.push(Group.GroupID);
    for (const Value of Group.ChildValues) Covered.add(Value);
  }
  for (const Value of Model.AllClientValues) {
    if (!Selected.has(Value) || Covered.has(Value)) continue;
    const ScopedID = scopeClientValueToScopedID(Value);
    if (ScopedID) Scope.Clients.push(ScopedID);
  }
  return Scope;
}

export function scopeToSelectedValues(Scope: ScopeInput): string[] {
  const Selected: string[] = [];
  if (Scope && Scope.Workspace) Selected.push('workspace:*');
  for (const GroupID of (Scope && Scope.Groups) || []) Selected.push(`group:${GroupID}`);
  for (const ClientID of (Scope && Scope.Clients) || []) Selected.push(`client:${ClientID}`);
  return Selected;
}

function scopeSummaryText(Selected: Array<{ Label: string }>, Placeholder: string): string {
  if (!Array.isArray(Selected) || !Selected.length) return Placeholder;
  // Selected is non-empty here (guarded above), so Selected[0] is present
  if (Selected.length === 1) return Selected[0]!.Label;
  return `${Selected[0]!.Label} +${Selected.length - 1}`;
}

export function summarizeScopeSelection(
  Model: AlertScopeModel,
  Scope: ScopeInput,
  Placeholder: string
): string {
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
  return scopeSummaryText(Selected, Placeholder);
}

function renderScopeClientNode(Entity: AlertScopeEntity, SelectedValues: Set<string>): string {
  const Checked = SelectedValues.has(Entity.Value);
  return `
    <label class="alert-multiselect-option alert-scope-node alert-scope-node-client">
      <input type="checkbox" data-kind="client" value="${Safe(Entity.Value)}" ${Checked ? 'checked' : ''} />
      <span class="alert-scope-prefix" aria-hidden="true"></span>
      <span class="alert-scope-label-wrap"><i class="bi ${Safe(Entity.IconClass || '')} alert-scope-entity-icon" aria-hidden="true"></i><span>${Safe(Entity.Label)}</span></span>
    </label>
  `;
}

function renderScopeGroupNode(
  Group: AlertScopeGroupNode,
  SelectedValues: Set<string>,
  Scope: ScopeInput
): string {
  const ExplicitlySelected = (Scope.Groups || []).some(
    (GroupID) => Number(GroupID) === Number(Group.GroupID)
  );
  const SelectedCount = Group.ChildValues.filter((Value) => SelectedValues.has(Value)).length;
  const FullySelected =
    ExplicitlySelected || (Group.ChildValues.length > 0 && SelectedCount === Group.ChildValues.length);
  const Indeterminate = !FullySelected && SelectedCount > 0;
  const ChildrenHtml = Group.Children.map((Entity) =>
    renderScopeClientNode(Entity, SelectedValues)
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

// Per-instance wiring. GetSelected/SetSelected own the flat selection-value
// array; BuildModel rebuilds the (option-filtered) tree; the selectors point at
// this instance's DOM. Namespace keeps jQuery event bindings isolated between
// instances (alerts vs. the script whitelist).
export interface ScopeDropdownConfig {
  DropdownSelector: string;
  MenuSelector: string;
  ToggleSelector: string;
  Namespace: string;
  Placeholder: string;
  GetSelected: () => string[];
  SetSelected: (values: string[]) => void;
  BuildModel: () => AlertScopeModel;
  /** Alert toggle renders a chevron via HTML; others just get text. Default 'text'. */
  ToggleRender?: 'html' | 'text';
}

export function renderScopeDropdown(Config: ScopeDropdownConfig): void {
  const Model = Config.BuildModel();
  const Scope = parseScopeSelection(Config.GetSelected());
  const EffectiveSelectedValues = resolveScopeTargetValues(Scope, Model);
  const ToggleText = summarizeScopeSelection(Model, Scope, Config.Placeholder);

  if (Config.ToggleRender === 'html') {
    $(Config.ToggleSelector).html(
      `<span>${Safe(ToggleText)}</span><i class="bi bi-chevron-down ms-2" aria-hidden="true"></i>`
    );
  } else {
    $(Config.ToggleSelector).text(ToggleText);
  }

  const WorkspaceChecked =
    !!Scope.Workspace ||
    (Model.AllClientValues.length > 0 &&
      EffectiveSelectedValues.size === Model.AllClientValues.length);
  const WorkspaceIndeterminate = !WorkspaceChecked && EffectiveSelectedValues.size > 0;
  const GroupHtml = Model.Groups.map((Group) =>
    renderScopeGroupNode(Group, EffectiveSelectedValues, Scope)
  ).join('');
  const UngroupedHtml = Model.Ungrouped.map((Entity) =>
    renderScopeClientNode(Entity, EffectiveSelectedValues)
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

  $(Config.MenuSelector).html(
    Html || '<div class="text-muted text-sm p-2">No options available.</div>'
  );
  $(Config.MenuSelector)
    .find('input[data-indeterminate="true"]')
    .each(function () {
      (this as HTMLInputElement).indeterminate = true;
    });
}

export function closeScopeDropdown(Config: ScopeDropdownConfig): void {
  $(Config.MenuSelector).addClass('d-none');
}

export function bindScopeDropdown(Config: ScopeDropdownConfig): void {
  const NS = Config.Namespace;

  $(Config.ToggleSelector)
    .off(`click.${NS}`)
    .on(`click.${NS}`, function (Event) {
      Event.preventDefault();
      Event.stopPropagation();
      const $menu = $(Config.MenuSelector);
      const isOpen = !$menu.hasClass('d-none');
      $menu.addClass('d-none');
      if (!isOpen) $menu.removeClass('d-none');
    });

  $(Config.MenuSelector)
    .off(`change.${NS}`)
    .on(`change.${NS}`, 'input[type="checkbox"]', function () {
      const Kind = String($(this).attr('data-kind') || '');
      const Value = String($(this).val() || '');
      const Checked = $(this).is(':checked');
      const Model = Config.BuildModel();

      if (Kind === 'workspace') {
        Config.SetSelected(Checked ? ['workspace:*'] : []);
      } else {
        const Scope = parseScopeSelection(Config.GetSelected());
        const SelectedTargets = resolveScopeTargetValues(Scope, Model);
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
        Config.SetSelected(
          scopeToSelectedValues(buildScopeFromTargetValues(Array.from(SelectedTargets), Model))
        );
      }
      renderScopeDropdown(Config);
      $(Config.MenuSelector).removeClass('d-none');
    });

  $(document)
    .off(`mousedown.${NS} touchstart.${NS}`)
    .on(`mousedown.${NS} touchstart.${NS}`, function (Event) {
      const inside = $(Event.target).closest(Config.DropdownSelector).length > 0;
      if (!inside) $(Config.MenuSelector).addClass('d-none');
    });
}
