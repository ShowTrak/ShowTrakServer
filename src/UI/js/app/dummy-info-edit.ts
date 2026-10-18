// A dummy client's Settings tab: its view modal doubling as its editor, as a
// ShowTrak Client's Info tab (client-info-edit.ts) and a monitor's Settings tab
// (monitor-info-edit.ts) do.
//
// Show mode renders the ID (its slug), title, group, heartbeat interval and
// tags read-only. Edit mode makes them editable in place, flipping live when
// the mode changes, and adds Delete Dummy Client.
//
// The save model is the old dummy editor's: the fields commit together on the
// footer Save, which lights up once something has changed; tags apply as they
// are clicked. Leaving Edit mode with unsaved changes discards them, so the
// read-only view always shows what is saved.
import type { DummyClientView, GroupView } from '@showtrak/protocol';
import { AppMode, Capabilities, DummyClients } from './state';
import { HandleNonFatalError, Safe } from './utils';
import { ConfirmationDialog, Notify } from './selection-init';
import { ClearTagPicker, RenderReadOnlyTagChips, RenderTagPicker } from './tag-picker';
import type { TagPickerMount } from './tag-picker';
import { CloseAllModals } from './modals';
import { FormatInterval } from './lib/monitor-format';
import { IsClientInfoEditable } from './lib/client-info-edit';
import { BuildDummyPayload, DummySettingsDraftChanged } from './lib/dummy-settings';
import type { DummySettingsDraft } from './lib/dummy-settings';

const MODAL_ID = 'SHOWTRAK_CLIENT_INFO';
// Shared with the other view-modal editors: whichever entity is mounted owns it.
const EDITING_CLASS = 'is-editing';
const DEFAULT_INTERVAL_MS = 30000;

const DUMMY_INFO_TAG_PICKER: TagPickerMount = {
  WrapperSelector: '#DUMMY_INFO_TAG_PICKER_WRAPPER',
  ListSelector: '#DUMMY_INFO_TAG_PICKER',
  Namespace: 'dummyInfoTags',
};

interface MountedDummy {
  UUID: string;
  Dummy: DummyClientView;
  Groups: GroupView[];
  /** The form as it was last populated; Save is offered once it differs. */
  Baseline: DummySettingsDraft | null;
}

let Mounted: MountedDummy | null = null;
let Editing = false;
let Bound = false;
let MountToken = 0;

function CanEdit(): boolean {
  return (
    !!Mounted &&
    IsClientInfoEditable({
      AppMode,
      CanManage: Capabilities.canManageMonitoring,
      Kind: 'dummy',
    })
  );
}

function IntervalOf(Dummy: DummyClientView): number {
  return Number(Dummy.Interval) || DEFAULT_INTERVAL_MS;
}

// --- Mounting ----------------------------------------------------------------

/** Take over the view modal's Settings tab for this dummy client. */
export async function MountDummyInfoEditor(UUID: string): Promise<void> {
  EnsureBound();
  const Token = ++MountToken;
  const Dummy = DummyClients.find((Entry) => String(Entry.UUID) === String(UUID));
  if (!Dummy) return;
  let Groups: GroupView[] = [];
  try {
    const Loaded = await window.API.GetAllGroups();
    Groups = Array.isArray(Loaded) ? Loaded : [];
  } catch (err) {
    HandleNonFatalError('DummyInfoEdit:LoadGroups', err);
  }
  if (Token !== MountToken) return;

  Mounted = { UUID: String(UUID), Dummy, Groups, Baseline: null };
  Editing = CanEdit();
  $(`#${MODAL_ID}`).toggleClass(EDITING_CLASS, Editing);
  $('#CLIENT_INFO_SAVE').removeClass('d-none');
  PopulateForm();
  RenderReadOnlyFields();
  RenderTags();
}

/** Forget the mounted dummy; the modal reverts to plain read-only. */
export function UnmountDummyInfoEditor(): void {
  if (!Mounted) return;
  MountToken++;
  ClearTagPicker();
  Mounted = null;
  Editing = false;
  $(`#${MODAL_ID}`).removeClass(EDITING_CLASS);
  $('#CLIENT_INFO_SAVE').prop('disabled', true).addClass('d-none');
}

/** Re-evaluate Show/Edit on a mode change; the tab flips in place. */
export function ApplyDummyInfoEditMode(): void {
  if (!Mounted) return;
  const Next = CanEdit();
  if (Next === Editing) return;
  if (!Next && HasUnsavedChanges()) {
    void Notify('Discarded unsaved changes to this dummy client.', 'warning');
  }
  Editing = Next;
  $(`#${MODAL_ID}`).toggleClass(EDITING_CLASS, Editing);
  PopulateForm();
  RenderReadOnlyFields();
  RenderTags();
}

/** A fresh copy of a dummy (live push). Never touches a field being edited. */
export function RefreshDummyInfoEditor(Dummy: DummyClientView): void {
  if (!Mounted || String(Dummy.UUID) !== Mounted.UUID) return;
  Mounted.Dummy = Dummy;
  if (!Editing) PopulateForm();
  RenderReadOnlyFields();
  if (!Editing) RenderTags();
}

/** After a tag push: the read-only chips (the picker redraws itself). */
export function RefreshDummyInfoTags(): void {
  if (Mounted && !Editing) RenderTags();
}

