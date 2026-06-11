// Script Manager (desktop UI)
// - Lists every script discovered in the scripts folder, showing its ID,
//   validity, and the operating systems it has scripts configured for.
// - Supports drag-and-drop reordering of scripts (persisted as Weight).
// - Lets the operator edit each script's configuration via structured fields.
//   Missing/invalid keys are repaired automatically on save by the backend.

// Platform display metadata, in preferred display order.
const SCRIPT_MANAGER_PLATFORMS = [
  { key: 'Windows', icon: 'bi-windows', label: 'Windows' },
  { key: 'macOS', icon: 'bi-apple', label: 'macOS' },
  { key: 'Linux', icon: 'bi-ubuntu', label: 'Linux' },
];

// Colour palette – order matches SCRIPT_COLOURS in schema.js.
// 0-5 rainbow, 6-7 greys.
const SCRIPT_COLOURS = [
  { hex: '#e74c3c', label: 'Red' },
  { hex: '#e67e22', label: 'Orange' },
  { hex: '#f1c40f', label: 'Yellow' },
  { hex: '#2ecc71', label: 'Green' },
  { hex: '#3498db', label: 'Blue' },
  { hex: '#9b59b6', label: 'Purple' },
  { hex: '#bdc3c7', label: 'Light grey' },
  { hex: '#7f8c8d', label: 'Dark grey' },
];

function ScriptColourHex(Index) {
  const entry = SCRIPT_COLOURS[Index];
  return entry ? entry.hex : SCRIPT_COLOURS[6].hex;
}

let ScriptManagerCache = [];
let ScriptManagerEditingId = null;
let ScriptManagerOriginal = null;
let ScriptManagerEditingFiles = [];
let ScriptManagerSampleCache = [];

function GetScriptManagerPlatformKey() {
  const ua = String(navigator.userAgent || '').toLowerCase();
  const platform = String(navigator.platform || '').toLowerCase();
  if (platform.includes('win') || ua.includes('windows')) return 'Windows';
  if (platform.includes('mac') || ua.includes('mac os')) return 'macOS';
  return 'Linux';
}

