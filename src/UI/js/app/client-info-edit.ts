// A client's view modal doubles as its editor — a ShowTrak Client install's
// and an SDK (integrated) client's alike.
//
// Every editable thing renders read-only in Show mode and editable in Edit mode,
// and flips live when the mode changes — from the bottom bar, Ctrl/Cmd+1/2, or
// another surface — without reopening the modal:
//
//   Info       slug, nickname, group, run on launch, launch delay, disconnect
//              grace, FOG host link and tags (no launch fields for an SDK
//              client, which runs no local agent).
//   Variables  this client's show-variable values (ShowTrak clients only).
//   Wake on LAN  its MAC addresses, plus filling them from the client's own
//              interfaces or from FOG.
//   Actions    everything the right-click menu offers for it, and Check for
//              Updates (not for an SDK client), Schedule FOG Task, Replace
//              Client and Delete Client.
//
// Save models are the ones the old client editor had: the Info and Variables
// fields commit together on Save; MACs, tags and the FOG link apply as they
// change.
//
// The whole modal carries `.is-editing` while editable, which the CSS
// uses to swap each `.ci-view-only` element for its `.ci-edit-only` twin.
import type {
  ClientVariableView,
  ClientView,
  FogHostView,
  FogTaskTypeView,
  GroupView,
} from '@showtrak/protocol';
import { AppMode, Capabilities, PendingAdoption, ScriptList } from './state';
import { IsIntegratedClientEntity } from './state/client-labels';
import { HandleNonFatalError, Safe } from './utils';
import { ConfirmationDialog, Notify, ShowExecutionToastIfActive } from './selection-init';
import { ClearTagPicker, RenderReadOnlyTagChips, RenderTagPicker } from './tag-picker';
import type { TagPickerMount } from './tag-picker';
import { IsFogAvailable, OpenFogTaskModal } from './fog';
import type { ContextMenuOption } from './context-menu-options';
import { GetActiveClientInfoTab, OnClientInfoTabShown } from './client-info-nav';
import { CloseAllModals, OpenClientReplacementModal } from './modals';
import {
  BuildClientUpdatePayload,
  ClientSettingsDraftChanged,
  CollectClientMacCandidates,
  IsClientInfoEditable,
  MAX_OFFLINE_GRACE_SECONDS,
  MIN_LAUNCH_DELAY_SECONDS,
  MissingMacAddresses,
  OfflineGraceLabel,
  OfflineGraceSummary,
} from './lib/client-info-edit';
import type { ClientSettingsDraft } from './lib/client-info-edit';

const MODAL_ID = 'SHOWTRAK_CLIENT_INFO';
// Shared with the monitor's Settings tab (monitor-info-edit.ts): whichever
// entity is mounted owns it.
const EDITING_CLASS = 'is-editing';

const CLIENT_INFO_TAG_PICKER: TagPickerMount = {
  WrapperSelector: '#CLIENT_INFO_TAG_PICKER_WRAPPER',
  ListSelector: '#CLIENT_INFO_TAG_PICKER',
  Namespace: 'clientInfoTags',
  ReturnTo: async (UUID) => {
    const { OpenClientInfo } = await import('./client-info-modal');
    await OpenClientInfo(UUID, { Tab: 'info' });
  },
  HasUnsavedChanges: () => HasUnsavedChanges(),
};

interface FogState {
  Available: boolean;
  LinkedID: number | null;
  LinkedName: string | null;
  Hosts: FogHostView[];
  TaskTypes: FogTaskTypeView[];
}

const NO_FOG: FogState = {
  Available: false,
  LinkedID: null,
  LinkedName: null,
  Hosts: [],
  TaskTypes: [],
};

interface MountedClient {
  UUID: string;
  Client: ClientView;
  Integrated: boolean;
  Groups: GroupView[];
  /** The Preferences disconnect grace a client with no override inherits;
   *  null where settings cannot be read (the Web UI). */
  InheritedGrace: number | null;
  Variables: ClientVariableView[];
  Fog: FogState;
  /** The form as it was last populated; Save is offered once it differs. */
  Baseline: ClientSettingsDraft | null;
}

interface ActionRow {
  Kind: 'action' | 'divider';
  Title?: string;
  Class?: string;
  Icon?: string;
  IconColour?: string;
  Run?: () => unknown;
}

let Mounted: MountedClient | null = null;
let Editing = false;
let Bound = false;
// One in-flight MAC or action operation at a time; buttons disable meanwhile.
let Busy = false;
// Bumped on every mount so an async render for a client that has since been
// replaced (or closed) drops its result instead of drawing it.
let MountToken = 0;
let ActionRows: ActionRow[] = [];
let ManageRows: ActionRow[] = [];
let ActionsSignature = '';

function CanEdit(): boolean {
  return (
    !!Mounted &&
    IsClientInfoEditable({
      AppMode,
      CanManage: Capabilities.canManageClients,
      Kind: Mounted.Integrated ? 'integrated' : 'client',
    })
  );
}

function ClientLabel(Client: ClientView): string {
  return Client.Nickname || Client.Hostname || String(Client.UUID);
}

// --- Mounting ----------------------------------------------------------------

/**
 * Take over the open view modal for this client: load what the editable fields
 * need, draw every pane in the current mode. Called by OpenClientInfo before the
 * modal shows.
 */
