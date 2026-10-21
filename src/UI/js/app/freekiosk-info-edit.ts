// A FreeKiosk terminal's Settings tab: its view modal doubling as its editor,
// like every other entity's (client-info-edit.ts and friends).
//
// The tab hosts THE terminal form, moved in from the Add modal while the view
// modal is open and handed back when it closes (see MoveFreeKioskForm for why
// there is only one). Show mode disables every input, so the form reads as the
// terminal's settings; Edit mode enables it, flipping live when the mode
// changes, and adds the API key, the tag picker, Test Connection and Delete.
//
// The save model is the old terminal editor's: everything commits together on
// the footer Save, which lights up once something has changed; tags apply as
// they are clicked. Leaving Edit mode with unsaved changes discards them.
//
// What the terminal monitors is not on this tab: it is set on the section tabs
// (freekiosk-monitoring.ts), which save as they change. This tab owns only the
// display mode among the terminal's Settings, and its Save merges that over the
// stored settings so it can never undo a monitoring change made meanwhile.
import type { FreeKioskTerminalView } from '@showtrak/protocol';
import { AppMode, Capabilities, FreeKioskTerminals } from './state';
import { HandleNonFatalError } from './utils';
import { ConfirmationDialog, Notify } from './selection-init';
import { ClearTagPicker, RenderReadOnlyTagChips, RenderTagPicker } from './tag-picker';
import { CloseAllModals } from './modals';
import { LoadFreeKioskCatalogues } from './freekiosk';
import { IsClientInfoEditable } from './lib/client-info-edit';
import {
  BindFreeKioskForm,
  BuildFreeKioskPayload,
  FREEKIOSK_EDITOR_TAG_PICKER,
  FillFreeKioskForm,
  MoveFreeKioskForm,
  SetFreeKioskFormEditable,
  ShowFreeKioskTestResult,
} from './freekiosk-editor';
import type { FreeKioskFormSource } from './freekiosk-editor';
import type { TagPickerMount } from './tag-picker';
import { EffectiveFreeKioskSettings } from './freekiosk-monitoring';

const MODAL_ID = 'SHOWTRAK_CLIENT_INFO';
// Shared with the other view-modal editors: whichever entity is mounted owns it.
const EDITING_CLASS = 'is-editing';
const PANE = '#FREEKIOSK_INFO_SETTINGS_SECTION';

// The form's picker, plus the way back here from the Tag Manager.
const TAG_PICKER: TagPickerMount = {
  ...FREEKIOSK_EDITOR_TAG_PICKER,
  ReturnTo: async (UUID) => {
    const { OpenFreeKioskTerminalHistory } = await import('./monitoring-history-modal');
    await OpenFreeKioskTerminalHistory(UUID, { Tab: 'settings' });
  },
  HasUnsavedChanges: () => HasUnsavedChanges(),
};

interface MountedTerminal {
  UUID: string;
  /** The last copy the form was filled from. */
  Source: FreeKioskFormSource;
  /** What that copy's settings were, to tell a real change from a 30s poll. */
  Signature: string;
  /** The form's payload as it was last filled; Save is offered once it differs. */
  Baseline: string | null;
}

let Mounted: MountedTerminal | null = null;
let Editing = false;
let Bound = false;
let MountToken = 0;

function CanEdit(): boolean {
  return (
    !!Mounted &&
    IsClientInfoEditable({
      AppMode,
      CanManage: Capabilities.canManageMonitoring,
      Kind: 'freekiosk',
    })
  );
}

// The settings a push could change. Live readings (battery, screen, …) churn on
// every poll and are not settings, so they stay out — or the form would be
// refilled every few seconds. So do the monitoring settings, which this tab
// does not show: ticking a condition on another tab must not refill this one.
function SettingsSignature(Terminal: FreeKioskFormSource): string {
  return JSON.stringify([
    Terminal.Nickname,
    Terminal.Slug,
    Terminal.Address,
    Terminal.Port,
    Terminal.HasApiKey ?? !!Terminal.ApiKey,
    Terminal.Interval,
    Terminal.TimeoutMs,
    Terminal.GroupID,
    (Terminal.Settings || {}).DisplayMode ?? null,
  ]);
}

function CachedTerminal(UUID: string): FreeKioskTerminalView | null {
  return FreeKioskTerminals.find((Entry) => String(Entry.UUID) === UUID) || null;
}

