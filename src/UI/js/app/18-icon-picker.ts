import { closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { HandleNonFatalError } from './04-utils';
import { Wait } from './14-selection-init';

// Reusable Bootstrap Icons picker.
// -----------------------------------------------------------------------------
// Opens a modal with a searchable grid of every Bootstrap icon and resolves
// with the chosen icon name (without the "bi-" prefix), or null if cancelled.
//
// Designed to be reused anywhere a selectable icon is needed (scripts today,
// groups/other entities later). Call it as:
//
//   const Icon = await OpenIconPicker(CurrentIcon);
//   if (Icon !== null) { ... }  // null means the user cancelled / closed it
//
// "Remembering the screen you were in": before opening, it records which modal
// (if any) is currently visible, hides it, and restores it once the picker
// closes — so opening the picker from inside the Script Manager (or any other
// modal) returns the operator exactly where they were.

// Normalize any icon reference ("bi bi-terminal", "bi-terminal", "terminal")
// down to the bare icon name. Returns '' when unusable.
export function NormalizeIconName(Value: unknown): string {
  if (typeof Value !== 'string') return '';
  let Name = Value.trim().toLowerCase();
  if (!Name) return '';
  Name = Name.replace(/^bi\s+/, '').replace(/^bi-/, '');
  if (!/^[a-z0-9-]+$/.test(Name)) return '';
  return Name;
}

// Cache of icon names, loaded once from the served bootstrap-icons manifest.
let IconNameCache: string[] | null = null;

// Load and cache the list of every Bootstrap icon name. The manifest is a
// served static asset (copied into vendors/ by the postinstall script) mapping
// "icon-name" -> codepoint; we only need the keys.
async function LoadIconNames(): Promise<string[]> {
  if (IconNameCache) return IconNameCache;
  try {
    const Response = await fetch('./vendors/bootstrap-icons/font/bootstrap-icons.json');
    if (!Response.ok) throw new Error(`HTTP ${Response.status}`);
    const Manifest = await Response.json();
    IconNameCache = Object.keys(Manifest || {}).sort((a, b) => a.localeCompare(b));
  } catch (Err) {
    HandleNonFatalError('IconPicker:LoadManifest', Err);
    IconNameCache = [];
  }
  return IconNameCache;
}

// State for the currently-open picker session.
let IconPickerResolve: ((value: string | null) => void) | null = null;
let IconPickerSelected: string | null = null;
let IconPickerRestoreModalId: string | null = null;
let IconPickerAllIcons: string[] = [];

// Cap how many tiles we render at once. The full set (~2000 icons) renders fine,
// but keeping a ceiling makes filtering snappy and avoids a huge DOM when the
// search box is empty.
const ICON_PICKER_RENDER_LIMIT = 400;

// Record which modal is currently visible so we can restore it on close.
function CaptureCurrentModal(): string | null {
  const Open = document.querySelector('.modal.show');
  return Open && Open.id ? Open.id : null;
}

function RenderIconGrid(Filter: string) {
  const Grid = document.getElementById('ICON_PICKER_GRID');
  if (!Grid) return;

  const Needle =
    NormalizeIconName(Filter) ||
    String(Filter || '')
      .trim()
      .toLowerCase();
  const Matches = Needle
    ? IconPickerAllIcons.filter((Name) => Name.includes(Needle))
    : IconPickerAllIcons;

  const Shown = Matches.slice(0, ICON_PICKER_RENDER_LIMIT);

  Grid.innerHTML = '';
  const Fragment = document.createDocumentFragment();
  for (const Name of Shown) {
    const Button = document.createElement('button');
    Button.type = 'button';
    Button.className = 'icon-picker-tile' + (Name === IconPickerSelected ? ' selected' : '');
    Button.title = Name;
    Button.setAttribute('data-icon-name', Name);
    Button.innerHTML = `<i class="bi bi-${Name}"></i><span class="icon-picker-tile-label">${Name}</span>`;
    Fragment.appendChild(Button);
  }
  Grid.appendChild(Fragment);
}

// Finish the picker session: hide the modal, restore the previous one, and
// resolve the promise with the chosen icon (or null when cancelled).
async function CloseIconPicker(Result: string | null) {
  const Resolve = IconPickerResolve;
  const RestoreId = IconPickerRestoreModalId;
  IconPickerResolve = null;
  IconPickerRestoreModalId = null;

  closeModal('SHOWTRAK_MODAL_ICONPICKER');
  await Wait(300);

  // Restore the screen the operator was on before opening the picker.
  if (RestoreId) {
    openModal(RestoreId);
  }

  if (Resolve) Resolve(Result);
}

// Open the icon picker. Resolves with the chosen icon name (no "bi-" prefix),
// or null if the operator cancelled / dismissed it without choosing.
export async function OpenIconPicker(CurrentIcon: unknown = null): Promise<string | null> {
  // If a previous session is somehow still open, resolve it as cancelled first.
  if (IconPickerResolve) {
    const Stale = IconPickerResolve;
    IconPickerResolve = null;
    Stale(null);
  }

  IconPickerAllIcons = await LoadIconNames();
  IconPickerSelected = NormalizeIconName(CurrentIcon) || null;

  // Remember (and hide) whatever modal is currently open so we can restore it.
  IconPickerRestoreModalId = CaptureCurrentModal();
  if (IconPickerRestoreModalId) {
    closeModal(IconPickerRestoreModalId);
    await Wait(300);
  }

  const SearchInput = document.getElementById('ICON_PICKER_SEARCH') as HTMLInputElement | null;
  if (SearchInput) SearchInput.value = '';
  RenderIconGrid('');

  openModal('SHOWTRAK_MODAL_ICONPICKER');
  if (SearchInput) setTimeout(() => SearchInput.focus(), 200);

  return new Promise<string | null>((Resolve) => {
    IconPickerResolve = Resolve;
  });
}

// Formerly a DOMContentLoaded handler; called by the bootstrap orchestrator in
// main.ts once the DOM is parsed — never at import time.
export function InitIconPicker() {
  const SearchInput = document.getElementById('ICON_PICKER_SEARCH') as HTMLInputElement | null;
  if (SearchInput) {
    SearchInput.addEventListener('input', () => RenderIconGrid(SearchInput.value));
  }

  // Clicking an icon confirms it immediately.
  const Grid = document.getElementById('ICON_PICKER_GRID');
  if (Grid) {
    Grid.addEventListener('click', (Event) => {
      const Target = Event.target as Element | null;
      const Tile =
        Target && Target.closest
          ? (Target.closest('.icon-picker-tile') as HTMLElement | null)
          : null;
      if (!Tile) return;
      const Name = Tile.getAttribute('data-icon-name');
      if (Name) CloseIconPicker(Name);
    });
  }

  // Back and close both cancel the picker (and restore the previous screen).
  $('#ICON_PICKER_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Choose an Icon',
        titleId: 'SHOWTRAK_MODAL_ICONPICKER_Label',
        onBack: () => CloseIconPicker(null),
        onClose: () => CloseIconPicker(null),
      }).$el
    );

  // Bootstrap fires this when the modal is dismissed via the backdrop / Esc key;
  // treat that as a cancel and restore the previous screen. Guard on an active
  // session so our own programmatic hide (in CloseIconPicker) doesn't re-enter.
  $('#SHOWTRAK_MODAL_ICONPICKER').on('hidden.bs.modal', () => {
    if (!IconPickerResolve) return;
    const Resolve = IconPickerResolve;
    const RestoreId = IconPickerRestoreModalId;
    IconPickerResolve = null;
    IconPickerRestoreModalId = null;
    if (RestoreId) openModal(RestoreId);
    Resolve(null);
  });
}
