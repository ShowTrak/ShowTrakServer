// The scope picker: a full-screen modal for choosing WHICH machines something
// applies to (alert targets, a script's whitelist, a tag's membership).
//
// It replaced an inline dropdown that hung below its button. On a show with a
// hundred machines that dropdown became a tall scrolling panel that resized the
// modal underneath it and buried the rest of the form, and there was no way to
// find one machine by name. So the picker is now a screen of its own: the modal
// you came from is hidden, the picker takes the space, and a back button returns
// you exactly where you were — the same pattern the icon picker uses.
//
// Two behaviours are deliberate and load-bearing:
//
//   1. It ALWAYS saves. Every tick writes straight through to the caller's
//      selection state, so back, the close button, Escape and a backdrop click
//      all keep the selection. There is no cancel, because a picker that
//      silently discards a hundred ticks is the failure mode this replaced.
//
//   2. Tags are a first-class category alongside groups and individual
//      machines. Selecting a tag means "whatever carries this tag, now and
//      later", which is what makes a tag that is a superset of other tags, or
//      an alert rule that watches a tag, possible at all. Machines pulled in by
//      a selected tag are shown as covered but are NOT tickable: removing one
//      would mean rewriting the tag itself, changing every other scope that
//      uses it.
import type { TagView } from '@showtrak/protocol';
import type { AlertScopeEntity, AlertScopeGroupNode, AlertScopeModel } from './state';
import { closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { Safe } from './utils';
import { Wait } from './selection-init';
import {
  buildScopeFromTargetValues,
  parseScopeSelection,
  resolveScopeTargetValues,
  resolveTagCoverage,
  scopeToSelectedValues,
  summarizeScopeSelection,
} from './lib/scope-model';

const MODAL_ID = 'SHOWTRAK_MODAL_SCOPEPICKER';

/**
 * One picker instance: the button that opens it plus the selection it edits.
 *
 * `GetSelected`/`SetSelected` own the flat selection-value array (see
 * ./lib/scope-model for the value grammar); `BuildModel` rebuilds the
 * option-filtered tree so each editor only ever offers valid choices.
 */
export interface ScopePickerConfig {
  /** The button in the editor that opens the picker and shows the summary. */
  ButtonSelector: string;
  /** jQuery event namespace, keeping instances isolated from each other. */
  Namespace: string;
  /** Picker modal title, e.g. "Alert Targets". */
  Title: string;
  /** Button text when nothing is selected. */
  Placeholder: string;
  /** Optional one-line explanation shown above the search box. */
  Hint?: string;
  GetSelected: () => string[];
  SetSelected: (values: string[]) => void;
  BuildModel: () => AlertScopeModel;
  /** Full tag list, used to resolve which machines a selected tag covers. */
  GetTags?: () => TagView[];
  /** Buttons that render a chevron pass 'html'; plain ones 'text'. Default 'text'. */
  ToggleRender?: 'html' | 'text';
  /**
   * Run after the picker closes, with the selection already committed. Editors
   * use it to persist or re-render; it is called on every exit path.
   */
  OnCommit?: () => void;
}

// The single picker modal in the DOM is driven by whichever config opened it.
let ActiveConfig: ScopePickerConfig | null = null;
let RestoreModalId: string | null = null;
let SearchText = '';

/** Update an editor's button to summarize its current selection. */
export function renderScopeButton(Config: ScopePickerConfig): void {
  const Model = Config.BuildModel();
  const Scope = parseScopeSelection(Config.GetSelected());
  const Text = summarizeScopeSelection(Model, Scope, Config.Placeholder);
  if (Config.ToggleRender === 'html') {
    $(Config.ButtonSelector).html(
      `<span>${Safe(Text)}</span><i class="bi bi-chevron-right ms-2" aria-hidden="true"></i>`
    );
  } else {
    $(Config.ButtonSelector).text(Text);
  }
}

/** Wire an editor's button to open the picker. Safe to call repeatedly. */
export function bindScopeButton(Config: ScopePickerConfig): void {
  $(Config.ButtonSelector)
    .off(`click.${Config.Namespace}`)
    .on(`click.${Config.Namespace}`, function (Event) {
      Event.preventDefault();
      Event.stopPropagation();
      void OpenScopePicker(Config);
    });
}

function matchesSearch(Label: string, Needle: string): boolean {
  if (!Needle) return true;
  return String(Label || '')
    .toLowerCase()
    .includes(Needle);
}

function renderEntityRow(
  Entity: AlertScopeEntity,
  SelectedValues: Set<string>,
  TagCoverage: Map<string, string[]>
): string {
  const Checked = SelectedValues.has(Entity.Value);
  const ViaTags = TagCoverage.get(Entity.Value) || [];
  // Covered by a selected tag but not named directly: shown, and locked,
  // because the only way to drop it is to edit the tag.
  const Implied = !Checked && ViaTags.length > 0;
  const ViaChip = ViaTags.length
    ? `<span class="scope-picker-via" title="Included by tag ${Safe(ViaTags.join(', '))}">via ${Safe(ViaTags.join(', '))}</span>`
    : '';
  return `
    <label class="alert-multiselect-option alert-scope-node alert-scope-node-client${Implied ? ' scope-picker-implied' : ''}">
      <input type="checkbox" data-kind="client" value="${Safe(Entity.Value)}" ${Checked ? 'checked' : ''} ${Implied ? 'disabled' : ''} />
      <span class="alert-scope-prefix" aria-hidden="true"></span>
      <span class="alert-scope-label-wrap"><i class="bi ${Safe(Entity.IconClass || '')} alert-scope-entity-icon" aria-hidden="true"></i><span>${Safe(Entity.Label)}</span>${ViaChip}</span>
    </label>
  `;
}

function renderGroupBranch(
  Group: AlertScopeGroupNode,
  Children: AlertScopeEntity[],
  SelectedValues: Set<string>,
  TagCoverage: Map<string, string[]>,
  Scope: { Groups?: unknown[] }
): string {
  const ExplicitlySelected = (Scope.Groups || []).some(
    (GroupID) => Number(GroupID) === Number(Group.GroupID)
  );
  const SelectedCount = Group.ChildValues.filter((Value) => SelectedValues.has(Value)).length;
  const FullySelected =
    ExplicitlySelected ||
    (Group.ChildValues.length > 0 && SelectedCount === Group.ChildValues.length);
  const Indeterminate = !FullySelected && SelectedCount > 0;
  const ChildrenHtml = Children.map((Entity) =>
    renderEntityRow(Entity, SelectedValues, TagCoverage)
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

function renderSection(Title: string, Body: string): string {
  if (!Body) return '';
  return `
    <div class="scope-picker-section">
      <div class="scope-picker-section-title">${Safe(Title)}</div>
      ${Body}
    </div>
  `;
}

/** Rebuild the picker's list from the live selection and the search box. */
export function RenderScopePickerList(): void {
  const Config = ActiveConfig;
  const Host = document.getElementById('SCOPE_PICKER_LIST');
  if (!Config || !Host) return;

  const Model = Config.BuildModel();
  const Scope = parseScopeSelection(Config.GetSelected());
  const SelectedValues = resolveScopeTargetValues(Scope, Model);
  const TagCoverage = resolveTagCoverage(Scope, Model, Config.GetTags ? Config.GetTags() : []);
  const Needle = SearchText.trim().toLowerCase();

  // "All Clients" is a control, not a search result, so it stays put while
  // filtering — otherwise the one row that clears a bad selection disappears
  // exactly when the operator is hunting through a long list.
  const WorkspaceChecked =
    !!Scope.Workspace ||
    (Model.AllClientValues.length > 0 && SelectedValues.size === Model.AllClientValues.length);
  const WorkspaceIndeterminate = !WorkspaceChecked && SelectedValues.size > 0;
  const WorkspaceHtml = `
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
  `;

  const TagsHtml = (Model.Tags || [])
    .filter((Tag) => matchesSearch(Tag.Label, Needle))
    .map((Tag) => {
      const Checked = Scope.Tags.some((TagID) => Number(TagID) === Number(Tag.TagID));
      return `
        <label class="alert-multiselect-option alert-scope-node scope-picker-tag" style="--scope-tag-colour:${Safe(Tag.ColourHex)}">
          <input type="checkbox" data-kind="tag" value="${Safe(Tag.Value)}" ${Checked ? 'checked' : ''} />
          <span class="alert-scope-prefix" aria-hidden="true"></span>
          <span class="alert-scope-label-wrap"><i class="bi ${Safe(Tag.IconClass)} scope-picker-tag-icon" aria-hidden="true"></i><span>${Safe(Tag.Label)}</span></span>
        </label>
      `;
    })
    .join('');

  const GroupsHtml = (Model.Groups || [])
    .map((Group) => {
      // A group whose own name matches keeps all its members, so searching for
      // "FOH" offers the whole group rather than an empty header.
      const GroupMatches = matchesSearch(Group.Label, Needle);
      const Children = GroupMatches
        ? Group.Children
        : Group.Children.filter((Entity) => matchesSearch(Entity.Label, Needle));
      if (!GroupMatches && !Children.length) return '';
      return renderGroupBranch(Group, Children, SelectedValues, TagCoverage, Scope);
    })
    .join('');

  const UngroupedHtml = (Model.Ungrouped || [])
    .filter((Entity) => matchesSearch(Entity.Label, Needle))
    .map((Entity) => renderEntityRow(Entity, SelectedValues, TagCoverage))
    .join('');

  const ClientsBody =
    GroupsHtml || UngroupedHtml
      ? `<div class="alert-scope-tree">${GroupsHtml}${UngroupedHtml}</div>`
      : '';

  const Sections =
    renderSection('Everything', `<div class="alert-scope-tree">${WorkspaceHtml}</div>`) +
    renderSection('Tags', TagsHtml ? `<div class="alert-scope-tree">${TagsHtml}</div>` : '') +
    renderSection('Groups & Clients', ClientsBody);

  const NoMatches = !TagsHtml && !ClientsBody;
  Host.innerHTML =
    Sections +
    (NoMatches && Needle
      ? `<div class="text-muted text-sm p-2 text-center">Nothing matches “${Safe(SearchText.trim())}”.</div>`
      : '');

  $(Host)
    .find('input[data-indeterminate="true"]')
    .each(function () {
      (this as HTMLInputElement).indeterminate = true;
    });
}

// Apply one checkbox change to the caller's selection.
function applyChange(Kind: string, Value: string, Checked: boolean): void {
  const Config = ActiveConfig;
  if (!Config) return;
  const Model = Config.BuildModel();

  if (Kind === 'workspace') {
    // "All Clients" is absolute: it supersedes every other token, so ticking it
    // replaces the selection rather than adding to it.
    Config.SetSelected(Checked ? ['workspace:*'] : []);
    return;
  }

  const Scope = parseScopeSelection(Config.GetSelected());

  if (Kind === 'tag') {
    const TagID = parseInt(String(Value).slice(4), 10);
    if (!Number.isInteger(TagID)) return;
    const Tags = Scope.Tags.filter((Existing) => Number(Existing) !== TagID);
    if (Checked) Tags.push(TagID);
    Config.SetSelected(scopeToSelectedValues({ ...Scope, Tags }));
    return;
  }

  // Groups and individual entities share the leaf-set logic: resolve the
  // directly-named entities, edit that set, then re-collapse it (so selecting
  // every member of a group stores the group, and future members stay covered).
  // Tag tokens are carried through untouched — they are never re-derived.
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
    scopeToSelectedValues(
      buildScopeFromTargetValues(Array.from(SelectedTargets), Model, Scope.Tags)
    )
  );
}

// Commit and leave: the selection is already in the caller's state (every tick
// wrote through), so this only restores the screen behind the picker and lets
// the caller react.
async function CloseScopePicker(): Promise<void> {
  const Config = ActiveConfig;
  const Restore = RestoreModalId;
  ActiveConfig = null;
  RestoreModalId = null;
  SearchText = '';

  closeModal(MODAL_ID);
  await Wait(300);
  if (Restore) openModal(Restore);

  if (Config) {
    renderScopeButton(Config);
    if (Config.OnCommit) Config.OnCommit();
  }
}

// Record which modal is currently visible so it can be restored on close.
function captureCurrentModal(): string | null {
  const Open = document.querySelector('.modal.show');
  return Open && Open.id && Open.id !== MODAL_ID ? Open.id : null;
}

/** Open the picker for a given editor, hiding the modal it was opened from. */
export async function OpenScopePicker(Config: ScopePickerConfig): Promise<void> {
  ActiveConfig = Config;
  SearchText = '';

  RestoreModalId = captureCurrentModal();
  if (RestoreModalId) {
    closeModal(RestoreModalId);
    await Wait(300);
  }

  $('#SCOPE_PICKER_TITLE').text(Config.Title || 'Select Clients');
  const $hint = $('#SCOPE_PICKER_HINT');
  if (Config.Hint) $hint.text(Config.Hint).removeClass('d-none');
  else $hint.text('').addClass('d-none');

  const Search = document.getElementById('SCOPE_PICKER_SEARCH') as HTMLInputElement | null;
  if (Search) Search.value = '';
  RenderScopePickerList();

  openModal(MODAL_ID);
  if (Search) setTimeout(() => Search.focus(), 200);
}

/** Called by the bootstrap orchestrator in main.ts once the DOM is parsed. */
export function InitScopePicker(): void {
  $('#SCOPE_PICKER_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Select Clients',
        titleId: 'SCOPE_PICKER_TITLE',
        // Back and close are the same action: the selection is already saved,
        // so both just return the operator to the editor they came from.
        onBack: () => void CloseScopePicker(),
        onClose: () => void CloseScopePicker(),
      }).$el
    );

  const Search = document.getElementById('SCOPE_PICKER_SEARCH') as HTMLInputElement | null;
  if (Search) {
    Search.addEventListener('input', () => {
      SearchText = Search.value || '';
      RenderScopePickerList();
    });
  }

  $('#SCOPE_PICKER_LIST')
    .off('change.scopePicker')
    .on('change.scopePicker', 'input[type="checkbox"]', function () {
      const Kind = String($(this).attr('data-kind') || '');
      const Value = String($(this).val() || '');
      applyChange(Kind, Value, $(this).is(':checked'));
      RenderScopePickerList();
    });

  // Escape / backdrop dismissal goes through Bootstrap rather than our buttons.
  // It must still restore the previous screen, and it still keeps the selection
  // — there is no cancel. The guard stops our own programmatic hide (inside
  // CloseScopePicker, which has already cleared ActiveConfig) re-entering here.
  $(`#${MODAL_ID}`).on('hidden.bs.modal', () => {
    if (!ActiveConfig) return;
    const Config = ActiveConfig;
    const Restore = RestoreModalId;
    ActiveConfig = null;
    RestoreModalId = null;
    SearchText = '';
    if (Restore) openModal(Restore);
    renderScopeButton(Config);
    if (Config.OnCommit) Config.OnCommit();
  });
}
