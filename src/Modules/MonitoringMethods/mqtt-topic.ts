// MQTT topic presence monitoring. Connects to an MQTT broker at Target.Address,
// subscribes to a topic filter, and confirms that a message is received on that
// topic within a timeout window.
//
// Retained messages are delivered by the broker immediately on subscribe, which
// makes this ideal for a presence/heartbeat check; non-retained topics require a
// live publish to arrive within the window.
//
// The `mqtt` npm package handles the wire protocol. Auto-reconnect is disabled
// (reconnectPeriod: 0) and the client is fully torn down with end(true) on every
// exit path — Run() is invoked on every monitoring tick, so a leaked socket or
// keep-alive timer would accumulate quickly.
//
// Result semantics (consumed by MonitoringTarget.Tick):
//   - No CONNACK / connection refused / TLS failure  -> offline  (could not connect)
//   - Connected but no message before timeout         -> offline  (no message on topic)
//   - Message received, ExpectedPayload not contained  -> degraded ("Unexpected payload")
//   - Message received on the topic within timeout     -> online
import mqtt, { type MqttClient, type IClientOptions } from 'mqtt';
import { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency, JsonCodeBlock } from './debug';
import { DEFAULT_MONITORING_INTERVAL_MS } from '../Config/constants';
import type { MonitoringResult, MonitoringSettingField, MonitoringTargetLike } from './types';

const ID = 'mqtt-topic';

const DEFAULT_PORT = 1883;
const DEFAULT_TIMEOUT_MS = 6000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60000;
const MAX_PAYLOAD_CHARS = 256;

const Settings: MonitoringSettingField[] = [
  { Key: 'Port', Label: 'Port', Type: 'number', Default: DEFAULT_PORT, Min: 1, Max: 65535, Required: true },
  {
    Key: 'Topic',
    Label: 'Topic filter',
    Type: 'string',
    Default: '',
    Required: true,
    Note: 'MQTT wildcards are supported: + matches one level, /# matches the rest.',
  },
  {
    Key: 'Protocol',
    Label: 'Protocol',
    Type: 'select',
    Default: 'mqtt',
    Options: [
      { value: 'mqtt', label: 'mqtt (plain TCP)' },
      { value: 'mqtts', label: 'mqtts (TLS)' },
    ],
  },
  {
    Key: 'Username',
    Label: 'Username',
    Type: 'string',
    Default: '',
    Note: 'Only needed if the broker requires authentication.',
  },
  { Key: 'Password', Label: 'Password', Type: 'string', Default: '', Advanced: true },
  {
    Key: 'ExpectedPayload',
    Label: 'Expected payload contains',
    Type: 'string',
    Default: '',
    Advanced: true,
    Note: 'Degraded when the received payload does not contain this substring. Leave blank to accept any payload.',
  },
  {
    Key: 'IgnoreTlsErrors',
    Label: 'Ignore TLS certificate errors',
    Type: 'boolean',
    Default: false,
    Advanced: true,
    Note: 'Applies to mqtts connections only.',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: DEFAULT_TIMEOUT_MS,
    Min: MIN_TIMEOUT_MS,
    Max: MAX_TIMEOUT_MS,
    Advanced: true,
  },
];

// Clamp the configured timeout into the supported range with a sane floor.
function ClampTimeout(Value: unknown): number {
  const N = Number(Value);
  if (!Number.isFinite(N)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, N | 0));
}

// Coerce a received MQTT payload to a display string, truncated to a safe length.
function TruncatePayload(Payload: unknown): string {
  let Str: string;
  if (Buffer.isBuffer(Payload)) {
    Str = Payload.toString('utf8');
  } else {
    Str = String(Payload == null ? '' : Payload);
  }
  if (Str.length > MAX_PAYLOAD_CHARS) {
    return Str.slice(0, MAX_PAYLOAD_CHARS) + '…';
  }
  return Str;
}

// Decide whether a received payload satisfies an optional ExpectedPayload
// substring. Returns a degraded descriptor when a non-empty expectation is set
// and the payload does not contain it, otherwise null (payload accepted).
function EvaluatePayload(
  PayloadStr: string,
  ExpectedPayload: string
): { Degraded: true; DegradedReason: string } | null {
  const Expected = String(ExpectedPayload == null ? '' : ExpectedPayload);
  if (!Expected) return null;
  if (PayloadStr.indexOf(Expected) !== -1) return null;
  return { Degraded: true, DegradedReason: 'Unexpected payload' };
}

