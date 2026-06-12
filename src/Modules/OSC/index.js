const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('OSC');

const { Server } = require('node-osc');

const { Manager: ClientManager } = require('../ClientManager');
const { Manager: Broadcast } = require('../Broadcast');
const { Manager: ScriptManager } = require('../ScriptManager');
const { Manager: DummyClientManager } = require('../DummyClientManager');
const { Manager: GroupManager } = require('../GroupManager');
var OSCServer = new Server(3333, '0.0.0.0', () => {
  console.log('OSC Server is listening');
});

let Routes = [];
const SelectedClientUUIDs = new Set();

const OSC = {};

function emitDebugEntry(payload) {
  Broadcast.emit('DebugTrafficEntry', {
    protocol: 'osc',
    timestamp: Date.now(),
    ...payload,
  });
}

function failureResult(detail) {
  return {
    ok: false,
    detail: String(detail || 'Request failed'),
  };
}

function successResult(detail = '') {
  return {
    ok: true,
    detail: String(detail || ''),
  };
}

function getSelectedUUIDList() {
  return Array.from(SelectedClientUUIDs);
}

function addSelectedUUIDs(UUIDs) {
  for (const UUID of UUIDs || []) {
    if (!UUID) continue;
    SelectedClientUUIDs.add(String(UUID));
  }
}

function removeSelectedUUIDs(UUIDs) {
  for (const UUID of UUIDs || []) {
    if (!UUID) continue;
    SelectedClientUUIDs.delete(String(UUID));
  }
}

async function getGroupClients(GroupIDRaw) {
  const GroupID = Number(GroupIDRaw);
  if (!Number.isFinite(GroupID)) {
    return [failureResult(`Invalid Group ID "${GroupIDRaw}"`), null, null];
  }

  const [GroupErr, Group] = await GroupManager.Get(GroupID);
  if (GroupErr || !Group) {
    return [failureResult(`Invalid Group ID "${GroupIDRaw}"`), null, null];
  }

  const [ClientsErr, Clients] = await ClientManager.GetAll();
  if (ClientsErr) {
    return [failureResult('Failed to fetch all clients'), null, null];
  }

  const GroupClients = (Clients || []).filter((Client) => Number(Client.GroupID) === GroupID);
  return [null, Group, GroupClients];
}

OSCServer.on('message', async function (Route, Info) {
  const RawPath = Array.isArray(Route) && Route.length > 0 ? String(Route[0] || '') : '';
  let ValidRoutes = [];

  Main: for (const PRoute of Routes) {
    let PRouteParts = PRoute.Path.split('/');
    let RouteParts = RawPath.split('/');
    if (PRouteParts.length !== RouteParts.length) continue Main;
    Sub: for (let i = 0; i < PRouteParts.length; i++) {
      if (PRouteParts[i] === RouteParts[i] || PRouteParts[i].startsWith(':')) continue Sub;
      continue Main;
    }
    ValidRoutes.push(PRoute);
  }

  if (!ValidRoutes || ValidRoutes.length == 0) {
    emitDebugEntry({
      valid: false,
      summary: RawPath || '[empty route]',
      detail: 'No matching OSC route',
    });
    return Logger.error(`Invalid OSC Route: ${RawPath}`);
  }

  for (const ValidRoute of ValidRoutes) {
    Logger.log(`Executing route: ${ValidRoute.Path}`);

    let Req = {};

    let PRouteParts = ValidRoute.Path.split('/');
    let RouteParts = RawPath.split('/');

    for (let i = 0; i < PRouteParts.length; i++) {
      if (PRouteParts[i].startsWith(':')) {
        Req[PRouteParts[i].substring(1)] = RouteParts[i];
      }
    }

    // Source address of the UDP packet (used by routes that record sender IPs).
    const Meta = { IP: Info && Info.address ? Info.address : null };

    let RequestComplete = await ValidRoute.Callback(Req, Meta);
    const RequestPassed =
      RequestComplete && typeof RequestComplete === 'object'
        ? RequestComplete.ok !== false
        : RequestComplete !== false;
    const RequestDetail =
      RequestComplete && typeof RequestComplete === 'object' && RequestComplete.detail
        ? String(RequestComplete.detail)
        : ValidRoute.Title || ValidRoute.Path;

    if (!RequestPassed) {
      emitDebugEntry({
        valid: false,
        summary: RawPath,
        detail: RequestDetail,
        source: Meta.IP || null,
      });
      continue;
    }
    emitDebugEntry({
      valid: true,
      summary: RawPath,
      detail: RequestDetail,
      source: Meta.IP || null,
    });
    Broadcast.emit('Notify', `OSC Processed Successfully`, 'success', 1200);
    return Logger.success(`OSC Complete: ${RawPath}`);
  }
  return Logger.warn(`OSC Incomplete but has matching path: ${RawPath}`);
});