function NormalizeScriptManagerPath(Value) {
  return String(Value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function GetMappedExecutableForCurrentPlatform() {
  const PlatformKey = GetScriptManagerPlatformKey();
  const Row = document.querySelector(
    `#SCRIPT_MANAGER_PLATFORMS .script-manager-platform-row[data-platform="${PlatformKey}"]`
  );
  if (!Row) return '';
  const Select = Row.querySelector('.script-manager-platform-select');
  if (!Select) return '';
  return NormalizeScriptManagerPath(Select.value || '');
}

async function OpenScriptManager() {
  await CloseAllModals();
  ShowScriptManagerList();
  await RefreshScriptManagerList();
  $('#SHOWTRAK_MODAL_SCRIPTMANAGER').modal('show');
}

function ShowScriptManagerList() {
  ScriptManagerEditingId = null;
  $('#SCRIPT_MANAGER_LIST_VIEW').removeClass('d-none');
  $('#SCRIPT_MANAGER_EDITOR_VIEW').addClass('d-none');
  $('#SCRIPT_MANAGER_TEMPLATES_VIEW').addClass('d-none');
}

function ShowScriptManagerEditor() {
  $('#SCRIPT_MANAGER_LIST_VIEW').addClass('d-none');
  $('#SCRIPT_MANAGER_EDITOR_VIEW').removeClass('d-none');
  $('#SCRIPT_MANAGER_TEMPLATES_VIEW').addClass('d-none');
}

function ShowScriptManagerTemplates() {
  $('#SCRIPT_MANAGER_LIST_VIEW').addClass('d-none');
  $('#SCRIPT_MANAGER_EDITOR_VIEW').addClass('d-none');
  $('#SCRIPT_MANAGER_TEMPLATES_VIEW').removeClass('d-none');
}

async function RefreshScriptManagerList() {
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
function ScriptManagerIDError(ID) {
  const Trimmed = String(ID || '').trim();
  if (!Trimmed) return 'ID is required';
  if (/\s/.test(Trimmed)) return 'ID cannot contain spaces';
  if (!/^[A-Za-z0-9]+$/.test(Trimmed)) return 'ID can only contain letters and numbers';
  const Taken = ScriptManagerCache.some(
    (s) => String(s.id).toLowerCase() === Trimmed.toLowerCase()
  );
  if (Taken) return 'A script with this ID already exists';
  return null;
}

// Create a brand new blank script and open it in the editor.
async function CreateBlankScript() {
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

async function OpenScriptManagerTemplates() {
  ShowScriptManagerTemplates();
  const Container = document.getElementById('SCRIPT_MANAGER_TEMPLATES_LIST');
  Container.innerHTML =
    '<div class="p-3 rounded bg-ghost text-center text-muted">Loading sample scripts…</div>';
  await RefreshScriptManagerTemplates(false);
}

async function RefreshScriptManagerTemplates(Force) {
  try {
    const [Err, List] = Force
      ? await window.API.RefreshSampleScripts()
      : await window.API.GetSampleScripts();
    if (Err) {
      Notify(`Could not load sample scripts: ${Err}`, 'error');
      ScriptManagerSampleCache = ScriptManagerSampleCache || [];
    } else {
      ScriptManagerSampleCache = List || [];
    }
  } catch (Err) {
    HandleNonFatalError('ScriptManager:Templates', Err);
    ScriptManagerSampleCache = [];
  }
  RenderScriptManagerTemplates();
}

function GenerateTemplatePlaceholderID() {
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

async function CreateScriptFromTemplateWithGeneratedID(SampleID) {
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

function RenderScriptManagerTemplates() {
  const Container = document.getElementById('SCRIPT_MANAGER_TEMPLATES_LIST');
  Container.innerHTML = '';

  if (!ScriptManagerSampleCache.length) {
    Container.innerHTML =
      '<div class="p-3 rounded bg-ghost text-center text-muted">No sample scripts available. Check your internet connection and try refreshing.</div>';
    return;
  }

  for (const Sample of ScriptManagerSampleCache) {
    const OSChips = RenderScriptManagerOSChips({
      platforms: Sample.platforms || {},
      compatiblePlatforms: SCRIPT_MANAGER_PLATFORMS
        .filter((p) => Sample.platforms && String(Sample.platforms[p.key] || '').trim())
        .map((p) => p.key),
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

    const CreateBtn = Item.querySelector('.script-manager-template-create');
    const Hint = Item.querySelector('.script-manager-template-hint');

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
      const NewID = Result && Result.id;
      await RefreshScriptManagerList();
      Notify(`Script "${NewID}" created from template`, 'success');
      OpenScriptManagerEditor(NewID);
    });

    Container.appendChild(Item);
  }
}

// Pick a Bootstrap icon for a file based on its extension.
function ScriptManagerFileIcon(FilePath) {
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

function RenderScriptManagerOSChips(Script) {
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

function RenderScriptManagerList() {
  // Preserve the saved order (Weight), tie-breaking on ID for stability.
  const List = ScriptManagerCache.slice().sort((a, b) => {
    const wa = a.weight || 0;
    const wb = b.weight || 0;
    if (wa !== wb) return wa - wb;
    return String(a.id).localeCompare(String(b.id));
  });
  const Container = document.getElementById('SCRIPT_MANAGER_LIST');
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

    const DisabledClass = (Script.valid && !Script.enabled) ? ' script-manager-item-disabled' : '';

    const Item = document.createElement('div');
    Item.className = `script-manager-item p-3 rounded bg-ghost${Script.valid ? '' : ' script-manager-item-invalid'}${DisabledClass}`;
    Item.setAttribute('draggable', 'true');
    Item.setAttribute('data-scriptid', Script.id);
    const AccentColour = ScriptColourHex(Script.colour);
    Item.style.setProperty('--script-accent', AccentColour);
    Item.innerHTML = `
      <div class="script-manager-accent-strip"></div>
      <div class="d-flex align-items-center gap-2">
        <span class="script-manager-grip" title="Drag to reorder"><i class="bi bi-grip-vertical"></i></span>
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
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', Script.id);
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
function ScriptManagerDragAfterElement(Container, Y) {
  const Items = [...Container.querySelectorAll('.script-manager-item:not(.dragging)')];
  let Closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const Child of Items) {
    const Box = Child.getBoundingClientRect();
    const Offset = Y - Box.top - Box.height / 2;
    if (Offset < 0 && Offset > Closest.offset) {
      Closest = { offset: Offset, element: Child };
    }
  }
  return Closest.element;
}

async function PersistScriptManagerOrder() {
  const Container = document.getElementById('SCRIPT_MANAGER_LIST');
  const OrderedIDs = [...Container.querySelectorAll('.script-manager-item')].map((el) =>
    el.getAttribute('data-scriptid')
  );
  const [Err] = await window.API.SetScriptOrder(OrderedIDs);
  if (Err) {
    Notify(`Failed to reorder scripts: ${Err}`, 'error');
  }
  await RefreshScriptManagerList();
}

async function OpenScriptManagerEditor(ID) {
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
  PopulateScriptManagerEditor(Data);
}

function PopulateScriptManagerEditor(Data) {
  $('#SCRIPT_MANAGER_FIELD_ID').val(Data.id || '');
  $('#SCRIPT_MANAGER_FIELD_NAME').val(Data.name || '');
  $('#SCRIPT_MANAGER_FIELD_DESCRIPTION').val(Data.description || '');

  // Colour swatch picker.
  const SwatchContainer = document.getElementById('SCRIPT_MANAGER_COLOUR_SWATCHES');
  SwatchContainer.innerHTML = '';
  const currentColour = typeof Data.colour === 'number' ? Data.colour : 6;
  SCRIPT_COLOURS.forEach((c, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'script-manager-swatch' + (idx === currentColour ? ' selected' : '');
    btn.title = c.label;
    btn.style.background = c.hex;
    btn.setAttribute('data-colour-index', idx);
    btn.addEventListener('click', () => {
      SwatchContainer.querySelectorAll('.script-manager-swatch').forEach((s) =>
        s.classList.remove('selected')
      );
      btn.classList.add('selected');
    });
    SwatchContainer.appendChild(btn);
  });

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
}

function RenderScriptManagerPlatforms(Platforms, Arguments) {
  const Container = $('#SCRIPT_MANAGER_PLATFORMS');
  Container.html('');
  for (const Platform of SCRIPT_MANAGER_PLATFORMS) {
    const Selected = typeof Platforms[Platform.key] === 'string' ? Platforms[Platform.key] : '';
    const ArgumentValue = typeof Arguments[Platform.key] === 'string' ? Arguments[Platform.key] : '';

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

function RenderScriptManagerFileList(Files) {
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

  Container
    .find('.script-manager-file-edit-btn')
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

  Container
    .find('.script-manager-file-run-btn')
    .off('click')
    .on('click', async function (Event) {
      Event.preventDefault();
      Event.stopPropagation();
      if (!ScriptManagerEditingId) return;

      const EncodedFile = $(this).attr('data-file') || '';
      const RelativeFilePath = decodeURIComponent(EncodedFile);
      const Confirmed = await ConfirmationDialog(
        `Run ${RelativeFilePath} on this machine now?`
      );
      if (!Confirmed) return;

      const [Err] = await window.API.RunScriptFileLocal(ScriptManagerEditingId, RelativeFilePath);
      if (Err) {
        Notify(`Could not run file: ${Err}`, 'error');
        return;
      }
      Notify(`Completed ${RelativeFilePath}`, 'success');
    });
}

function CollectScriptManagerFields() {
  const Platforms = {};
  const Arguments = {};
  $('#SCRIPT_MANAGER_PLATFORMS .script-manager-platform-row').each(function () {
    const Key = $(this).attr('data-platform');
    Platforms[Key] = $(this).find('.script-manager-platform-select').val() || '';
    Arguments[Key] = String($(this).find('.script-manager-platform-args').val() || '').trim();
  });
  const SwatchContainer = document.getElementById('SCRIPT_MANAGER_COLOUR_SWATCHES');
  const selectedSwatch = SwatchContainer
    ? SwatchContainer.querySelector('.script-manager-swatch.selected')
    : null;
  const colourIndex = selectedSwatch
    ? parseInt(selectedSwatch.getAttribute('data-colour-index'), 10)
    : 6;
  const timeoutSecondsRaw = Number($('#SCRIPT_MANAGER_FIELD_TIMEOUT_SECONDS').val());
  const timeoutSeconds =
    Number.isFinite(timeoutSecondsRaw) && Number.isInteger(timeoutSecondsRaw) && timeoutSecondsRaw >= 5
      ? timeoutSecondsRaw
      : 15;
  return {
    id: String($('#SCRIPT_MANAGER_FIELD_ID').val() || '').trim(),
    name: $('#SCRIPT_MANAGER_FIELD_NAME').val(),
    description: $('#SCRIPT_MANAGER_FIELD_DESCRIPTION').val(),
    colour: isNaN(colourIndex) ? 6 : colourIndex,
    confirm: $('#SCRIPT_MANAGER_FIELD_CONFIRM').is(':checked'),
    timeoutMs: timeoutSeconds * 1000,
    enabled: $('#SCRIPT_MANAGER_FIELD_ENABLED').is(':checked'),
    platforms: Platforms,
    arguments: Arguments,
  };
}

function RenderScriptManagerIssues(Title, Issues, Kind) {
  const El = $('#SCRIPT_MANAGER_ISSUES');
  El.removeClass('d-none info error').addClass(Kind);
  const Items = (Issues || []).map((i) => `<li>${Safe(i)}</li>`).join('');
  El.html(
    `<div class="text-bold">${Safe(Title)}</div>${Items ? `<ul class="mb-0">${Items}</ul>` : ''}`
  );
}

function HideScriptManagerIssues() {
  $('#SCRIPT_MANAGER_ISSUES').addClass('d-none').removeClass('info error').html('');
}

async function SaveScriptManagerConfig() {
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

  Notify('Script saved', 'success');

  // The folder may have been renamed; track the final ID for further edits.
  const FinalID = (Result && Result.id) || ID;
  ScriptManagerEditingId = FinalID;

  await RefreshScriptManagerList();

  ShowScriptManagerList();
}

document.addEventListener('DOMContentLoaded', () => {
  $('#SCRIPT_MANAGER_BACK')
    .off('click')
    .on('click', () => ShowScriptManagerList());

  $('#SCRIPT_MANAGER_CREATE')
    .off('click')
    .on('click', () => CreateBlankScript());

  $('#SCRIPT_MANAGER_CREATE_TEMPLATE')
    .off('click')
    .on('click', () => OpenScriptManagerTemplates());

  $('#SCRIPT_MANAGER_TEMPLATES_BACK')
    .off('click')
    .on('click', () => ShowScriptManagerList());

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
      const Confirmed = await ConfirmationDialog(
        `Delete script "${ID}"? This cannot be undone.`
      );
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

  $('#SCRIPT_MANAGER_SAVE')
    .off('click')
    .on('click', () => SaveScriptManagerConfig());

  $('#SCRIPT_MANAGER_REVERT')
    .off('click')
    .on('click', () => {
      if (ScriptManagerOriginal) PopulateScriptManagerEditor(ScriptManagerOriginal);
      HideScriptManagerIssues();
    });

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
});
