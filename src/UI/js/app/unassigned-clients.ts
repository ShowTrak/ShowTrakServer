// Unassigned Clients (renderer)
//
// An unassigned client is a reserved slot: a real client row with a random UUID
// and filler details, standing in for hardware that has not arrived yet. The
// operator lays out the show against the slots up front, then fills each one in
// by replacing it with the real device once it appears (which clears the
// reservation and turns the slot into an ordinary client).
//
// The feature is gated behind SYSTEM_ALLOW_UNASSIGNED_CLIENTS, which is off by
// default. This module hides the entry point when the setting is off; the main
// process re-checks the setting and is the actual authority.
import { closeAllModals, closeModal, openModal } from './lib/modal';
import { GetSettingValue } from './settings';
import { Capabilities } from './state/capabilities';
import { Notify, Wait } from './selection-init';
import {
  FormatUnassignedClientsCreated,
  ResolveUnassignedClientsEnabled,
  ValidateUnassignedClientRequest,
} from './lib/unassigned-clients';

// Mirrors group-manager's local helper: close everything, then let the CSS
// transition settle before opening the next modal.
async function CloseAllModals(): Promise<void> {
  closeAllModals();
  await Wait(300);
}

/**
 * Show or hide the "Create Unassigned Client" entry in the + menu to match the
 * setting. Called on boot and whenever settings are pushed, so toggling the
 * setting takes effect without a reload.
 *
 * The two surfaces learn the answer differently. The desktop reads the setting
 * directly. The browser cannot read settings at all, so it relies on the
 * capability hint the server sends at connect, which already folds in both
 * SYSTEM_ALLOW_UNASSIGNED_CLIENTS and WEBUI_ALLOW_UNASSIGNED_CLIENTS. Either
 * way this is only cosmetic: the server re-checks on every create.
 *
 * Fails closed if the setting cannot be read.
 */
export async function RefreshUnassignedClientMenuVisibility(): Promise<void> {
  let SettingValue: unknown = false;
  if (!Capabilities.isWeb) {
    try {
      SettingValue = await GetSettingValue('SYSTEM_ALLOW_UNASSIGNED_CLIENTS');
    } catch {
      SettingValue = false;
    }
  }
  const Enabled = ResolveUnassignedClientsEnabled(Capabilities, SettingValue);
  $('#ADD_UNASSIGNED_CLIENT_ACTION_ITEM').toggleClass('d-none', !Enabled);
}

export async function OpenUnassignedClientCreationModal(): Promise<void> {
  await CloseAllModals();

  $('#UNASSIGNED_CLIENT_CREATION_NAME').val('');
  $('#UNASSIGNED_CLIENT_CREATION_COUNT').val(1);
  $('#UNASSIGNED_CLIENT_CREATION_HINT').text(
    'Creating more than one numbers them automatically. Replace a slot with a real device once you have it.'
  );

  openModal('SHOWTRAK_MODAL_UNASSIGNED_CLIENT_CREATION');

  $('#UNASSIGNED_CLIENT_CREATION_SUBMIT')
    .off('click')
    .on('click', async () => {
      // Rules live in ./lib/unassigned-clients (pure and tested). The main
      // process re-validates and is the authority; this is for the message.
      const Validation = ValidateUnassignedClientRequest(
        $('#UNASSIGNED_CLIENT_CREATION_NAME').val(),
        $('#UNASSIGNED_CLIENT_CREATION_COUNT').val()
      );
      if (!Validation.ok) return Notify(Validation.error, 'error');

      const [Err, Created] = await window.API.CreateUnassignedClients(Validation.payload);
      if (Err) return Notify(String(Err), 'error');

      closeModal('SHOWTRAK_MODAL_UNASSIGNED_CLIENT_CREATION');
      Notify(FormatUnassignedClientsCreated(Created), 'success');
    });
}