OSC.GetRoutes = () => {
  return Routes;
};

OSC.CreateRoute = (Path, Callback, Title = 'Default OSC Route') => {
  Routes.push({
    Title: Title,
    Path: Path,
    Callback: Callback,
  });
  return;
};

// System Control
OSC.CreateRoute(
  '/API/Shutdown',
  async (_Req) => {
    Logger.warn('Received shutdown command via OSC');
    Broadcast.emit('Shutdown');
    return successResult('Shutdown requested');
  },
  'Close the ShowTrak Server'
);

OSC.CreateRoute(
  '/API/Shutdown/Force',
  async (_Req) => {
    Logger.warn('Received force shutdown command via OSC');
    Broadcast.emit('ShutdownForce');
    return successResult('Force shutdown requested');
  },
  'Force close the ShowTrak Server without save/show-mode prompts'
);

// Individual Client Operations
OSC.CreateRoute(
  '/API/Client/:UUID/Select',
  async (Req) => {
    let [Err, Client] = await ClientManager.Get(Req.UUID);
    if (Err) {
      Broadcast.emit('Notify', `OSC - Invalid UUID "${Req.UUID}"`, 'error');
      return failureResult(`Invalid UUID "${Req.UUID}"`);
    }
    addSelectedUUIDs([Client.UUID]);
    Broadcast.emit('OSCBulkAction', 'Select', [Client.UUID], null);
    return successResult(`Selected client "${Client.UUID}"`);
  },
  'Select a Client by their UUID'
);

OSC.CreateRoute(
  '/API/Client/:UUID/Deselect',
  async (Req) => {
    let [Err, Client] = await ClientManager.Get(Req.UUID);
    if (Err) {
      Broadcast.emit('Notify', `OSC - Invalid UUID "${Req.UUID}"`, 'error');
      return failureResult(`Invalid UUID "${Req.UUID}"`);
    }
    removeSelectedUUIDs([Client.UUID]);
    Broadcast.emit('OSCBulkAction', 'Deselect', [Client.UUID], null);
    return successResult(`Deselected client "${Client.UUID}"`);
  },
  'Deselect a Client by their UUID'
);

OSC.CreateRoute(
  '/API/Client/:UUID/WakeOnLAN',
  async (Req) => {
    let [Err, Client] = await ClientManager.Get(Req.UUID);
    if (Err) {
      Broadcast.emit('Notify', `OSC - Invalid UUID "${Req.UUID}"`, 'error');
      return failureResult(`Invalid UUID "${Req.UUID}"`);
    }
    Broadcast.emit('OSCBulkAction', 'WOL', [Client.UUID], null);
    return successResult(`Wake-on-LAN queued for client "${Client.UUID}"`);
  },
  'Send a WOL packet to a Client by UUID'
);

OSC.CreateRoute(
  '/API/Client/:UUID/RunScript/:ScriptID',
  async (Req) => {
    let [Err, Client] = await ClientManager.Get(Req.UUID);
    if (Err) {
      Broadcast.emit('Notify', `OSC - Invalid UUID "${Req.UUID}"`, 'error');
      return failureResult(`Invalid UUID "${Req.UUID}"`);
    }
    let Script = await ScriptManager.Get(Req.ScriptID);
    if (!Script) {
      Broadcast.emit('Notify', `OSC - Invalid Script ID "${Req.ScriptID}"`, 'error');
      return failureResult(`Invalid Script ID "${Req.ScriptID}"`);
    }
    Broadcast.emit('OSCBulkAction', 'ExecuteScript', [Client.UUID], Req.ScriptID);
    return successResult(`Script "${Req.ScriptID}" queued for client "${Client.UUID}"`);
  },
  'Execute a script on a Client by UUID and Script ID'
);

