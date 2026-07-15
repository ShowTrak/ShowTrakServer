import type { GroupView, ScriptEditable, ScriptManagerEntry } from '@showtrak/protocol';
import { closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { HandleNonFatalError, Safe } from './04-utils';
import { CloseAllModals } from './11-modals';
import { ConfirmationDialog, Notify } from './14-selection-init';
import { NormalizeIconName, OpenIconPicker } from './18-icon-picker';
import {
  buildScopeModel,
  parseScopeSelection,
  scopeToSelectedValues,
  renderScopeDropdown,
  bindScopeDropdown,
} from './scope-dropdown';
import type { ScopeDropdownConfig } from './scope-dropdown';
// Script Manager (desktop UI)
// - Lists every script discovered in the scripts folder, showing its ID,
//   validity, and the operating systems it has scripts configured for.
// - Supports drag-and-drop reordering of scripts (persisted as Weight).
// - Lets the operator edit each script's configuration via structured fields.
//   Missing/invalid keys are repaired automatically on save by the backend.

// Platform display metadata, in preferred display order.
export const SCRIPT_MANAGER_PLATFORMS = [
  { key: 'Windows', icon: 'bi-windows', label: 'Windows' },
  { key: 'macOS', icon: 'bi-apple', label: 'macOS' },
  { key: 'Linux', icon: 'bi-ubuntu', label: 'Linux' },
];

// Colour palette – order matches SCRIPT_COLOURS in schema.js.
// 0-5 rainbow, 6-7 greys.
export const SCRIPT_COLOURS = [
  { hex: '#e74c3c', label: 'Red' },
  { hex: '#e67e22', label: 'Orange' },
  { hex: '#f1c40f', label: 'Yellow' },
  { hex: '#2ecc71', label: 'Green' },
  { hex: '#3498db', label: 'Blue' },
  { hex: '#9b59b6', label: 'Purple' },
  { hex: '#bdc3c7', label: 'Light grey' },
  { hex: '#7f8c8d', label: 'Dark grey' },
];

export function ScriptColourHex(Index: number | undefined) {
  const entry = Index === undefined ? undefined : SCRIPT_COLOURS[Index];
  return entry ? entry.hex : SCRIPT_COLOURS[6].hex;
}

// Sample script manifest entry as returned by GetSampleScripts /
// RefreshSampleScripts (opaque `unknown[]` on the wire; narrowed here).
interface SampleScriptEntry {
  id: string;
  name?: string;
  description?: string;
  colour?: number;
  platforms?: Record<string, string>;
}

// Minimal shape needed to render the per-platform OS chips. Satisfied by both
// ScriptManagerEntry rows and the synthesized template-preview objects.
interface ScriptOSChipsSource {
  platforms?: Record<string, string>;
  compatiblePlatforms?: string[];
}

export let ScriptManagerCache: ScriptManagerEntry[] = [];
export let ScriptManagerEditingId: string | null = null;
export let ScriptManagerOriginal: ScriptEditable | null = null;
export let ScriptManagerEditingFiles: string[] = [];
export let ScriptManagerSampleCache: SampleScriptEntry[] = [];
// Currently-selected icon in the editor (bare Bootstrap Icons name, no "bi-").
export let ScriptManagerEditingIcon: string = 'terminal';

// --- Script whitelist editor state -----------------------------------------
// The per-script whitelist reuses the shared scope-dropdown engine, restricted
// to real remote clients (scripts never run on integrated/dummy/monitoring
// targets). Selection is the flat value list; groups are cached at editor-open
// so BuildModel stays synchronous for the render/change handlers.
let ScriptWhitelistSelected: string[] = [];
let ScriptWhitelistOriginal: string[] = [];
let ScriptWhitelistGroups: GroupView[] = [];

const ScriptWhitelistConfig: ScopeDropdownConfig = {
  DropdownSelector: '#SCRIPT_WHITELIST_DROPDOWN',
  MenuSelector: '#SCRIPT_WHITELIST_MENU',
  ToggleSelector: '#SCRIPT_WHITELIST_TOGGLE',
  // Shown only when nothing is selected. The genuine "all clients" state is
  // Workspace:true, which renders "All Clients" via its own branch — an empty
  // selection instead means no client may run the script.
  Namespace: 'scriptWhitelist',
  Placeholder: 'No clients',
  GetSelected: () => ScriptWhitelistSelected,
  SetSelected: (values) => {
    ScriptWhitelistSelected = values;
  },
  // Only real (non-integrated) clients and their groups are valid script
  // targets, so that is all the dropdown offers.
  BuildModel: () =>
    buildScopeModel({
      Groups: ScriptWhitelistGroups,
      IncludeKinds: ['showtrak'],
      ExcludeIntegrated: true,
    }),
  ToggleRender: 'html',
};

// Reflect the given icon name into the editor's preview swatch + label, and
// track it as the pending value collected on save.
export function SetScriptManagerEditorIcon(Icon: unknown) {
  const Name = NormalizeIconName(Icon) || 'terminal';
  ScriptManagerEditingIcon = Name;
  const Preview = document.querySelector('#SCRIPT_MANAGER_ICON_PREVIEW i');
  if (Preview) Preview.className = `bi bi-${Name}`;
  const PreviewButton = document.getElementById('SCRIPT_MANAGER_ICON_PREVIEW');
  if (PreviewButton) PreviewButton.title = `Icon: ${Name} — click to change`;
}

export function GetScriptManagerPlatformKey() {
  const ua = String(navigator.userAgent || '').toLowerCase();
  const platform = String(navigator.platform || '').toLowerCase();
  if (platform.includes('win') || ua.includes('windows')) return 'Windows';
  if (platform.includes('mac') || ua.includes('mac os')) return 'macOS';
  return 'Linux';
}

export function NormalizeScriptManagerPath(Value: unknown) {
  return String(Value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

export function GetMappedExecutableForCurrentPlatform() {
  const PlatformKey = GetScriptManagerPlatformKey();
  const Row = document.querySelector<HTMLElement>(
    `#SCRIPT_MANAGER_PLATFORMS .script-manager-platform-row[data-platform="${PlatformKey}"]`
  );
  if (!Row) return '';
  const Select = Row.querySelector<HTMLSelectElement>('.script-manager-platform-select');
  if (!Select) return '';
  return NormalizeScriptManagerPath(Select.value || '');
}

export async function OpenScriptManager() {
  await CloseAllModals();
  ShowScriptManagerList();
  await RefreshScriptManagerList();
  openModal('SHOWTRAK_MODAL_SCRIPTMANAGER');
}

export function ShowScriptManagerList() {
  ScriptManagerEditingId = null;
  $('#SCRIPT_MANAGER_LIST_VIEW').removeClass('d-none');
  $('#SCRIPT_MANAGER_EDITOR_VIEW').addClass('d-none');
  $('#SCRIPT_MANAGER_TEMPLATES_VIEW').addClass('d-none');
}

export function ShowScriptManagerEditor() {
  $('#SCRIPT_MANAGER_LIST_VIEW').addClass('d-none');
  $('#SCRIPT_MANAGER_EDITOR_VIEW').removeClass('d-none');
  $('#SCRIPT_MANAGER_TEMPLATES_VIEW').addClass('d-none');
}

export function ShowScriptManagerTemplates() {
  $('#SCRIPT_MANAGER_LIST_VIEW').addClass('d-none');
  $('#SCRIPT_MANAGER_EDITOR_VIEW').addClass('d-none');
  $('#SCRIPT_MANAGER_TEMPLATES_VIEW').removeClass('d-none');
}

export async function RefreshScriptManagerList() {
  try {
    ScriptManagerCache = (await window.API.GetScriptManagerList()) || [];
  } catch (Err) {
    HandleNonFatalError('ScriptManager:List', Err);
    ScriptManagerCache = [];
  }
  RenderScriptManagerList();
}

// Validate a candidate script ID against the schema rules + existing scripts.
// Returns null when valid, otherwise a human-readable reason.
export function ScriptManagerIDError(ID: unknown) {
  const Trimmed = String(ID || '').trim();
  if (!Trimmed) return 'ID is required';
  if (/\s/.test(Trimmed)) return 'ID cannot contain spaces';
  if (!/^[A-Za-z0-9_-]+$/.test(Trimmed))
    return 'ID can only contain letters, numbers, hyphens and underscores';
  const Taken = ScriptManagerCache.some(
    (s) => String(s.id).toLowerCase() === Trimmed.toLowerCase()
  );
  if (Taken) return 'A script with this ID already exists';
  return null;
}

// Create a brand new blank script and open it in the editor.
export async function CreateBlankScript() {
  const Btn = $('#SCRIPT_MANAGER_CREATE');
  Btn.prop('disabled', true);
  const [Err, Result] = await window.API.CreateScript();
  Btn.prop('disabled', false);
  if (Err || !Result || !Result.id) {
    Notify(`Could not create script: ${Err || 'unknown error'}`, 'error');
    return;
  }
  await RefreshScriptManagerList();
  Notify('Blank script created', 'success');
  OpenScriptManagerEditor(Result.id);
}

export async function OpenScriptManagerTemplates() {
  ShowScriptManagerTemplates();
  const Container = document.getElementById('SCRIPT_MANAGER_TEMPLATES_LIST') as HTMLElement;
  Container.innerHTML =
    '<div class="p-3 rounded bg-ghost text-center text-muted">Loading sample scripts…</div>';
  await RefreshScriptManagerTemplates(false);
}

export async function RefreshScriptManagerTemplates(Force: boolean) {
  try {
    const [Err, List] = Force
      ? await window.API.RefreshSampleScripts()
      : await window.API.GetSampleScripts();
    if (Err) {
      Notify(`Could not load sample scripts: ${Err}`, 'error');
      ScriptManagerSampleCache = ScriptManagerSampleCache || [];
    } else {
      ScriptManagerSampleCache = (List || []) as SampleScriptEntry[];
    }
  } catch (Err) {
    HandleNonFatalError('ScriptManager:Templates', Err);
    ScriptManagerSampleCache = [];
  }
  RenderScriptManagerTemplates();
}

export function GenerateTemplatePlaceholderID() {
  const Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let Candidate = '';
  do {
    Candidate = 'Script';
    for (let Index = 0; Index < 6; Index += 1) {
      Candidate += Alphabet[Math.floor(Math.random() * Alphabet.length)];
    }
  } while (ScriptManagerIDError(Candidate));
  return Candidate;
}

export async function CreateScriptFromTemplateWithGeneratedID(
  SampleID: string
): Promise<
  [string | null, { id?: string; conflict?: boolean; ok?: boolean; errors?: string[] } | null]
> {
  const MaxAttempts = 10;
  for (let Attempt = 0; Attempt < MaxAttempts; Attempt += 1) {
    const DesiredID = GenerateTemplatePlaceholderID();
    const [Err, Result] = await window.API.CreateScriptFromTemplate(SampleID, DesiredID);
    if (!Err) return [null, Result];
    if (!(Result && Result.conflict)) {
      return [Err, Result];
    }
  }
  return ['Could not generate a unique script ID', null];
}

export function RenderScriptManagerTemplates() {
  const Container = document.getElementById('SCRIPT_MANAGER_TEMPLATES_LIST') as HTMLElement;
  Container.innerHTML = '';

  if (!ScriptManagerSampleCache.length) {
    Container.innerHTML =
      '<div class="p-3 rounded bg-ghost text-center text-muted">No sample scripts available. Check your internet connection and try refreshing.</div>';
    return;
  }

  for (const Sample of ScriptManagerSampleCache) {
    const OSChips = RenderScriptManagerOSChips({
      platforms: Sample.platforms || {},
      compatiblePlatforms: SCRIPT_MANAGER_PLATFORMS.filter(
        (p) => Sample.platforms && String(Sample.platforms[p.key] || '').trim()
      ).map((p) => p.key),
    });
    const DescriptionLine = Sample.description
      ? `<div class="script-manager-item-desc">${Safe(Sample.description)}</div>`
      : '';
    const AccentColour = ScriptColourHex(Sample.colour);

    const Item = document.createElement('div');
    Item.className = 'script-manager-item p-3 rounded bg-ghost';
    Item.style.setProperty('--script-accent', AccentColour);
    Item.innerHTML = `
      <div class="script-manager-accent-strip"></div>
      <div class="d-flex align-items-center gap-2">
        <div class="flex-grow-1 min-w-0">
          <div class="d-flex align-items-center">
            <span class="text-bold script-manager-item-name">${Safe(Sample.name || Sample.id)}</span>
          </div>
          ${DescriptionLine}
        </div>
        <div class="d-flex align-items-center gap-2 flex-shrink-0">
          <div class="script-manager-os-list">${OSChips}</div>
          <button type="button" class="btn btn-sm script-manager-folder-btn script-manager-template-create flex-shrink-0">
            <i class="bi bi-plus-lg"></i> Create
          </button>
        </div>
      </div>
      <div class="script-manager-template-hint text-sm text-muted mt-1"></div>
    `;

    const CreateBtn = Item.querySelector('.script-manager-template-create') as HTMLButtonElement;
    const Hint = Item.querySelector('.script-manager-template-hint') as HTMLElement;

    CreateBtn.addEventListener('click', async () => {
      CreateBtn.disabled = true;
      Hint.textContent = '';
      Hint.classList.remove('text-danger');
      Hint.classList.add('text-muted');
      const [Err, Result] = await CreateScriptFromTemplateWithGeneratedID(Sample.id);
      if (Err) {
        Hint.textContent = Err;
        Hint.classList.add('text-danger');
        Hint.classList.remove('text-muted');
        CreateBtn.disabled = false;
        Notify(`Could not create script: ${Err}`, 'error');
        return;
      }
      const NewID = (Result && Result.id) || '';
      await RefreshScriptManagerList();
      Notify(`Script "${NewID}" created from template`, 'success');
      OpenScriptManagerEditor(NewID);
    });

    Container.appendChild(Item);
  }
}

// Pick a Bootstrap icon for a file based on its extension.
export function ScriptManagerFileIcon(FilePath: string) {
  const Lower = String(FilePath || '').toLowerCase();
  const Ext = Lower.includes('.') ? Lower.slice(Lower.lastIndexOf('.')) : '';
  switch (Ext) {
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.command':
    case '.bat':
    case '.cmd':
    case '.ps1':
      return 'bi-terminal';
    case '.exe':
      return 'bi-windows';
    case '.py':
      return 'bi-filetype-py';
    case '.js':
      return 'bi-filetype-js';
    case '.json':
      return 'bi-filetype-json';
    case '.txt':
      return 'bi-filetype-txt';
    case '.md':
      return 'bi-filetype-md';
    default:
      return 'bi-file-earmark';
  }
}

export function RenderScriptManagerOSChips(Script: ScriptOSChipsSource) {
  const Platforms = Script.platforms || {};
  const Compatible = new Set(Script.compatiblePlatforms || []);
  return SCRIPT_MANAGER_PLATFORMS.map((p) => {
    const Path = typeof Platforms[p.key] === 'string' ? Platforms[p.key].trim() : '';

    // Always show every platform and mark missing paths in red so authoring
    // gaps are immediately visible.
    if (!Path) {
      return `<span class="script-manager-os-chip missing" title="${p.label}: no script configured"><i class="bi ${p.icon}"></i>${p.label}</span>`;
    }

    const State = Compatible.has(p.key) ? 'compatible' : 'broken';
    const Title = Compatible.has(p.key)
      ? `${p.label}: ${Safe(Path)}`
      : `${p.label}: file "${Safe(Path)}" not found`;
    return `<span class="script-manager-os-chip ${State}" title="${Title}"><i class="bi ${p.icon}"></i>${p.label}</span>`;
  }).join('');
}

export function RenderScriptManagerList() {
  // Preserve the saved order (Weight), tie-breaking on ID for stability.
  const List = ScriptManagerCache.slice().sort((a, b) => {
    const wa = a.weight || 0;
    const wb = b.weight || 0;
    if (wa !== wb) return wa - wb;
    return String(a.id).localeCompare(String(b.id));
  });
  const Container = document.getElementById('SCRIPT_MANAGER_LIST') as HTMLElement;
  Container.innerHTML = '';

  if (!List.length) {
    Container.innerHTML =
      '<div class="p-3 rounded bg-ghost text-center text-muted">No scripts found in the scripts folder.</div>';
    return;
  }

  for (const Script of List) {
    const InvalidBadge = Script.valid
      ? ''
      : '<span class="badge bg-danger text-light ms-2">Invalid</span>';

    const RightContent = Script.valid
      ? `<div class="script-manager-os-list">${RenderScriptManagerOSChips(Script)}</div>`
      : `<div class="script-manager-os-empty">${Safe(Script.parseError || 'Cannot parse Script.json')}</div>`;

    const DescriptionLine = Script.description
      ? `<div class="script-manager-item-desc">${Safe(Script.description)}</div>`
      : '';

    const DisabledClass = Script.valid && !Script.enabled ? ' script-manager-item-disabled' : '';

    const IconName = NormalizeIconName(Script.icon) || 'terminal';

    const Item = document.createElement('div');
    Item.className = `script-manager-item p-3 rounded bg-ghost${Script.valid ? '' : ' script-manager-item-invalid'}${DisabledClass}`;
    Item.setAttribute('draggable', 'true');
    Item.setAttribute('data-scriptid', Script.id);
    const AccentColour = ScriptColourHex(Script.colour);
    Item.style.setProperty('--script-accent', AccentColour);
    Item.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <span class="script-manager-grip" title="Drag to reorder"><i class="bi bi-grip-vertical"></i></span>
        <span class="script-manager-item-icon"><i class="bi bi-${Safe(IconName)}"></i></span>
        <div class="flex-grow-1 min-w-0">
          <div class="d-flex align-items-center">
            <span class="text-bold script-manager-item-name">${Safe(Script.name || Script.id)}</span>
            ${InvalidBadge}
          </div>
          ${DescriptionLine}
        </div>
        <div class="d-flex align-items-center gap-2 flex-shrink-0">
          ${RightContent}
          <i class="bi bi-chevron-right script-manager-chevron"></i>
        </div>
      </div>
    `;

    Item.addEventListener('click', () => {
      // Ignore the click that can follow a drag operation.
      if (Item.dataset.dragged === '1') {
        Item.dataset.dragged = '';
        return;
      }
      OpenScriptManagerEditor(Script.id);
    });

    Item.addEventListener('dragstart', (e) => {
      Item.classList.add('dragging');
      try {
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', Script.id);
      } catch {
        // Some platforms require setData; ignore failures.
      }
    });

    Item.addEventListener('dragend', async () => {
      Item.classList.remove('dragging');
      Item.dataset.dragged = '1';
      await PersistScriptManagerOrder();
    });

    Container.appendChild(Item);
  }
}

// Find the item the dragged element should be inserted before, based on cursor Y.
export function ScriptManagerDragAfterElement(Container: HTMLElement, Y: number) {
  const Items = [...Container.querySelectorAll('.script-manager-item:not(.dragging)')];
  let Closest: { offset: number; element: Element | null } = {
    offset: Number.NEGATIVE_INFINITY,
    element: null,
  };
  for (const Child of Items) {
    const Box = Child.getBoundingClientRect();
    const Offset = Y - Box.top - Box.height / 2;
    if (Offset < 0 && Offset > Closest.offset) {
      Closest = { offset: Offset, element: Child };
    }
  }
  return Closest.element;
}

export async function PersistScriptManagerOrder() {
  const Container = document.getElementById('SCRIPT_MANAGER_LIST') as HTMLElement;
  const OrderedIDs = [...Container.querySelectorAll('.script-manager-item')].map(
    (el) => el.getAttribute('data-scriptid') || ''
  );
  const [Err] = await window.API.SetScriptOrder(OrderedIDs);
  if (Err) {
    Notify(`Failed to reorder scripts: ${Err}`, 'error');
  }
  await RefreshScriptManagerList();
}

export async function OpenScriptManagerEditor(ID: string) {
  ScriptManagerEditingId = ID;
  HideScriptManagerIssues();
  ShowScriptManagerEditor();

  const [Err, Data] = await window.API.GetScriptConfig(ID);
  if (ScriptManagerEditingId !== ID) return;
  if (Err || !Data) {
    Notify(`Failed to load script config: ${Err || 'unknown error'}`, 'error');
    ShowScriptManagerList();
    return;
  }

  ScriptManagerOriginal = Data;
  ScriptManagerEditingFiles = Array.isArray(Data.files) ? Data.files : [];

  // Load the whitelist picker's data: the current group list (for the tree) and
  // this script's stored scope. A null scope means unrestricted → "All Clients".
  const Groups = await window.API.GetAllGroups();
  ScriptWhitelistGroups = Array.isArray(Groups) ? Groups : [];
  const [WhitelistErr, Scope] = await window.API.GetScriptWhitelist(ID);
  if (ScriptManagerEditingId !== ID) return;
  ScriptWhitelistSelected = !WhitelistErr && Scope ? scopeToSelectedValues(Scope) : ['workspace:*'];
  ScriptWhitelistOriginal = ScriptWhitelistSelected.slice();

  PopulateScriptManagerEditor(Data);
}

export function PopulateScriptManagerEditor(Data: ScriptEditable) {
  $('#SCRIPT_MANAGER_FIELD_ID').val(Data.id || '');
  $('#SCRIPT_MANAGER_FIELD_NAME').val(Data.name || '');
  $('#SCRIPT_MANAGER_FIELD_DESCRIPTION').val(Data.description || '');

  // Colour swatch picker.
  const SwatchContainer = document.getElementById('SCRIPT_MANAGER_COLOUR_SWATCHES') as HTMLElement;
  SwatchContainer.innerHTML = '';
  const currentColour = typeof Data.colour === 'number' ? Data.colour : 6;
  SCRIPT_COLOURS.forEach((c, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'script-manager-swatch' + (idx === currentColour ? ' selected' : '');
    btn.title = c.label;
    btn.style.background = c.hex;
    btn.setAttribute('data-colour-index', String(idx));
    btn.addEventListener('click', () => {
      SwatchContainer.querySelectorAll('.script-manager-swatch').forEach((s) =>
        s.classList.remove('selected')
      );
      btn.classList.add('selected');
    });
    SwatchContainer.appendChild(btn);
  });

  // Icon field.
  SetScriptManagerEditorIcon(Data.icon);

  $('#SCRIPT_MANAGER_FIELD_CONFIRM').prop('checked', !!Data.confirm);
  $('#SCRIPT_MANAGER_FIELD_ENABLED').prop('checked', !!Data.enabled);
  const timeoutMs =
    typeof Data.timeoutMs === 'number' && Number.isFinite(Data.timeoutMs) && Data.timeoutMs > 0
      ? Data.timeoutMs
      : 15000;
  const timeoutSeconds = Math.max(5, Math.round(timeoutMs / 1000));
  $('#SCRIPT_MANAGER_FIELD_TIMEOUT_SECONDS').val(timeoutSeconds);

  RenderScriptManagerPlatforms(Data.platforms || {}, Data.arguments || {});
  RenderScriptManagerFileList(Data.files || []);
  renderScopeDropdown(ScriptWhitelistConfig);
}

export function RenderScriptManagerPlatforms(
  Platforms: Record<string, string>,
  Arguments: Record<string, string>
) {
  const Container = $('#SCRIPT_MANAGER_PLATFORMS');
  Container.html('');
  for (const Platform of SCRIPT_MANAGER_PLATFORMS) {
    const Selected = typeof Platforms[Platform.key] === 'string' ? Platforms[Platform.key] : '';
    const ArgumentValue =
      typeof Arguments[Platform.key] === 'string' ? Arguments[Platform.key] : '';

    // Build the option set from the folder's files; always include a "None"
    // option and preserve a configured path even if the file is missing.
    const Options = [''].concat(ScriptManagerEditingFiles);
    if (Selected && !Options.includes(Selected)) Options.push(Selected);

    const OptionHtml = Options.map((File) => {
      if (File === '') {
        return `<option value=""${Selected === '' ? ' selected' : ''}>— None —</option>`;
      }
      const Missing = !ScriptManagerEditingFiles.includes(File) ? ' (missing)' : '';
      return `<option value="${Safe(File)}"${File === Selected ? ' selected' : ''}>${Safe(
        File
      )}${Missing}</option>`;
    }).join('');

    Container.append(`
      <div class="d-flex align-items-center gap-2 script-manager-platform-row" data-platform="${Platform.key}">
        <span class="script-manager-platform-label"><i class="bi ${Platform.icon}"></i> ${Platform.label}</span>
        <select class="form-select form-select-sm bg-ghost-light text-light border-0 script-manager-platform-select">
          ${OptionHtml}
        </select>
        <input
          type="text"
          class="form-control form-control-sm bg-ghost-light text-light border-0 script-manager-platform-args"
          value="${Safe(ArgumentValue)}"
          placeholder="Arguments (optional)"
        />
      </div>
    `);
  }
}

export function RenderScriptManagerFileList(Files: string[]) {
  const Container = $('#SCRIPT_MANAGER_FILE_LIST');
  Container.html('');
  if (!Files || !Files.length) {
    Container.append('<span class="text-sm text-muted">No additional files in this folder.</span>');
    return;
  }
  const PlatformKey = GetScriptManagerPlatformKey();
  const MappedExecutable = GetMappedExecutableForCurrentPlatform();
  for (const File of Files) {
    const EncodedFile = encodeURIComponent(File);
    const NormalizedFile = NormalizeScriptManagerPath(File);
    const CanRunLocally = !!MappedExecutable && NormalizedFile === MappedExecutable;
    const RunTitle = CanRunLocally
      ? `Run this ${PlatformKey} executable locally`
      : `Only the mapped ${PlatformKey} executable can be run`;
    Container.append(`
      <div class="d-flex align-items-center gap-2 script-manager-file-row">
        <i class="bi ${ScriptManagerFileIcon(File)}"></i>
        <span class="text-sm flex-grow-1 text-break">${Safe(File)}</span>
        <button
          type="button"
          class="btn btn-sm script-manager-file-edit-btn"
          data-file="${EncodedFile}"
          title="Edit in workspace editor"
        >
          <i class="bi bi-pencil-square"></i>
          Edit
        </button>
        <button
          type="button"
          class="btn btn-sm script-manager-file-run-btn"
          data-file="${EncodedFile}"
          title="${Safe(RunTitle)}"
          ${CanRunLocally ? '' : 'disabled'}
        >
          <i class="bi bi-play-fill"></i>
          Run Locally
        </button>
      </div>
    `);
  }

  Container.find('.script-manager-file-edit-btn')
    .off('click')
    .on('click', async function (Event) {
      Event.preventDefault();
      Event.stopPropagation();
      if (!ScriptManagerEditingId) return;

      const EncodedFile = $(this).attr('data-file') || '';
      const RelativeFilePath = decodeURIComponent(EncodedFile);
      const [Err] = await window.API.OpenScriptFile(ScriptManagerEditingId, RelativeFilePath);
      if (Err) {
        Notify(`Could not open file: ${Err}`, 'error');
        return;
      }
      Notify(`Opened ${RelativeFilePath} for editing`, 'success', 1000);
    });

  Container.find('.script-manager-file-run-btn')
    .off('click')
    .on('click', async function (Event) {
      Event.preventDefault();
      Event.stopPropagation();
      if (!ScriptManagerEditingId) return;

      const EncodedFile = $(this).attr('data-file') || '';
      const RelativeFilePath = decodeURIComponent(EncodedFile);
      const Confirmed = await ConfirmationDialog(`Run ${RelativeFilePath} on this machine now?`);
      if (!Confirmed) return;

      const [Err] = await window.API.RunScriptFileLocal(ScriptManagerEditingId, RelativeFilePath);
      if (Err) {
        Notify(`Could not run file: ${Err}`, 'error');
        return;
      }
      Notify(`Completed ${RelativeFilePath}`, 'success');
    });
}

export function CollectScriptManagerFields() {
  const Platforms: Record<string, string> = {};
  const Arguments: Record<string, string> = {};
  $('#SCRIPT_MANAGER_PLATFORMS .script-manager-platform-row').each(function () {
    const Key = $(this).attr('data-platform') || '';
    Platforms[Key] = String($(this).find('.script-manager-platform-select').val() || '');
    Arguments[Key] = String($(this).find('.script-manager-platform-args').val() || '').trim();
  });
  const SwatchContainer = document.getElementById(
    'SCRIPT_MANAGER_COLOUR_SWATCHES'
  ) as HTMLElement | null;
  const selectedSwatch = SwatchContainer
    ? SwatchContainer.querySelector('.script-manager-swatch.selected')
    : null;
  const colourIndex = selectedSwatch
    ? parseInt(selectedSwatch.getAttribute('data-colour-index') || '', 10)
    : 6;
  const timeoutSecondsRaw = Number($('#SCRIPT_MANAGER_FIELD_TIMEOUT_SECONDS').val());
  const timeoutSeconds =
    Number.isFinite(timeoutSecondsRaw) &&
    Number.isInteger(timeoutSecondsRaw) &&
    timeoutSecondsRaw >= 5
      ? timeoutSecondsRaw
      : 15;
  return {
    id: String($('#SCRIPT_MANAGER_FIELD_ID').val() || '').trim(),
    name: $('#SCRIPT_MANAGER_FIELD_NAME').val(),
    description: $('#SCRIPT_MANAGER_FIELD_DESCRIPTION').val(),
    colour: isNaN(colourIndex) ? 6 : colourIndex,
    icon: NormalizeIconName(ScriptManagerEditingIcon) || 'terminal',
    confirm: $('#SCRIPT_MANAGER_FIELD_CONFIRM').is(':checked'),
    timeoutMs: timeoutSeconds * 1000,
    enabled: $('#SCRIPT_MANAGER_FIELD_ENABLED').is(':checked'),
    platforms: Platforms,
    arguments: Arguments,
  };
}

export function RenderScriptManagerIssues(Title: string, Issues: string[], Kind: string) {
  const El = $('#SCRIPT_MANAGER_ISSUES');
  El.removeClass('d-none info error').addClass(Kind);
  const Items = (Issues || []).map((i) => `<li>${Safe(i)}</li>`).join('');
  El.html(
    `<div class="text-bold">${Safe(Title)}</div>${Items ? `<ul class="mb-0">${Items}</ul>` : ''}`
  );
}

export function HideScriptManagerIssues() {
  $('#SCRIPT_MANAGER_ISSUES').addClass('d-none').removeClass('info error').html('');
}

export async function SaveScriptManagerConfig() {
  if (!ScriptManagerEditingId) return;
  const ID = ScriptManagerEditingId;
  const Fields = CollectScriptManagerFields();
  const SaveBtn = $('#SCRIPT_MANAGER_SAVE');
  SaveBtn.prop('disabled', true);

  const [Err, Result] = await window.API.SaveScriptConfig(ID, Fields);
  SaveBtn.prop('disabled', false);
  if (ScriptManagerEditingId !== ID) return;

  if (Err) {
    const Issues = Result && Result.errors && Result.errors.length ? Result.errors : [Err];
    RenderScriptManagerIssues('Could not save — please fix the following:', Issues, 'error');
    Notify('Could not save script', 'error');
    return;
  }

  // The folder may have been renamed; track the final ID for further edits.
  // (The backend has already carried any existing whitelist across the rename,
  // so persisting the edited scope under FinalID below is correct.)
  const FinalID = (Result && Result.id) || ID;
  ScriptManagerEditingId = FinalID;

  // Persist the whitelist scope. parseScopeSelection collapses "All Clients"
  // (workspace) to Workspace:true, which the backend stores as the unrestricted
  // (no-row) default so new clients keep inheriting access.
  const [WhitelistErr] = await window.API.SetScriptWhitelist(
    FinalID,
    parseScopeSelection(ScriptWhitelistSelected)
  );
  if (WhitelistErr) {
    Notify(`Script saved, but the whitelist could not be saved: ${WhitelistErr}`, 'error');
  } else {
    Notify('Script saved', 'success');
  }

  await RefreshScriptManagerList();

  ShowScriptManagerList();
}

// Formerly a DOMContentLoaded handler; called by the bootstrap orchestrator in
// main.ts once the DOM is parsed — never at import time.
export function InitScriptManager() {
  // Each view carries the shared modal header. The list is top-level (title +
  // close); the templates and editor views add a Back to the list. Per-view
  // action buttons (New, Refresh, Open folder, Delete) live in the toolbar row
  // beneath each header and keep their own handlers below.
  $('#SCRIPT_MANAGER_LIST_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Script Manager',
        onClose: () => closeModal('SHOWTRAK_MODAL_SCRIPTMANAGER'),
      }).$el
    );
  $('#SCRIPT_MANAGER_TEMPLATES_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Create From Template',
        onBack: () => ShowScriptManagerList(),
        onClose: () => closeModal('SHOWTRAK_MODAL_SCRIPTMANAGER'),
      }).$el
    );
  $('#SCRIPT_MANAGER_EDITOR_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Script Editor',
        onBack: () => ShowScriptManagerList(),
        onClose: () => closeModal('SHOWTRAK_MODAL_SCRIPTMANAGER'),
      }).$el
    );

  $('#SCRIPT_MANAGER_CREATE')
    .off('click')
    .on('click', () => CreateBlankScript());

  $('#SCRIPT_MANAGER_CREATE_TEMPLATE')
    .off('click')
    .on('click', () => OpenScriptManagerTemplates());

  $('#SCRIPT_MANAGER_TEMPLATES_REFRESH')
    .off('click')
    .on('click', () => RefreshScriptManagerTemplates(true));

  $('#SCRIPT_MANAGER_OPEN_FOLDER')
    .off('click')
    .on('click', () => {
      if (ScriptManagerEditingId) window.API.OpenScriptFolder(ScriptManagerEditingId);
    });

  $('#SCRIPT_MANAGER_DELETE')
    .off('click')
    .on('click', async () => {
      if (!ScriptManagerEditingId) return;
      const ID = ScriptManagerEditingId;
      const Confirmed = await ConfirmationDialog(`Delete script "${ID}"? This cannot be undone.`);
      if (!Confirmed) return;
      const [Err] = await window.API.DeleteScript(ID);
      if (Err) {
        Notify(`Failed to delete script: ${Err}`, 'error');
        return;
      }
      Notify(`Script "${ID}" deleted`, 'success');
      ShowScriptManagerList();
      await RefreshScriptManagerList();
    });

  $('#SCRIPT_MANAGER_ICON_PREVIEW')
    .off('click')
    .on('click', async () => {
      // The picker records the Script Manager as the open modal and restores it
      // when it closes, so the operator returns to the editor either way.
      const Chosen = await OpenIconPicker(ScriptManagerEditingIcon);
      if (Chosen !== null) SetScriptManagerEditorIcon(Chosen);
    });

  $('#SCRIPT_MANAGER_SAVE')
    .off('click')
    .on('click', () => SaveScriptManagerConfig());

  $('#SCRIPT_MANAGER_REVERT')
    .off('click')
    .on('click', () => {
      // Reset the whitelist selection to what it was on open before re-rendering
      // (PopulateScriptManagerEditor renders the dropdown from ScriptWhitelistSelected).
      ScriptWhitelistSelected = ScriptWhitelistOriginal.slice();
      if (ScriptManagerOriginal) PopulateScriptManagerEditor(ScriptManagerOriginal);
      HideScriptManagerIssues();
    });

  // Wire the whitelist scope dropdown once; it targets the always-present
  // editor markup and reads/writes the module-level selection state.
  bindScopeDropdown(ScriptWhitelistConfig);

  // Drag-and-drop reordering within the list container.
  const ListContainer = document.getElementById('SCRIPT_MANAGER_LIST');
  if (ListContainer) {
    ListContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      const Dragging = ListContainer.querySelector('.script-manager-item.dragging');
      if (!Dragging) return;
      const After = ScriptManagerDragAfterElement(ListContainer, e.clientY);
      if (After == null) ListContainer.appendChild(Dragging);
      else ListContainer.insertBefore(Dragging, After);
    });
    ListContainer.addEventListener('drop', (e) => e.preventDefault());
  }
}
