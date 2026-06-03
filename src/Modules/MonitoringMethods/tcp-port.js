// TCP port monitoring. Opens a TCP socket to Target.Address on the configured
// port and reports success when the three-way handshake completes within the
// timeout. No data is sent or read, so this is safe against arbitrary services.
const net = require('net');

const ID = 'tcp-port';

const Settings = [
  {
    Key: 'Port',
    Label: 'Port',
    Type: 'number',
    Default: 80,
    Min: 1,
    Max: 65535,
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 3000,
    Min: 200,
    Max: 30000,
  },
];

async function Run(Target) {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const Port = Number.isFinite(Cfg.Port) ? Cfg.Port | 0 : 80;
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? Cfg.Timeout : 3000;
  if (Port < 1 || Port > 65535) {
    return { Success: false, Error: `Invalid port: ${Port}` };
  }

  return new Promise((resolve) => {
    const Started = Date.now();
    let Settled = false;

    const Socket = new net.Socket();

    const Finish = (Result) => {
      if (Settled) return;
      Settled = true;
      try {
        Socket.destroy();
      } catch (_e) {
        // ignore
      }
      resolve(Result);
    };

    Socket.setTimeout(Math.max(200, TimeoutMs | 0));

    Socket.once('connect', () => {
      Finish({ Success: true, LatencyMs: Date.now() - Started });
    });

    Socket.once('timeout', () => {
      Finish({ Success: false, Error: `Connection timed out after ${TimeoutMs}ms` });
    });

    Socket.once('error', (Err) => {
      Finish({ Success: false, Error: Err && Err.message ? Err.message : String(Err) });
    });

    try {
      Socket.connect(Port, Address);
    } catch (Err) {
      Finish({ Success: false, Error: Err && Err.message ? Err.message : String(Err) });
    }
  });
}

module.exports = {
  ID,
  Name: 'TCP Port',
  Description: 'Attempts a TCP handshake against the configured host and port.',
  DefaultInterval: 30000,
  Settings,
  Run,
};