// Dummy Client Operations
OSC.CreateRoute(
  '/API/Dummy/:ID/Heartbeat',
  async (Req, Meta) => {
    let [Err] = await DummyClientManager.Heartbeat(Req.ID, Meta && Meta.IP ? Meta.IP : null);
    if (Err) {
      Broadcast.emit('Notify', `OSC - ${Err}`, 'error');
      return failureResult(String(Err));
    }
    return successResult(`Dummy heartbeat accepted for "${Req.ID}"`);
  },
  'Deliver a heartbeat to a Dummy Client by its Dummy ID'
);

// Group Operations
OSC.CreateRoute(
  '/API/Group/:GroupID/Select',
  async (Req) => {
    const [GroupErr, Group, GroupClients] = await getGroupClients(Req.GroupID);
    if (GroupErr) {
      Broadcast.emit('Notify', `OSC - ${GroupErr.detail}`, 'error');
      return GroupErr;
    }

    const UUIDs = GroupClients.map((Client) => Client.UUID);
    addSelectedUUIDs(UUIDs);
    Broadcast.emit('OSCBulkAction', 'Select', UUIDs, null);
    return successResult(`Selected ${UUIDs.length} clients in group "${Group.Title}" (${Group.GroupID})`);
  },
  'Select all members of a Group by its Group ID'
);

OSC.CreateRoute(
  '/API/Group/:GroupID/Deselect',
  async (Req) => {
    const [GroupErr, Group, GroupClients] = await getGroupClients(Req.GroupID);
    if (GroupErr) {
      Broadcast.emit('Notify', `OSC - ${GroupErr.detail}`, 'error');
      return GroupErr;
    }

    const UUIDs = GroupClients.map((Client) => Client.UUID);
    removeSelectedUUIDs(UUIDs);
    Broadcast.emit('OSCBulkAction', 'Deselect', UUIDs, null);
    return successResult(
      `Deselected ${UUIDs.length} clients in group "${Group.Title}" (${Group.GroupID})`
    );
  },
  'Deselect all members of a Group by its Group ID'
);

OSC.CreateRoute(
  '/API/Group/:GroupID/WakeOnLAN',
  async (Req) => {
    const [GroupErr, Group, GroupClients] = await getGroupClients(Req.GroupID);
    if (GroupErr) {
      Broadcast.emit('Notify', `OSC - ${GroupErr.detail}`, 'error');
      return GroupErr;
    }

    const UUIDs = GroupClients.map((Client) => Client.UUID);
    Broadcast.emit('OSCBulkAction', 'WOL', UUIDs, null);
    return successResult(
      `Wake-on-LAN queued for ${UUIDs.length} clients in group "${Group.Title}" (${Group.GroupID})`
    );
  },
  'Send a WOL packet to all offline members of a Group by its Group ID'
);

OSC.CreateRoute(
  '/API/Group/:GroupID/RunScript/:ScriptID',
  async (Req) => {
    const [GroupErr, Group, GroupClients] = await getGroupClients(Req.GroupID);
    if (GroupErr) {
      Broadcast.emit('Notify', `OSC - ${GroupErr.detail}`, 'error');
      return GroupErr;
    }

    let Script = await ScriptManager.Get(Req.ScriptID);
    if (!Script) {
      Broadcast.emit('Notify', `OSC - Invalid Script ID "${Req.ScriptID}"`, 'error');
      return failureResult(`Invalid Script ID "${Req.ScriptID}"`);
    }

    const UUIDs = GroupClients.map((Client) => Client.UUID);
    Broadcast.emit('OSCBulkAction', 'ExecuteScript', UUIDs, Req.ScriptID);
    return successResult(
      `Script "${Req.ScriptID}" queued for ${UUIDs.length} clients in group "${Group.Title}" (${Group.GroupID})`
    );
  },
  'Execute a script on all online members of a Group by its Group ID and Script ID'
);

