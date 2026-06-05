// Ping monitoring method. Uses the OS `ping` binary so we don't need raw ICMP
// privileges. Cross-platform argument shapes are kept tiny on purpose.
const { spawn } = require('child_process');
const os = require('os');

const ID = 'ping';

// Settings schema is consumed by the renderer to build the dynamic config form
// inside the monitoring target editor.
const Settings = [
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 2000,
    Min: 200,
    Max: 30000,
  },
];

function BuildArgs(Address, TimeoutMs) {
  const Platform = os.platform();
  // Single ping; timeout in seconds (rounded up) for *nix, ms for Windows.
  if (Platform === 'win32') {
    return ['-n', '1', '-w', String(Math.max(100, TimeoutMs | 0)), Address];
  }
  if (Platform === 'darwin') {
    // macOS: -W is wait time per reply in milliseconds.
    return ['-c', '1', '-W', String(Math.max(100, TimeoutMs | 0)), Address];
  }
  // linux + others
  const TimeoutSec = Math.max(1, Math.ceil(TimeoutMs / 1000));
  return ['-c', '1', '-W', String(TimeoutSec), Address];
}

// Don't shell-interpret; Address is forwarded as a process argument so a value
// like "; rm -rf /" can never be parsed as a separate command.
async function Run(Target) {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No address configured' };

  const Cfg = (Target && Target.Settings) || {};
  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? Cfg.Timeout : 2000;
  const Args = BuildArgs(Address, TimeoutMs);

  return new Promise((resolve) => {
    let Stdout = '';
    let Settled = false;
    const Started = Date.now();

    let Child;
    try {
      Child = spawn('ping', Args, { windowsHide: true });
    } catch (Err) {
      return resolve({ Success: false, Error: `Failed to spawn ping: ${Err.message}` });
    }

    // Hard kill guard; OS-level timeout flags don't always fire reliably.
    const KillTimer = setTimeout(() => {
      try {
        Child.kill();
      } catch (_e) {
        // ignore: process may have already exited
      }
    }, Math.max(1000, TimeoutMs + 2000));

    Child.stdout.on('data', (Chunk) => {
      Stdout += Chunk.toString();
    });

    Child.on('error', (Err) => {
      if (Settled) return;
      Settled = true;
      clearTimeout(KillTimer);
      resolve({ Success: false, Error: Err.message });
    });

    Child.on('close', (Code) => {
      if (Settled) return;
      Settled = true;
      clearTimeout(KillTimer);

      if (Code !== 0) {
        return resolve({ Success: false, Error: 'Host unreachable' });
      }
      // Try to parse latency from the ping output; fall back to wall-clock.
      let LatencyMs = null;
      const Match = Stdout.match(/time[=<]\s*([\d.]+)\s*ms/i);
      if (Match) {
        LatencyMs = parseFloat(Match[1]);
      } else {
        LatencyMs = Date.now() - Started;
      }
      resolve({ Success: true, LatencyMs });
    });
  });
}

module.exports = {
  ID,
  Name: 'Ping (ICMP)',
  Description: 'Sends a single ICMP echo request and reports round-trip latency.',
  DefaultInterval: 30000,
  Settings,
  Run,
};
