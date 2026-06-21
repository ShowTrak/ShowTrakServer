// Safe, serializable projections of internal manager objects for the Web UI.
function IsIntegratedClient(c) {
  if (!c) return false;
  if (c.Integrated === true) return true;
  return String(c.OperatingSystem || '')
    .trim()
    .toLowerCase() === 'integrated';
}

function FormatClientVersionLabel(c) {
  const RawVersion = String((c && c.Version) || '')
    .trim()
    .replace(/^v\s*/i, '');
  const Version = RawVersion.length > 0 ? RawVersion : 'Unknown';
  return `${IsIntegratedClient(c) ? 'SDK v' : 'v'}${Version}`;
}

const ToPublicClient = (c) => ({
  Type: 'client',
  UUID: c.UUID,
  Nickname: c.Nickname,
  Hostname: c.Hostname,
  OperatingSystem: c.OperatingSystem || '',
  GroupID: c.GroupID,
  Weight: c.Weight,
  Version: c.Version,
  VersionLabel: FormatClientVersionLabel(c),
  IP: c.IP,
  MacAddress: c.MacAddress,
  Online: c.Online,
  LastSeen: c.LastSeen,
  Vitals: c.Vitals,
  USBDeviceList: Array.isArray(c.USBDeviceList) ? c.USBDeviceList : [],
  CriticalUSBDevices: Array.isArray(c.CriticalUSBDevices) ? c.CriticalUSBDevices : [],
  CriticalUSBSerials: Array.isArray(c.CriticalUSBSerials) ? c.CriticalUSBSerials : [],
  MissingCriticalUSBDevices: Array.isArray(c.MissingCriticalUSBDevices)
    ? c.MissingCriticalUSBDevices
    : [],
  Degraded: !!c.Degraded,
  DegradedWarnings: Array.isArray(c.DegradedWarnings) ? c.DegradedWarnings : [],
  NetworkInterfaces: Array.isArray(c.NetworkInterfaces) ? c.NetworkInterfaces : [],
  Integrated: !!c.Integrated,
  IntegratedActions: Array.isArray(c.IntegratedActions) ? c.IntegratedActions : [],
  RunningApplications: c && c.RunningApplications ? c.RunningApplications : { Items: [] },
  CriticalApplications: Array.isArray(c.CriticalApplications) ? c.CriticalApplications : [],
  MissingCriticalApplications: Array.isArray(c.MissingCriticalApplications)
    ? c.MissingCriticalApplications
    : [],
});

const ToPublicGroup = (g) => ({
  GroupID: g.GroupID,
  Title: g.Title,
  Weight: g.Weight,
});

module.exports = {
  FormatClientVersionLabel,
  ToPublicClient,
  ToPublicGroup,
};
