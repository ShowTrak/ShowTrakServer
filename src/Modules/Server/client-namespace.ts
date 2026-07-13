// ShowTrak client Socket.IO namespace (default namespace)
// Handles the lifecycle of connected ShowTrak client agents: presence,
// heartbeats, system/USB/network telemetry, script execution responses, and
// disconnect cleanup.
//
// Every inbound event carries untrusted network input, so each handler is
// registered through GuardedOn: the SocketValidation validator runs first
// (invalid payloads are logged, rate-limited per socket, and dropped) and the
// handler body is exception-guarded so a malformed event can never become an
// unhandled rejection.
import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@showtrak/protocol';
import type {
  RunningApplicationsSnapshot,
  AdoptionHeartbeatPayload,
  HeartbeatPayload,
  USBDevice,
} from '@showtrak/protocol';
import { CreateLogger } from '../Logger';
import { Manager as AdoptionManager } from '../AdoptionManager';
import { Manager as ClientManager } from '../ClientManager';
import { Manager as ScriptManager } from '../ScriptManager';
import { Manager as ScriptExecutionManager } from '../ScriptExecutionManager';
import { Manager as ServerIdentityManager } from '../ServerIdentity';
import { Manager as IdentifyManager } from '../IdentifyManager';
import { Manager as SocketValidation } from '../SocketValidation';
import { Manager as SettingsManager } from '../SettingsManager';
import {
  recordClientApplicationHistorySamples,
  recordClientUSBHistorySamples,
  recordClientDisplayHistorySamples,
} from '../../main/monitoring-history';

// The connection handler stamps per-connection state directly onto the socket.
// Augment the socket.io Socket type so those properties are typed everywhere the
// default namespace touches them.
declare module 'socket.io' {
  interface Socket {
    UUID: string;
    Adopted: boolean;
    ExpectedServerIdentity: string;
    IP: string;
  }
}

// The default-namespace socket, bound to the shared client wire contract.
type ClientSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
// The Socket.IO server bound to the same contract.
type ClientNamespaceServer = Server<ClientToServerEvents, ServerToClientEvents>;

const Logger = CreateLogger('WebServer');

// Log the first few validation failures per event per socket, then sample, so
// a misbehaving client cannot flood the log.
const VALIDATION_LOG_LIMIT = 3;
const VALIDATION_LOG_SAMPLE_EVERY = 100;

function makeValidationFailureLogger(socket: ClientSocket) {
  const counts = new Map<string, number>();
  return (event: string, error: unknown) => {
    const count = (counts.get(event) || 0) + 1;
    counts.set(event, count);
    if (count <= VALIDATION_LOG_LIMIT || count % VALIDATION_LOG_SAMPLE_EVERY === 0) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.warn(
        `Dropped invalid '${event}' payload from ${socket.UUID || socket.id}: ${message}` +
          (count > VALIDATION_LOG_LIMIT ? ` (${count} total)` : '')
      );
    }
  };
}

// Register an exception-guarded, validated event handler.
// `validate` receives the raw event args and returns the normalized argument
// array for `handler` (throwing drops the event). Passing null skips
// validation for events that carry no payload.
function makeGuardedOn(
  socket: ClientSocket,
  logValidationFailure: (event: string, error: unknown) => void
) {
  return function GuardedOn(
    event: string,
    validate: ((...args: unknown[]) => unknown[]) | null,
    handler: (...args: never[]) => unknown
  ) {
    // Events are registered dynamically by name (some are reserved, e.g.
    // 'disconnect'), so the strictly-typed `on` is widened to a string-keyed
    // registrar for this single dispatch point. `.bind(socket)` is REQUIRED:
    // extracting the method reference alone detaches `this`, and Socket.IO's
    // `on` dereferences `this._events` internally (crashes on an unbound call).
    const register = socket.on.bind(socket) as (
      event: string,
      listener: (...args: unknown[]) => void
    ) => void;
    register(event, async (...args: unknown[]) => {
      let normalized: unknown[] = args;
      if (validate) {
        try {
          normalized = validate(...args);
        } catch (error) {
          logValidationFailure(event, error);
          return;
        }
      }
      try {
        await (handler as (...args: unknown[]) => unknown)(...normalized);
      } catch (e) {
        Logger.error(`${event} handler error for`, socket.UUID || socket.id, e);
      }
    });
  };
}

