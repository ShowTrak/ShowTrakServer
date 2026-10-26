import { closeAllModals, closeModal, openModal } from './lib/modal';
import { buildModalHeader } from './lib/modal-header';
import { Config, PendingAdoption, ScriptList, CompactMode } from './state';
import { SetCompactMode } from './mode';
import { OpenClientInfo } from './client-info-modal';
import { OpenMonitoringTargetHistory, OpenDummyClientHistory } from './monitoring';
import { Safe } from './utils';
import { ConfirmationDialog, Notify, ShowExecutionToastIfActive, Wait } from './selection-init';
import { ClearTagPicker } from './tag-picker';
import type { ClientView, ShowFileUpgrade } from '@showtrak/protocol';

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
  if (!ScriptTarget) return Notify('Script not found.', 'error');
  await window.API.ExecuteScript(Script, Targets, true);
  ShowExecutionToastIfActive();
}

// Trigger an integrated client event (declared by an integrated client) on the
// given targets. Mirrors ExecuteScript but uses the integrated event protocol.
export async function TriggerIntegratedEvent(EventID: string, Targets: string[]) {
  await window.API.TriggerIntegratedEvent(EventID, Targets);
  ShowExecutionToastIfActive('Integrated Events');
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
  build('SETTINGS_HEADER', {
    title: 'ShowTrak Preferences',
    onClose: dismiss('SHOWTRAK_MODAL_SETTINGS'),
  });
  build('FOG_TASK_HEADER', {
    title: 'Schedule FOG Task',
    onClose: dismiss('SHOWTRAK_MODAL_FOG_TASK'),
  });
  build('EXECUTIONQUEUE_HEADER', {
    title: 'Executing Scripts',
    onClose: dismiss('SHOWTRAK_MODEL_EXECUTIONQUEUE'),
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
    onClose: dismiss('SHOWTRAK_MODAL_GROUPCREATION'),
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
      ShowExecutionToastIfActive();
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
  DependenciesContainer.empty().text('Loading dependencies…');
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
    DependenciesContainer.empty().text('Failed to load dependencies.');
    DependenciesCount.text('Unavailable');
  }

  const LicenseText = $('#SHOWTRAK_ABOUT_LICENSE');
  const LicenseToggle = $('#SHOWTRAK_ABOUT_LICENSE_TOGGLE');
  LicenseText.addClass('d-none').text('Loading licence…');
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
    LicenseText.text('Failed to load the licence text.');
  }

  openModal('SHOWTRAK_MODAL_ABOUT');
}

export async function OpenShow() {
  console.log('Opening ShowTrak file');
  const [Err, Outcome] = await window.API.OpenShow();
  if (Err) {
    if (/cancelled by user/i.test(String(Err))) return;
    await Notify(String(Err), 'error');
    return;
  }
  if (Outcome && Outcome.Status === 'UpgradeRequired') {
    await PromptShowFileUpgrade(Outcome.Upgrade);
    return;
  }
  await Notify('Opened show file.', 'success');
}

const NO_SHOW_DEFAULT_MESSAGE = 'Open an existing show file or create a new one to get started.';

// The empty state: no show file is open, so ask for one. Message replaces the
// default prompt (e.g. to say the last show file has gone missing).
export function OpenNoShowPrompt(Message: string = NO_SHOW_DEFAULT_MESSAGE) {
  $('#NO_SHOW_MESSAGE').text(Message);
  openModal('SHOWTRAK_MODAL_NO_SHOW');
}

// Ask the operator whether to upgrade a show file an older ShowTrak Server
// saved. Accepting backs the original up and upgrades it; declining leaves it
// untouched and starts a new show file instead, falling back to the empty state
// if they then cancel choosing where to save it. Resolves once they answer.
export function PromptShowFileUpgrade(Upgrade: ShowFileUpgrade): Promise<void> {
  const SavedWith = Upgrade.FileVersion
    ? `ShowTrak Server v${Upgrade.FileVersion}`
    : 'an earlier version of ShowTrak Server';
  $('#UPGRADE_SHOW_MESSAGE').text(
    `${Upgrade.FileName} was last saved with ${SavedWith}. Opening it in v${Upgrade.CurrentVersion} ` +
      'upgrades the file, and older versions may not be able to open it afterwards.'
  );
  closeModal('SHOWTRAK_MODAL_NO_SHOW');
  openModal('SHOWTRAK_MODAL_UPGRADE_SHOW');

  const Buttons = $('#UPGRADE_SHOW_ACCEPT, #UPGRADE_SHOW_DECLINE');
  return new Promise((resolve) => {
    const Answer = async (Accept: boolean) => {
      Buttons.prop('disabled', true);
      const [Err] = await window.API.ResolveShowFileUpgrade(Accept);
      Buttons.prop('disabled', false);
      if (Err) {
        await Notify(String(Err), 'error');
        // Still waiting on an answer (the backup failed, say): let them retry.
        const [, StillPending] = await window.API.CheckShowFileUpgrade();
        if (StillPending) return;
      }
      Buttons.off('click.showUpgrade');
      closeModal('SHOWTRAK_MODAL_UPGRADE_SHOW');
      if (!Err && Accept) await Notify(`Backed up and upgraded ${Upgrade.FileName}.`, 'success');
      if (!Err && !Accept) await CreateNewShowFile();
      if (!(await window.API.GetCurrentShowFile())) OpenNoShowPrompt();
      resolve();
    };
    Buttons.off('click.showUpgrade');
    $('#UPGRADE_SHOW_ACCEPT').on('click.showUpgrade', () => Answer(true));
    $('#UPGRADE_SHOW_DECLINE').on('click.showUpgrade', () => Answer(false));
  });
}

// Create a new show file, choosing where it is saved first. False when the
// operator cancelled the location prompt (nothing has changed) or it failed.
export async function CreateNewShowFile(): Promise<boolean> {
  const [Err] = await window.API.NewShow();
  if (Err) {
    if (!/cancelled by user/i.test(String(Err))) await Notify(String(Err), 'error');
    return false;
  }
  await Notify('Created new show file.', 'success');
  return true;
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
  await Notify('Saved show file.', 'success');
}

export async function SaveShowAs() {
  console.log('Saving ShowTrak file');
  const [Err] = await window.API.SaveShowAs();
  if (Err) {
    if (/cancelled by user/i.test(String(Err))) return;
    await Notify(String(Err), 'error');
    return;
  }
  await Notify('Saved show file.', 'success');
}

export async function NewShow() {
  const Confirmed = await ConfirmationDialog(
    'Create a new show file? You choose where to save it, then the current working data is cleared.',
    { ConfirmLabel: 'New Show File' }
  );
  if (!Confirmed) return;
  await CreateNewShowFile();
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
      await Notify('Client replaced successfully.', 'success');
    });

  await CloseAllModals();
  openModal('SHOWTRAK_MODAL_CLIENT_REPLACE');
}

export async function AdoptDevice(UUID: string) {
  await window.API.AdoptDevice(UUID);
}
