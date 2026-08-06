import type { VariableView } from '@showtrak/protocol';
import { closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { HandleNonFatalError, Safe } from './utils';
import { CloseAllModals } from './modals';
import { ConfirmationDialog, Notify } from './selection-init';
import { Variables as AllVariables } from './state';

// Variable Manager (desktop UI)
// - Lists every show variable: an operator-defined value that reaches a
//   client's scripts as an environment variable. GAME_VERSION arrives as
//   %SHOWTRAK_VAR_GAME_VERSION% in a batch file.
// - The editor owns the name, the default value used by any client that has not
//   been given its own, a description, and whether the value is also mirrored
//   into the Windows user environment for programs outside ShowTrak.
// - Per-client values are NOT edited here. They live in each client's editor,
//   because that is where an operator is thinking about one machine; this modal
//   is where they think about the show.

/** Prefix the server applies to every variable. Mirrored from VariableManager's
 * VARIABLE_PREFIX — duplicated rather than imported because the renderer must
 * not pull in a module that reaches the database. */
const VARIABLE_PREFIX = 'SHOWTRAK_VAR_';

let VariableManagerCache: VariableView[] = [];
let VariableManagerEditingId: number | null = null;

/**
 * Mirror of VariableManager.NormalizeKey for live feedback in the name field.
 *
 * The server is authoritative and normalizes again on save; this exists so the
 * operator sees the name become GAME_VERSION as they type "game version",
 * rather than being surprised by it after saving.
 */
export function NormalizeVariableKey(Value: unknown): string {
  const Raw = String(Value == null ? '' : Value).trim();
  if (!Raw) return '';
  let Key = Raw.toUpperCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^A-Z0-9_]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!Key) return '';
  if (/^[0-9]/.test(Key)) Key = `_${Key}`;
  return Key;
}

/** How a script references this variable, in the platform's own syntax. */
export function VariableUsageHint(Key: string): string {
  const EnvironmentKey = `${VARIABLE_PREFIX}${Key || 'NAME'}`;
  return `%${EnvironmentKey}%`;
}

export async function OpenVariableManager() {
  await CloseAllModals();
  ShowVariableManagerList();
  await RefreshVariableManagerList();
  openModal('SHOWTRAK_MODAL_VARIABLEMANAGER');
}

export function ShowVariableManagerList() {
  VariableManagerEditingId = null;
  $('#VARIABLE_MANAGER_LIST_VIEW').removeClass('d-none');
  $('#VARIABLE_MANAGER_EDITOR_VIEW').addClass('d-none');
}

export function ShowVariableManagerEditor() {
  $('#VARIABLE_MANAGER_LIST_VIEW').addClass('d-none');
  $('#VARIABLE_MANAGER_EDITOR_VIEW').removeClass('d-none');
}

export async function RefreshVariableManagerList() {
  try {
    VariableManagerCache = (await window.API.GetAllVariables()) || [];
  } catch (Err) {
    HandleNonFatalError('VariableManager:List', Err);
    VariableManagerCache = [];
  }
  RenderVariableManagerList();
}

