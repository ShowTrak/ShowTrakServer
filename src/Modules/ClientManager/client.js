// Client
// In-memory representation of a connected ShowTrak client. Holds high-churn
// runtime state (online, vitals, USB devices, NICs) plus durable fields that
// are mirrored to the database. Emits BroadcastManager events on changes so
// the UI and other modules stay reactive.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ClientManager');

const { Manager: DB } = require('../DB');
const { Manager: BroadcastManager } = require('../Broadcast');

function getDBRunner(markUnsaved = true) {
  if (markUnsaved === false && typeof DB.RunWithoutDirtyTracking === 'function') {
    return DB.RunWithoutDirtyTracking.bind(DB);
  }
  return DB.Run.bind(DB);
}

function normalizeSerialNumber(SerialNumber) {
  if (typeof SerialNumber !== 'string') return null;
  const Value = SerialNumber.trim();
  if (!Value) return null;
  return Value.toUpperCase();
}

class Client {
  constructor(Data) {
    this.UUID = Data.UUID;
    this.Nickname = Data.Nickname ? Data.Nickname : Data.Hostname;
    this.Hostname = Data.Hostname || null;
    this.OperatingSystem = Data.OperatingSystem || null;
    this.GroupID = Data.GroupID || null;
    // Weight supports manual ordering within groups; defaults to 100 if unspecified
    this.Weight = typeof Data.Weight === 'number' ? Data.Weight : 100;
    this.MacAddress = Data.MacAddress || null;
    this.Version = Data.Version || null;
    this.IP = Data.IP || null;
    this.Timestamp = Data.Timestamp;

    this.Online = false;
    this.LastSeen = Date.now();
    this.Vitals = {
      CPU: {},
      Ram: {},
      Uptime: {},
    };
    this.ConnectedUSBDeviceList = [];
    this.USBDeviceList = [];
    this.CriticalUSBDevices = [];
    this.CriticalUSBSerials = [];
    this.MissingCriticalUSBDevices = [];
    this.Degraded = false;
    this.DegradedWarnings = [];
    this.NetworkInterfaces = [];
    this.ScriptsFingerprint = null;
  }