// Wire the default namespace (ShowTrak client agents) onto the Socket.IO server.
function SetupClientNamespace(io: ClientNamespaceServer) {
  const localServerIdentity = ServerIdentityManager.GetIdentityToken();

  // Per-connection lifecycle
  io.on('connection', async (socket) => {
    try {
      Logger.log('Incoming socket connection', {
        id: socket.id,
        address: socket.handshake && socket.handshake.address,
        query: socket.handshake && socket.handshake.query,
        headers: socket.handshake &&
          socket.handshake.headers && {
            'x-forwarded-for': socket.handshake.headers['x-forwarded-for'],
          },
      });
    } catch {
      /* intentional: connection logging is best-effort */
    }
    // Expect clients to provide a UUID and whether they believe they are
    // adopted. The UUID is constrained to a room/selector-safe identifier —
    // it flows into Socket.IO rooms, DOM ids and data-uuid attributes.
    try {
      socket.UUID = SocketValidation.HandshakeUUID(
        socket.handshake && socket.handshake.query && socket.handshake.query.UUID
      );
    } catch (error) {
      Logger.warn(
        `Rejected socket ${socket.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      return socket.disconnect(true);
    }
    socket.Adopted = socket.handshake.query.Adopted === 'true' ? true : false;
    socket.ExpectedServerIdentity =
      typeof socket.handshake.query.ExpectedServerIdentity === 'string'
        ? socket.handshake.query.ExpectedServerIdentity.trim()
        : '';
    Logger.log(
      `Client Connected As ${socket.UUID} ${socket.Adopted ? '(Adopted)' : '(Pending Adoption)'}`
    );
    // Join a room keyed by UUID so we can message specific clients
    socket.join(socket.UUID);

    // IP
    socket.IP = socket.handshake.address;
    if (socket.IP.startsWith('::ffff:')) {
      socket.IP = socket.IP.substring(7); // Remove IPv6 prefix if present
    }

    const logValidationFailure = makeValidationFailureLogger(socket);
    const GuardedOn = makeGuardedOn(socket, logValidationFailure);

    // If the client claims adoption, verify against our DB to prevent drift
    if (socket.Adopted) {
      if (
        socket.ExpectedServerIdentity &&
        localServerIdentity &&
        socket.ExpectedServerIdentity !== localServerIdentity
      ) {
        Logger.warn('Adopted client server identity mismatch; rejecting adoption claim', {
          UUID: socket.UUID,
          expected: socket.ExpectedServerIdentity,
          actual: localServerIdentity,
        });
        socket.emit('Unadopt', {
          Reason: 'server_identity_mismatch',
          ServerIdentity: localServerIdentity,
        });
        return;
      }

      const IsInDatabase = await ClientManager.Exists(socket.UUID);
      if (!IsInDatabase) {
        Logger.warn('Client is adopted but not found in the database:', socket.UUID);
        Logger.warn('Unadopting Client');
        socket.emit('Unadopt', {
          Reason: 'client_missing_in_server_database',
          ServerIdentity: localServerIdentity,
        });
      }
    }

    // Unadopted devices send presence to appear in the adoption list
    GuardedOn(
      'AdoptionHeartbeat',
      (Data) => [SocketValidation.AdoptionHeartbeat(Data)],
      async (Data: AdoptionHeartbeatPayload) => {
        // Guard against stale/incorrect client state so adopted devices never
        // reappear in the pending-adoption lane.
        if (socket.Adopted) {
          AdoptionManager.RemoveClientPendingAdoption(socket.UUID);
          return;
        }

        const IsAlreadyAdopted = await ClientManager.Exists(socket.UUID);
        if (IsAlreadyAdopted) {
          AdoptionManager.RemoveClientPendingAdoption(socket.UUID);
          if (!socket.Adopted) {
            socket.Adopted = true;
            socket.emit('Adopt');
          }
          return;
        }

        await AdoptionManager.AddClientPendingAdoption(socket.UUID, socket.IP, Data);
      }
    );

    GuardedOn(
      'GetScripts',
      (Callback) => {
        if (typeof Callback !== 'function') throw new Error('GetScripts requires an ack callback');
        return [Callback];
      },
      async (Callback: (scripts: unknown) => void) => {
        Logger.log(`Client ${socket.UUID} requested scripts.`);
        const Scripts = await ScriptManager.GetScripts();
        Callback(Scripts);
      }
    );

    // Per-client run-on-launch config. The client caches the result to disk and
    // executes it on its NEXT process launch (decoupled from this connection).
    // Integrated / unadopted clients get a null config.
    GuardedOn(
      'GetLaunchConfig',
      (Callback) => {
        if (typeof Callback !== 'function')
          throw new Error('GetLaunchConfig requires an ack callback');
        return [Callback];
      },
      async (Callback: (config: unknown) => void) => {
        // Global toggle for the on-screen abort countdown, applied to every
        // client's launch config so the operator controls it from one place.
        const ShowCountdown = !!(await SettingsManager.GetValue('CLIENT_SHOW_LAUNCH_COUNTDOWN'));
        const [Err, Client] = await ClientManager.Get(socket.UUID);
        if (Err || !Client || Client.Integrated === true) {
          return Callback({ ScriptID: null, DelaySeconds: null, ShowCountdown });
        }
        Callback({
          ScriptID: Client.RunOnLaunchScriptID ?? null,
          DelaySeconds: Client.RunOnLaunchDelaySeconds ?? null,
          ShowCountdown,
        });
      }
    );

    // Integrated clients declare their catalog of actions (events) on
    // connection (and whenever it changes) via the ShowTrak Integration SDK.
    GuardedOn(
      'RegisterActions',
      (Actions) => [SocketValidation.RegisterActions(Actions)],
      async (Actions: unknown[]) => {
        const [Err, Normalized] = await ClientManager.SetIntegratedActions(socket.UUID, Actions);
        if (Err) {
          Logger.warn(`RegisterActions failed for ${socket.UUID}: ${Err}`);
          return;
        }
        Logger.log(
          `Integrated client ${socket.UUID} registered ${
            Normalized ? Normalized.length : 0
          } action(s)`
        );
      }
    );

    // Feedback path for integrated events that declared HasFeedback=true. The
    // RequestID maps back to the queued execution entry created at dispatch.
    GuardedOn(
      'IntegratedEventResponse',
      (RequestID, Error) => [
        SocketValidation.RequestID(RequestID),
        SocketValidation.ExecutionError(Error),
      ],
      (RequestID: string, Error: string | null) => {
        Logger.log(`Received Integrated Event Response for RequestID: ${RequestID}`);
        ScriptExecutionManager.Complete(RequestID, Error);
      }
    );

    // Integrated clients can self-report a health state via the SDK
    // (ShowTrak.SetState). ONLINE clears any degraded reason; DEGRADED records an
    // optional reason. OFFLINE is not accepted from the client.
    GuardedOn(
      'SetIntegratedState',
      (State, Message) => SocketValidation.IntegratedState(State, Message),
      async (State: string, Message: string | null) => {
        const [Err] = await ClientManager.SetIntegratedState(socket.UUID, State, Message);
        if (Err) Logger.warn(`SetIntegratedState failed for ${socket.UUID}: ${Err}`);
      }
    );

    GuardedOn(
      'Heartbeat',
      (Data) => [SocketValidation.Heartbeat(Data)],
      async (Data: HeartbeatPayload) => {
        const [Err] = await ClientManager.Heartbeat(socket.UUID, Data, socket.IP);
        if (Err) Logger.error('Heartbeat failed for', socket.UUID, Err);
      }
    );

    GuardedOn(
      'SystemInfo',
      (Data) => [SocketValidation.SystemInfo(Data)],
      async (Data: Parameters<typeof ClientManager.SystemInfo>[1]) => {
        await ClientManager.SystemInfo(socket.UUID, Data, socket.IP);
      }
    );

    GuardedOn(
      'USBDeviceList',
      (DeviceList) => [SocketValidation.USBDeviceList(DeviceList)],
      async (DeviceList: ReturnType<typeof SocketValidation.USBDeviceList>) => {
        Logger.log(
          `USB Device list recieved from ${socket.UUID} (${DeviceList.length} ${
            DeviceList.length === 1 ? 'Device' : 'Devices'
          })`
        );
        await ClientManager.SetUSBDeviceList(socket.UUID, DeviceList);
        const [ClientErr, Client] = await ClientManager.Get(socket.UUID);
        if (!ClientErr && Client) recordClientUSBHistorySamples(Client);
      }
    );

    GuardedOn(
      'USBDeviceConnected',
      (Device) => [SocketValidation.USBDevice(Device)],
      async (Device: USBDevice) => {
        Logger.log(
          `USB Device Connected to ${socket.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
        );
        await ClientManager.USBDeviceAdded(socket.UUID, Device);
        const [ClientErr, Client] = await ClientManager.Get(socket.UUID);
        if (!ClientErr && Client) recordClientUSBHistorySamples(Client);
      }
    );

    GuardedOn(
      'USBDeviceDisconnected',
      (Device) => [SocketValidation.USBDevice(Device)],
      async (Device: USBDevice) => {
        Logger.log(
          `USB Device Disconnected from ${socket.UUID} (${Device.ManufacturerName} ${Device.ProductName})`
        );
        await ClientManager.USBDeviceRemoved(socket.UUID, Device);
        const [ClientErr, Client] = await ClientManager.Get(socket.UUID);
        if (!ClientErr && Client) recordClientUSBHistorySamples(Client);
      }
    );

    GuardedOn(
      'DisplayList',
      (DisplayList) => [SocketValidation.DisplayList(DisplayList)],
      async (DisplayList: ReturnType<typeof SocketValidation.DisplayList>) => {
        Logger.log(
          `Display list received from ${socket.UUID} (${DisplayList.length} ${
            DisplayList.length === 1 ? 'Display' : 'Displays'
          })`
        );
        await ClientManager.SetDisplayList(socket.UUID, DisplayList);
        const [ClientErr, Client] = await ClientManager.Get(socket.UUID);
        if (!ClientErr && Client) recordClientDisplayHistorySamples(Client);
      }
    );

    GuardedOn(
      'NetworkInterfaces',
      (Interfaces) => [SocketValidation.NetworkInterfaces(Interfaces)],
      async (Interfaces: ReturnType<typeof SocketValidation.NetworkInterfaces>) => {
        Logger.log(
          `Network interfaces received from ${socket.UUID} (${Interfaces.length} interfaces)`
        );
        await ClientManager.SetNetworkInterfaces(socket.UUID, Interfaces);
      }
    );

    GuardedOn(
      'RunningApplications',
      (Snapshot) => [SocketValidation.RunningApplications(Snapshot)],
      async (Snapshot: RunningApplicationsSnapshot) => {
        Logger.log(
          `Running applications received from ${socket.UUID} (${Snapshot.Items.length} items)`
        );
        await ClientManager.SetRunningApplications(socket.UUID, Snapshot);
        const [ClientErr, Client] = await ClientManager.Get(socket.UUID);
        if (!ClientErr && Client) {
          recordClientApplicationHistorySamples(Client, Snapshot.SampledAt);
          recordClientUSBHistorySamples(Client, Snapshot.SampledAt);
          recordClientDisplayHistorySamples(Client, Snapshot.SampledAt);
        }
      }
    );

    // Cleanup on disconnect: clear adoption entry and mark offline
    GuardedOn('disconnect', null, async (reason: unknown) => {
      if (!socket.UUID) {
        Logger.log('Socket disconnected without UUID:', socket.id, reason);
        return;
      }
      Logger.log('Client disconnected', { UUID: socket.UUID, reason });
      await IdentifyManager.HandleDisconnect(socket.UUID);
      AdoptionManager.RemoveClientPendingAdoption(socket.UUID);
      ClientManager.Timeout(socket.UUID);
    });

    // Client-initiated stop of identify mode (esc pressed or overlay clicked).
    GuardedOn('IdentifyStopped', null, async () => {
      await IdentifyManager.HandleClientStopped(socket.UUID);
    });

    GuardedOn(
      'ScriptExecutionResponse',
      (RequestID, Error) => [
        SocketValidation.RequestID(RequestID),
        SocketValidation.ExecutionError(Error),
      ],
      (RequestID: string, Error: string | null) => {
        Logger.log(`Received Script Execution Response for RequestID: ${RequestID}`);
        ScriptExecutionManager.Complete(RequestID, Error);
      }
    );

    GuardedOn(
      'ScriptExecutionProgress',
      (RequestID, Progress, StatusText) => [
        SocketValidation.RequestID(RequestID),
        ...SocketValidation.ExecutionProgress(Progress, StatusText),
      ],
      (RequestID: string, Progress: number, StatusText: string | null) => {
        ScriptExecutionManager.UpdateProgress(RequestID, Progress, StatusText);
      }
    );
  });
}

export { SetupClientNamespace };