export async function MountClientInfoEditor(Client: ClientView): Promise<void> {
  EnsureBound();
  const Token = ++MountToken;
  const UUID = String(Client.UUID);
  const Integrated = IsIntegratedClientEntity(Client);

  const [Groups, InheritedGrace, Variables, Fog] = await Promise.all([
    LoadGroups(),
    LoadInheritedGrace(),
    Integrated ? Promise.resolve([]) : LoadVariables(UUID),
    LoadFogState(UUID),
  ]);
  if (Token !== MountToken) return;

  Mounted = { UUID, Client, Integrated, Groups, InheritedGrace, Variables, Fog, Baseline: null };
  Editing = CanEdit();
  Busy = false;
  ActionsSignature = '';
  $('#CLIENT_INFO_MAC_INPUT').val('');
  $(`#${MODAL_ID}`).toggleClass(EDITING_CLASS, Editing);
  // Monitors autosave, so the Save button belongs to a mounted client alone.
  $('#CLIENT_INFO_SAVE').removeClass('d-none');
  PopulateForm();
  RenderReadOnlyFields();
  RenderMacList();
  RenderFogMacButton();
  RenderTags();
  await RenderActions();
}

/** Forget the mounted client; the modal reverts to plain read-only. */
export function UnmountClientInfoEditor(): void {
  MountToken++;
  if (Mounted) ClearTagPicker();
  Mounted = null;
  Editing = false;
  Busy = false;
  ActionRows = [];
  ManageRows = [];
  ActionsSignature = '';
  $(`#${MODAL_ID}`).removeClass(EDITING_CLASS);
  $('#CLIENT_INFO_SAVE').prop('disabled', true).addClass('d-none');
}

/**
 * Re-evaluate Show/Edit for the open modal. Called on every mode change, so the
 * panes flip in place. Leaving Edit mode with unsaved changes discards them —
 * the read-only view must show what is saved, not what was half-typed.
 */
export function ApplyClientInfoEditMode(): void {
  // Nothing mounted: the modal is showing something else, which owns the class.
  if (!Mounted) return;
  const Next = CanEdit();
  if (Next === Editing) return;
  if (!Next && HasUnsavedChanges()) {
    void Notify('Discarded unsaved changes to this client.', 'warning');
  }
  Editing = Next;
  $(`#${MODAL_ID}`).toggleClass(EDITING_CLASS, Editing);
  PopulateForm();
  RenderReadOnlyFields();
  RenderMacList();
  RenderFogMacButton();
  RenderTags();
  void RenderActions();
  // Entering Edit mode is when the FOG link becomes changeable, so it is worth
  // seeing the current host list rather than the one from when the modal opened.
  if (Editing) void ReloadFog();
}

/**
 * A fresh copy of the open client (live push or the periodic refresh). Updates
 * everything read-only; never touches a field being edited.
 */
export function RefreshClientInfoEditor(Client: ClientView): void {
  if (!Mounted || String(Client.UUID) !== Mounted.UUID) return;
  Mounted.Client = Client;
  if (!Editing) PopulateForm();
  RenderReadOnlyFields();
  RenderMacList();
  RenderFogMacButton();
  if (!Editing) RenderTags();
  if (GetActiveClientInfoTab() === 'actions') void RenderActions();
}

/** After a tag push: the read-only chips (the picker redraws itself). */
export function RefreshClientInfoTags(): void {
  if (Mounted && !Editing) RenderTags();
}

/**
 * After a variable push (a variable added, renamed or deleted elsewhere): redraw
 * the rows. Anything typed into them is dropped — the row it belonged to may be
 * gone, and half of a stale form is worse than the current truth.
 */
export async function RefreshClientInfoVariables(): Promise<void> {
  if (!Mounted || Mounted.Integrated) return;
  const UUID = Mounted.UUID;
  const Variables = await LoadVariables(UUID);
  if (!Mounted || Mounted.UUID !== UUID) return;
  Mounted.Variables = Variables;
  RenderVariables();
  if (Mounted.Baseline) Mounted.Baseline.Variables = CollectDraft().Variables;
  UpdateSaveButton();
}

