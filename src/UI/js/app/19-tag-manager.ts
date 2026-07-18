import type { GroupView, TagView } from '@showtrak/protocol';
import { closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { HandleNonFatalError, Safe } from './04-utils';
import { CloseAllModals } from './11-modals';
import { ConfirmationDialog, Notify } from './14-selection-init';
import { NormalizeIconName, OpenIconPicker } from './18-icon-picker';
// Tags reuse the Scripts colour palette (index-based) and its swatch/icon CSS,
// so the palette + hex helper are imported rather than duplicated.
import { SCRIPT_COLOURS, ScriptColourHex } from './15-script-manager';
import {
  buildScopeModel,
  parseScopeSelection,
  scopeToSelectedValues,
  renderScopeDropdown,
  bindScopeDropdown,
} from './scope-dropdown';
import type { ScopeDropdownConfig } from './scope-dropdown';

// Tag Manager (desktop UI)
// - Lists every tag: a cross-cutting, colour+icon labelled collection of
//   clients (the slug doubles as the label). Unlike groups, a client may carry
//   any number of tags.
// - The editor edits the slug, colour, icon and — via the shared scope-dropdown
//   ("client selector") — the tag's dynamic membership scope. All client kinds
//   (real clients, monitoring targets, dummy clients) are taggable.

const DEFAULT_TAG_ICON = 'tag';

let TagManagerCache: TagView[] = [];
let TagManagerEditingId: number | null = null;
// Currently-selected icon in the editor (bare Bootstrap Icons name, no "bi-").
let TagManagerEditingIcon: string = DEFAULT_TAG_ICON;

// --- Tag scope ("client selector") editor state ----------------------------
// The membership picker reuses the shared scope-dropdown engine across every
// client kind. Selection is the flat value list; groups are cached at
// editor-open so BuildModel stays synchronous for the render/change handlers.
let TagScopeSelected: string[] = [];
let TagScopeOriginal: string[] = [];
let TagScopeGroups: GroupView[] = [];

const TagScopeConfig: ScopeDropdownConfig = {
  DropdownSelector: '#TAG_SCOPE_DROPDOWN',
  MenuSelector: '#TAG_SCOPE_MENU',
  ToggleSelector: '#TAG_SCOPE_TOGGLE',
  Namespace: 'tagScope',
  Placeholder: 'No clients',
  GetSelected: () => TagScopeSelected,
  SetSelected: (values) => {
    TagScopeSelected = values;
  },
  // Tags apply to every client kind (integrated clients included); only
  // monitoring *checks* are excluded since a check is not itself a client.
  BuildModel: () =>
    buildScopeModel({
      Groups: TagScopeGroups,
      IncludeKinds: ['showtrak', 'monitor', 'dummy'],
    }),
  ToggleRender: 'html',
};

export async function OpenTagManager() {
  await CloseAllModals();
  ShowTagManagerList();
  await RefreshTagManagerList();
  openModal('SHOWTRAK_MODAL_TAGMANAGER');
}

export function ShowTagManagerList() {
  TagManagerEditingId = null;
  $('#TAG_MANAGER_LIST_VIEW').removeClass('d-none');
  $('#TAG_MANAGER_EDITOR_VIEW').addClass('d-none');
}

export function ShowTagManagerEditor() {
  $('#TAG_MANAGER_LIST_VIEW').addClass('d-none');
  $('#TAG_MANAGER_EDITOR_VIEW').removeClass('d-none');
}

export async function RefreshTagManagerList() {
  try {
    TagManagerCache = (await window.API.GetAllTags()) || [];
  } catch (Err) {
    HandleNonFatalError('TagManager:List', Err);
    TagManagerCache = [];
  }
  RenderTagManagerList();
}

export function RenderTagManagerList() {
  const Container = document.getElementById('TAG_MANAGER_LIST') as HTMLElement;
  Container.innerHTML = '';

  if (!TagManagerCache.length) {
    Container.innerHTML =
      '<div class="p-3 rounded bg-ghost text-center text-muted">No tags yet. Create one to group clients across your show.</div>';
    return;
  }

  for (const Tag of TagManagerCache) {
    const IconName = NormalizeIconName(Tag.Icon) || DEFAULT_TAG_ICON;
    const Label = Tag.Slug || `Tag ${Tag.TagID}`;
    const MemberSummary = SummarizeTagScope(Tag);

    const Item = document.createElement('div');
    Item.className = 'script-manager-item p-3 rounded bg-ghost';
    Item.setAttribute('draggable', 'true');
    Item.setAttribute('data-tagid', String(Tag.TagID));
    Item.style.setProperty('--script-accent', ScriptColourHex(Tag.Colour));
    Item.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <span class="script-manager-grip" title="Drag to reorder"><i class="bi bi-grip-vertical"></i></span>
        <span class="script-manager-item-icon"><i class="bi bi-${Safe(IconName)}"></i></span>
        <div class="flex-grow-1 min-w-0">
          <div class="d-flex align-items-center">
            <span class="text-bold script-manager-item-name">${Safe(Label)}</span>
          </div>
          <div class="script-manager-item-desc">${Safe(MemberSummary)}</div>
        </div>
        <div class="d-flex align-items-center gap-2 flex-shrink-0">
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
      OpenTagManagerEditor(Tag.TagID);
    });

    Item.addEventListener('dragstart', (e) => {
      Item.classList.add('dragging');
      try {
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('text/plain', String(Tag.TagID));
      } catch {
        // Some platforms require setData; ignore failures.
      }
    });

    Item.addEventListener('dragend', async () => {
      Item.classList.remove('dragging');
      Item.dataset.dragged = '1';
      await PersistTagManagerOrder();
    });

    Container.appendChild(Item);
  }
}

