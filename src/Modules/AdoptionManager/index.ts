// AdoptionManager
// - Tracks devices that are discoverable but not yet adopted into the DB
// - Provides a small in-memory list for the UI and transitions to adopted
import { CreateLogger } from '../Logger';
import { Manager as BroadcastManager } from '../Broadcast';
import type { ValidatedAdoptionHeartbeat } from '../SocketValidation';

const Logger = CreateLogger('AdoptionManager');

// Not-yet-migrated JS manager, typed loosely until its own migration.
import { Manager as ClientManager } from '../ClientManager';

// Ephemeral list of discoverable, not-yet-adopted clients
let ClientsPendingAdoption: ClientPendingAdoption[] = [];

class ClientPendingAdoption {
  State: string;
  UUID: string;
  Hostname: string;
  Version: string;
  IP: string;
  Identifying: boolean;

  constructor(UUID: string, IP: string | null | undefined, Data: ValidatedAdoptionHeartbeat) {
    this.State = 'Pending';
    this.UUID = UUID;
    this.Hostname = Data.Hostname || 'No Hostname Found';
    this.Version = Data.Version || 'No Version Found';
    this.IP = IP || 'No IP Found';
    // Identify mode (RAM-only): pulses the pending tile blue while active.
    this.Identifying = false;
  }
}

const Manager = {
  GetClientsPendingAdoption(): ClientPendingAdoption[] {
    return ClientsPendingAdoption;
  },

  // Reset the list (e.g., on reinitialize)
  async ClearAllDevicesPendingAdoption(): Promise<void> {
    ClientsPendingAdoption = [];
    BroadcastManager.emit('AdoptionListUpdated');
    return;
  },

  // Register or refresh a device in the pending list; if already adopted, trigger readopt flow
  async AddClientPendingAdoption(
    UUID: string,
    IP: string | null | undefined,
    Data: ValidatedAdoptionHeartbeat
  ): Promise<void> {
    const IsClientMeantToBeAdopted = await ClientManager.Exists(UUID);
    if (IsClientMeantToBeAdopted) {
      Manager.RemoveClientPendingAdoption(UUID);
      Logger.log(`Client ${UUID} is already adopted, removing from pending adoption list.`);
      BroadcastManager.emit('ReadoptDevice', UUID);
      return;
    } else {
      // Already listed: refresh whatever the device has since told us, so an
      // entry first seen with placeholders fills in as details arrive.
      const existingClient = ClientsPendingAdoption.find((client) => client.UUID === UUID);
      if (existingClient) {
        const Fresh = new ClientPendingAdoption(UUID, IP, Data);
        let Changed = false;
        if (Data.Hostname && existingClient.Hostname !== Fresh.Hostname) {
          existingClient.Hostname = Fresh.Hostname;
          Changed = true;
        }
        if (Data.Version && existingClient.Version !== Fresh.Version) {
          existingClient.Version = Fresh.Version;
          Changed = true;
        }
        if (IP && existingClient.IP !== Fresh.IP) {
          existingClient.IP = Fresh.IP;
          Changed = true;
        }
        if (Changed) BroadcastManager.emit('AdoptionListUpdated');
        return;
      }
      ClientsPendingAdoption.push(new ClientPendingAdoption(UUID, IP, Data));
      Logger.log(`Client ${UUID} added to pending adoption list.`);
      BroadcastManager.emit('AdoptionListUpdated');
      return;
    }
  },

  // Toggle identify mode for a pending device so its tile pulses blue.
  // Returns true when the device exists in the pending list.
  SetIdentifying(UUID: string, Identifying: unknown): boolean {
    const client = ClientsPendingAdoption.find((client) => client.UUID === UUID);
    if (!client) return false;
    client.Identifying = !!Identifying;
    BroadcastManager.emit('AdoptionListUpdated');
    return true;
  },

  // Update UI-visible state for a pending device (e.g., "Adopting")
  async SetState(UUID: string, State: string): Promise<void> {
    const client = ClientsPendingAdoption.find((client) => client.UUID === UUID);
    if (!client) {
      Logger.log(`Client ${UUID} not found in pending adoption list.`);
      return;
    }
    client.State = State;
    Logger.log(`Client ${UUID} state set to ${State}.`);
    BroadcastManager.emit('AdoptionListUpdated');
    return;
  },

  IsPendingAdoption(UUID: string): boolean {
    return ClientsPendingAdoption.some((client) => client.UUID === UUID);
  },

  // Remove a device from the pending list; safe if missing
  RemoveClientPendingAdoption(UUID: string): void {
    const index = ClientsPendingAdoption.findIndex((client) => client.UUID === UUID);
    if (index !== -1) {
      ClientsPendingAdoption.splice(index, 1);
      BroadcastManager.emit('AdoptionListUpdated');
      Logger.log(`Client ${UUID} removed from pending adoption list.`);
    } else {
      Logger.log(`Client ${UUID} not found in pending adoption list.`);
    }
    return;
  },
};

export { Manager };