function EnsureBound(): void {
  if (Bound) return;
  Bound = true;
  const $Modal = $(`#${MODAL_ID}`);

  // `hide`, not `hidden`: it fires as the close starts, so switching straight to
  // another entity (which closes this modal first) can never unmount the NEXT
  // client because the fade happened to finish after it mounted.
  $Modal.on('hide.bs.modal.clientInfoEdit', (Event) => {
    if (Event.target === $Modal[0]) UnmountClientInfoEditor();
  });

  $Modal.on('input.clientInfoEdit change.clientInfoEdit', '.ci-draft', () => UpdateSaveButton());
  $('#CLIENT_INFO_SAVE').on('click', () => void SaveClientSettings());
  $('#CLIENT_INFO_VARIABLES_LIST')
    .on('click', '.field-reset-btn', function () {
      ResetVariable(this);
    })
    .on('input', '.ci-variable', function () {
      SyncResetButton(this as HTMLInputElement);
    });

  // Moving the client to another group changes which tags it inherits, so the
  // picker re-derives from the selection rather than waiting for Save.
  $('#CLIENT_INFO_GROUP_SELECT').on('change', () => RenderTags());
  $('#CLIENT_INFO_RUNONLAUNCH_SCRIPT').on('change', () => SyncLaunchDelayInput());

  $('#CLIENT_INFO_FOG_HOST').on('change', function () {
    void ChangeFogLink(String($(this).val() || '').trim());
  });

  $('#CLIENT_INFO_MAC_LIST').on('click', '.mac-address-remove', function () {
    void RemoveMac(String($(this).attr('data-mac') || ''));
  });
  $('#CLIENT_INFO_MAC_ADD').on('click', () => void AddTypedMac());
  $('#CLIENT_INFO_MAC_INPUT').on('keydown', (Event) => {
    if (Event.key !== 'Enter') return;
    Event.preventDefault();
    void AddTypedMac();
  });
  $('#CLIENT_INFO_MAC_FROM_CLIENT').on('click', () => void AddMacsFromClient());
  $('#CLIENT_INFO_MAC_FROM_FOG').on('click', () => void AddMacsFromFog());

  $('#CLIENT_INFO_ACTIONS').on('click', '[data-client-action]', function () {
    const [List, Index] = String($(this).attr('data-client-action') || '').split(':');
    const Row = (List === 'manage' ? ManageRows : ActionRows)[Number(Index)];
    if (Row) void RunAction(Row);
  });

  OnClientInfoTabShown((Key) => {
    if (Key === 'actions') void RenderActions();
  });
}

// --- Loading -----------------------------------------------------------------

async function LoadGroups(): Promise<GroupView[]> {
  try {
    const Groups = await window.API.GetAllGroups();
    return Array.isArray(Groups) ? Groups : [];
  } catch (err) {
    HandleNonFatalError('ClientInfoEdit:LoadGroups', err);
    return [];
  }
}

async function LoadInheritedGrace(): Promise<number | null> {
  // The Web UI cannot read settings, so it shows the default without its value.
  if (Capabilities.isWeb) return null;
  try {
    // Imported lazily: ./settings pulls in the audio stack at module load.
    const { GetSettingValue } = await import('./settings');
    const Raw = Number(await GetSettingValue('CLIENT_OFFLINE_GRACE_SECONDS'));
    return Number.isInteger(Raw) && Raw >= 0 ? Raw : 0;
  } catch (err) {
    HandleNonFatalError('ClientInfoEdit:LoadOfflineGrace', err);
    return 0;
  }
}

async function LoadVariables(UUID: string): Promise<ClientVariableView[]> {
  try {
    return (await window.API.GetClientVariables(UUID)) || [];
  } catch {
    return [];
  }
}

// FOG degrades rather than fails: disabled or unreachable hides everything FOG,
// and a host-list failure falls back to the backend's cached list, so opening a
// client never depends on a FOG server being up.
async function LoadFogState(UUID: string): Promise<FogState> {
  if (!IsFogAvailable()) return NO_FOG;
  try {
    const [[LinkErr, Link], [HostsErr, Hosts], TaskTypes] = await Promise.all([
      window.API.GetFogHostLink(UUID),
      window.API.GetFogHosts(),
      window.API.GetFogTaskTypes(),
    ]);
    return {
      Available: true,
      LinkedID: !LinkErr && Link ? Link.FogHostID : null,
      LinkedName: !LinkErr && Link ? Link.FogHostName : null,
      Hosts: !HostsErr && Array.isArray(Hosts) ? Hosts : [],
      TaskTypes: Array.isArray(TaskTypes) ? TaskTypes : [],
    };
  } catch (err) {
    HandleNonFatalError('ClientInfoEdit:LoadFog', err);
    return NO_FOG;
  }
}

async function ReloadFog(): Promise<void> {
  if (!Mounted) return;
  const UUID = Mounted.UUID;
  const Fog = await LoadFogState(UUID);
  if (!Mounted || Mounted.UUID !== UUID) return;
  Mounted.Fog = Fog;
  RenderFogField();
  RenderFogMacButton();
  void RenderActions();
}

async function ReloadClient(): Promise<ClientView | null> {
  if (!Mounted) return null;
  const UUID = Mounted.UUID;
  const Fresh = await window.API.GetClient(UUID);
  if (!Fresh || !Mounted || Mounted.UUID !== UUID) return null;
  Mounted.Client = Fresh;
  return Fresh;
}

// --- Info + Variables form ----------------------------------------------------