// Bulk All Operations
OSC.CreateRoute(
  '/API/All/Select',
  async (_Req) => {
    let [Err, AllClients] = await ClientManager.GetAll();
    if (Err) {
      Broadcast.emit('Notify', `OSC - Failed to fetch all clients.`, 'error');
      return failureResult('Failed to fetch all clients');
    }
    Broadcast.emit(
      'OSCBulkAction',
      'Select',
      AllClients.map((Client) => Client.UUID),
      null
    );
    addSelectedUUIDs(AllClients.map((Client) => Client.UUID));
    return successResult(`Selected ${AllClients.length} clients`);
  },
  'Select all Clients'
);

OSC.CreateRoute(
  '/API/All/Deselect',
  async (_Req) => {
    const UUIDs = getSelectedUUIDList();
    if (UUIDs.length > 0) {
      Broadcast.emit('OSCBulkAction', 'Deselect', UUIDs, null);
    }
    SelectedClientUUIDs.clear();
    return successResult(`Deselected ${UUIDs.length} selected clients`);
  },
  'Clear the selected clients'
);

OSC.CreateRoute(
  '/API/All/WakeOnLAN',
  async (_Req) => {
    let [Err, AllClients] = await ClientManager.GetAll();
    if (Err) {
      Broadcast.emit('Notify', `OSC - Failed to fetch all clients.`, 'error');
      return failureResult('Failed to fetch all clients');
    }
    Broadcast.emit(
      'OSCBulkAction',
      'WOL',
      AllClients.map((Client) => Client.UUID),
      null
    );
    return successResult(`Wake-on-LAN queued for ${AllClients.length} clients`);
  },
  'Send a WOL packet to all offline Clients'
);

OSC.CreateRoute(
  '/API/All/RunScript/:ScriptID',
  async (Req) => {
    let [Err, AllClients] = await ClientManager.GetAll();
    if (Err) {
      Broadcast.emit('Notify', `OSC - Failed to fetch all clients.`, 'error');
      return failureResult('Failed to fetch all clients');
    }
    let Script = await ScriptManager.Get(Req.ScriptID);
    if (!Script) {
      Broadcast.emit('Notify', `OSC - Invalid Script ID "${Req.ScriptID}"`, 'error');
      return failureResult(`Invalid Script ID "${Req.ScriptID}"`);
    }
    Broadcast.emit(
      'OSCBulkAction',
      'ExecuteScript',
      AllClients.map((Client) => Client.UUID),
      Req.ScriptID
    );
    return successResult(`Script "${Req.ScriptID}" queued for ${AllClients.length} clients`);
  },
  'Execute a script on all online Clients by Script ID'
);

// Selection-based Operations
OSC.CreateRoute(
  '/API/Selection/WakeOnLAN',
  async (_Req) => {
    const UUIDs = getSelectedUUIDList();
    if (UUIDs.length === 0) {
      Broadcast.emit('Notify', 'OSC - No selected clients', 'error');
      return failureResult('No selected clients');
    }
    Broadcast.emit('OSCBulkAction', 'WOL', UUIDs, null);
    return successResult(`Wake-on-LAN queued for ${UUIDs.length} selected clients`);
  },
  'Send a WOL packet to currently selected clients'
);

OSC.CreateRoute(
  '/API/Selection/RunScript/:ScriptID',
  async (Req) => {
    const UUIDs = getSelectedUUIDList();
    if (UUIDs.length === 0) {
      Broadcast.emit('Notify', 'OSC - No selected clients', 'error');
      return failureResult('No selected clients');
    }

    let Script = await ScriptManager.Get(Req.ScriptID);
    if (!Script) {
      Broadcast.emit('Notify', `OSC - Invalid Script ID "${Req.ScriptID}"`, 'error');
      return failureResult(`Invalid Script ID "${Req.ScriptID}"`);
    }

    Broadcast.emit('OSCBulkAction', 'ExecuteScript', UUIDs, Req.ScriptID);
    return successResult(`Script "${Req.ScriptID}" queued for ${UUIDs.length} selected clients`);
  },
  'Execute a script on currently selected clients by Script ID'
);

module.exports = { OSC };