// The terminal with its stored API key. The key is none of the Web UI's
// business, so it keeps to the cached copy; a save with the key field left
// blank keeps the stored key.
async function LoadTerminal(UUID: string): Promise<FreeKioskFormSource | null> {
  if (!Capabilities.isWeb) {
    try {
      const Full = await window.API.GetFreeKioskTerminal(UUID);
      if (Full) return Full;
    } catch (err) {
      HandleNonFatalError('FreeKioskInfoEdit:LoadTerminal', err);
    }
  }
  return CachedTerminal(UUID);
}

function PayloadSignature(): string | null {
  const [, Payload] = BuildFreeKioskPayload(true);
  return Payload ? JSON.stringify(Payload) : null;
}

// --- Mounting ----------------------------------------------------------------

/** Take over the view modal's Settings tab for this terminal. */
export async function MountFreeKioskInfoEditor(UUID: string): Promise<void> {
  EnsureBound();
  const Token = ++MountToken;
  await LoadFreeKioskCatalogues();
  const Source = await LoadTerminal(String(UUID));
  if (!Source || Token !== MountToken) return;

  Mounted = { UUID: String(UUID), Source, Signature: SettingsSignature(Source), Baseline: null };
  Editing = CanEdit();
  MoveFreeKioskForm(PANE);
  BindFreeKioskForm();
  $(`#${MODAL_ID}`).toggleClass(EDITING_CLASS, Editing);
  $('#CLIENT_INFO_SAVE').removeClass('d-none');
  await Fill();
}

/** Forget the mounted terminal and hand the form back to the Add modal. */
export function UnmountFreeKioskInfoEditor(): void {
  if (!Mounted) return;
  MountToken++;
  ClearTagPicker();
  Mounted = null;
  Editing = false;
  MoveFreeKioskForm();
  $(`#${MODAL_ID}`).removeClass(EDITING_CLASS);
  $('#CLIENT_INFO_SAVE').prop('disabled', true).addClass('d-none');
}

/** Re-evaluate Show/Edit on a mode change; the tab flips in place. */
export async function ApplyFreeKioskInfoEditMode(): Promise<void> {
  if (!Mounted) return;
  const Next = CanEdit();
  if (Next === Editing) return;
  if (!Next && HasUnsavedChanges()) {
    void Notify('Discarded unsaved changes to this terminal.', 'warning');
  }
  Editing = Next;
  $(`#${MODAL_ID}`).toggleClass(EDITING_CLASS, Editing);
  // Editing starts from the stored terminal, key included, not from whatever
  // the last poll happened to carry.
  if (Editing) {
    const UUID = Mounted.UUID;
    const Fresh = await LoadTerminal(UUID);
    if (!Mounted || Mounted.UUID !== UUID) return;
    if (Fresh) {
      Mounted.Source = Fresh;
      Mounted.Signature = SettingsSignature(Fresh);
    }
  }
  await Fill();
}

/** A fresh copy of a terminal (live push). Never touches a form being edited. */
export async function RefreshFreeKioskInfoEditor(Terminal: FreeKioskTerminalView): Promise<void> {
  if (!Mounted || String(Terminal.UUID) !== Mounted.UUID || Editing) return;
  const Signature = SettingsSignature(Terminal);
  if (Signature === Mounted.Signature) {
    RenderTags();
    return;
  }
  Mounted.Source = Terminal;
  Mounted.Signature = Signature;
  await Fill();
}

/** After a tag push: the read-only chips (the picker redraws itself). */
export function RefreshFreeKioskInfoTags(): void {
  if (Mounted && !Editing) RenderTags();
}

function EnsureBound(): void {
  if (Bound) return;
  Bound = true;
  const $Modal = $(`#${MODAL_ID}`);

  // `hide`, not `hidden`, for the reason given in client-info-edit.ts.
  $Modal.on('hide.bs.modal.freeKioskInfoEdit', (Event) => {
    if (Event.target === $Modal[0]) UnmountFreeKioskInfoEditor();
  });

  // Bound on the pane, not the form: in the Add modal the form answers to that
  // modal's own Save.
  $(PANE).on('input change', () => UpdateSaveButton());
  // Moving the terminal to another group changes which tags it inherits.
  $(PANE).on('change', '#FREEKIOSK_GROUPID', () => {
    if (Editing) RenderTags();
  });

  // The footer Save is shared; each editor answers it only while its own entity
  // is mounted.
  $('#CLIENT_INFO_SAVE').on('click.freeKioskInfoEdit', () => void SaveTerminal());
  $(PANE).on('click', '#FREEKIOSK_TEST_CONNECTION', () => void TestConnection());
  $(PANE).on('click', '#FREEKIOSK_DELETE', () => void DeleteTerminal());
}