// Fill every editable control from the saved client and take that as the
// baseline. In Show mode the same controls (or their read-only twins) display it.
function PopulateForm(): void {
  if (!Mounted) return;
  const { Client, Groups, InheritedGrace } = Mounted;

  $('#CLIENT_INFO_SLUG').val(Client.Slug || '');
  $('#CLIENT_INFO_NICKNAME').val(Client.Nickname || Client.Hostname || '');
  $('#CLIENT_INFO_SLUG, #CLIENT_INFO_NICKNAME')
    .prop('disabled', !Editing)
    .toggleClass('disabled', !Editing);

  let GroupOptions = '';
  for (const Group of Groups) {
    const Selected = Client.GroupID === Group.GroupID ? 'selected' : '';
    GroupOptions += `<option value="${Safe(Group.GroupID)}" ${Selected}>${Safe(Group.Title)}</option>`;
  }
  GroupOptions += `<option value="null" ${Client.GroupID == null ? 'selected' : ''}>No Group</option>`;
  $('#CLIENT_INFO_GROUP_SELECT').html(GroupOptions);

  $('#CLIENT_INFO_LAUNCH_WRAPPER').toggleClass('d-none', Mounted.Integrated);
  const Scripts = [...ScriptList].sort(
    (a, b) => (a.Weight || 0) - (b.Weight || 0) || String(a.Name).localeCompare(String(b.Name))
  );
  let ScriptOptions = '<option value="">None</option>';
  for (const Script of Scripts) {
    const Selected = Client.RunOnLaunchScriptID === Script.ID ? 'selected' : '';
    ScriptOptions += `<option value="${Safe(Script.ID)}" ${Selected}>${Safe(Script.Name)}</option>`;
  }
  $('#CLIENT_INFO_RUNONLAUNCH_SCRIPT').html(ScriptOptions);
  $('#CLIENT_INFO_RUNONLAUNCH_DELAY').val(
    String(Client.RunOnLaunchDelaySeconds ?? MIN_LAUNCH_DELAY_SECONDS)
  );
  SyncLaunchDelayInput();

  const $Grace = $('#CLIENT_INFO_OFFLINE_GRACE').empty();
  $Grace.append(
    $('<option></option>').attr('value', '').text(OfflineGraceSummary(null, InheritedGrace))
  );
  for (let n = 0; n <= MAX_OFFLINE_GRACE_SECONDS; n++) {
    $Grace.append($('<option></option>').attr('value', String(n)).text(OfflineGraceLabel(n)));
  }
  $Grace.val(
    typeof Client.OfflineGraceSeconds === 'number' ? String(Client.OfflineGraceSeconds) : ''
  );

  RenderFogField();
  RenderVariables();

  Mounted.Baseline = CollectDraft();
  UpdateSaveButton();
}

// A delay only means something with a script to delay.
function SyncLaunchDelayInput(): void {
  const HasScript = !!String($('#CLIENT_INFO_RUNONLAUNCH_SCRIPT').val() || '');
  $('#CLIENT_INFO_RUNONLAUNCH_DELAY').prop('disabled', !HasScript);
}

// The read-only twins of the editable selects, and the fields that are only
// ever read.
function RenderReadOnlyFields(): void {
  if (!Mounted) return;
  const { Client, Groups, InheritedGrace } = Mounted;

  const Group = Groups.find((Entry) => Entry && Entry.GroupID === Client.GroupID);
  $('#CLIENT_INFO_GROUP').val(Group && Group.Title ? Group.Title : 'No Group');

  const Script = Client.RunOnLaunchScriptID
    ? ScriptList.find((Entry) => Entry.ID === Client.RunOnLaunchScriptID)
    : null;
  $('#CLIENT_INFO_RUNONLAUNCH_VIEW').val(
    Client.RunOnLaunchScriptID ? (Script ? Script.Name : 'Unknown script') : 'None'
  );
  const Delay = Client.RunOnLaunchDelaySeconds ?? MIN_LAUNCH_DELAY_SECONDS;
  $('#CLIENT_INFO_RUNONLAUNCH_DELAY_VIEW').val(Delay === 1 ? '1 second' : `${Delay} seconds`);
  $('#CLIENT_INFO_LAUNCH_DELAY_VIEW_WRAPPER').toggleClass('d-none', !Client.RunOnLaunchScriptID);

  $('#CLIENT_INFO_OFFLINE_GRACE_VIEW').val(
    OfflineGraceSummary(Client.OfflineGraceSeconds, InheritedGrace)
  );
}

function CollectDraft(): ClientSettingsDraft {
  let Variables: Record<string, string> | null = null;
  const Inputs = document.querySelectorAll<HTMLInputElement>(
    '#CLIENT_INFO_VARIABLES_LIST .ci-variable'
  );
  if (Editing && Inputs.length) {
    Variables = {};
    Inputs.forEach((Input) => {
      const VariableID = String(Input.getAttribute('data-variableid') || '').trim();
      if (VariableID) Variables![VariableID] = Input.value;
    });
  }
  return {
    Slug: String($('#CLIENT_INFO_SLUG').val() || ''),
    Nickname: String($('#CLIENT_INFO_NICKNAME').val() || ''),
    GroupID: String($('#CLIENT_INFO_GROUP_SELECT').val() ?? ''),
    OfflineGraceSeconds: String($('#CLIENT_INFO_OFFLINE_GRACE').val() ?? ''),
    RunOnLaunchScriptID: String($('#CLIENT_INFO_RUNONLAUNCH_SCRIPT').val() || ''),
    RunOnLaunchDelaySeconds: String($('#CLIENT_INFO_RUNONLAUNCH_DELAY').val() ?? ''),
    Variables,
  };
}

function HasUnsavedChanges(): boolean {
  return !!Mounted && Editing && ClientSettingsDraftChanged(Mounted.Baseline, CollectDraft());
}

function UpdateSaveButton(): void {
  $('#CLIENT_INFO_SAVE').prop('disabled', !HasUnsavedChanges());
}

