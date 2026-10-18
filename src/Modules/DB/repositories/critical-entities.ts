// Repository for the per-client side tables of monitored ("critical") entries:
// CriticalUSBDevices, CriticalUSBDeviceNames, CriticalApplications,
// CriticalDisplays, CriticalAudioDevices, CriticalNetworkInterfaces,
// CriticalStorageVolumes and CriticalSystemChecks. Receives the DB manager instead of importing it so test
// DB mocks injected into ClientManager propagate through unchanged.
//
// Every table is the same shape: rows keyed by (UUID, one key column), read in
// full at start-up and written one at a time. So each table's statements are
// generated from its column list instead of being written out per table, which
// is where they had drifted (some tables had a lookup, others not). The column
// list is the INSERT order. Every name interpolated below is a fixed identifier
// from this file, never a value from a request.
//
// A client's rows are removed by ClientsRepo.DeleteClientCascade, in the same
// transaction as the client itself, so there is no per-table bulk delete here.
import type { DBManager, DBResult } from '../index';
import type {
  CriticalApplicationRow,
  CriticalAudioDeviceRow,
  CriticalNetworkInterfaceRow,
  CriticalStorageVolumeRow,
  CriticalDisplayRow,
  CriticalUSBDeviceRow,
  CriticalUSBDeviceNameRow,
  SystemCheckRow,
} from '../rows';

export interface CriticalTable<Row> {
  LoadAll(): Promise<DBResult<Row[]>>;
  /** Insert the row, or replace the one under the same (UUID, key). */
  Mark(Row: Row): Promise<DBResult<unknown>>;
  Remove(UUID: string, Key: string): Promise<DBResult<unknown>>;
  /** Whether a row exists under (UUID, key); `Found` is 1 when it does. */
  Is(UUID: string, Key: string): Promise<DBResult<{ Found: number } | undefined>>;
}

function DefineCriticalTable<Row extends { UUID: string }>(
  DB: DBManager,
  Table: string,
  KeyColumn: keyof Row & string,
  Columns: ReadonlyArray<keyof Row & string>
): CriticalTable<Row> {
  const ColumnList = Columns.join(', ');
  const Placeholders = Columns.map(() => '?').join(', ');
  return {
    LoadAll: () => DB.All<Row>(`SELECT ${ColumnList} FROM ${Table}`),
    Mark: (Row) =>
      DB.Run(
        `INSERT OR REPLACE INTO ${Table} (${ColumnList}) VALUES (${Placeholders})`,
        Columns.map((Column) => Row[Column])
      ),
    Remove: (UUID, Key) =>
      DB.Run(`DELETE FROM ${Table} WHERE UUID = ? AND ${KeyColumn} = ?`, [UUID, Key]),
    Is: (UUID, Key) =>
      DB.Get<{ Found: number } | undefined>(
        `SELECT 1 AS Found FROM ${Table} WHERE UUID = ? AND ${KeyColumn} = ? LIMIT 1`,
        [UUID, Key]
      ),
  };
}

export function CreateCriticalEntitiesRepository(DB: DBManager) {
  return {
    USB: DefineCriticalTable<CriticalUSBDeviceRow>(DB, 'CriticalUSBDevices', 'SerialNumber', [
      'UUID',
      'SerialNumber',
      'ManufacturerName',
      'ProductName',
      'RequirePresent',
      'Location',
      'FirmwareVersion',
      'RequireNoError',
      'Timestamp',
    ]),
    // Serial-less USB devices, guarded by name and quantity.
    USBNames: DefineCriticalTable<CriticalUSBDeviceNameRow>(
      DB,
      'CriticalUSBDeviceNames',
      'NameKey',
      [
        'UUID',
        'NameKey',
        'ManufacturerName',
        'ProductName',
        'Quantity',
        'RequirePresent',
        'Location',
        'FirmwareVersion',
        'RequireNoError',
        'Timestamp',
      ]
    ),
    Applications: DefineCriticalTable<CriticalApplicationRow>(
      DB,
      'CriticalApplications',
      'ApplicationKey',
      [
        'UUID',
        'ApplicationKey',
        'ApplicationName',
        'Timestamp',
        'RequireForeground',
        'RequireResponding',
      ]
    ),
    Displays: DefineCriticalTable<CriticalDisplayRow>(DB, 'CriticalDisplays', 'DisplayID', [
      'UUID',
      'DisplayID',
      'Label',
      'RequirePresent',
      'Width',
      'Height',
      'RefreshRate',
      'ScaleFactor',
      'Rotation',
      'RequirePrimary',
      'PositionX',
      'PositionY',
      'Timestamp',
    ]),
    Audio: DefineCriticalTable<CriticalAudioDeviceRow>(DB, 'CriticalAudioDevices', 'EndpointID', [
      'UUID',
      'EndpointID',
      'Direction',
      'Name',
      'Channels',
      'SampleRate',
      'RequireDefault',
      'RequireUnmuted',
      'MinVolume',
      'MaxVolume',
      'Timestamp',
    ]),
    Network: DefineCriticalTable<CriticalNetworkInterfaceRow>(
      DB,
      'CriticalNetworkInterfaces',
      'Name',
      [
        'UUID',
        'Name',
        'MAC',
        'Family',
        'RequirePresent',
        'Address',
        'RangeStart',
        'RangeEnd',
        'Netmask',
        'Gateway',
        'Timestamp',
      ]
    ),
    Storage: DefineCriticalTable<CriticalStorageVolumeRow>(
      DB,
      'CriticalStorageVolumes',
      'MountPoint',
      [
        'UUID',
        'MountPoint',
        'Name',
        'MinFreePercent',
        'MinFreeGB',
        'RequireWritable',
        'RequireHealthy',
        'Timestamp',
      ]
    ),
    SystemChecks: DefineCriticalTable<SystemCheckRow>(DB, 'CriticalSystemChecks', 'CheckKey', [
      'UUID',
      'CheckKey',
      'MaxPercent',
      'SustainSeconds',
      'MaxDays',
      'RequireMains',
      'MinBatteryPercent',
      'ChargingBelowPercent',
      'MaxCelsius',
      'MaxThermalState',
      'Timestamp',
    ]),
  };
}