// Short human description of a tag's membership scope for the list row.
function SummarizeTagScope(Tag: TagView): string {
  const Scope = Tag.Scope || { Workspace: false, Groups: [], Clients: [] };
  if (Scope.Workspace) return 'All clients';
  const Parts: string[] = [];
  const GroupCount = Array.isArray(Scope.Groups) ? Scope.Groups.length : 0;
  const ClientCount = Array.isArray(Scope.Clients) ? Scope.Clients.length : 0;
  if (GroupCount) Parts.push(`${GroupCount} group${GroupCount === 1 ? '' : 's'}`);
  if (ClientCount) Parts.push(`${ClientCount} client${ClientCount === 1 ? '' : 's'}`);
  return Parts.length ? Parts.join(' + ') : 'No clients';
}

export async function CreateTag() {
  const Btn = $('#TAG_MANAGER_CREATE');
  Btn.prop('disabled', true);
  const [Err, Tag] = await window.API.CreateTag();
  Btn.prop('disabled', false);
  if (Err || !Tag) {
    Notify(`Could not create tag: ${Err || 'unknown error'}`, 'error');
    return;
  }
  await RefreshTagManagerList();
  Notify('Tag created', 'success');
  OpenTagManagerEditor(Tag.TagID);
}

export async function PersistTagManagerOrder() {
  const Container = document.getElementById('TAG_MANAGER_LIST') as HTMLElement;
  const OrderedIDs = [...Container.querySelectorAll('.script-manager-item')]
    .map((el) => Number(el.getAttribute('data-tagid')))
    .filter((id) => Number.isInteger(id) && id > 0);
  const [Err] = await window.API.SetTagOrder(OrderedIDs);
  if (Err) Notify(`Failed to reorder tags: ${Err}`, 'error');
  await RefreshTagManagerList();
}