async function SaveClientSettings(): Promise<void> {
  if (!Mounted || !Editing) return;
  const { UUID, Client, Integrated } = Mounted;
  const Payload = BuildClientUpdatePayload(CollectDraft(), {
    Slug: Client.Slug,
    Hostname: Client.Hostname,
    Integrated,
  });

  const $Save = $('#CLIENT_INFO_SAVE').prop('disabled', true);
  const [Err] = await window.API.UpdateClient(UUID, Payload);
  if (Err) {
    // The form keeps everything typed, so the operator can correct and retry.
    await Notify(`Failed to update client: ${Err}`, 'error');
    UpdateSaveButton();
    return;
  }
  await Notify('Client updated.', 'success');
  if (!Mounted || Mounted.UUID !== UUID) return;
  const [Fresh, Variables] = await Promise.all([
    ReloadClient(),
    Integrated ? Promise.resolve([]) : LoadVariables(UUID),
  ]);
  if (!Mounted || Mounted.UUID !== UUID) return;
  if (!Fresh) {
    $Save.prop('disabled', false);
    return;
  }
  Mounted.Variables = Variables;
  PopulateForm();
  RenderReadOnlyFields();
}

/**
 * One row per variable defined in the show. Editable rows hold this client's own
 * value — empty means "use the default", and the default is named underneath so
 * an empty box never reads as an unexplained blank. Read-only rows show the
 * value the client's scripts actually get.
 */
function RenderVariables(): void {
  const List = document.getElementById('CLIENT_INFO_VARIABLES_LIST');
  if (!List || !Mounted) return;
  const Variables = Mounted.Variables;

  $('#CLIENT_INFO_VARIABLES_HINT').text(
    !Variables.length
      ? 'No variables are defined. Create them in the Variable Manager.'
      : Editing
        ? 'Leave a field empty to use the default.'
        : "Available to this client's scripts."
  );

  List.innerHTML = '';
  for (const Variable of Variables) {
    const ID = String(Variable.VariableID);
    const Inherited = Variable.Value == null;
    const Default = Variable.DefaultValue || '';
    const Row = document.createElement('div');
    Row.className = 'client-info-variable';
    // Edit mode floats a reset button where the Info fields carry their copy
    // button: it empties the field, which is what "use the default" means.
    Row.innerHTML = `
      <div class="form-floating ${Editing ? 'has-copy' : ''}">
        <input
          type="text"
          class="form-control ${Editing ? 'ci-draft ci-variable' : 'disabled'}"
          id="CLIENT_INFO_VARIABLE_${Safe(ID)}"
          data-variableid="${Safe(ID)}"
          autocomplete="off"
          spellcheck="false"
          ${Editing ? '' : 'disabled'}
        />
        <label for="CLIENT_INFO_VARIABLE_${Safe(ID)}">${Safe(Variable.EnvironmentKey)}</label>
        ${
          Editing
            ? `<button type="button" class="field-reset-btn" data-target="#CLIENT_INFO_VARIABLE_${Safe(ID)}" title="Reset to Default" aria-label="Reset ${Safe(Variable.EnvironmentKey)} to default"><i class="bi bi-arrow-counterclockwise"></i></button>`
            : ''
        }
      </div>
      <div class="client-info-variable-note"></div>`;
    const Input = Row.querySelector('input') as HTMLInputElement;
    const Note = Row.querySelector('.client-info-variable-note') as HTMLElement;
    // Values go in through properties, never the markup, so quotes in a value
    // cannot break out of an attribute.
    if (Editing) {
      Input.value = Inherited ? '' : String(Variable.Value);
      Input.placeholder = Default;
      Note.textContent = Default ? `Default: ${Default}` : 'No default value';
      SyncResetButton(Input);
    } else {
      Input.value = Inherited ? Default : String(Variable.Value);
      Note.textContent = Inherited
        ? Default
          ? 'Default value'
          : 'Not set'
        : 'Set for this client';
    }
    List.appendChild(Row);
  }
}

// A reset button has nothing to do while its field is already empty.
function SyncResetButton(Input: HTMLInputElement): void {
  const Button = Input.parentElement?.querySelector<HTMLButtonElement>('.field-reset-btn');
  if (Button) Button.disabled = Input.value === '';
}

function ResetVariable(Button: HTMLElement): void {
  if (!Editing) return;
  const Input = document.querySelector<HTMLInputElement>(Button.getAttribute('data-target') || '');
  if (!Input) return;
  Input.value = '';
  // Through the same event a keystroke sends, so Save picks the change up.
  Input.dispatchEvent(new Event('input', { bubbles: true }));
  Input.focus();
}

// --- FOG host link -------------------------------------------------------------

function RenderFogField(): void {
  if (!Mounted) return;
  const { Fog } = Mounted;
  $('#CLIENT_INFO_FOG_WRAPPER').toggleClass('d-none', !Fog.Available);
  if (!Fog.Available) return;

  let Options = '<option value="">Not linked to FOG</option>';
  let Matched = false;
  for (const Host of Fog.Hosts) {
    const Selected = Fog.LinkedID === Host.FogHostID ? 'selected' : '';
    if (Selected) Matched = true;
    Options += `<option value="${Safe(Host.FogHostID)}" ${Selected}>${Safe(Host.Name)}</option>`;
  }
  // The linked host is missing from the list (FOG unreachable, or the host was
  // deleted there). Keep it, from the cached name, so a stale link stays visible
  // and clearable rather than silently vanishing.
  const StaleName = `${Fog.LinkedName || `FOG host ${Fog.LinkedID}`} (unavailable)`;
  if (Fog.LinkedID && !Matched) {
    Options += `<option value="${Safe(Fog.LinkedID)}" selected>${Safe(StaleName)}</option>`;
  }
  $('#CLIENT_INFO_FOG_HOST').html(Options);

  const Host = LinkedFogHost();
  $('#CLIENT_INFO_FOG_HOST_VIEW').val(
    !Fog.LinkedID ? 'Not linked to FOG' : Host ? Host.Name : StaleName
  );
  $('#CLIENT_INFO_FOG_HINT').text(
    Fog.LinkedID
      ? Host && Host.ImageName
        ? `Assigned image: ${Host.ImageName}`
        : 'No image assigned in FOG — Deploy tasks will fail.'
      : Editing
        ? 'Link this client to a FOG host to schedule imaging tasks.'
        : ''
  );
}

