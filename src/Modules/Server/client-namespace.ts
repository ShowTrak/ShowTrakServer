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
import { Manager as VariableManager } from '../VariableManager';
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
  /**
   * Tail of the serialized telemetry chain for this socket.
   *
   * Socket.IO dispatches a connection's events in arrival order, but it does not
   * await the listener — so two async handlers dispatched back to back can both
   * begin, suspend at their first `await ClientManager.Get(...)`, and then apply
   * their mutations in either order. That is harmless while every event replaces
   * the whole list, and not harmless at all once incremental deltas are in play:
   * a full-list resync overtaking the delta that followed it would silently undo
   * the newer change until the next resync.
   *
   * Handlers registered with `{ serial: true }` are chained here so their bodies
   * run strictly in the order the events arrived. Everything else (script
   * responses, identify, launch config) is unaffected.
   */
  let telemetryTail: Promise<unknown> = Promise.resolve();

  return function GuardedOn(
    event: string,
    validate: ((...args: unknown[]) => unknown[]) | null,
    handler: (...args: never[]) => unknown,
    options: { serial?: boolean } = {}
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
      const run = async () => {
        try {
          await (handler as (...args: unknown[]) => unknown)(...normalized);
        } catch (e) {
          Logger.error(`${event} handler error for`, socket.UUID || socket.id, e);
        }
      };
      if (!options.serial) return run();
      // `run` swallows its own failures, so the chain can never be poisoned;
      // the second argument is belt-and-braces against an unexpected rejection.
      telemetryTail = telemetryTail.then(run, run);
      await telemetryTail;
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

    // A malformed vital is dropped rather than failing the heartbeat, but the
    // client is still wrong and we want to know. Heartbeats arrive every
    // second, so each distinct problem is reported once per connection.
    const WarnedVitals = new Set<string>();
    const WarnVitals = (Message: string) => {
      if (WarnedVitals.has(Message)) return;
      WarnedVitals.add(Message);
      Logger.warn(`Dropped vitals from ${socket.UUID}: ${Message}`);
    };

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

    // Resolved show variables for this client. Fetched once per connection,
    // before the run-on-launch sequence hands off, so an auto-start script sees
    // exactly what a server-dispatched one would. Subsequent changes arrive as
    // 'SetVariables' pushes rather than by re-asking.
    //
    // Integrated clients run no local agent and execute no scripts, so they get
    // an empty set rather than the show's variables.
    GuardedOn(
      'GetVariables',
      (Callback) => {
        if (typeof Callback !== 'function')
          throw new Error('GetVariables requires an ack callback');
        return [Callback];
      },
      async (Callback: (payload: unknown) => void) => {
        const [Err, Client] = await ClientManager.Get(socket.UUID);
        if (Err || !Client || Client.Integrated === true) {
          return Callback({ Environment: {}, Exported: [] });
        }
        Callback(await VariableManager.GetPayload(socket.UUID));
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
        ScriptExecutionManager.Complete(RequestID, Error).catch((err) =>
          Logger.error('Failed to complete integrated event execution:', err)
        );
      }
    );

    // Optional progress line pushed by an integrated event while it runs. It
    // only moves the row's status text — the bar keeps whatever progress it
    // had — and is dropped once the event settles.
    GuardedOn(
      'IntegratedEventFeedback',
      (RequestID, Message) => [
        SocketValidation.RequestID(RequestID),
        SocketValidation.IntegratedEventFeedback(Message),
      ],
      async (RequestID: string, Message: string) => {
        // Unlike the response path, feedback is unsolicited and repeatable, so
        // check the row belongs to the client sending it before trusting it.
        const Execution = await ScriptExecutionManager.GetExecution(RequestID);
        if (!Execution || !Execution.Client || Execution.Client.UUID !== socket.UUID) {
          Logger.warn(`IntegratedEventFeedback for a foreign RequestID from ${socket.UUID}`);
          return;
        }
        ScriptExecutionManager.UpdateProgress(RequestID, null, Message).catch((err) =>
          Logger.error('Failed to update integrated event feedback:', err)
        );
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
      (Data) => [SocketValidation.Heartbeat(Data, WarnVitals)],
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
      },
      { serial: true }
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
      },
      { serial: true }
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
      },
      { serial: true }
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
      },
      { serial: true }
    );

    GuardedOn(
      'NetworkInterfaces',
      (Interfaces) => [SocketValidation.NetworkInterfaces(Interfaces)],
      async (Interfaces: ReturnType<typeof SocketValidation.NetworkInterfaces>) => {
        Logger.log(
          `Network interfaces received from ${socket.UUID} (${Interfaces.length} interfaces)`
        );
        await ClientManager.SetNetworkInterfaces(socket.UUID, Interfaces);
      },
      { serial: true }
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
      },
      { serial: true }
    );

    /**
     * Capability handshake.
     *
     * A client asks once per connection what this server understands, and only
     * starts sending `*Delta` events if the reply says so. A server that predates
     * this event simply never invokes the acknowledgement, and the client stays on
     * full-list reporting — which is why the client must treat "no reply" as
     * "no deltas" rather than applying a default.
     */
    GuardedOn(
      'GetServerCapabilities',
      (Callback) => {
        if (typeof Callback !== 'function')
          throw new Error('GetServerCapabilities requires an ack callback');
        return [Callback];
      },
      async (Callback: (capabilities: { Deltas: boolean }) => void) => {
        Callback({ Deltas: true });
      }
    );

    // --- Incremental telemetry ---------------------------------------------
    // Each delta amends the state its full-list counterpart above replaces. They
    // are serialized with those handlers so a resync can never be overtaken by a
    // delta that was sent after it.

    GuardedOn(
      'NetworkInterfaceDelta',
      (Delta) => [SocketValidation.NetworkInterfaceDelta(Delta)],
      async (Delta: ReturnType<typeof SocketValidation.NetworkInterfaceDelta>) => {
        Logger.debug(
          `Network interface delta from ${socket.UUID} (+${Delta.Added.length} -${Delta.Removed.length} ~${Delta.Changed.length})`
        );
        await ClientManager.ApplyNetworkInterfaceDelta(socket.UUID, Delta);
      },
      { serial: true }
    );

    GuardedOn(
      'DisplayDelta',
      (Delta) => [SocketValidation.DisplayDelta(Delta)],
      async (Delta: ReturnType<typeof SocketValidation.DisplayDelta>) => {
        Logger.log(
          `Display delta from ${socket.UUID} (+${Delta.Added.length} -${Delta.Removed.length} ~${Delta.Changed.length})`
        );
        await ClientManager.ApplyDisplayDelta(socket.UUID, Delta);
        const [ClientErr, Client] = await ClientManager.Get(socket.UUID);
        if (!ClientErr && Client) recordClientDisplayHistorySamples(Client);
      },
      { serial: true }
    );

    GuardedOn(
      'ApplicationDelta',
      (Delta) => [SocketValidation.ApplicationDelta(Delta)],
      async (Delta: ReturnType<typeof SocketValidation.ApplicationDelta>) => {
        Logger.debug(
          `Application delta from ${socket.UUID} (+${Delta.Started.length} -${Delta.Stopped.length} ~${Delta.Changed.length})`
        );
        await ClientManager.ApplyApplicationDelta(socket.UUID, Delta);
        const [ClientErr, Client] = await ClientManager.Get(socket.UUID);
        if (!ClientErr && Client) {
          recordClientApplicationHistorySamples(Client, Delta.SampledAt);
        }
      },
      { serial: true }
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
      ClientManager.Timeout(socket.UUID).catch((err) =>
        Logger.error('Failed to time out client on disconnect:', err)
      );
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
        ScriptExecutionManager.Complete(RequestID, Error).catch((err) =>
          Logger.error('Failed to complete script execution:', err)
        );
      }
    );

    GuardedOn(
      'ScriptExecutionProgress',
      (RequestID, Progress, StatusText) => [
        SocketValidation.RequestID(RequestID),
        ...SocketValidation.ExecutionProgress(Progress, StatusText),
      ],
      (RequestID: string, Progress: number, StatusText: string | null) => {
        ScriptExecutionManager.UpdateProgress(RequestID, Progress, StatusText).catch((err) =>
          Logger.error('Failed to update script execution progress:', err)
        );
      }
    );
  });
}

export { SetupClientNamespace };