async function Run(Target: MonitoringTargetLike): Promise<MonitoringResult> {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_PORT;
  if (Port < 1 || Port > 65535) return { Success: false, Error: `Invalid port: ${Port}` };

  const Topic = Cfg.Topic == null ? '' : String(Cfg.Topic).trim();
  if (!Topic) return { Success: false, Error: 'No topic configured' };

  const Protocol = Cfg.Protocol === 'mqtts' ? 'mqtts' : 'mqtt';
  const Username = Cfg.Username == null ? '' : String(Cfg.Username);
  const Password = Cfg.Password == null ? '' : String(Cfg.Password);
  const ExpectedPayload = Cfg.ExpectedPayload == null ? '' : String(Cfg.ExpectedPayload);
  const IgnoreTlsErrors = Cfg.IgnoreTlsErrors === true;
  const TimeoutMs = ClampTimeout(Cfg.Timeout);

  const Options: IClientOptions = {
    host: Address,
    port: Port,
    protocol: Protocol,
    connectTimeout: TimeoutMs,
    reconnectPeriod: 0, // no auto-reconnect: one probe per tick.
    clean: true,
    resubscribe: false,
    keepalive: 0,
  };
  if (Username) Options.username = Username;
  if (Password) Options.password = Password;
  if (Protocol === 'mqtts' && IgnoreTlsErrors) Options.rejectUnauthorized = false;

  return new Promise<MonitoringResult>((resolve) => {
    const Started = Date.now();
    let Settled = false;
    let Connected = false;
    let LastError = '';
    let Client: MqttClient | null = null;
    let Deadline: ReturnType<typeof setTimeout> | null = null;

    const Finish = (Result: MonitoringResult) => {
      if (Settled) return;
      Settled = true;
      if (Deadline) {
        clearTimeout(Deadline);
        Deadline = null;
      }
      // Fully tear down the client on EVERY exit path so no socket or keep-alive
      // timer survives the tick. end(true) forces an immediate close.
      try {
        if (Client) Client.end(true);
      } catch {
        // ignore teardown errors
      }
      resolve(Result);
    };

    Deadline = setTimeout(() => {
      if (Connected) {
        Finish({
          Success: false,
          Connected: true,
          MessageReceived: false,
          Topic,
          Error: `Connected but received no message on "${Topic}" within ${TimeoutMs}ms`,
        });
      } else {
        Finish({
          Success: false,
          Connected: false,
          MessageReceived: false,
          Topic,
          Error: LastError
            ? `Could not connect to broker: ${LastError}`
            : `Could not connect to broker within ${TimeoutMs}ms`,
        });
      }
    }, TimeoutMs);

    try {
      Client = mqtt.connect(Options);
    } catch (Err) {
      Finish({
        Success: false,
        Connected: false,
        MessageReceived: false,
        Topic,
        Error: `Could not connect to broker: ${Err && (Err as Error).message ? (Err as Error).message : String(Err)}`,
      });
      return;
    }

    Client.on('connect', () => {
      Connected = true;
      Client!.subscribe(Topic, (Err) => {
        if (Err) {
          Finish({
            Success: false,
            Connected: true,
            MessageReceived: false,
            Topic,
            Error: `Subscribe to "${Topic}" failed: ${Err.message || String(Err)}`,
          });
        }
      });
    });

    Client.on('message', (ReceivedTopic: string, Payload: Buffer) => {
      const PayloadStr = TruncatePayload(Payload);
      const Base: MonitoringResult = {
        Success: true,
        LatencyMs: Date.now() - Started,
        Connected: true,
        MessageReceived: true,
        Topic,
        ReceivedTopic,
        Payload: PayloadStr,
      };
      const Mismatch = EvaluatePayload(PayloadStr, ExpectedPayload);
      if (Mismatch) {
        Finish({ ...Base, ...Mismatch });
        return;
      }
      Finish(Base);
    });

    Client.on('error', (Err: Error) => {
      LastError = Err && Err.message ? Err.message : String(Err);
      // Before CONNACK an error means we could not establish the session
      // (refused, unreachable, TLS failure). After CONNACK, surface it too.
      Finish({
        Success: false,
        Connected,
        MessageReceived: false,
        Topic,
        Error: Connected
          ? `Broker error: ${LastError}`
          : `Could not connect to broker: ${LastError}`,
      });
    });

    Client.on('close', () => {
      // With reconnectPeriod 0, a close before we ever connected means the
      // connection attempt failed; let the deadline report timeouts otherwise.
      if (Settled || Connected) return;
      Finish({
        Success: false,
        Connected: false,
        MessageReceived: false,
        Topic,
        Error: LastError
          ? `Could not connect to broker: ${LastError}`
          : 'Connection closed before CONNACK',
      });
    });
  });
}