function LinkedFogHost(): FogHostView | null {
  if (!Mounted || !Mounted.Fog.LinkedID) return null;
  const ID = Mounted.Fog.LinkedID;
  return Mounted.Fog.Hosts.find((Host) => Host.FogHostID === ID) || null;
}

// Persisted on change rather than on Save: FOG data lives in its own table and
// has no business travelling through the client update payload.
async function ChangeFogLink(Raw: string): Promise<void> {
  if (!Mounted || !Editing) return;
  const NextID = Raw ? parseInt(Raw, 10) : null;
  const [Err] = await window.API.SetFogHostLink(Mounted.UUID, NextID);
  if (Err) await Notify(String(Err), 'error');
  else await Notify(NextID ? 'Linked to FOG host.' : 'Unlinked from FOG.', 'success');
  await ReloadFog();
}

// --- Wake on LAN ---------------------------------------------------------------

function RenderMacList(): void {
  if (!Mounted) return;
  const Client = Mounted.Client;
  const Entries = Array.isArray(Client.MacAddresses) ? Client.MacAddresses : [];
  const ActiveMac = String(Client.MacAddress || '')
    .toUpperCase()
    .replace(/-/g, ':');

  if (!Entries.length) {
    $('#CLIENT_INFO_MAC_LIST').html(
      '<div class="mac-address-empty">No MAC addresses on record.</div>'
    );
  } else {
    let Html = '';
    for (const Entry of Entries) {
      const Mac = String(Entry.MacAddress || '');
      const IsActive = !!ActiveMac && Mac === ActiveMac;
      // Manual entries are labelled so typed addresses can be told from reported
      // ones — the two behave differently on removal (a reported address the
      // client still has comes back on its next report).
      const Tag = IsActive
        ? '<span class="mac-address-tag is-active">Active</span>'
        : Entry.Source === 'Manual'
          ? '<span class="mac-address-tag">Manual</span>'
          : '';
      const Interface = Entry.InterfaceName
        ? `<span class="mac-address-iface">${Safe(Entry.InterfaceName)}</span>`
        : '';
      const Remove = Editing
        ? `<button type="button" class="mac-address-remove" data-mac="${Safe(Mac)}" title="Remove ${Safe(Mac)}" ${Busy ? 'disabled' : ''}><i class="bi bi-x-lg"></i></button>`
        : '';
      Html += `
        <div class="mac-address-item">
          <span class="mac-address-value">${Safe(Mac)}</span>
          ${Interface}
          ${Tag}
          ${Remove}
        </div>`;
    }
    $('#CLIENT_INFO_MAC_LIST').html(Html);
  }

  $('#CLIENT_INFO_MAC_ADD, #CLIENT_INFO_MAC_FROM_CLIENT').prop('disabled', Busy);
}

function RenderFogMacButton(): void {
  if (!Mounted) return;
  const { Fog } = Mounted;
  const $Button = $('#CLIENT_INFO_MAC_FROM_FOG').toggleClass('d-none', !Fog.Available);
  const $Hint = $('#CLIENT_INFO_MAC_FOG_HINT');
  if (!Fog.Available) {
    $Hint.addClass('d-none');
    return;
  }
  $Button.prop('disabled', Busy || !Fog.LinkedID);
  $Hint
    .toggleClass('d-none', !!Fog.LinkedID)
    .text('Link this client to a FOG host on the Info tab to fetch its addresses.');
}

async function WithBusy(Work: () => Promise<void>): Promise<void> {
  if (Busy || !Mounted || !Editing) return;
  Busy = true;
  RenderMacList();
  RenderFogMacButton();
  try {
    await Work();
  } catch (err) {
    HandleNonFatalError('ClientInfoEdit:MacAddresses', err);
    await Notify('Failed to update MAC addresses.', 'error');
  } finally {
    Busy = false;
    await ReloadClient();
    RenderMacList();
    RenderFogMacButton();
  }
}

async function RemoveMac(Mac: string): Promise<void> {
  if (!Mac) return;
  await WithBusy(async () => {
    const [Err] = await window.API.RemoveClientMacAddress(Mounted!.UUID, Mac);
    if (Err) await Notify(String(Err), 'error');
  });
}

async function AddTypedMac(): Promise<void> {
  const $Input = $('#CLIENT_INFO_MAC_INPUT');
  const Raw = String($Input.val() || '').trim();
  if (!Raw) return;
  await WithBusy(async () => {
    const [Err] = await window.API.AddClientMacAddress(Mounted!.UUID, Raw);
    if (Err) {
      await Notify(String(Err), 'error');
      return;
    }
    $Input.val('');
  });
}

