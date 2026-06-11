// Web UI (`/ui`) Socket.IO namespace
// Hosts the permission-aware, per-session viewer used by the PWA. Auth is a
// simple in-memory session-token model; data/action events are gated on auth
// (and, for scripts/WOL, on the relevant feature settings). Behavior is
// identical to the original inline implementation in Server/index.js.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('WebServer');

const crypto = require('crypto');
const { Config } = require('../Config');
const { Manager: ClientManager } = require('../ClientManager');
const { Manager: GroupManager } = require('../GroupManager');
const { Manager: MonitoringTargetManager } = require('../MonitoringTargetManager');
const { Manager: DummyClientManager } = require('../DummyClientManager');
const { Manager: SettingsManager } = require('../SettingsManager');
const { Manager: WOLManager } = require('../WOLManager');
const { Manager: ScriptManager } = require('../ScriptManager');
const { Manager: BroadcastManager } = require('../Broadcast');

const { ToPublicClient, ToPublicGroup } = require('./serializers');

// In-memory set of currently valid Web UI session tokens. Cleared on restart
// and on logout, giving us a simple per-session auth model.
const WebSessions = new Set();

// Snapshot of the relevant Web UI settings used for permissions.
const GetWebConfig = async () => {
  let Enabled = true;
  let ProtectionEnabled = false;
  let Password = '';
  let AllowRemoteScripts = false;
  let WOLEnabled = false;
  try {
    Enabled = !!(await SettingsManager.GetValue('WEBUI_ENABLED'));
    ProtectionEnabled = !!(await SettingsManager.GetValue('WEBUI_PASSWORD_PROTECTION_ENABLED'));
    Password = String((await SettingsManager.GetValue('WEBUI_PASSWORD')) || '').trim();
    AllowRemoteScripts = !!(await SettingsManager.GetValue('WEBUI_ALLOW_REMOTE_SCRIPT_EXECUTION'));
    WOLEnabled = !!(await SettingsManager.GetValue('SYSTEM_ALLOW_WOL'));
  } catch {}
  if (Enabled === undefined) Enabled = true;
  // Protection is only meaningful when a passcode is actually set.
  const RequireAuth = ProtectionEnabled && Password.length > 0;
  return { Enabled, ProtectionEnabled, Password, AllowRemoteScripts, WOLEnabled, RequireAuth };
};

// Public-facing config (never leaks the password itself).
const GetPublicConfig = async (socket) => {
  const Cfg = await GetWebConfig();
  return {
    Enabled: Cfg.Enabled,
    PasswordProtection: Cfg.RequireAuth,
    AllowRemoteScripts: Cfg.AllowRemoteScripts,
    WOLEnabled: Cfg.WOLEnabled,
    Authed: !Cfg.RequireAuth || !!(socket && socket.Authed),
    Version: Config.Application.Version,
  };
};

// Is this socket allowed to receive/act on data right now?
const IsAuthed = async (socket) => {
  const Cfg = await GetWebConfig();
  if (!Cfg.Enabled) return false;
  if (!Cfg.RequireAuth) return true;
  return !!(socket && socket.Authed);
};

