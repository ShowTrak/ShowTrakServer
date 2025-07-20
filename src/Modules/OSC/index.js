const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('OSC');

const { Server } = require("node-osc");

const { Manager: ClientManager } = require('../ClientManager');
const { Manager: Broadcast } = require('../Broadcast');
var OSCServer = new Server(3333, "0.0.0.0", () => {
	console.log("OSC Server is listening");
});

let Routes = [];

const OSC = {};


OSCServer.on("message", async function (Route) {
    let ValidRoutes = [];

    Main: for (const PRoute of Routes) {
        let PRouteParts = PRoute.Path.split('/');
        let RouteParts = Route[0].split('/');
        if (PRouteParts.length !== RouteParts.length) continue Main;
        Sub: for (let i = 0; i < PRouteParts.length; i++) {
            if (PRouteParts[i] === RouteParts[i] || PRouteParts[i].startsWith(':')) continue Sub;
            continue Main;
        }
        ValidRoutes.push(PRoute);
    }

    if (!ValidRoutes || ValidRoutes.length == 0) return Logger.error(`Invalid OSC Route: ${Route[0]}`);

    for (const ValidRoute of ValidRoutes) {
        Logger.log(`Executing route: ${ValidRoute.Path}`);

        let Req = {};

        let PRouteParts = ValidRoute.Path.split('/');
        let RouteParts = Route[0].split('/');

        for (let i = 0; i < PRouteParts.length; i++) {
            if (PRouteParts[i].startsWith(':')) {
                Req[PRouteParts[i].substring(1)] = RouteParts[i];
            }
        }

        let RequestComplete = await ValidRoute.Callback(Req);
        if (RequestComplete === false) continue;
        return Logger.success(`OSC Complete: ${Route[0]}`);
    }
    return Logger.warn(`OSC Incomplete but has matching path: ${Route[0]}`);
});

OSC.GetRoutes = () => {
    return Routes
}

OSC.CreateRoute = (Path, Callback, Title = "Default OSC Route") => {
    Routes.push({
        Title: Title,
        Path: Path,
        Callback: Callback
    })
    return;
};

// Other
OSC.CreateRoute('/ShowTrak/Shutdown', async (_Req) => {
    Logger.warn('Received shutdown command via OSC');
    Broadcast.emit('Shutdown');
    return true;
}, 'Close the ShowTrak Server');

// Client
OSC.CreateRoute('/ShowTrak/Client/:UUID/Select', async (Req) => {
    let [Err, Client] = await ClientManager.Get(Req.UUID);
    if (Err) return Broadcast.emit('Notify', `OSC - Invalid UUID "${Req.UUID}"`, 'error');
    Broadcast.emit('OSCBulkAction', 'Select', [Client.UUID], null)
    return true;
}, 'Select a Client by their UUID');

OSC.CreateRoute('/ShowTrak/Client/:UUID/Deselect', async (Req) => {
    let [Err, Client] = await ClientManager.Get(Req.UUID);
    if (Err) return Broadcast.emit('Notify', `OSC - Invalid UUID "${Req.UUID}"`, 'error');
    Broadcast.emit('OSCBulkAction', 'Deselect', [Client.UUID], null)
    return true;
}, 'Deselect a Client by their UUID');

OSC.CreateRoute('/ShowTrak/Client/:UUID/WakeOnLAN', async (_Req) => {
    return false;
}, 'Send a WOL packet to a Client by UUID');

OSC.CreateRoute('/ShowTrak/Client/:UUID/RunScript/:ScriptID', async (_Req) => {
    return false;
}, 'Execute a script on a Client by UUID and Script ID');

// Selected
OSC.CreateRoute('/ShowTrak/Selected/WakeOnLAN', async (_Req) => {
    return false;
}, 'Send a WOL packet to the currently selected Client(s)');

OSC.CreateRoute('/ShowTrak/Selected/RunScript/:ScriptID', async (_Req) => {
    return false;
}, 'Execute a script on the currently selected online Client(s) by Script ID');

// Group
OSC.CreateRoute('/ShowTrak/Group/:GroupID/Select', async (_Req) => {
    return false;
}, 'Select all members of a Group by its Group ID');

OSC.CreateRoute('/ShowTrak/Group/:GroupID/Deselect', async (_Req) => {
    return false;
}, 'Deselect all members of a Group by its Group ID');

OSC.CreateRoute('/ShowTrak/Group/:GroupID/WakeOnLAN', async (_Req) => {
    return false;
}, 'Send a WOL packet to all offline members of a Group by its Group ID');

OSC.CreateRoute('/ShowTrak/Group/:GroupID/RunScript/:ScriptID', async (_Req) => {
    return false;
}, 'Execute a script on all online members of a Group by its Group ID and Script ID');

// All
OSC.CreateRoute('/ShowTrak/All/WakeOnLAN', async (_Req) => {
    let [Err, AllClients] = await ClientManager.GetAll()
    if (Err) {
        Logger.error(`Failed to get all clients: ${Err}`);
        return false;
    }
    Broadcast.emit('OSCBulkAction', 'WOL', AllClients.map(Client => Client.UUID), null)
    return true;
}, 'Send a WOL packet to all offline Clients');

OSC.CreateRoute('/ShowTrak/All/RunScript/:ScriptID', async (_Req) => {
    return false;
}, 'Execute a script on all online Clients by Script ID');

module.exports = { OSC };