// --- Form ----------------------------------------------------------------------

async function Fill(): Promise<void> {
  if (!Mounted) return;
  const UUID = Mounted.UUID;
  await FillFreeKioskForm(Mounted.Source);
  if (!Mounted || Mounted.UUID !== UUID) return;
  SetFreeKioskFormEditable(Editing);
  RenderTags();
  Mounted.Baseline = PayloadSignature();
  UpdateSaveButton();
}

function HasUnsavedChanges(): boolean {
  if (!Mounted || !Editing) return false;
  return PayloadSignature() !== Mounted.Baseline;
}

function UpdateSaveButton(): void {
  if (!Mounted) return;
  $('#CLIENT_INFO_SAVE').prop('disabled', !HasUnsavedChanges());
}

function SelectedGroupID(): number | null {
  const Raw = String($('#FREEKIOSK_GROUPID').val() ?? '');
  const Parsed = Raw === '' || Raw === 'null' ? NaN : parseInt(Raw, 10);
  return Number.isFinite(Parsed) ? Parsed : null;
}

function RenderTags(): void {
  if (!Mounted) return;
  // Scoped by bare UUID, like every other client-like entity.
  const ScopedID = Mounted.UUID;
  if (Editing) {
    RenderTagPicker(TAG_PICKER, { ScopedID, GroupID: SelectedGroupID() });
    return;
  }
  ClearTagPicker();
  const Chips = RenderReadOnlyTagChips({ ScopedID, GroupID: Mounted.Source.GroupID ?? null });
  $('#FREEKIOSK_TAGS_VIEW_SECTION').toggleClass('d-none', Chips.Count === 0);
  $('#FREEKIOSK_TAGS_VIEW').html(Chips.Html);
}

// --- Actions -------------------------------------------------------------------

async function SaveTerminal(): Promise<void> {
  if (!Mounted || !Editing) return;
  const UUID = Mounted.UUID;
  const [Invalid, Payload] = BuildFreeKioskPayload(true);
  if (!Payload) {
    await Notify(Invalid, 'error');
    return;
  }
  // Over the latest stored settings (and any monitoring save still in flight),
  // not the copy this form was filled from.
  Payload.Settings = {
    ...EffectiveFreeKioskSettings(UUID, CachedTerminal(UUID)?.Settings ?? Mounted.Source.Settings),
    ...(Payload.Settings as object),
  };
  $('#CLIENT_INFO_SAVE').prop('disabled', true);
  const [Err] = await window.API.UpdateFreeKioskTerminal(UUID, Payload);
  if (Err) {
    // The form keeps everything typed, so the operator can correct and retry.
    await Notify(Err, 'error');
    UpdateSaveButton();
    return;
  }
  await Notify('FreeKiosk terminal updated.', 'success');
  const Fresh = await LoadTerminal(UUID);
  if (!Mounted || Mounted.UUID !== UUID || !Fresh) return;
  Mounted.Source = Fresh;
  Mounted.Signature = SettingsSignature(Fresh);
  await Fill();
}

async function TestConnection(): Promise<void> {
  if (!Mounted || !Editing) return;
  ShowFreeKioskTestResult('Polling…', 'ok');
  const [Err, Summary] = await window.API.RunFreeKioskTerminalsNow([Mounted.UUID]);
  if (Err) return ShowFreeKioskTestResult(Err, 'error');
  if (Summary && Summary.Succeeded) return ShowFreeKioskTestResult('Device answered.', 'ok');
  const Reason = Summary?.Results.find((Entry) => !Entry.Success)?.Error;
  ShowFreeKioskTestResult(Reason || 'No response from the device.', 'error');
}

async function DeleteTerminal(): Promise<void> {
  if (!Mounted || !Editing) return;
  const UUID = Mounted.UUID;
  const Confirmed = await ConfirmationDialog(
    'Delete this FreeKiosk terminal? This cannot be undone.',
    { ConfirmLabel: 'Delete Terminal' }
  );
  if (!Confirmed) return;
  const [Err] = await window.API.DeleteFreeKioskTerminal(UUID);
  if (Err) return Notify(Err, 'error');
  await CloseAllModals();
  await Notify('FreeKiosk terminal deleted.', 'success');
}
