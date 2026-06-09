// Safe, serializable projections of internal manager objects for the Web UI.
const ToPublicClient = (c) => ({
  Type: 'client',
  UUID: c.UUID,
  Nickname: c.Nickname,
  Hostname: c.Hostname,
  GroupID: c.GroupID,
  Weight: c.Weight,
  Version: c.Version,
  IP: c.IP,
  MacAddress: c.MacAddress,
  Online: c.Online,
  LastSeen: c.LastSeen,
  Vitals: c.Vitals,
  USBDeviceList: Array.isArray(c.USBDeviceList) ? c.USBDeviceList : [],
  NetworkInterfaces: Array.isArray(c.NetworkInterfaces) ? c.NetworkInterfaces : [],
});

const ToPublicGroup = (g) => ({
  GroupID: g.GroupID,
  Title: g.Title,
  Weight: g.Weight,
});

module.exports = {
  ToPublicClient,
  ToPublicGroup,
};
