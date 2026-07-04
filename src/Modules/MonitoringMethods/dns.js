// DNS monitoring. Performs a record lookup against either the OS resolver or a
// caller-supplied resolver and reports success when at least one record is
// returned (optionally matching an expected value).
const dns = require('dns');
const net = require('net');
const { Esc, Pill, Rows, TextRow, Row, Note, FormatLatency } = require('./debug');

const ID = 'dns';

const SUPPORTED_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'];

const Settings = [
  {
    Key: 'RecordType',
    Label: 'Record type',
    Type: 'string',
    Default: 'A',
    Advanced: true,
  },
  {
    Key: 'Resolver',
    Label: 'Resolver IP (optional, e.g. 1.1.1.1)',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'ResolverPort',
    Label: 'Resolver port',
    Type: 'number',
    Default: 53,
    Min: 1,
    Max: 65535,
    Advanced: true,
  },
  {
    Key: 'ExpectedValue',
    Label: 'Expected value (optional substring match)',
    Type: 'string',
    Default: '',
  },
  {
    Key: 'Timeout',
    Label: 'Timeout (ms)',
    Type: 'number',
    Default: 4000,
    Min: 200,
    Max: 30000,
    Advanced: true,
  },
];

function NormalizeRecord(Record) {
  if (Record == null) return '';
  if (typeof Record === 'string') return Record;
  if (Array.isArray(Record)) return Record.join('');
  if (typeof Record === 'object') {
    // MX: { exchange, priority }, SRV: { name, port, ... }, SOA: { nsname, ... }
    return JSON.stringify(Record);
  }
  return String(Record);
}

async function Run(Target) {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  if (!Address) return { Success: false, Error: 'No hostname configured' };

  const Cfg = (Target && Target.Settings) || {};
  const RecordType = String(Cfg.RecordType || 'A').toUpperCase();
  if (!SUPPORTED_TYPES.includes(RecordType)) {
    return { Success: false, Error: `Unsupported record type: ${RecordType}` };
  }

  const TimeoutMs = Number.isFinite(Cfg.Timeout) ? Cfg.Timeout : 4000;
  const Expected = Cfg.ExpectedValue == null ? '' : String(Cfg.ExpectedValue).trim();
  const ResolverIp = Cfg.Resolver == null ? '' : String(Cfg.Resolver).trim();
  const ResolverPort = Number.isFinite(Cfg.ResolverPort) ? Cfg.ResolverPort | 0 : 53;

  let Resolver;
  if (ResolverIp) {
    if (!net.isIP(ResolverIp)) {
      return { Success: false, Error: `Resolver must be an IP address: ${ResolverIp}` };
    }
    Resolver = new dns.promises.Resolver();
    try {
      Resolver.setServers([`${ResolverIp}:${ResolverPort}`]);
    } catch (Err) {
      return { Success: false, Error: `Invalid resolver: ${Err.message}` };
    }
  } else {
    Resolver = dns.promises;
  }

  const Started = Date.now();
  const Lookup = Resolver.resolve(Address, RecordType);
  const Timeout = new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${TimeoutMs}ms`)),
      Math.max(200, TimeoutMs | 0)
    );
  });

  let Records;
  try {
    Records = await Promise.race([Lookup, Timeout]);
  } catch (Err) {
    return { Success: false, Error: Err && Err.message ? Err.message : String(Err) };
  }

  if (!Array.isArray(Records) || Records.length === 0) {
    return { Success: false, Error: 'No DNS records returned', RecordType, Records: [] };
  }

  const Flat = Records.map(NormalizeRecord);

  if (Expected) {
    const Match = Flat.some((R) => R.indexOf(Expected) !== -1);
    if (!Match) {
      return {
        Success: false,
        Error: `No ${RecordType} record matched "${Expected}" (got ${Flat.slice(0, 3).join(', ')})`,
        RecordType,
        Records: Flat,
        Expected,
      };
    }
  }

  return { Success: true, LatencyMs: Date.now() - Started, RecordType, Records: Flat, Expected };
}

// Render the resolved records (and any expected-value match state) for the
// check editor.
function Debug(Result, Target) {
  const Address = Target && Target.Address ? String(Target.Address).trim() : '';
  const Cfg = (Target && Target.Settings) || {};
  const RecordType = (Result && Result.RecordType) || String(Cfg.RecordType || 'A').toUpperCase();
  const Records = Array.isArray(Result && Result.Records) ? Result.Records : [];
  const Success = !!(Result && Result.Success);
  const Expected =
    (Result && Result.Expected) ||
    (Cfg.ExpectedValue == null ? '' : String(Cfg.ExpectedValue).trim());

  const Head = Rows([
    TextRow('Hostname', Address || '—'),
    TextRow('Record type', RecordType),
    Row('Result', Pill(Success ? 'success' : 'danger', Success ? 'Resolved' : 'Failed')),
    Success
      ? Row('Query time', `<span class="font-monospace">${FormatLatency(Result.LatencyMs)}</span>`)
      : null,
    Expected ? TextRow('Expected match', Expected) : null,
  ]);

  if (!Records.length) {
    return (
      Head +
      '<div class="mt-2">' +
      Note((Result && Result.Error) || 'No records returned') +
      '</div>'
    );
  }

  const List = Records.map(
    (R) =>
      '<div class="bg-ghost rounded px-2 py-1 font-monospace small text-light text-break">' +
      `${Esc(R)}` +
      '</div>'
  ).join('');

  return (
    Head +
    `<div class="text-muted small mt-2 mb-1">${RecordType} records (${Records.length})</div>` +
    `<div class="d-grid gap-1">${List}</div>`
  );
}

module.exports = {
  ID,
  Name: 'DNS',
  Description: 'Resolves the configured hostname against the system or a custom resolver.',
  DefaultInterval: 60000,
  Settings,
  Run,
  Debug,
};
