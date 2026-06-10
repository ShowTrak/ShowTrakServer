// Client
// In-memory representation of a connected ShowTrak client. Holds high-churn
// runtime state (online, vitals, USB devices, NICs) plus durable fields that
// are mirrored to the database. Emits BroadcastManager events on changes so
// the UI and other modules stay reactive.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('ClientManager');

const { Manager: DB } = require('../DB');
const { Manager: BroadcastManager } = require('../Broadcast');
const { Manager: SettingsManager } = require('../SettingsManager');

function getDBRunner(markUnsaved = true) {
  if (markUnsaved === false && typeof DB.RunWithoutDirtyTracking === 'function') {
    return DB.RunWithoutDirtyTracking.bind(DB);
  }
  return DB.Run.bind(DB);
}

class Client {
  constructor(Data) {
    this.UUID = Data.UUID;
    this.Nickname = Data.Nickname ? Data.Nickname : Data.Hostname;
    this.Hostname = Data.Hostname || null;
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
    this.USBDeviceList = [];
    this.NetworkInterfaces = [];
    this.ScriptsFingerprint = null;
  }

  // RAM-only fields and notifications
  SetOnline(Online) {
    if (this.Online === Online) return;
    this.Online = Online;
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
    this.USBDeviceList = USBDeviceList;
    Logger.debug(`Client ${this.UUID} USB Device List updated`);
    return;
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
    this.USBDeviceList.push(Device);
    BroadcastManager.emit('USBDeviceAdded', this, Device);
    let AUDIO_ON_USB_DEVICE_CONNECT = await SettingsManager.GetValue('AUDIO_ON_USB_DEVICE_CONNECT');
    if (AUDIO_ON_USB_DEVICE_CONNECT) {
      BroadcastManager.emit('PlaySound', 'Notification');
    }
    return;
  }
  async USBDeviceRemoved(Device) {
    this.USBDeviceList = this.USBDeviceList.filter((d) => d.SerialNumber !== Device.SerialNumber);
    BroadcastManager.emit('USBDeviceRemoved', this, Device);
    let AUDIO_ON_USB_DEVICE_CONNECT = await SettingsManager.GetValue(
      'AUDIO_ON_USB_DEVICE_DISCONNECT'
    );
    if (AUDIO_ON_USB_DEVICE_CONNECT) {
      BroadcastManager.emit('PlaySound', 'Warning');
    }
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