// Wire the `/ui` namespace onto the provided Socket.IO server. `ServerManager`
// is the Server module's Manager (used for script execution dispatch).
function SetupWebUiNamespace(io, ServerManager) {
  const ui = io.of('/ui');

  // Validate any token presented in the handshake so reconnects stay logged in.
  ui.use((socket, next) => {
    try {
      const Token =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.query && socket.handshake.query.token) ||
        null;
      socket.Authed = Token ? WebSessions.has(Token) : false;
      socket.SessionToken = socket.Authed ? Token : null;
    } catch {
      socket.Authed = false;
    }
    next();
  });

  ui.on('connection', async (socket) => {
    try {
      Logger.log('Web UI connected', { id: socket.id, ip: socket.handshake.address });
    } catch {}

    // Build and emit the full bootstrap snapshot for an authed session.
    const SendBootstrap = async () => {
      try {
        if (!(await IsAuthed(socket))) return;
        const [cErr, clients] = await ClientManager.GetAll();
        const [gErr, groups] = await GroupManager.GetAll();
        const [mErr, monitors] = await MonitoringTargetManager.GetAll();
        const [dErr, dummies] = await DummyClientManager.GetAll();
        let scripts = [];
        try {
          scripts = (await ScriptManager.GetScripts()) || [];
        } catch {}
        socket.emit('bootstrap', {
          clients: cErr ? [] : clients.map(ToPublicClient),
          groups: gErr ? [] : (groups || []).map(ToPublicGroup),
          monitors: mErr ? [] : monitors || [],
          dummies: dErr ? [] : dummies || [],
          scripts: scripts
            .filter((s) => s.isValid)
            .map((s) => ({
              id: s.ID,
              name: s.Name,
              colour: typeof s.Colour === 'number' ? s.Colour : 6,
              weight: s.Weight || 0,
              confirm: !!s.Confirmation,
            })),
          config: await GetPublicConfig(socket),
        });
      } catch (e) {
        Logger.error('Web UI bootstrap failed:', e);
      }
    };

    // Tell the client whether it must authenticate before anything else.
    socket.emit('hello', await GetPublicConfig(socket));
    await SendBootstrap();

    // --- Authentication handlers -------------------------------------------
    socket.on('auth:login', async (payload, cb) => {
      try {
        const Cfg = await GetWebConfig();
        if (!Cfg.Enabled) {
          return cb && cb({ error: 'disabled' });
        }
        if (!Cfg.RequireAuth) {
          socket.Authed = true;
          const token = crypto.randomBytes(24).toString('hex');
          WebSessions.add(token);
          socket.SessionToken = token;
          await SendBootstrap();
          return cb && cb({ ok: true, token });
        }
        const Passcode = String((payload && payload.password) || '').trim();
        if (Passcode !== Cfg.Password) {
          return cb && cb({ error: 'invalid_password' });
        }
        const token = crypto.randomBytes(24).toString('hex');
        WebSessions.add(token);
        socket.Authed = true;
        socket.SessionToken = token;
        await SendBootstrap();
        cb && cb({ ok: true, token });
      } catch (e) {
        cb && cb({ error: 'failed' });
      }
    });

    socket.on('auth:logout', async (cb) => {
      try {
        if (socket.SessionToken) WebSessions.delete(socket.SessionToken);
        socket.Authed = false;
        socket.SessionToken = null;
        cb && cb({ ok: true });
      } catch (e) {
        cb && cb({ error: 'failed' });
      }
    });

    socket.on('config:get', async (cb) => {
      try {
        cb && cb({ data: await GetPublicConfig(socket) });
      } catch {
        cb && cb({ error: 'failed' });
      }
    });

    // --- Data request handlers (all gated on auth) -------------------------
    socket.on('bootstrap:get', async () => {
      await SendBootstrap();
    });

    socket.on('clients:get', async (cb) => {
      try {
        if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
        const [err, list] = await ClientManager.GetAll();
        if (err) return cb && cb({ error: err });
        cb && cb({ data: list.map(ToPublicClient) });
      } catch (e) {
        cb && cb({ error: 'failed' });
      }
    });

    socket.on('client:get', async (uuid, cb) => {
      try {
        if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
        const [err, client] = await ClientManager.Get(uuid);
        if (err) return cb && cb({ error: err });
        if (!client) return cb && cb({ error: 'not_found' });
        cb && cb({ data: ToPublicClient(client) });
      } catch (e) {
        cb && cb({ error: 'failed' });
      }
    });

    // --- Live push wiring (per-socket, only to authed sessions) ------------
    const onClientListChanged = async () => {
      try {
        if (!(await IsAuthed(socket))) return;
        const [err, list] = await ClientManager.GetAll();
        if (err) return;
        socket.emit('clients:list', list.map(ToPublicClient));
      } catch {}
    };

    const onClientUpdated = async (client) => {
      try {
        if (!(await IsAuthed(socket))) return;
        socket.emit('clients:updated', ToPublicClient(client));
      } catch {}
    };

    const onGroupListChanged = async () => {
      try {
        if (!(await IsAuthed(socket))) return;
        const [err, groups] = await GroupManager.GetAll();
        if (err) return;
        socket.emit('groups:list', (groups || []).map(ToPublicGroup));
      } catch {}
    };

    const onMonitorListChanged = async () => {
      try {
        if (!(await IsAuthed(socket))) return;
        const [err, monitors] = await MonitoringTargetManager.GetAll();
        if (err) return;
        socket.emit('monitors:list', monitors || []);
      } catch {}
    };

    const onMonitorUpdated = async (monitor) => {
      try {
        if (!(await IsAuthed(socket))) return;
        socket.emit('monitors:updated', monitor);
      } catch {}
    };

    const onDummyListChanged = async () => {
      try {
        if (!(await IsAuthed(socket))) return;
        const [err, dummies] = await DummyClientManager.GetAll();
        if (err) return;
        socket.emit('dummies:list', dummies || []);
      } catch {}
    };

    const onDummyUpdated = async (dummy) => {
      try {
        if (!(await IsAuthed(socket))) return;
        socket.emit('dummies:updated', dummy);
      } catch {}
    };

    // When server settings change, permissions may change. If auth is now
    // required and this socket isn't authed, force it back to the login screen.
    const onSettingsUpdated = async () => {
      try {
        const Cfg = await GetWebConfig();
        if (!Cfg.Enabled || (Cfg.RequireAuth && !socket.Authed)) {
          socket.emit('config', await GetPublicConfig(socket));
          return;
        }
        socket.emit('config', await GetPublicConfig(socket));
        await SendBootstrap();
      } catch {}
    };

    BroadcastManager.on('ClientListChanged', onClientListChanged);
    BroadcastManager.on('ClientUpdated', onClientUpdated);
    BroadcastManager.on('GroupListChanged', onGroupListChanged);
    BroadcastManager.on('MonitoringTargetListChanged', onMonitorListChanged);
    BroadcastManager.on('MonitoringTargetUpdated', onMonitorUpdated);
    BroadcastManager.on('DummyClientListChanged', onDummyListChanged);
    BroadcastManager.on('DummyClientUpdated', onDummyUpdated);
    BroadcastManager.on('SettingsUpdated', onSettingsUpdated);

    // --- Action handlers (gated on auth + permission) ----------------------
    socket.on('scripts:run', async (payload, cb) => {
      try {
        if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
        const Cfg = await GetWebConfig();
        if (!Cfg.AllowRemoteScripts) return cb && cb({ error: 'forbidden' });
        const { uuid, scriptId } = payload || {};
        if (!uuid || !scriptId) return cb && cb({ error: 'invalid_args' });
        const Summary = await ServerManager.ExecuteScripts(scriptId, [uuid], false);
        const Failed =
          Summary && Array.isArray(Summary.failed)
            ? Summary.failed.find((Entry) => Entry && Entry.UUID === uuid)
            : null;
        if (Failed) {
          return cb && cb({ error: 'failed', message: Failed.message || 'Script was blocked' });
        }
        cb && cb({ ok: true });
      } catch (e) {
        cb && cb({ error: 'failed' });
      }
    });

    socket.on('wol:wake', async (payload, cb) => {
      try {
        if (!(await IsAuthed(socket))) return cb && cb({ error: 'unauthorized' });
        const Cfg = await GetWebConfig();
        if (!Cfg.AllowRemoteScripts || !Cfg.WOLEnabled) return cb && cb({ error: 'forbidden' });
        const { uuid } = payload || {};
        if (!uuid) return cb && cb({ error: 'invalid_args' });
        const [err, client] = await ClientManager.Get(uuid);
        if (err || !client) return cb && cb({ error: err || 'not_found' });
        const mac = client.MacAddress;
        if (!mac) return cb && cb({ error: 'no_mac' });
        const [wolErr, result] = await WOLManager.Wake(mac);
        if (wolErr) return cb && cb({ error: String(wolErr) });
        cb && cb({ ok: true, message: result });
      } catch (e) {
        cb && cb({ error: 'failed' });
      }
    });

    socket.on('disconnect', () => {
      BroadcastManager.off('ClientListChanged', onClientListChanged);
      BroadcastManager.off('ClientUpdated', onClientUpdated);
      BroadcastManager.off('GroupListChanged', onGroupListChanged);
      BroadcastManager.off('MonitoringTargetListChanged', onMonitorListChanged);
      BroadcastManager.off('MonitoringTargetUpdated', onMonitorUpdated);
      BroadcastManager.off('DummyClientListChanged', onDummyListChanged);
      BroadcastManager.off('DummyClientUpdated', onDummyUpdated);
      BroadcastManager.off('SettingsUpdated', onSettingsUpdated);
    });
  });

  return ui;
}

module.exports = {
  SetupWebUiNamespace,
};
