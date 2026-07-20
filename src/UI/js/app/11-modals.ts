import { closeAllModals, closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { Config, PendingAdoption, ScriptList, CompactMode } from './01-state';
import { SetCompactMode } from './02-mode';
import { OpenClientInfo } from './client-info-modal';
import { OpenMonitoringTargetHistory, OpenDummyClientHistory } from './07-monitoring';
import { IsIntegratedClientEntity } from './state/client-labels';
import { Safe } from './04-utils';

// Minimum launch delay (seconds); mirrors MIN_LAUNCH_DELAY_SECONDS enforced by
// the server-side ClientUpdatePayload validator.
const MIN_LAUNCH_DELAY_SECONDS = 10;
import {
  ClearSelection,
  ConfirmationDialog,
  Notify,
  ShowExecutionToast,
  Wait,
} from './14-selection-init';
import { IsFogAvailable, OpenFogTaskModal } from './20-fog';
import type { ClientView } from '@showtrak/protocol';

// The former Update Manager and Group Manager god-sections now live in their own
// modules; re-export them so existing `./11-modals` importers keep working.
export * from './11-group-manager';
export * from './11-update-manager';

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

    const License =
      Payload && typeof Payload.license === 'string' ? Payload.license : '';
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

  const { Nickname, Hostname, IP, Version, MacAddress } = Client;

  $('#CLIENT_EDITOR_NICKNAME').val((Nickname ? Nickname : Hostname) || '');
  $('#CLIENT_EDITOR_SLUG').val(Client.Slug || '');
  $('#CLIENT_EDITOR_HOSTNAME').val(Hostname || '');
  $('#CLIENT_EDITOR_IP').val(IP || '');
  if (MacAddress && String(MacAddress).trim().length > 0) {
    $('#CLIENT_EDITOR_MAC').val(MacAddress.toUpperCase());
    $('#CLIENT_EDITOR_MAC_WRAPPER').removeClass('d-none');
  } else {
    $('#CLIENT_EDITOR_MAC').val('');
    $('#CLIENT_EDITOR_MAC_WRAPPER').addClass('d-none');
  }
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

  await PopulateFogSection(UUID, (Nickname ? Nickname : Hostname) || UUID);

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

      await window.API.UpdateClient(UUID, Payload);
      await CloseAllModals();
    });

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