// Add each address one by one, through the same channel as a typed address, and
// report how many landed. Returns early on the first refusal.
async function AddMacs(Macs: string[], Source: string): Promise<void> {
  let Added = 0;
  for (const Mac of Macs) {
    const [Err] = await window.API.AddClientMacAddress(Mounted!.UUID, Mac);
    if (Err) {
      await Notify(`Failed to add ${Mac}: ${Err}`, 'error');
      break;
    }
    Added += 1;
  }
  if (Added) {
    await Notify(`Added ${Added} MAC address${Added === 1 ? '' : 'es'} from ${Source}.`, 'success');
  }
}

async function AddMacsFromClient(): Promise<void> {
  await WithBusy(async () => {
    const Client = (await ReloadClient()) || Mounted!.Client;
    const Interfaces = Array.isArray(Client.NetworkInterfaces) ? Client.NetworkInterfaces : [];
    if (!Interfaces.length) {
      await Notify('This client has not reported its network interfaces yet.', 'info');
      return;
    }
    const Candidates = CollectClientMacCandidates(Interfaces).map((Entry) => Entry.MacAddress);
    const Missing = MissingMacAddresses(Candidates, Client.MacAddresses);
    if (!Missing.length) {
      await Notify('Every address this client reports is already listed.', 'info');
      return;
    }
    await AddMacs(Missing, 'the client');
  });
}

async function AddMacsFromFog(): Promise<void> {
  await WithBusy(async () => {
    const LinkedID = Mounted!.Fog.LinkedID;
    if (!LinkedID) return;
    // Asked fresh, not from the list loaded when the modal opened: the point is
    // to pick up whatever FOG holds now.
    const [Err, Hosts] = await window.API.GetFogHosts();
    if (Err) {
      await Notify(String(Err), 'error');
      return;
    }
    const Host = (Array.isArray(Hosts) ? Hosts : []).find((Entry) => Entry.FogHostID === LinkedID);
    if (!Host) {
      await Notify('The linked FOG host is unavailable.', 'error');
      return;
    }
    const FromFog =
      Array.isArray(Host.MacAddresses) && Host.MacAddresses.length
        ? Host.MacAddresses
        : Host.MacAddress
          ? [Host.MacAddress]
          : [];
    if (!FromFog.length) {
      await Notify('FOG holds no MAC addresses for this host.', 'info');
      return;
    }
    const Missing = MissingMacAddresses(FromFog, Mounted!.Client.MacAddresses);
    if (!Missing.length) {
      await Notify('Every address FOG holds for this host is already listed.', 'info');
      return;
    }
    await AddMacs(Missing, 'FOG');
  });
}

// --- Tags ----------------------------------------------------------------------

function SelectedGroupID(): number | null {
  const Raw = String($('#CLIENT_INFO_GROUP_SELECT').val() ?? '');
  const Parsed = Raw === '' || Raw === 'null' ? NaN : parseInt(Raw, 10);
  return Number.isFinite(Parsed) ? Parsed : null;
}

function RenderTags(): void {
  if (!Mounted) return;
  const ScopedID = Mounted.UUID;

  if (Editing) {
    // A ShowTrak client's scope ID is its bare UUID. Redrawn by the SetTagList
    // push, so chips stay right if a tag is edited elsewhere meanwhile.
    RenderTagPicker(CLIENT_INFO_TAG_PICKER, { ScopedID, GroupID: SelectedGroupID() });
    return;
  }
  ClearTagPicker();

  // Read-only: hidden entirely when there are none.
  const Chips = RenderReadOnlyTagChips({ ScopedID, GroupID: Mounted.Client.GroupID ?? null });
  $('#CLIENT_INFO_TAGS_SECTION').toggleClass('d-none', Chips.Count === 0);
  $('#CLIENT_INFO_TAGS').html(Chips.Html);
}

// --- Actions -------------------------------------------------------------------

// The context menu's rows for just this client, minus the selection management.
// Dividers are kept between sections but never doubled or left at an end.
function ToActionRows(Options: ContextMenuOption[]): ActionRow[] {
  const Rows: ActionRow[] = [];
  for (const Option of Options) {
    if (Option.Type === 'Divider') {
      if (Rows.length && Rows[Rows.length - 1]!.Kind !== 'divider') Rows.push({ Kind: 'divider' });
      continue;
    }
    if (Option.Type !== 'Action' || !Option.Action) continue;
    Rows.push({
      Kind: 'action',
      Title: Option.Title,
      Class: Option.Class,
      Icon: Option.Icon,
      IconColour: Option.IconColour,
      Run: Option.Action,
    });
  }
  while (Rows.length && Rows[Rows.length - 1]!.Kind === 'divider') Rows.pop();
  return Rows;
}