  // RAM-only fields and notifications
  SetOnline(Online) {
    if (this.Online === Online) return;
    this.Online = Online;
    this._refreshClientHealthState();
    Logger.debug(`Client ${this.UUID} Online updated to ${Online}`);
    BroadcastManager.emit('ClientUpdated', this);
    return;
  }
  SetLastSeen(LastSeen) {
    if (this.LastSeen === LastSeen) return;
    this.LastSeen = LastSeen;
    // Intentionally quiet: LastSeen is high-churn and not UI-critical.
    return;
  }
  SetVitals(Vitals) {
    this.Vitals = Vitals;
    // Broadcast vitals so UI can animate/refresh live stats.
    BroadcastManager.emit('ClientUpdated', this);
  }
  SetUSBDeviceList(USBDeviceList) {
    this.ConnectedUSBDeviceList = Array.isArray(USBDeviceList) ? USBDeviceList : [];
    this._rebuildUSBDeviceView();
    Logger.debug(`Client ${this.UUID} USB Device List updated`);
    BroadcastManager.emit('ClientUpdated', this);
    return;
  }
  SetCriticalUSBDevices(Devices) {
    if (!Array.isArray(Devices)) Devices = [];
    const Normalized = [];
    const Seen = new Set();
    for (const Entry of Devices) {
      const SerialNumber = normalizeSerialNumber(Entry && Entry.SerialNumber);
      if (!SerialNumber || Seen.has(SerialNumber)) continue;
      Seen.add(SerialNumber);
      Normalized.push({
        SerialNumber,
        ManufacturerName: Entry && Entry.ManufacturerName ? String(Entry.ManufacturerName) : null,
        ProductName: Entry && Entry.ProductName ? String(Entry.ProductName) : null,
        Timestamp: Entry && Entry.Timestamp ? Entry.Timestamp : null,
      });
    }
    this.CriticalUSBDevices = Normalized;
    this.CriticalUSBSerials = Normalized.map((Entry) => Entry.SerialNumber);
    this._rebuildUSBDeviceView();
    return;
  }
  IsUSBDeviceCritical(SerialNumber) {
    const Normalized = normalizeSerialNumber(SerialNumber);
    if (!Normalized) return false;
    return this.CriticalUSBSerials.includes(Normalized);
  }
  MarkCriticalUSBDevice(Device) {
    const SerialNumber = Device && Device.SerialNumber;
    const Normalized = normalizeSerialNumber(SerialNumber);
    if (!Normalized) return false;
    const Existing = this.CriticalUSBDevices.find((Entry) => Entry.SerialNumber === Normalized);
    if (Existing) {
      if (!Existing.ManufacturerName && Device && Device.ManufacturerName) {
        Existing.ManufacturerName = String(Device.ManufacturerName);
      }
      if (!Existing.ProductName && Device && Device.ProductName) {
        Existing.ProductName = String(Device.ProductName);
      }
      if (!Existing.Timestamp && Device && Device.Timestamp) {
        Existing.Timestamp = Device.Timestamp;
      }
      this._rebuildUSBDeviceView();
      return false;
    }

    this.CriticalUSBDevices.push({
      SerialNumber: Normalized,
      ManufacturerName: Device && Device.ManufacturerName ? String(Device.ManufacturerName) : null,
      ProductName: Device && Device.ProductName ? String(Device.ProductName) : null,
      Timestamp: Device && Device.Timestamp ? Device.Timestamp : null,
    });
    this.CriticalUSBSerials = this.CriticalUSBDevices.map((Entry) => Entry.SerialNumber);
    this._rebuildUSBDeviceView();
    return true;
  }
  UnmarkCriticalUSBSerial(SerialNumber) {
    const Normalized = normalizeSerialNumber(SerialNumber);
    if (!Normalized) return false;
    const PrevLength = this.CriticalUSBDevices.length;
    this.CriticalUSBDevices = this.CriticalUSBDevices.filter(
      (Entry) => Entry.SerialNumber !== Normalized
    );
    if (this.CriticalUSBDevices.length === PrevLength) return false;
    this.CriticalUSBSerials = this.CriticalUSBDevices.map((Entry) => Entry.SerialNumber);
    this._rebuildUSBDeviceView();
    return true;
  }
  _refreshClientHealthState() {
    const MissingCount = Array.isArray(this.MissingCriticalUSBDevices)
      ? this.MissingCriticalUSBDevices.length
      : 0;
    this.Degraded = !!this.Online && MissingCount > 0;
    this.DegradedWarnings = this.Degraded ? ['Missing USB Device'] : [];
  }
  _rebuildUSBDeviceView() {
    const CriticalBySerial = new Map(
      (Array.isArray(this.CriticalUSBDevices) ? this.CriticalUSBDevices : [])
        .map((Entry) => {
          const SerialNumber = normalizeSerialNumber(Entry && Entry.SerialNumber);
          if (!SerialNumber) return null;
          return [SerialNumber, Entry];
        })
        .filter((Entry) => !!Entry)
    );

    const Connected = (Array.isArray(this.ConnectedUSBDeviceList) ? this.ConnectedUSBDeviceList : []).map(
      (Device) => {
        const SerialNumber = normalizeSerialNumber(Device && Device.SerialNumber);
        const CriticalEntry = SerialNumber ? CriticalBySerial.get(SerialNumber) : null;
        return {
          ...(Device || {}),
          SerialNumber: Device && Device.SerialNumber ? String(Device.SerialNumber) : null,
          IsConnected: true,
          IsCritical: !!CriticalEntry,
          Missing: false,
          ManufacturerName:
            (Device && Device.ManufacturerName) ||
            (CriticalEntry && CriticalEntry.ManufacturerName) ||
            null,
          ProductName:
            (Device && Device.ProductName) || (CriticalEntry && CriticalEntry.ProductName) || null,
        };
      }
    );

    const ConnectedSerials = new Set(
      Connected.map((Device) => normalizeSerialNumber(Device && Device.SerialNumber)).filter(Boolean)
    );

    const Missing = [];
    for (const Entry of this.CriticalUSBDevices) {
      if (!Entry || !Entry.SerialNumber) continue;
      if (ConnectedSerials.has(Entry.SerialNumber)) continue;
      Missing.push({
        ManufacturerName: Entry.ManufacturerName,
        ProductName: Entry.ProductName,
        SerialNumber: Entry.SerialNumber,
        IsConnected: false,
        IsCritical: true,
        Missing: true,
      });
    }

    this.MissingCriticalUSBDevices = Missing;
    this.USBDeviceList = Connected.concat(Missing);
    this._refreshClientHealthState();
  }
  SetNetworkInterfaces(Interfaces) {
    try {
      if (!Array.isArray(Interfaces)) Interfaces = [];
      const normalized = Interfaces.map((iface) => ({
        name: iface && iface.name ? String(iface.name) : 'unknown',
        addresses: Array.isArray(iface && iface.addresses)
          ? iface.addresses.map((a) => ({
              family: a.family,
              address: a.address,
              netmask: a.netmask,
              cidr: a.cidr || null,
              mac: a.mac,
              internal: !!a.internal,
              scopeid: typeof a.scopeid !== 'undefined' ? a.scopeid : null,
            }))
          : [],
      }));
      this.NetworkInterfaces = normalized;
      Logger.debug(`Client ${this.UUID} Network Interfaces updated (${normalized.length})`);
      // Broadcast for UI updates if needed
      BroadcastManager.emit('ClientUpdated', this);
    } catch (e) {
      Logger.error('Failed to set network interfaces for', this.UUID, e);
    }
  }
  SetScriptsFingerprint(ScriptsFingerprint) {
    const NextValue =
      typeof ScriptsFingerprint === 'string' && ScriptsFingerprint.trim().length > 0
        ? ScriptsFingerprint.trim()
        : null;
    if (this.ScriptsFingerprint === NextValue) return;
    this.ScriptsFingerprint = NextValue;
    BroadcastManager.emit('ClientUpdated', this);
  }
  async USBDeviceAdded(Device) {
    const AddedSerial = normalizeSerialNumber(Device && Device.SerialNumber);
    this.ConnectedUSBDeviceList = (Array.isArray(this.ConnectedUSBDeviceList)
      ? this.ConnectedUSBDeviceList
      : []
    ).filter((Entry) => normalizeSerialNumber(Entry && Entry.SerialNumber) !== AddedSerial);
    this.ConnectedUSBDeviceList.push(Device || {});
    this._rebuildUSBDeviceView();
    BroadcastManager.emit('ClientUpdated', this);
    BroadcastManager.emit('USBDeviceAdded', this, Device);
    return;
  }
  async USBDeviceRemoved(Device) {
    const RemovedSerial = normalizeSerialNumber(Device && Device.SerialNumber);
    this.ConnectedUSBDeviceList = (Array.isArray(this.ConnectedUSBDeviceList)
      ? this.ConnectedUSBDeviceList
      : []
    ).filter((Entry) => normalizeSerialNumber(Entry && Entry.SerialNumber) !== RemovedSerial);
    this._rebuildUSBDeviceView();
    BroadcastManager.emit('ClientUpdated', this);
    BroadcastManager.emit('USBDeviceRemoved', this, Device);
    return;
  }