function EnsureBound(): void {
  if (Bound) return;
  Bound = true;
  const $Modal = $(`#${MODAL_ID}`);

  // `hide`, not `hidden`, for the reason given in client-info-edit.ts.
  $Modal.on('hide.bs.modal.dummyInfoEdit', (Event) => {
    if (Event.target === $Modal[0]) UnmountDummyInfoEditor();
  });

  $('#DUMMY_INFO_SETTINGS_SECTION').on('input change', '.di-draft', function () {
    if (this.id === 'DUMMY_INFO_INTERVAL') {
      $('#DUMMY_INFO_INTERVAL_LABEL').text(FormatInterval($(this).val()));
    }
    UpdateSaveButton();
  });
  // Moving the dummy to another group changes which tags it inherits, so the
  // picker re-derives from the selection rather than waiting for Save.
  $('#DUMMY_INFO_GROUP_SELECT').on('change', () => RenderTags());

  // The footer Save is shared with a client's Info tab; each editor answers it
  // only while its own entity is mounted.
  $('#CLIENT_INFO_SAVE').on('click.dummyInfoEdit', () => void SaveDummySettings());
  $('#DUMMY_INFO_DELETE').on('click', () => void DeleteDummy());
}

// --- Form ----------------------------------------------------------------------

function PopulateForm(): void {
  if (!Mounted) return;
  const { Dummy, Groups } = Mounted;
  $('#DUMMY_INFO_ID').val(Dummy.DummyID || '');
  $('#DUMMY_INFO_TITLE').val(Dummy.Nickname || '');
  $('#DUMMY_INFO_ID, #DUMMY_INFO_TITLE')
    .prop('disabled', !Editing)
    .toggleClass('disabled', !Editing);

  let Options = '';
  for (const Group of Groups) {
    const Selected = Dummy.GroupID === Group.GroupID ? 'selected' : '';
    Options += `<option value="${Safe(Group.GroupID)}" ${Selected}>${Safe(Group.Title)}</option>`;
  }
  Options += `<option value="null" ${Dummy.GroupID == null ? 'selected' : ''}>No Group</option>`;
  $('#DUMMY_INFO_GROUP_SELECT').html(Options);

  const Interval = IntervalOf(Dummy);
  $('#DUMMY_INFO_INTERVAL').val(String(Interval));
  $('#DUMMY_INFO_INTERVAL_LABEL').text(FormatInterval(Interval));

  Mounted.Baseline = CollectDraft();
  UpdateSaveButton();
}

function RenderReadOnlyFields(): void {
  if (!Mounted) return;
  const { Dummy, Groups } = Mounted;
  const Group = Groups.find((Entry) => Entry && Entry.GroupID === Dummy.GroupID);
  $('#DUMMY_INFO_GROUP').val(Group && Group.Title ? Group.Title : 'No Group');
  $('#DUMMY_INFO_INTERVAL_VIEW').val(FormatInterval(IntervalOf(Dummy)));
}

function CollectDraft(): DummySettingsDraft {
  return {
    DummyID: String($('#DUMMY_INFO_ID').val() || ''),
    Nickname: String($('#DUMMY_INFO_TITLE').val() || ''),
    GroupID: String($('#DUMMY_INFO_GROUP_SELECT').val() ?? ''),
    Interval: String($('#DUMMY_INFO_INTERVAL').val() ?? ''),
  };
}

function HasUnsavedChanges(): boolean {
  return !!Mounted && Editing && DummySettingsDraftChanged(Mounted.Baseline, CollectDraft());
}

function UpdateSaveButton(): void {
  if (!Mounted) return;
  $('#CLIENT_INFO_SAVE').prop('disabled', !HasUnsavedChanges());
}

async function SaveDummySettings(): Promise<void> {
  if (!Mounted || !Editing) return;
  const UUID = Mounted.UUID;
  const { Payload, Error } = BuildDummyPayload(CollectDraft());
  if (!Payload) {
    await Notify(Error, 'error');
    return;
  }
  $('#CLIENT_INFO_SAVE').prop('disabled', true);
  const [Err, Updated] = await window.API.UpdateDummyClient(UUID, Payload);
  if (Err) {
    // The form keeps everything typed, so the operator can correct and retry.
    await Notify(Err, 'error');
    UpdateSaveButton();
    return;
  }
  await Notify('Dummy client updated.', 'success');
  if (!Mounted || Mounted.UUID !== UUID) return;
  if (Updated) Mounted.Dummy = Updated;
  PopulateForm();
  RenderReadOnlyFields();
}

// --- Tags ----------------------------------------------------------------------

function SelectedGroupID(): number | null {
  const Raw = String($('#DUMMY_INFO_GROUP_SELECT').val() ?? '');
  const Parsed = Raw === '' || Raw === 'null' ? NaN : parseInt(Raw, 10);
  return Number.isFinite(Parsed) ? Parsed : null;
}

function RenderTags(): void {
  if (!Mounted) return;
  // Dummies are scoped by their bare UUID, like ShowTrak clients.
  const ScopedID = Mounted.UUID;
  if (Editing) {
    RenderTagPicker(DUMMY_INFO_TAG_PICKER, { ScopedID, GroupID: SelectedGroupID() });
    return;
  }
  ClearTagPicker();
  const Chips = RenderReadOnlyTagChips({ ScopedID, GroupID: Mounted.Dummy.GroupID ?? null });
  $('#DUMMY_INFO_TAGS_SECTION').toggleClass('d-none', Chips.Count === 0);
  $('#DUMMY_INFO_TAGS').html(Chips.Html);
}

// --- Delete --------------------------------------------------------------------

async function DeleteDummy(): Promise<void> {
  if (!Mounted || !Editing) return;
  const UUID = Mounted.UUID;
  const Confirmed = await ConfirmationDialog('Delete this dummy client? This cannot be undone.', {
    ConfirmLabel: 'Delete Dummy Client',
  });
  if (!Confirmed) return;
  const [Err] = await window.API.DeleteDummyClient(UUID);
  if (Err) return Notify(Err, 'error');
  await CloseAllModals();
  await Notify('Dummy client deleted.', 'success');
}