export async function OpenTagManagerEditor(TagID: number) {
  TagManagerEditingId = TagID;
  HideTagManagerIssues();
  ShowTagManagerEditor();

  // Refresh the cache so the editor reflects any concurrent changes, then find
  // the tag. A missing tag (deleted elsewhere) drops back to the list.
  await RefreshTagManagerList();
  if (TagManagerEditingId !== TagID) return;
  const Tag = TagManagerCache.find((T) => T.TagID === TagID);
  if (!Tag) {
    Notify('Tag no longer exists', 'error');
    ShowTagManagerList();
    return;
  }

  // Load the client-selector data: the current group list (for the tree) and
  // this tag's stored membership scope.
  const Groups = await window.API.GetAllGroups();
  if (TagManagerEditingId !== TagID) return;
  TagScopeGroups = Array.isArray(Groups) ? Groups : [];
  TagScopeSelected = scopeToSelectedValues(Tag.Scope || { Workspace: false, Groups: [], Clients: [] });
  TagScopeOriginal = TagScopeSelected.slice();

  PopulateTagManagerEditor(Tag);
}

export function PopulateTagManagerEditor(Tag: TagView) {
  $('#TAG_MANAGER_FIELD_SLUG').val(Tag.Slug || '');

  // Colour swatch picker.
  const SwatchContainer = document.getElementById('TAG_MANAGER_COLOUR_SWATCHES') as HTMLElement;
  SwatchContainer.innerHTML = '';
  const CurrentColour = typeof Tag.Colour === 'number' ? Tag.Colour : 6;
  SCRIPT_COLOURS.forEach((c, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'script-manager-swatch' + (idx === CurrentColour ? ' selected' : '');
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
  SetTagManagerEditorIcon(Tag.Icon);

  renderScopeDropdown(TagScopeConfig);
}

// Reflect the given icon name into the editor's preview + track it for save.
export function SetTagManagerEditorIcon(Icon: unknown) {
  const Name = NormalizeIconName(Icon) || DEFAULT_TAG_ICON;
  TagManagerEditingIcon = Name;
  const Preview = document.querySelector('#TAG_MANAGER_ICON_PREVIEW i');
  if (Preview) Preview.className = `bi bi-${Name}`;
  const PreviewButton = document.getElementById('TAG_MANAGER_ICON_PREVIEW');
  if (PreviewButton) PreviewButton.title = `Icon: ${Name} — click to change`;
}

function CollectTagManagerColour(): number {
  const SwatchContainer = document.getElementById('TAG_MANAGER_COLOUR_SWATCHES');
  const Selected = SwatchContainer
    ? SwatchContainer.querySelector('.script-manager-swatch.selected')
    : null;
  const Index = Selected ? parseInt(Selected.getAttribute('data-colour-index') || '', 10) : 6;
  return Number.isInteger(Index) ? Index : 6;
}

export function RenderTagManagerIssues(Title: string, Issues: string[]) {
  const El = $('#TAG_MANAGER_ISSUES');
  El.removeClass('d-none info error').addClass('error');
  const Items = (Issues || []).map((i) => `<li>${Safe(i)}</li>`).join('');
  El.html(
    `<div class="text-bold">${Safe(Title)}</div>${Items ? `<ul class="mb-0">${Items}</ul>` : ''}`
  );
}

export function HideTagManagerIssues() {
  $('#TAG_MANAGER_ISSUES').addClass('d-none').removeClass('info error').html('');
}

export async function SaveTagManagerConfig() {
  if (!TagManagerEditingId) return;
  const TagID = TagManagerEditingId;
  HideTagManagerIssues();

  const SaveBtn = $('#TAG_MANAGER_SAVE');
  SaveBtn.prop('disabled', true);

  // Slug first: it can be rejected (empty or colliding), in which case nothing
  // else is persisted and the reason is surfaced inline.
  const Slug = String($('#TAG_MANAGER_FIELD_SLUG').val() || '').trim();
  const [SlugErr] = await window.API.SetTagSlug(TagID, Slug);
  if (SlugErr) {
    SaveBtn.prop('disabled', false);
    if (TagManagerEditingId !== TagID) return;
    RenderTagManagerIssues('Could not save — please fix the following:', [SlugErr]);
    Notify('Could not save tag', 'error');
    return;
  }

  const [ColourErr] = await window.API.SetTagColour(TagID, CollectTagManagerColour());
  const [IconErr] = await window.API.SetTagIcon(
    TagID,
    NormalizeIconName(TagManagerEditingIcon) || DEFAULT_TAG_ICON
  );
  const [ScopeErr] = await window.API.SetTagScope(TagID, parseScopeSelection(TagScopeSelected));

  SaveBtn.prop('disabled', false);
  if (TagManagerEditingId !== TagID) return;

  const Errors = [ColourErr, IconErr, ScopeErr].filter(Boolean) as string[];
  if (Errors.length) {
    RenderTagManagerIssues('Tag partially saved — the following failed:', Errors);
    Notify('Tag could not be fully saved', 'error');
    return;
  }

  Notify('Tag saved', 'success');
  await RefreshTagManagerList();
  ShowTagManagerList();
}

// Called by the bootstrap orchestrator in main.ts once the DOM is parsed.
export function InitTagManager() {
  $('#TAG_MANAGER_LIST_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Tag Manager',
        onClose: () => closeModal('SHOWTRAK_MODAL_TAGMANAGER'),
      }).$el
    );
  $('#TAG_MANAGER_EDITOR_HEADER')
    .empty()
    .append(
      buildModalHeader({
        title: 'Tag Editor',
        onBack: () => ShowTagManagerList(),
        onClose: () => closeModal('SHOWTRAK_MODAL_TAGMANAGER'),
      }).$el
    );

  $('#TAG_MANAGER_CREATE')
    .off('click')
    .on('click', () => CreateTag());

  $('#TAG_MANAGER_DELETE')
    .off('click')
    .on('click', async () => {
      if (!TagManagerEditingId) return;
      const TagID = TagManagerEditingId;
      const Tag = TagManagerCache.find((T) => T.TagID === TagID);
      const Label = (Tag && Tag.Slug) || `Tag ${TagID}`;
      const Confirmed = await ConfirmationDialog(`Delete tag "${Label}"? This cannot be undone.`);
      if (!Confirmed) return;
      const [Err] = await window.API.DeleteTag(TagID);
      if (Err) {
        Notify(`Failed to delete tag: ${Err}`, 'error');
        return;
      }
      Notify(`Tag "${Label}" deleted`, 'success');
      ShowTagManagerList();
      await RefreshTagManagerList();
    });

  $('#TAG_MANAGER_ICON_PREVIEW')
    .off('click')
    .on('click', async () => {
      // The picker records the Tag Manager as the open modal and restores it
      // when it closes, so the operator returns to the editor either way.
      const Chosen = await OpenIconPicker(TagManagerEditingIcon);
      if (Chosen !== null) SetTagManagerEditorIcon(Chosen);
    });

  $('#TAG_MANAGER_SAVE')
    .off('click')
    .on('click', () => SaveTagManagerConfig());

  $('#TAG_MANAGER_REVERT')
    .off('click')
    .on('click', () => {
      TagScopeSelected = TagScopeOriginal.slice();
      const Tag = TagManagerEditingId
        ? TagManagerCache.find((T) => T.TagID === TagManagerEditingId)
        : null;
      if (Tag) PopulateTagManagerEditor(Tag);
      HideTagManagerIssues();
    });

  // Wire the client-selector dropdown once; it targets the always-present
  // editor markup and reads/writes the module-level selection state.
  bindScopeDropdown(TagScopeConfig);

  // Drag-and-drop reordering within the list container.
  const ListContainer = document.getElementById('TAG_MANAGER_LIST');
  if (ListContainer) {
    ListContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      const Dragging = ListContainer.querySelector('.script-manager-item.dragging');
      if (!Dragging) return;
      const After = TagManagerDragAfterElement(ListContainer, e.clientY);
      if (After == null) ListContainer.appendChild(Dragging);
      else ListContainer.insertBefore(Dragging, After);
    });
    ListContainer.addEventListener('drop', (e) => e.preventDefault());
  }
}

// Find the item the dragged element should be inserted before, based on cursor Y.
function TagManagerDragAfterElement(Container: HTMLElement, Y: number) {
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