function BuildManageRows(Client: ClientView, Fog: FogState, Integrated: boolean): ActionRow[] {
  const UUID = String(Client.UUID);
  const Rows: ActionRow[] = [];

  // Asks the ShowTrak Client agent to update itself; an SDK client has none.
  if (!Integrated) {
    Rows.push({
      Kind: 'action',
      Title: 'Check for Updates',
      Class: 'text-light',
      Icon: 'bi-cloud-arrow-down',
      IconColour: '#3498db',
      Run: async () => {
        await window.API.CheckForUpdatesOnClient(UUID);
        ShowExecutionToastIfActive();
      },
    });
  }

  // Only when FOG is up, this client is linked, and some task type is allowed.
  if (Fog.Available && Fog.LinkedID && Fog.TaskTypes.length) {
    Rows.push({
      Kind: 'action',
      Title: 'Schedule FOG Task',
      Class: 'text-info',
      Icon: 'bi-hdd-network',
      IconColour: '#3498db',
      Run: async () => {
        const Host = LinkedFogHost();
        await OpenFogTaskModal(UUID, ClientLabel(Client), Host ? Host.ImageName : null);
      },
    });
  }

  // Replacing swaps an offline client's identity onto a device awaiting adoption.
  if (!Client.Online) {
    const Candidates = (Array.isArray(PendingAdoption) ? PendingAdoption : []).filter(
      (Device) => Device && Device.UUID && String(Device.UUID) !== UUID
    );
    if (Candidates.length) {
      Rows.push({
        Kind: 'action',
        Title: 'Replace Client',
        Class: 'text-warning',
        Icon: 'bi-arrow-left-right',
        IconColour: '#e67e22',
        Run: async () => OpenClientReplacementModal(Client),
      });
    }
  }
  return Rows;
}

async function RenderActions(): Promise<void> {
  if (!Mounted) return;
  const Token = MountToken;
  const { UUID, Client, Fog, Integrated } = Mounted;

  let Options: ContextMenuOption[] = [];
  try {
    // Imported lazily: the menu builder pulls in ./settings and the audio stack.
    const { BuildContextMenuOptions } = await import('./context-menu-options');
    Options = await BuildContextMenuOptions([UUID], { IncludeSelectionRows: false });
  } catch (err) {
    HandleNonFatalError('ClientInfoEdit:BuildActions', err);
  }
  if (Token !== MountToken || !Mounted) return;

  ActionRows = ToActionRows(Options);
  ManageRows = BuildManageRows(Client, Fog, Integrated);

  // Redrawn only when something visible changed: the refresh runs every few
  // seconds, and replacing the buttons under the pointer would eat clicks.
  const Signature = JSON.stringify([
    Editing,
    Busy,
    ActionRows.map((Row) => [Row.Kind, Row.Title, Row.Class, Row.Icon, Row.IconColour]),
    ManageRows.map((Row) => Row.Title),
  ]);
  if (Signature === ActionsSignature) return;
  ActionsSignature = Signature;

  const Disabled = !Editing || Busy ? 'disabled' : '';
  const Button = (Row: ActionRow, Ref: string) =>
    Row.Kind === 'divider'
      ? '<div class="client-info-action-divider" role="separator"></div>'
      : `<button type="button" class="client-info-action ${Safe(Row.Class || '')}" data-client-action="${Ref}" ${Disabled}>
          <i class="bi ${Safe(Row.Icon || 'bi-lightning')}" style="color: ${Safe(Row.IconColour || 'inherit')}" aria-hidden="true"></i>
          <span>${Safe(Row.Title || '')}</span>
        </button>`;

  const ActionsHtml = ActionRows.length
    ? ActionRows.map((Row, Index) => Button(Row, `run:${Index}`)).join('')
    : '<div class="mac-address-empty">No actions are available for this client.</div>';

  $('#CLIENT_INFO_ACTIONS').html(`
    <div class="rounded-3 p-2 bg-ghost-light"><h6 class="mb-0">Actions</h6></div>
    <div class="client-info-action-list">${ActionsHtml}</div>
    <div class="rounded-3 p-2 bg-ghost-light"><h6 class="mb-0">Manage</h6></div>
    <div class="client-info-action-list">
      ${ManageRows.map((Row, Index) => Button(Row, `manage:${Index}`)).join('')}
    </div>
    <button type="button" class="btn btn-delete" id="CLIENT_INFO_DELETE" ${Disabled}>Delete Client</button>
  `);
  $('#CLIENT_INFO_DELETE')
    .off('click')
    .on('click', () => void DeleteClient());
}

async function RunAction(Row: ActionRow): Promise<void> {
  if (!Row.Run || Busy || !Mounted || !Editing) return;
  Busy = true;
  await RenderActions();
  try {
    await Row.Run();
  } catch (err) {
    HandleNonFatalError('ClientInfoEdit:RunAction', err);
  } finally {
    Busy = false;
    // Identify flips to Stop Identifying, and so on.
    await ReloadClient();
    await RenderActions();
  }
}

async function DeleteClient(): Promise<void> {
  if (!Mounted || !Editing) return;
  const { UUID, Client } = Mounted;
  const Label = Client.Nickname || Client.Hostname || 'this client';
  // Confirmed over the open modal, so Cancel leaves the operator where they were.
  const Confirmed = await ConfirmationDialog(
    `Delete ${Label}? It will need to be adopted again to come back.`,
    { ConfirmLabel: 'Delete Client' }
  );
  if (!Confirmed) return;
  const [Err] = ((await window.API.UnadoptClient(UUID)) || []) as [unknown, unknown];
  if (Err) {
    await Notify(`Failed to delete client: ${Err}`, 'error');
    return;
  }
  await CloseAllModals();
  await Notify(`Deleted ${Label}.`, 'success');
}
