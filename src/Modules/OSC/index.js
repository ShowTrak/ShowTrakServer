const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('OSC');

const { Server } = require('node-osc');

const { Manager: ClientManager } = require('../ClientManager');
const { Manager: Broadcast } = require('../Broadcast');
const { Manager: ScriptManager } = require('../ScriptManager');
const { Manager: DummyClientManager } = require('../DummyClientManager');
var OSCServer = new Server(3333, '0.0.0.0', () => {
  console.log('OSC Server is listening');
});

let Routes = [];

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

// Other
OSC.CreateRoute(
  '/ShowTrak/Shutdown',
  async (_Req) => {
    Logger.warn('Received shutdown command via OSC');
    Broadcast.emit('Shutdown');
    return successResult('Shutdown requested');
  },
  'Close the ShowTrak Server'
);

OSC.CreateRoute(
  '/ShowTrak/Shutdown/Force',
  async (_Req) => {
    Logger.warn('Received force shutdown command via OSC');
    Broadcast.emit('ShutdownForce');
    return successResult('Force shutdown requested');
  },
  'Force close the ShowTrak Server without save/show-mode prompts'
);

// Client
OSC.CreateRoute(
  '/ShowTrak/Client/:UUID/Select',
  async (Req) => {
    let [Err, Client] = await ClientManager.Get(Req.UUID);
    if (Err) {
      Broadcast.emit('Notify', `OSC - Invalid UUID "${Req.UUID}"`, 'error');
      return failureResult(`Invalid UUID "${Req.UUID}"`);
    }
    Broadcast.emit('OSCBulkAction', 'Select', [Client.UUID], null);
    return successResult(`Selected client "${Client.UUID}"`);
  },
  'Select a Client by their UUID'
);

OSC.CreateRoute(
  '/ShowTrak/Client/:UUID/Deselect',
  async (Req) => {
    let [Err, Client] = await ClientManager.Get(Req.UUID);
    if (Err) {
      Broadcast.emit('Notify', `OSC - Invalid UUID "${Req.UUID}"`, 'error');
      return failureResult(`Invalid UUID "${Req.UUID}"`);
    }
    Broadcast.emit('OSCBulkAction', 'Deselect', [Client.UUID], null);
    return successResult(`Deselected client "${Client.UUID}"`);
  },
  'Deselect a Client by their UUID'
);

OSC.CreateRoute(
  '/ShowTrak/Client/:UUID/WakeOnLAN',
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
  '/ShowTrak/Client/:UUID/RunScript/:ScriptID',
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

// Dummy Clients
// Heartbeat for a virtual dummy client, addressed by its user-facing DummyID.
OSC.CreateRoute(
  '/ShowTrak/Dummy/:ID/Heartbeat',
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

// Group
// OSC.CreateRoute('/ShowTrak/Group/:GroupID/Select', async (_Req) => {
//     return false;
// }, 'Select all members of a Group by its Group ID');

// OSC.CreateRoute('/ShowTrak/Group/:GroupID/Deselect', async (_Req) => {
//     return false;
// }, 'Deselect all members of a Group by its Group ID');

// OSC.CreateRoute('/ShowTrak/Group/:GroupID/WakeOnLAN', async (_Req) => {
//     return false;
// }, 'Send a WOL packet to all offline members of a Group by its Group ID');

// OSC.CreateRoute('/ShowTrak/Group/:GroupID/RunScript/:ScriptID', async (_Req) => {
//     return false;
// }, 'Execute a script on all online members of a Group by its Group ID and Script ID');

// All
OSC.CreateRoute(
  '/ShowTrak/All/WakeOnLAN',
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
  '/ShowTrak/All/RunScript/:ScriptID',
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

module.exports = { OSC };
