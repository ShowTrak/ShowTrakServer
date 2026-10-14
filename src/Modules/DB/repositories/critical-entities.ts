// Repository for the critical-entity tables (CriticalUSBDevices,
// CriticalApplications, CriticalDisplays, CriticalAudioDevices,
// CriticalNetworkInterfaces). Receives the DB manager instead of
// importing it so test DB mocks injected into ClientManager propagate through
// unchanged. SQL strings are byte-identical to the historical inline
// statements — tests match on them.
//
// The three table shapes are deliberately parallel; Phase 4 of
// REFACTOR_PLAN.md generalizes the manager-side triplication on top of this.
import type { DBManager, DBResult } from '../index';
import type {
  CriticalApplicationRow,
  CriticalAudioDeviceRow,
  CriticalNetworkInterfaceRow,
  CriticalDisplayRow,
  CriticalUSBDeviceRow,
  CriticalUSBDeviceNameRow,
} from '../rows';

export function CreateCriticalEntitiesRepository(DB: DBManager) {
  return {
    // --- USB devices --------------------------------------------------------
    LoadAllUSB(): Promise<DBResult<CriticalUSBDeviceRow[]>> {
      return DB.All<CriticalUSBDeviceRow>(
        'SELECT UUID, SerialNumber, ManufacturerName, ProductName, RequirePresent, Location, FirmwareVersion, RequireNoError, Timestamp FROM CriticalUSBDevices'
      );
    },
    MarkUSB(Row: CriticalUSBDeviceRow): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO CriticalUSBDevices (UUID, SerialNumber, ManufacturerName, ProductName, RequirePresent, Location, FirmwareVersion, RequireNoError, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          Row.UUID,
          Row.SerialNumber,
          Row.ManufacturerName,
          Row.ProductName,
          Row.RequirePresent,
          Row.Location,
          Row.FirmwareVersion,
          Row.RequireNoError,
          Row.Timestamp,
        ]
      );
    },
    RemoveUSB(UUID: string, SerialNumber: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalUSBDevices WHERE UUID = ? AND SerialNumber = ?', [
        UUID,
        SerialNumber,
      ]);
    },
    IsUSBCritical(UUID: string, SerialNumber: string): Promise<DBResult<{ Found: number }>> {
      return DB.Get<{ Found: number }>(
        'SELECT 1 AS Found FROM CriticalUSBDevices WHERE UUID = ? AND SerialNumber = ? LIMIT 1',
        [UUID, SerialNumber]
      );
    },
    DeleteAllUSBForClient(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalUSBDevices WHERE UUID = ?', [UUID]);
    },

    // --- Serial-less USB devices (guarded by name + quantity) ---------------
    LoadAllUSBNames(): Promise<DBResult<CriticalUSBDeviceNameRow[]>> {
      return DB.All<CriticalUSBDeviceNameRow>(
        'SELECT UUID, NameKey, ManufacturerName, ProductName, Quantity, RequirePresent, Location, FirmwareVersion, RequireNoError, Timestamp FROM CriticalUSBDeviceNames'
      );
    },
    MarkUSBName(Row: CriticalUSBDeviceNameRow): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO CriticalUSBDeviceNames (UUID, NameKey, ManufacturerName, ProductName, Quantity, RequirePresent, Location, FirmwareVersion, RequireNoError, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          Row.UUID,
          Row.NameKey,
          Row.ManufacturerName,
          Row.ProductName,
          Row.Quantity,
          Row.RequirePresent,
          Row.Location,
          Row.FirmwareVersion,
          Row.RequireNoError,
          Row.Timestamp,
        ]
      );
    },
    RemoveUSBName(UUID: string, NameKey: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalUSBDeviceNames WHERE UUID = ? AND NameKey = ?', [
        UUID,
        NameKey,
      ]);
    },
    IsUSBNameCritical(UUID: string, NameKey: string): Promise<DBResult<{ Found: number }>> {
      return DB.Get<{ Found: number }>(
        'SELECT 1 AS Found FROM CriticalUSBDeviceNames WHERE UUID = ? AND NameKey = ? LIMIT 1',
        [UUID, NameKey]
      );
    },
    DeleteAllUSBNamesForClient(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalUSBDeviceNames WHERE UUID = ?', [UUID]);
    },

    // --- Applications -------------------------------------------------------
    LoadAllApplications(): Promise<DBResult<CriticalApplicationRow[]>> {
      return DB.All<CriticalApplicationRow>(
        'SELECT UUID, ApplicationKey, ApplicationName, Timestamp FROM CriticalApplications'
      );
    },
    MarkApplication(
      UUID: string,
      ApplicationKey: string,
      ApplicationName: string,
      Timestamp: number
    ): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO CriticalApplications (UUID, ApplicationKey, ApplicationName, Timestamp) VALUES (?, ?, ?, ?)',
        [UUID, ApplicationKey, ApplicationName, Timestamp]
      );
    },
    RemoveApplication(UUID: string, ApplicationKey: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalApplications WHERE UUID = ? AND ApplicationKey = ?', [
        UUID,
        ApplicationKey,
      ]);
    },
    IsApplicationCritical(
      UUID: string,
      ApplicationKey: string
    ): Promise<DBResult<{ Found: number }>> {
      return DB.Get<{ Found: number }>(
        'SELECT 1 AS Found FROM CriticalApplications WHERE UUID = ? AND ApplicationKey = ? LIMIT 1',
        [UUID, ApplicationKey]
      );
    },
    DeleteAllApplicationsForClient(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalApplications WHERE UUID = ?', [UUID]);
    },

    // --- Displays -----------------------------------------------------------
    LoadAllDisplays(): Promise<DBResult<CriticalDisplayRow[]>> {
      return DB.All<CriticalDisplayRow>(
        'SELECT UUID, DisplayID, Label, RequirePresent, Width, Height, RefreshRate, ScaleFactor, Rotation, RequirePrimary, PositionX, PositionY, Timestamp FROM CriticalDisplays'
      );
    },
    MarkDisplay(Row: CriticalDisplayRow): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO CriticalDisplays (UUID, DisplayID, Label, RequirePresent, Width, Height, RefreshRate, ScaleFactor, Rotation, RequirePrimary, PositionX, PositionY, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          Row.UUID,
          Row.DisplayID,
          Row.Label,
          Row.RequirePresent,
          Row.Width,
          Row.Height,
          Row.RefreshRate,
          Row.ScaleFactor,
          Row.Rotation,
          Row.RequirePrimary,
          Row.PositionX,
          Row.PositionY,
          Row.Timestamp,
        ]
      );
    },
    RemoveDisplay(UUID: string, DisplayID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalDisplays WHERE UUID = ? AND DisplayID = ?', [
        UUID,
        DisplayID,
      ]);
    },
    IsDisplayCritical(UUID: string, DisplayID: string): Promise<DBResult<{ Found: number }>> {
      return DB.Get<{ Found: number }>(
        'SELECT 1 AS Found FROM CriticalDisplays WHERE UUID = ? AND DisplayID = ? LIMIT 1',
        [UUID, DisplayID]
      );
    },
    DeleteAllDisplaysForClient(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalDisplays WHERE UUID = ?', [UUID]);
    },

    // --- Audio endpoints ----------------------------------------------------
    LoadAllAudio(): Promise<DBResult<CriticalAudioDeviceRow[]>> {
      return DB.All<CriticalAudioDeviceRow>(
        'SELECT UUID, EndpointID, Direction, Name, Channels, SampleRate, RequireDefault, RequireUnmuted, MinVolume, MaxVolume, Timestamp FROM CriticalAudioDevices'
      );
    },
    MarkAudio(Row: CriticalAudioDeviceRow): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO CriticalAudioDevices (UUID, EndpointID, Direction, Name, Channels, SampleRate, RequireDefault, RequireUnmuted, MinVolume, MaxVolume, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          Row.UUID,
          Row.EndpointID,
          Row.Direction,
          Row.Name,
          Row.Channels,
          Row.SampleRate,
          Row.RequireDefault,
          Row.RequireUnmuted,
          Row.MinVolume,
          Row.MaxVolume,
          Row.Timestamp,
        ]
      );
    },
    RemoveAudio(UUID: string, EndpointID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalAudioDevices WHERE UUID = ? AND EndpointID = ?', [
        UUID,
        EndpointID,
      ]);
    },
    DeleteAllAudioForClient(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalAudioDevices WHERE UUID = ?', [UUID]);
    },

    // --- Network interfaces -------------------------------------------------
    LoadAllNetwork(): Promise<DBResult<CriticalNetworkInterfaceRow[]>> {
      return DB.All<CriticalNetworkInterfaceRow>(
        'SELECT UUID, Name, MAC, Family, RequirePresent, Address, RangeStart, RangeEnd, Netmask, Gateway, Timestamp FROM CriticalNetworkInterfaces'
      );
    },
    MarkNetwork(Row: CriticalNetworkInterfaceRow): Promise<DBResult<unknown>> {
      return DB.Run(
        'INSERT OR REPLACE INTO CriticalNetworkInterfaces (UUID, Name, MAC, Family, RequirePresent, Address, RangeStart, RangeEnd, Netmask, Gateway, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          Row.UUID,
          Row.Name,
          Row.MAC,
          Row.Family,
          Row.RequirePresent,
          Row.Address,
          Row.RangeStart,
          Row.RangeEnd,
          Row.Netmask,
          Row.Gateway,
          Row.Timestamp,
        ]
      );
    },
    RemoveNetwork(UUID: string, Name: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalNetworkInterfaces WHERE UUID = ? AND Name = ?', [
        UUID,
        Name,
      ]);
    },
    DeleteAllNetworkForClient(UUID: string): Promise<DBResult<unknown>> {
      return DB.Run('DELETE FROM CriticalNetworkInterfaces WHERE UUID = ?', [UUID]);
    },
  };
}