  // Persistent fields (DB-backed)
  async SetNickname(Nickname) {
    if (this.Nickname === Nickname) return;
    this.Nickname = Nickname;
    let [Err, _Res] = await DB.Run('UPDATE Clients SET Nickname = ? WHERE UUID = ?', [
      Nickname,
      this.UUID,
    ]);
    if (Err) return Logger.error('Failed to update client nickname');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} nickname updated to ${Nickname}`);
  }
  async SetGroupID(GroupID) {
    if (this.GroupID === GroupID) return;
    if (GroupID === 'null') GroupID = null;
    this.GroupID = GroupID;
    let [Err, _Res] = await DB.Run('UPDATE Clients SET GroupID = ? WHERE UUID = ?', [
      GroupID,
      this.UUID,
    ]);
    if (Err) return Logger.error('Failed to update client GroupID');
    BroadcastManager.emit('ClientListChanged');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} GroupID updated to ${GroupID}`);
  }
  async SetHostname(Hostname, Options = {}) {
    if (this.Hostname === Hostname) return;
    this.Hostname = Hostname;
    const Run = getDBRunner(Options.markUnsaved);
    let [Err, _Res] = await Run('UPDATE Clients SET Hostname = ? WHERE UUID = ?', [
      Hostname,
      this.UUID,
    ]);
    if (Err) return Logger.error('Failed to update client hostname');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} hostname updated to ${Hostname}`);
  }
  async SetOperatingSystem(OperatingSystem, Options = {}) {
    if (this.OperatingSystem === OperatingSystem) return;
    this.OperatingSystem = OperatingSystem;
    const Run = getDBRunner(Options.markUnsaved);
    let [Err, _Res] = await Run('UPDATE Clients SET OperatingSystem = ? WHERE UUID = ?', [
      OperatingSystem,
      this.UUID,
    ]);
    if (Err) return Logger.error('Failed to update client operating system');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} operating system updated to ${OperatingSystem}`);
  }
  async SetMacAddress(MacAddress, Options = {}) {
    if (this.MacAddress === MacAddress) return;
    this.MacAddress = MacAddress;
    const Run = getDBRunner(Options.markUnsaved);
    let [Err, _Res] = await Run('UPDATE Clients SET MacAddress = ? WHERE UUID = ?', [
      MacAddress,
      this.UUID,
    ]);
    if (Err) return Logger.error('Failed to update client mac address');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} mac address updated to ${MacAddress}`);
  }
  async SetVersion(Version, Options = {}) {
    if (this.Version === Version) return;
    this.Version = Version;
    const Run = getDBRunner(Options.markUnsaved);
    let [Err, _Res] = await Run('UPDATE Clients SET Version = ? WHERE UUID = ?', [
      Version,
      this.UUID,
    ]);
    if (Err) return Logger.error('Failed to update client version');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} version updated to ${Version}`);
  }
  async SetWeight(Weight) {
    if (this.Weight === Weight) return;
    this.Weight = Weight;
    let [Err, _Res] = await DB.Run('UPDATE Clients SET Weight = ? WHERE UUID = ?', [
      Weight,
      this.UUID,
    ]);
    if (Err) return Logger.error('Failed to update client weight');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} weight updated to ${Weight}`);
  }
  async SetIP(IP, Options = {}) {
    if (this.IP === IP) return;
    this.IP = IP;
    const Run = getDBRunner(Options.markUnsaved);
    let [Err, _Res] = await Run('UPDATE Clients SET IP = ? WHERE UUID = ?', [IP, this.UUID]);
    if (Err) return Logger.error('Failed to update client IP');
    BroadcastManager.emit('ClientUpdated', this);
    Logger.debug(`Client ${this.UUID} IP updated to ${IP}`);
  }
}

module.exports = {
  Client,
  getDBRunner,
};
