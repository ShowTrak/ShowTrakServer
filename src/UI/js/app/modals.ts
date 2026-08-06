import { closeAllModals, closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { Config, PendingAdoption, ScriptList, CompactMode } from './state';
import { SetCompactMode } from './mode';
import { OpenClientInfo } from './client-info-modal';
import { OpenMonitoringTargetHistory, OpenDummyClientHistory } from './monitoring';
import { IsIntegratedClientEntity } from './state/client-labels';
import { Safe } from './utils';

// Minimum launch delay (seconds); mirrors MIN_LAUNCH_DELAY_SECONDS enforced by
// the server-side ClientUpdatePayload validator.
const MIN_LAUNCH_DELAY_SECONDS = 10;

const CLIENT_EDITOR_TAG_PICKER: TagPickerMount = {
  WrapperSelector: '#CLIENT_EDITOR_TAGS_WRAPPER',
  ListSelector: '#CLIENT_EDITOR_TAGS',
  Namespace: 'clientEditorTags',
};
import {
  ClearSelection,
  ConfirmationDialog,
  Notify,
  ShowExecutionToast,
  Wait,
} from './selection-init';
import { IsFogAvailable, OpenFogTaskModal } from './fog';
import { ClearTagPicker, RenderTagPicker } from './tag-picker';
import type { TagPickerMount } from './tag-picker';
import type { ClientVariableView, ClientView } from '@showtrak/protocol';

// UUID of the client whose editor is currently open, or null. Tracked so a
// SetVariableList push (someone renaming or deleting a variable elsewhere, or on
// the web UI) can redraw the open editor's variable rows instead of leaving
// names that no longer resolve to anything.
let ClientEditorOpenUUID: string | null = null;

// The former Update Manager and Group Manager god-sections now live in their own
// modules; re-export them so existing `./modals` importers keep working.
export * from './group-manager';
export * from './update-manager';

export async function ExecuteScript(
  Script: string | null,
  Targets: string[],
  _ResetList?: unknown
) {
  const ScriptTarget = ScriptList.find((s) => s.ID === Script);
  if (!ScriptTarget) return Notify('Script not found', 'error');
  await window.API.ExecuteScript(Script, Targets, true);
  ShowExecutionToast();
}

// Trigger an integrated client event (declared by an integrated client) on the
// given targets. Mirrors ExecuteScript but uses the integrated event protocol.
export async function TriggerIntegratedEvent(EventID: string, Targets: string[]) {
  await window.API.TriggerIntegratedEvent(EventID, Targets);
  ShowExecutionToast('Integrated Events');
}

// Build the shared header (title + close) for the simpler single-panel modals.
// Titles that change at runtime keep their id via `titleId` so the existing
// `$('#id').text(...)` calls still update them. Run once at boot: the modals'
// placeholder divs are static markup, and every open path runs after this.
export function InitSimpleModalHeaders() {
  const dismiss = (ModalID: string) => () => closeModal(ModalID);
  const build = (PlaceholderID: string, opts: Parameters<typeof buildModalHeader>[0]) =>
    $('#' + PlaceholderID)
      .empty()
      .append(buildModalHeader(opts).$el);

  build('SHORTCUTS_HEADER', {
    title: 'Keyboard Shortcuts',
    onClose: dismiss('SHOWTRAK_MODAL_SHORTCUTS'),
  });
  build('ABOUT_HEADER', { title: 'About', onClose: dismiss('SHOWTRAK_MODAL_ABOUT') });
  build('APP_UPDATE_HEADER', {
    title: 'Software Update',
    onClose: dismiss('SHOWTRAK_MODAL_APP_UPDATE'),
  });
  build('GROUP_MANAGER_HEADER', {
    title: 'Group Manager',
    onClose: dismiss('SHOWTRAK_MODAL_GROUPMANAGER'),
  });
  build('UPDATE_MANAGER_HEADER', {
    title: 'Update Manager',
    onClose: dismiss('SHOWTRAK_MODAL_UPDATE_MANAGER'),
  });
  build('SETTINGS_HEADER', { title: 'Settings', onClose: dismiss('SHOWTRAK_MODAL_SETTINGS') });
  build('FOG_TASK_HEADER', {
    title: 'Schedule FOG Task',
    onClose: dismiss('SHOWTRAK_MODAL_FOG_TASK'),
  });
  build('EXECUTIONQUEUE_HEADER', {
    title: 'Executing Scripts',
    onClose: dismiss('SHOWTRAK_MODEL_EXECUTIONQUEUE'),
  });
  build('CLIENT_EDITOR_HEADER', {
    title: 'Client Settings',
    onClose: dismiss('SHOWTRAK_CLIENT_EDITOR'),
  });
  build('CLIENT_REPLACE_HEADER', {
    title: 'Replace Client',
    titleId: 'CLIENT_REPLACE_MODAL_TITLE',
    onClose: dismiss('SHOWTRAK_MODAL_CLIENT_REPLACE'),
  });
  build('CLIENT_INFO_HEADER', {
    title: 'Client Info',
    titleId: 'CLIENT_INFO_TITLE',
    onClose: dismiss('SHOWTRAK_CLIENT_INFO'),
  });
  build('GROUP_CREATION_HEADER', {
    title: 'Create New Group',
    onClose: dismiss('SHOWTRAL_MODAL_GROUPCREATION'),
  });
  build('UNASSIGNED_CLIENT_CREATION_HEADER', {
    title: 'Create Unassigned Clients',
    onClose: dismiss('SHOWTRAK_MODAL_UNASSIGNED_CLIENT_CREATION'),
  });

  // No-Show and Migrate are intentionally left out: they are static-backdrop
  // prompts that must be answered, and the shared title bar reads as a
  // dismissible/manageable panel, so they keep their plain centred titles.
}

// Called by the bootstrap orchestrator in main.ts — never at import time.
export function InitModals() {
  InitSimpleModalHeaders();

  window.API.OSCBulkAction(async (Type, Targets, Args = null) => {
    if (Type == 'ExecuteScript') return await ExecuteScript(Args, Targets);
    if (Type == 'WOL') {
      window.API.WakeOnLan(Targets);
      ShowExecutionToast();
      return;
    }
    if (Type == 'InternalScript') return;
    // SDK control API: open the view modal for a client, monitor or dummy. The
    // entity type rides in Args (set by ControlService.OpenClientModal); each
    // type has its own renderer view. Missing/unknown Args defaults to a client
    // for backward compatibility with older callers.
    if (Type == 'OpenClientModal') {
      const Id = Array.isArray(Targets) ? Targets[0] : null;
      if (!Id) return;
      if (Args === 'monitor') return await OpenMonitoringTargetHistory(Number(Id));
      if (Args === 'dummy') return await OpenDummyClientHistory(String(Id));
      return await OpenClientInfo(String(Id));
    }
    // SDK control API: dismiss whatever is open. Like OpenClientModal this only
    // reaches the desktop window — the web namespace suppresses both types.
    if (Type == 'CloseModals') return closeAllModals();
    // SDK control API: drive the compact/expanded view (persisted, like the UI).
    if (Type == 'SetCompactView') return SetCompactMode(!!Args, { persist: true });
    if (Type == 'ToggleCompactView') return SetCompactMode(!CompactMode, { persist: true });
  });
}

export async function CloseAllModals() {
  closeAllModals();
  // Forget which entity the tag picker was editing; a tag push arriving after
  // the editor closed would otherwise redraw chips into a hidden modal.
  ClearTagPicker();
  // Same reasoning for the variable rows: a SetVariableList push landing after
  // the editor closed must not repopulate a hidden form.
  ClientEditorOpenUUID = null;
  await Wait(300);
  return;
}

export function FormatDependencyVersion(Version: unknown) {
  const RawVersion = Version ? String(Version) : '';
  const SemverMatch = RawVersion.match(/(\d+)\.(\d+)/);
  if (SemverMatch) return `${SemverMatch[1]}.${SemverMatch[2]}`;
  return RawVersion.replace(/^[~^<>=\s]+/, '') || '-';
}

export function RenderAboutDependencyList(Dependencies: unknown[] = []) {
  const Group = $('<div class="SHOWTRAK_ABOUT_DEPENDENCY_GROUP"></div>');

  if (!Dependencies.length) {
    Group.append($('<div class="text-muted"></div>').text('None'));
    return Group;
  }

  for (const Dependency of Dependencies) {
    const Entry: { name?: unknown; version?: unknown } =
      Dependency && typeof Dependency === 'object'
        ? (Dependency as { name?: unknown; version?: unknown })
        : {};
    const Name = Entry.name ? String(Entry.name) : 'unknown';
    const Version = FormatDependencyVersion(Entry.version);
    const Item = $('<div class="SHOWTRAK_ABOUT_DEPENDENCY_ITEM"></div>');
    const PackageLink = $(
      '<button type="button" class="btn btn-link p-0 SHOWTRAK_ABOUT_DEPENDENCY_LINK"></button>'
    )
      .text(Name)
      .attr('data-package-name', Name);

    Item.append($('<span class="SHOWTRAK_ABOUT_DEPENDENCY_NAME"></span>').append(PackageLink));
    Item.append($('<span class="SHOWTRAK_ABOUT_DEPENDENCY_VERSION"></span>').text(Version));
    Group.append(Item);
  }

  return Group;
}

export async function OpenAboutModal() {
  await CloseAllModals();
  try {
    const Version = Config && Config.Application ? Config.Application.Version : null;
    $('#SHOWTRAK_ABOUT_VERSION').text(Version ? `Version ${Version}` : '');
  } catch {
    $('#SHOWTRAK_ABOUT_VERSION').text('');
  }

  const DependenciesContainer = $('#SHOWTRAK_ABOUT_DEPENDENCIES');
  const DependenciesCount = $('#SHOWTRAK_ABOUT_DEPENDENCY_COUNT');
  DependenciesContainer.empty().text('Loading dependencies...');
  DependenciesCount.text('');

  try {
    const [Err, Payload] = await window.API.GetProjectDependencies();
    if (Err) throw new Error(Err);

    const RuntimeDependencies =
      Payload && Array.isArray(Payload.dependencies) ? Payload.dependencies : [];

    DependenciesContainer.empty();
    DependenciesContainer.append(RenderAboutDependencyList(RuntimeDependencies));
    DependenciesCount.text(`${RuntimeDependencies.length} total`);
  } catch {
    DependenciesContainer.empty().text('Could not load dependencies.');
    DependenciesCount.text('Unavailable');
  }

  const LicenseText = $('#SHOWTRAK_ABOUT_LICENSE');
  const LicenseToggle = $('#SHOWTRAK_ABOUT_LICENSE_TOGGLE');
  LicenseText.addClass('d-none').text('Loading licence...');
  LicenseToggle.text('Show full licence');
  LicenseToggle.off('click').on('click', () => {
    const Hidden = LicenseText.hasClass('d-none');
    LicenseText.toggleClass('d-none', !Hidden);
    LicenseToggle.text(Hidden ? 'Hide full licence' : 'Show full licence');
  });

  try {
    const [Err, Payload] = await window.API.GetLicense();
    if (Err) throw new Error(Err);

    const License = Payload && typeof Payload.license === 'string' ? Payload.license : '';
    if (!License.trim()) throw new Error('Empty licence');

    LicenseText.text(License);
  } catch {
    LicenseText.text('Could not load the licence text.');
  }

  openModal('SHOWTRAK_MODAL_ABOUT');
}

export async function OpenShow() {
  console.log('Opening ShowTrak file');
  const [Err] = await window.API.OpenShow();
  if (Err) {
    if (/cancelled by user/i.test(String(Err))) return;
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Opened ShowTrak file.', 'success');
}

// Derive a display name from a .ShowTrak path: basename without the extension.
export function GetShowFileDisplayName(Path: unknown) {
  if (!Path) return '';
  const Base = String(Path).split(/[\\/]/).pop() || '';
  return Base.replace(/\.showtrak$/i, '');
}

// Show the currently open file name in the navbar (empty when none is open).
export function RenderShowFileName(Path: unknown) {
  $('#APPLICATION_NAVBAR_FILE').text(GetShowFileDisplayName(Path));
}

export async function SaveShow() {
  console.log('Saving ShowTrak file');
  const [Err] = await window.API.SaveShow();
  if (Err) {
    if (/cancelled by user/i.test(String(Err))) return;
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Saved ShowTrak file.', 'success');
}

export async function SaveShowAs() {
  console.log('Saving ShowTrak file');
  const [Err] = await window.API.SaveShowAs();
  if (Err) {
    if (/cancelled by user/i.test(String(Err))) return;
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Saved ShowTrak file.', 'success');
}

export async function NewShow() {
  const Confirmed = await ConfirmationDialog(
    'Create a new show? This clears the current working data.'
  );
  if (!Confirmed) return;
  const [Err] = await window.API.NewShow();
  if (Err) {
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Created new show.', 'success');
}

// Populate the FOG section of the client editor: the host dropdown and the
// "Schedule FOG Task" button.
//
// Every part of this degrades rather than fails. If FOG is disabled or unreachable
// the whole section is hidden and the editor behaves exactly as it did before the
// integration existed — opening a client must never depend on a FOG server being up.
// If FOG is reachable but the host list request failed, the backend hands back its
// cached list, and if that is empty too we still show the currently-linked host so
// the link is visible and clearable.
async function PopulateFogSection(UUID: string, ClientLabel: string): Promise<void> {
  const $Wrapper = $('#CLIENT_EDITOR_FOG_WRAPPER');
  const $Button = $('#SHOWTRAK_CLIENT_EDITOR_FOG_TASK');
  const $Select = $('#CLIENT_EDITOR_FOG_HOST');

  if (!IsFogAvailable()) {
    $Wrapper.addClass('d-none');
    $Button.addClass('d-none');
    return;
  }
  $Wrapper.removeClass('d-none');

  const [LinkErr, Link] = await window.API.GetFogHostLink(UUID);
  const LinkedID = !LinkErr && Link ? Link.FogHostID : null;

  const [HostsErr, Hosts] = await window.API.GetFogHosts();
  const HostList = !HostsErr && Array.isArray(Hosts) ? Hosts : [];

  let Options = '<option value="">Not linked to FOG</option>';
  let Matched = false;
  for (const Host of HostList) {
    const Selected = LinkedID === Host.FogHostID ? 'selected' : '';
    if (Selected) Matched = true;
    Options += `<option value="${Host.FogHostID}" ${Selected}>${Safe(Host.Name)}</option>`;
  }
  // The linked host is missing from the list (FOG unreachable, or the host was
  // deleted in FOG). Keep it selectable from the cached name so the operator can
  // see and clear the stale link instead of it silently vanishing.
  if (LinkedID && !Matched) {
    const CachedName = Link && Link.FogHostName ? Link.FogHostName : `FOG host ${LinkedID}`;
    Options += `<option value="${LinkedID}" selected>${Safe(CachedName)} (unavailable)</option>`;
  }
  $Select.html(Options);

  const SelectedHost = HostList.find((Host) => Host.FogHostID === LinkedID) || null;
  $('#CLIENT_EDITOR_FOG_HINT').text(
    LinkedID
      ? SelectedHost && SelectedHost.ImageName
        ? `Assigned image: ${SelectedHost.ImageName}`
        : 'No image assigned in FOG — Deploy tasks will fail.'
      : 'Link this client to a FOG host to schedule imaging tasks.'
  );

  // Persist the link on change rather than folding it into Save: FOG data lives in
  // its own table and has no business travelling through the client update payload.
  $Select.off('change').on('change', async function () {
    const Raw = String($(this).val() || '').trim();
    const NextID = Raw ? parseInt(Raw, 10) : null;
    const [Err] = await window.API.SetFogHostLink(UUID, NextID);
    if (Err) {
      await Notify(String(Err), 'error');
      return;
    }
    await Notify(NextID ? 'Linked to FOG host.' : 'Unlinked from FOG.', 'success');
    await PopulateFogSection(UUID, ClientLabel);
  });

  const TaskTypes = await window.API.GetFogTaskTypes();
  const CanSchedule = !!LinkedID && TaskTypes.length > 0;
  $Button.toggleClass('d-none', !CanSchedule);
  if (CanSchedule) {
    $Button.off('click').on('click', async () => {
      await OpenFogTaskModal(UUID, ClientLabel, SelectedHost ? SelectedHost.ImageName : null);
    });
  }
}

// Render the client editor's MAC address list and wire its add/remove controls.
//
// Like the FOG section above, edits persist immediately rather than folding into
// Save: these rows live in their own table and have no business travelling
// through the client update payload. Re-reads the client after each change so
// the list reflects what actually landed (a reported address the operator
// removes will be back the moment the client next reports it, and showing it
// gone would be a lie).
async function PopulateMacAddressSection(UUID: string) {
  const Client = await window.API.GetClient(UUID);
  const $Wrapper = $('#CLIENT_EDITOR_MAC_WRAPPER');
  if (!Client) {
    $Wrapper.addClass('d-none');
    return;
  }
  $Wrapper.removeClass('d-none');

  const Entries = Array.isArray(Client.MacAddresses) ? Client.MacAddresses : [];
  const ActiveMac = String(Client.MacAddress || '')
    .toUpperCase()
    .replace(/-/g, ':');

  if (!Entries.length) {
    $('#CLIENT_EDITOR_MAC_LIST').html(
      '<div class="mac-address-empty">No hardware MAC addresses on record.</div>'
    );
  } else {
    let Html = '';
    for (const Entry of Entries) {
      const Mac = String(Entry.MacAddress || '');
      const IsActive = !!ActiveMac && Mac === ActiveMac;
      // Manual entries are labelled so an operator can tell what they typed from
      // what the client reported — the two behave differently on deletion.
      const Tag = IsActive
        ? '<span class="mac-address-tag is-active">Active</span>'
        : Entry.Source === 'Manual'
          ? '<span class="mac-address-tag">Manual</span>'
          : '';
      Html += `
        <div class="mac-address-item">
          <span class="mac-address-value">${Safe(Mac)}</span>
          ${Tag}
          <button
            type="button"
            class="mac-address-remove"
            data-mac="${Safe(Mac)}"
            title="Remove ${Safe(Mac)}"
          ><i class="bi bi-x-lg"></i></button>
        </div>`;
    }
    $('#CLIENT_EDITOR_MAC_LIST').html(Html);
  }

  $('#CLIENT_EDITOR_MAC_LIST .mac-address-remove')
    .off('click')
    .on('click', async function () {
      const Mac = String($(this).data('mac') || '');
      if (!Mac) return;
      const [Err] = await window.API.RemoveClientMacAddress(UUID, Mac);
      if (Err) {
        await Notify(String(Err), 'error');
        return;
      }
      await PopulateMacAddressSection(UUID);
    });

  const AddMacAddress = async () => {
    const $Input = $('#CLIENT_EDITOR_MAC_INPUT');
    const Raw = String($Input.val() || '').trim();
    if (!Raw) return;
    const [Err] = await window.API.AddClientMacAddress(UUID, Raw);
    if (Err) {
      await Notify(String(Err), 'error');
      return;
    }
    $Input.val('');
    await PopulateMacAddressSection(UUID);
  };

  $('#CLIENT_EDITOR_MAC_ADD').off('click').on('click', AddMacAddress);
  $('#CLIENT_EDITOR_MAC_INPUT')
    .off('keydown')
    .on('keydown', async (Event) => {
      // Enter adds the address rather than submitting the surrounding editor,
      // which would close the modal and discard the half-typed entry.
      if (Event.key !== 'Enter') return;
      Event.preventDefault();
      await AddMacAddress();
    });
}

/**
 * Render this client's variable rows: one per variable defined in the show,
 * each pre-filled with the client's own value or left empty to inherit.
 *
 * The placeholder carries the default, so an empty box reads as "uses the
 * default: TEST_GAME" rather than as an unexplained blank. That distinction is
 * the whole model — an empty field keeps tracking the default forever, while a
 * typed value pins this machine to it.
 */
async function PopulateVariablesSection(UUID: string, IsIntegrated: boolean): Promise<void> {
  const Wrapper = $('#CLIENT_EDITOR_VARIABLES_WRAPPER');
  const List = document.getElementById('CLIENT_EDITOR_VARIABLES_LIST') as HTMLElement | null;
  if (!List) return;

  // Integrated clients run no local agent and execute no scripts, so there is
  // nothing to inject into — the server rejects the field for them anyway.
  if (IsIntegrated) {
    Wrapper.addClass('d-none');
    List.innerHTML = '';
    return;
  }

  let Variables: ClientVariableView[] = [];
  try {
    Variables = (await window.API.GetClientVariables(UUID)) || [];
  } catch {
    Variables = [];
  }

  // Nothing defined yet: hide the section entirely rather than showing an empty
  // box on every client editor in a show that does not use variables.
  if (!Variables.length) {
    Wrapper.addClass('d-none');
    List.innerHTML = '';
    return;
  }

  Wrapper.removeClass('d-none');
  List.innerHTML = '';

  for (const Variable of Variables) {
    const Placeholder = Variable.DefaultValue
      ? `Default: ${Variable.DefaultValue}`
      : 'No default value';
    const Row = document.createElement('div');
    Row.className = 'form-floating';
    Row.innerHTML = `
      <input
        type="text"
        class="form-control st-client-variable"
        id="CLIENT_EDITOR_VARIABLE_${Safe(String(Variable.VariableID))}"
        data-variableid="${Safe(String(Variable.VariableID))}"
        placeholder="${Safe(Placeholder)}"
        autocomplete="off"
        spellcheck="false"
      />
      <label for="CLIENT_EDITOR_VARIABLE_${Safe(String(Variable.VariableID))}">${Safe(Variable.EnvironmentKey)}</label>
    `;
    const Input = Row.querySelector('input') as HTMLInputElement;
    // Set the value via the property rather than the markup so a value
    // containing quotes cannot break out of the attribute.
    Input.value = Variable.Value == null ? '' : Variable.Value;
    List.appendChild(Row);
  }
}

/**
 * Collect the editor's variable rows into the override map the server expects.
 *
 * An empty box means "inherit", which is null — NOT an empty string. Sending ''
 * would pin the client to an empty value and silently stop it tracking the
 * default, which is the opposite of what clearing a field looks like it does.
 */
function CollectClientVariables(): Record<string, string | null> {
  const Result: Record<string, string | null> = {};
  document.querySelectorAll<HTMLInputElement>('.st-client-variable').forEach((Input) => {
    const VariableID = String(Input.getAttribute('data-variableid') || '').trim();
    if (!VariableID) return;
    const Value = Input.value;
    Result[VariableID] = Value === '' ? null : Value;
  });
  return Result;
}

/**
 * Redraw the open client editor's variable rows after the variable set changed
 * elsewhere. A no-op when no editor is open.
 *
 * Any value the operator had typed but not yet saved is deliberately discarded:
 * the row it belonged to may no longer exist, and re-applying half of a stale
 * form is worse than showing them the current truth.
 */
export async function RefreshClientEditorVariablesIfMounted(): Promise<void> {
  if (!ClientEditorOpenUUID) return;
  const UUID = ClientEditorOpenUUID;
  const Client = await window.API.GetClient(UUID);
  if (!Client || ClientEditorOpenUUID !== UUID) return;
  await PopulateVariablesSection(UUID, IsIntegratedClientEntity(Client));
}

export async function OpenClientEditor(UUID: string) {
  const Client = await window.API.GetClient(UUID);
  if (!Client) return console.error('Client not found:', UUID);

  let Groups = await window.API.GetAllGroups();
  if (!Groups) Groups = [];
  Groups.push({
    GroupID: null,
    Title: 'No Group',
    Weight: 100000,
  } as unknown as (typeof Groups)[number]);

  $('#CLIENT_EDITOR_GROUPID').html('');
  for (const Group of Groups) {
    $('#CLIENT_EDITOR_GROUPID').append(
      `<option value="${Group.GroupID}" ${Client.GroupID == Group.GroupID ? 'selected' : ''}>${Safe(
        Group.Title
      )}</option>`
    );
  }

  ClearSelection();

  const { Nickname, Hostname, IP, Version } = Client;

  $('#CLIENT_EDITOR_NICKNAME').val((Nickname ? Nickname : Hostname) || '');
  $('#CLIENT_EDITOR_SLUG').val(Client.Slug || '');
  $('#CLIENT_EDITOR_HOSTNAME').val(Hostname || '');
  $('#CLIENT_EDITOR_IP').val(IP || '');
  // Unlike the old single read-only MAC field, this section always shows — a
  // client with no MAC on record is exactly the case where an operator needs to
  // add one by hand.
  $('#CLIENT_EDITOR_MAC_INPUT').val('');
  await PopulateMacAddressSection(UUID);
  $('#CLIENT_EDITOR_UUID').val(UUID);
  $('#CLIENT_EDITOR_VERSION').val(Version || '');

  // Run-on-launch script + delay. Hidden for integrated clients (they run no
  // local agent). Populated from the live script catalog; "None" clears it.
  const IsIntegrated = IsIntegratedClientEntity(Client);
  $('#CLIENT_EDITOR_LAUNCH_WRAPPER').toggleClass('d-none', IsIntegrated);
  if (!IsIntegrated) {
    const LaunchScripts = [...ScriptList].sort(
      (a, b) => (a.Weight || 0) - (b.Weight || 0) || String(a.Name).localeCompare(String(b.Name))
    );
    let LaunchOptions = '<option value="">None</option>';
    for (const Script of LaunchScripts) {
      const Selected = Client.RunOnLaunchScriptID === Script.ID ? 'selected' : '';
      LaunchOptions += `<option value="${Safe(Script.ID)}" ${Selected}>${Safe(Script.Name)}</option>`;
    }
    $('#CLIENT_EDITOR_RUNONLAUNCH_SCRIPT').html(LaunchOptions);
    $('#CLIENT_EDITOR_RUNONLAUNCH_DELAY').val(
      Client.RunOnLaunchDelaySeconds ?? MIN_LAUNCH_DELAY_SECONDS
    );
  }

  // A ShowTrak client's scope ID is its bare UUID. Rendered from the live tag
  // cache and refreshed by the SetTagList push, so chips stay correct if a tag
  // is edited elsewhere while this editor is open.
  RenderTagPicker(CLIENT_EDITOR_TAG_PICKER, {
    ScopedID: String(UUID),
    GroupID: Client.GroupID ?? null,
  });

  // Moving the client to another group changes which tags it inherits, so the
  // chips are re-derived as soon as the selection changes rather than only
  // after save — otherwise the picker would advertise the old group's tags.
  $('#CLIENT_EDITOR_GROUPID')
    .off('change.clientEditorTags')
    .on('change.clientEditorTags', function () {
      const Raw = $(this).val();
      const Next = Raw == null || Raw === 'null' ? null : parseInt(String(Raw), 10);
      RenderTagPicker(CLIENT_EDITOR_TAG_PICKER, {
        ScopedID: String(UUID),
        GroupID: Number.isFinite(Next as number) ? (Next as number) : null,
      });
    });

  await PopulateFogSection(UUID, (Nickname ? Nickname : Hostname) || UUID);
  await PopulateVariablesSection(UUID, IsIntegrated);

  $('#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES').html('');
  // USB section moved to read-only Client Info modal
  $('#SHOWTRAK_CLIENT_EDITOR_USB_DEVICES').remove();

  $('#SHOWTRAK_CLIENT_EDITOR_UPDATE')
    .off('click')
    .on('click', async () => {
      await CloseAllModals();
      await window.API.CheckForUpdatesOnClient(UUID);
      ShowExecutionToast();
    });

  $('#SHOWTRAK_CLIENT_EDITOR_REMOVE')
    .off('click')
    .on('click', async () => {
      await CloseAllModals();
      const Confirmation = await ConfirmationDialog(
        `Are you sure you want to delete ${Nickname || Hostname}?`
      );
      if (!Confirmation) return;
      await window.API.UnadoptClient(UUID);
      await Notify(`Unadopted ${Nickname ? Nickname : Hostname}`, 'success');
    });

  const replacementCandidates = (Array.isArray(PendingAdoption) ? PendingAdoption : []).filter(
    (Device) => Device && Device.UUID && String(Device.UUID) !== String(UUID)
  );
  const canReplace = !Client.Online;
  $('#SHOWTRAK_CLIENT_EDITOR_REPLACE')
    .toggleClass('d-none', !canReplace)
    .prop('disabled', replacementCandidates.length === 0)
    .off('click')
    .on('click', async () => {
      await OpenClientReplacementModal(Client);
    });

  $('#SHOWTRAK_CLIENT_EDITOR_SAVE')
    .off('click')
    .on('click', async () => {
      let Nickname = $('#CLIENT_EDITOR_NICKNAME').val();
      if (!Nickname) Nickname = Hostname || '';

      const GroupIDRaw = $('#CLIENT_EDITOR_GROUPID').val();
      let GroupID: number | null;
      if (GroupIDRaw == null || GroupIDRaw === 'null') {
        GroupID = null;
      } else {
        GroupID = parseInt(String(GroupIDRaw));
      }

      const Payload: Record<string, unknown> = {
        Nickname: Nickname,
        GroupID: GroupID,
      };

      // Slug: only send when the operator actually changed it (a slug never
      // auto-changes once set). Empty input is ignored so the existing slug
      // stands.
      const SlugRaw = String($('#CLIENT_EDITOR_SLUG').val() || '').trim();
      if (SlugRaw && SlugRaw !== (Client.Slug || '')) {
        Payload.Slug = SlugRaw;
      }

      // Only send launch fields for non-integrated clients (the server rejects
      // them for integrated clients regardless).
      if (!IsIntegrated) {
        const ScriptIDRaw = String($('#CLIENT_EDITOR_RUNONLAUNCH_SCRIPT').val() || '');
        const RunOnLaunchScriptID = ScriptIDRaw ? ScriptIDRaw : null;
        let RunOnLaunchDelaySeconds: number | null = null;
        if (RunOnLaunchScriptID) {
          const ParsedDelay = parseInt(String($('#CLIENT_EDITOR_RUNONLAUNCH_DELAY').val()), 10);
          RunOnLaunchDelaySeconds = Math.max(
            MIN_LAUNCH_DELAY_SECONDS,
            Number.isFinite(ParsedDelay) ? ParsedDelay : MIN_LAUNCH_DELAY_SECONDS
          );
        }
        Payload.RunOnLaunchScriptID = RunOnLaunchScriptID;
        Payload.RunOnLaunchDelaySeconds = RunOnLaunchDelaySeconds;
      }

      // Only send variables when the section is actually rendered. An integrated
      // client (or a show with no variables defined) has no rows, and sending an
      // empty map would be indistinguishable from "clear every override".
      if (!IsIntegrated && document.querySelector('.st-client-variable')) {
        Payload.Variables = CollectClientVariables();
      }

      await window.API.UpdateClient(UUID, Payload);
      await CloseAllModals();
    });

  ClientEditorOpenUUID = UUID;
  openModal('SHOWTRAK_CLIENT_EDITOR');
}

export async function OpenClientReplacementModal(Client: ClientView) {
  if (!Client || !Client.UUID) return;
  const currentUUID = String(Client.UUID);
  const currentName = Client.Nickname || Client.Hostname || currentUUID;
  const candidates = (Array.isArray(PendingAdoption) ? PendingAdoption : []).filter(
    (Device) => Device && Device.UUID && String(Device.UUID) !== currentUUID
  );

  $('#CLIENT_REPLACE_MODAL_TITLE').text(`Replace ${currentName}`);

  if (!candidates.length) {
    $('#CLIENT_REPLACE_LIST').html(`
      <div class="rounded-3 p-3 bg-ghost text-muted text-center">
        No devices are pending adoption.
      </div>
    `);
  } else {
    let html = '';
    for (const Device of candidates) {
      const Name = Device.Hostname || 'Unknown Host';
      const IP = Device.IP || 'Unknown IP';
      const ReplacementUUID = String(Device.UUID);
      html += `
        <div class="SHOWTRAK_CLIENT_PENDING_ADOPTION rounded-3 d-flex justify-content-between align-items-center p-3">
          <div class="text-start">
            <h6 class="mb-1">${Safe(Name)}</h6>
            <small class="text-sm text-light">${Safe(IP)}</small>
          </div>
          <button
            type="button"
            class="btn btn-sm btn-warning SHOWTRAK_BTN_ROUNDED REPLACE_CLIENT_BTN"
            data-current-uuid="${Safe(currentUUID)}"
            data-replacement-uuid="${Safe(ReplacementUUID)}"
          >
            Replace
          </button>
        </div>
      `;
    }
    $('#CLIENT_REPLACE_LIST').html(html);
  }

  $('#CLIENT_REPLACE_LIST')
    .off('click.replace', '.REPLACE_CLIENT_BTN')
    .on('click.replace', '.REPLACE_CLIENT_BTN', async function () {
      const CurrentUUID = String($(this).attr('data-current-uuid') || '').trim();
      const ReplacementUUID = String($(this).attr('data-replacement-uuid') || '').trim();
      if (!CurrentUUID || !ReplacementUUID) return;

      $('#CLIENT_REPLACE_LIST .REPLACE_CLIENT_BTN').prop('disabled', true);
      const [Err] = await window.API.ReplaceClient(CurrentUUID, ReplacementUUID);
      if (Err) {
        await Notify(String(Err), 'error');
        $('#CLIENT_REPLACE_LIST .REPLACE_CLIENT_BTN').prop('disabled', false);
        return;
      }

      await CloseAllModals();
      await Notify('Client replaced successfully', 'success');
    });

  await CloseAllModals();
  openModal('SHOWTRAK_MODAL_CLIENT_REPLACE');
}

export async function AdoptDevice(UUID: string) {
  await window.API.AdoptDevice(UUID);
}