function Debug(Result: MonitoringResult, Target: MonitoringTargetLike): string {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? (Cfg.Port as number) | 0 : DEFAULT_PORT;
  const Protocol = Cfg.Protocol === 'mqtts' ? 'mqtts' : 'mqtt';
  const Topic =
    (Result && Result.Topic != null ? String(Result.Topic) : '') ||
    (Cfg.Topic == null ? '' : String(Cfg.Topic).trim());

  const Connected = !!(Result && Result.Connected);
  const MessageReceived = !!(Result && Result.MessageReceived);
  const Online = !!(Result && Result.Success && !Result.Degraded);
  const Degraded = !!(Result && Result.Degraded);

  let StatePill: string;
  if (Online) StatePill = Pill('success', 'Connected');
  else if (Degraded) StatePill = Pill('warning', 'Connected');
  else if (Connected) StatePill = Pill('warning', 'Connected (no message)');
  else StatePill = Pill('danger', 'Not connected');

  const Head = Rows([
    TextRow('Broker', `${Address || '—'}:${Port}`),
    TextRow('Protocol', Protocol),
    TextRow('Topic', Topic || '—'),
    Row('Connection', StatePill),
    Row('Message', Pill(MessageReceived ? 'success' : 'muted', MessageReceived ? 'Received' : 'None')),
    Result && (Result.Success || Result.Degraded)
      ? Row('Latency', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : TextRow('Error', (Result && Result.Error) || 'Could not connect'),
    Degraded && Result.DegradedReason ? TextRow('Reason', Result.DegradedReason) : null,
  ]);

  if (!MessageReceived) {
    return (
      Head +
      '<div class="mt-2">' +
      Note(Connected ? 'Connected to broker but no message arrived on the topic' : 'Could not connect to the broker') +
      '</div>'
    );
  }

  const PayloadStr = Result && Result.Payload != null ? String(Result.Payload) : '';
  let PayloadBlock: string;
  const Trimmed = PayloadStr.trim();
  if (Trimmed && (Trimmed.startsWith('{') || Trimmed.startsWith('['))) {
    try {
      JSON.parse(Trimmed);
      PayloadBlock = JsonCodeBlock(Trimmed);
    } catch {
      PayloadBlock = `<pre class="bg-ghost rounded p-2 text-light font-monospace" style="font-size: 0.8rem; overflow-x: auto; max-height: 300px; margin: 0;">${Esc(PayloadStr)}</pre>`;
    }
  } else {
    PayloadBlock = `<pre class="bg-ghost rounded p-2 text-light font-monospace" style="font-size: 0.8rem; overflow-x: auto; max-height: 300px; margin: 0;">${Esc(PayloadStr || '(empty payload)')}</pre>`;
  }

  return Head + '<div class="text-muted small mt-2 mb-1">Received payload</div>' + PayloadBlock;
}

export const Name = 'MQTT Topic Presence';
export const Description =
  'Connects to an MQTT broker, subscribes to a topic, and confirms a message is received within a timeout.';
export const DefaultInterval = DEFAULT_MONITORING_INTERVAL_MS;
// Presence check: "latency" is time-to-first-message (driven by publish cadence,
// not broker health), so the latency-based Degraded Threshold field is hidden.
export const SupportsLatencyThreshold = false;
// Exported for unit tests.
export const _internal = {
  ClampTimeout,
  TruncatePayload,
  EvaluatePayload,
};
export { ID, Settings, Run, Debug };
