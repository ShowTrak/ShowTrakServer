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
import { GetSettingValue } from './03-settings';
import { Notify, Wait } from './14-selection-init';

const MAX_UNASSIGNED_CLIENTS_PER_REQUEST = 64;

// Mirrors 11-group-manager's local helper: close everything, then let the CSS
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
 * Fails closed: the Web UI cannot read settings at all, so the entry stays
 * hidden there — which is correct, since the channel is desktop-only.
 */
export async function RefreshUnassignedClientMenuVisibility(): Promise<void> {
  let Enabled = false;
  try {
    Enabled = !!(await GetSettingValue('SYSTEM_ALLOW_UNASSIGNED_CLIENTS'));
  } catch {
    Enabled = false;
  }
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
      const Name = String($('#UNASSIGNED_CLIENT_CREATION_NAME').val() || '').trim();
      if (!Name) return Notify('Please enter a name', 'error');
      if (Name.length > 64) return Notify('Name must be 64 characters or less', 'error');

      const Count = Number($('#UNASSIGNED_CLIENT_CREATION_COUNT').val());
      if (!Number.isInteger(Count) || Count < 1) {
        return Notify('How many must be a whole number of at least 1', 'error');
      }
      if (Count > MAX_UNASSIGNED_CLIENTS_PER_REQUEST) {
        return Notify(`You can create at most ${MAX_UNASSIGNED_CLIENTS_PER_REQUEST} at once`, 'error');
      }

      const [Err, Created] = await window.API.CreateUnassignedClients({ Name, Count });
      if (Err) return Notify(String(Err), 'error');

      closeModal('SHOWTRAK_MODAL_UNASSIGNED_CLIENT_CREATION');
      Notify(
        `Created ${Created} unassigned client${Created === 1 ? '' : 's'}`,
        'success'
      );
    });
}