export function RenderVariableManagerList() {
  const Container = document.getElementById('VARIABLE_MANAGER_LIST') as HTMLElement;
  if (!Container) return;
  Container.innerHTML = '';

  if (!VariableManagerCache.length) {
    Container.innerHTML =
      '<div class="p-3 rounded bg-ghost text-center text-muted">No variables yet. Create one to pass show values into your scripts.</div>';
    return;
  }

  for (const Variable of VariableManagerCache) {
    // Say what a script would actually see, not what is stored: an empty
    // default with no overrides is the case most likely to confuse, so it is
    // called out rather than rendered as blank space.
    const DefaultLabel = Variable.DefaultValue
      ? `Default: ${Variable.DefaultValue}`
      : 'No default value';
    const OverrideLabel =
      Variable.OverrideCount === 0
        ? 'no client overrides'
        : Variable.OverrideCount === 1
          ? '1 client overrides it'
          : `${Variable.OverrideCount} clients override it`;
    const ExportLabel = Variable.ExportToSystem ? ' · Windows environment' : '';

    const Item = document.createElement('div');
    Item.className = 'script-manager-item p-3 rounded bg-ghost';
    Item.setAttribute('data-variableid', String(Variable.VariableID));
    Item.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <span class="script-manager-item-icon"><i class="bi bi-braces"></i></span>
        <div class="flex-grow-1 min-w-0">
          <div class="d-flex align-items-center">
            <span class="text-bold script-manager-item-name">${Safe(Variable.EnvironmentKey)}</span>
          </div>
          <div class="script-manager-item-desc">${Safe(`${DefaultLabel} · ${OverrideLabel}${ExportLabel}`)}</div>
        </div>
        <div class="d-flex align-items-center gap-2 flex-shrink-0">
          <i class="bi bi-chevron-right script-manager-chevron"></i>
        </div>
      </div>
    `;

    Item.addEventListener('click', () => OpenVariableManagerEditor(Variable.VariableID));
    Container.appendChild(Item);
  }
}

export async function CreateVariable() {
  const Btn = $('#VARIABLE_MANAGER_CREATE');
  Btn.prop('disabled', true);
  const [Err, Variable] = await window.API.CreateVariable();
  Btn.prop('disabled', false);
  if (Err || !Variable) {
    Notify(`Could not create variable: ${Err || 'unknown error'}`, 'error');
    return;
  }
  await RefreshVariableManagerList();
  Notify('Variable created', 'success');
  OpenVariableManagerEditor(Variable.VariableID);
}

export async function OpenVariableManagerEditor(VariableID: number) {
  VariableManagerEditingId = VariableID;
  HideVariableManagerIssues();
  ShowVariableManagerEditor();

  // Refresh so the editor reflects concurrent changes; a variable deleted
  // elsewhere drops back to the list rather than editing a ghost.
  await RefreshVariableManagerList();
  if (VariableManagerEditingId !== VariableID) return;
  const Variable = VariableManagerCache.find((V) => V.VariableID === VariableID);
  if (!Variable) {
    Notify('Variable no longer exists', 'error');
    ShowVariableManagerList();
    return;
  }

  PopulateVariableManagerEditor(Variable);
}

export function PopulateVariableManagerEditor(Variable: VariableView) {
  $('#VARIABLE_MANAGER_FIELD_KEY').val(Variable.Key || '');
  $('#VARIABLE_MANAGER_FIELD_DEFAULT').val(Variable.DefaultValue || '');
  $('#VARIABLE_MANAGER_FIELD_DESCRIPTION').val(Variable.Description || '');
  $('#VARIABLE_MANAGER_FIELD_EXPORT').prop('checked', !!Variable.ExportToSystem);
  UpdateVariableUsageHint(Variable.Key || '');

  const Summary =
    Variable.OverrideCount === 0
      ? 'No clients have their own value for this variable — every client uses the default.'
      : Variable.OverrideCount === 1
        ? '1 client has its own value for this variable.'
        : `${Variable.OverrideCount} clients have their own value for this variable.`;
  $('#VARIABLE_MANAGER_OVERRIDE_SUMMARY').text(Summary);
}

/** Keep the "scripts reference it as %…%" hint in step with the name field. */
export function UpdateVariableUsageHint(Key: string) {
  $('#VARIABLE_MANAGER_USAGE_HINT').text(VariableUsageHint(NormalizeVariableKey(Key)));
}

export function RenderVariableManagerIssues(Title: string, Issues: string[]) {
  const El = $('#VARIABLE_MANAGER_ISSUES');
  El.removeClass('d-none info error').addClass('error');
  const Items = (Issues || []).map((i) => `<li>${Safe(i)}</li>`).join('');
  El.html(
    `<div class="text-bold">${Safe(Title)}</div>${Items ? `<ul class="mb-0">${Items}</ul>` : ''}`
  );
}

export function HideVariableManagerIssues() {
  $('#VARIABLE_MANAGER_ISSUES').addClass('d-none').removeClass('info error').html('');
}

export async function SaveVariableManagerConfig() {
  if (!VariableManagerEditingId) return;
  const VariableID = VariableManagerEditingId;
  HideVariableManagerIssues();

  const SaveBtn = $('#VARIABLE_MANAGER_SAVE');
  SaveBtn.prop('disabled', true);

  // Name first: it can be rejected (empty, reserved, or colliding), in which
  // case nothing else is persisted and the reason is surfaced inline. Saving
  // the other fields against a name the operator thinks they changed would be
  // worse than saving nothing.
  const Key = String($('#VARIABLE_MANAGER_FIELD_KEY').val() || '').trim();
  const [KeyErr] = await window.API.SetVariableKey(VariableID, Key);
  if (KeyErr) {
    SaveBtn.prop('disabled', false);
    if (VariableManagerEditingId !== VariableID) return;
    RenderVariableManagerIssues('Could not save — please fix the following:', [KeyErr]);
    Notify('Could not save variable', 'error');
    return;
  }

  const [DefaultErr] = await window.API.SetVariableDefault(
    VariableID,
    String($('#VARIABLE_MANAGER_FIELD_DEFAULT').val() || '')
  );
  const [DescriptionErr] = await window.API.SetVariableDescription(
    VariableID,
    String($('#VARIABLE_MANAGER_FIELD_DESCRIPTION').val() || '')
  );
  const [ExportErr] = await window.API.SetVariableExport(
    VariableID,
    $('#VARIABLE_MANAGER_FIELD_EXPORT').is(':checked')
  );

  SaveBtn.prop('disabled', false);
  if (VariableManagerEditingId !== VariableID) return;

  const Errors = [DefaultErr, DescriptionErr, ExportErr].filter(Boolean) as string[];
  if (Errors.length) {
    RenderVariableManagerIssues('Variable partially saved — the following failed:', Errors);
    Notify('Variable could not be fully saved', 'error');
    return;
  }

  Notify('Variable saved', 'success');
  await RefreshVariableManagerList();
  ShowVariableManagerList();
}

/**
 * The read-only reference list shown in the Script Editor.
 *
 * Script authors need the exact spelling far more often than they need to edit
 * a variable, and getting it wrong fails silently (a batch file just prints the
 * literal `%SHOWTRAK_VAR_TYPO%`), so the names are click-to-copy.
 */
export function RenderScriptEditorVariableList() {
  const Container = document.getElementById('SCRIPT_MANAGER_VARIABLE_LIST') as HTMLElement;
  if (!Container) return;
  Container.innerHTML = '';

  if (!AllVariables.length) {
    Container.innerHTML =
      '<span class="text-sm text-muted">No variables defined. Create them in the Variable Manager.</span>';
    return;
  }

  for (const Variable of AllVariables) {
    const Row = document.createElement('div');
    Row.className = 'd-flex align-items-center gap-2';
    const Usage = VariableUsageHint(Variable.Key);
    // The default is what an un-configured client will actually see, so it is
    // the useful thing to show beside the name — not the variable's own metadata.
    const Detail = Variable.Description
      ? Variable.Description
      : Variable.DefaultValue
        ? `Default: ${Variable.DefaultValue}`
        : 'No default value';
    Row.innerHTML = `
      <button type="button" class="btn btn-sm btn-outline-light flex-shrink-0 st-variable-copy" data-copy="${Safe(Usage)}" title="Copy ${Safe(Usage)}">
        <code>${Safe(Usage)}</code>
      </button>
      <span class="text-sm text-muted text-truncate">${Safe(Detail)}</span>
    `;
    Container.appendChild(Row);
  }
}

// Called by the bootstrap orchestrator in main.ts once the DOM is parsed.
export function InitVariableManager() {
  $('#VARIABLE_MANAGER_LIST_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Variable Manager',
        onClose: () => closeModal('SHOWTRAK_MODAL_VARIABLEMANAGER'),
      }).$el
    );
  $('#VARIABLE_MANAGER_EDITOR_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Variable Editor',
        onBack: () => ShowVariableManagerList(),
        onClose: () => closeModal('SHOWTRAK_MODAL_VARIABLEMANAGER'),
      }).$el
    );

  $('#VARIABLE_MANAGER_CREATE')
    .off('click')
    .on('click', () => CreateVariable());

  // Live-normalize the name as it is typed so the operator sees the canonical
  // spelling (and the usage hint) rather than discovering it on save.
  $('#VARIABLE_MANAGER_FIELD_KEY')
    .off('input')
    .on('input', function () {
      UpdateVariableUsageHint(String($(this).val() || ''));
    });

  $('#VARIABLE_MANAGER_FIELD_KEY')
    .off('blur')
    .on('blur', function () {
      const Normalized = NormalizeVariableKey($(this).val());
      if (Normalized) $(this).val(Normalized);
      UpdateVariableUsageHint(Normalized);
    });

  $('#VARIABLE_MANAGER_DELETE')
    .off('click')
    .on('click', async () => {
      if (!VariableManagerEditingId) return;
      const VariableID = VariableManagerEditingId;
      const Variable = VariableManagerCache.find((V) => V.VariableID === VariableID);
      const Label = (Variable && Variable.EnvironmentKey) || `Variable ${VariableID}`;
      // Spell out the two consequences that are not obvious from "delete":
      // per-client values go too, and exported values leave client machines.
      const Confirmed = await ConfirmationDialog(
        `Delete ${Label}? Every client's value for it is removed, and it will be cleared from the Windows environment on clients that had it.`
      );
      if (!Confirmed) return;
      const [Err] = await window.API.DeleteVariable(VariableID);
      if (Err) {
        Notify(`Failed to delete variable: ${Err}`, 'error');
        return;
      }
      Notify(`${Label} deleted`, 'success');
      ShowVariableManagerList();
      await RefreshVariableManagerList();
    });

  $('#VARIABLE_MANAGER_SAVE')
    .off('click')
    .on('click', () => SaveVariableManagerConfig());

  $('#VARIABLE_MANAGER_REVERT')
    .off('click')
    .on('click', () => {
      const Variable = VariableManagerEditingId
        ? VariableManagerCache.find((V) => V.VariableID === VariableManagerEditingId)
        : null;
      if (Variable) PopulateVariableManagerEditor(Variable);
      HideVariableManagerIssues();
    });

  // Click-to-copy on the script editor's reference list. Delegated off the
  // container because the list is re-rendered whenever the variable set changes.
  $(document)
    .off('click.variableCopy', '.st-variable-copy')
    .on('click.variableCopy', '.st-variable-copy', function () {
      const Text = String($(this).attr('data-copy') || '');
      if (!Text) return;
      void navigator.clipboard
        .writeText(Text)
        .then(() => Notify(`Copied ${Text}`, 'success'))
        .catch(() => Notify('Could not copy to clipboard', 'error'));
    });
}
