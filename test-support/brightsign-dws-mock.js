// A fake `http` / `https` module pair that emulates a BrightSign player's Local
// DWS well enough to exercise the brightsign* monitoring methods end to end.
//
// It speaks real RFC 2617 digest auth — it issues a challenge and verifies the
// Authorization header the method computes against the configured credentials —
// so the auth handshake is genuinely under test rather than stubbed out.
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const md5 = (Value) => crypto.createHash('md5').update(Value, 'utf8').digest('hex');

const NONCE = 'a1b2c3d4e5f60718';
const REALM = 'BrightSign';

function parseAuthParams(Header) {
  const Params = {};
  const Re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi;
  let Match;
  while ((Match = Re.exec(String(Header || ''))) !== null) {
    Params[Match[1].toLowerCase()] =
      Match[2] !== undefined ? Match[2].replace(/\\(.)/g, '$1') : Match[3];
  }
  return Params;
}

// Recompute what the client's `response=` should be, so a wrong password or a
// malformed header fails exactly as a real player would reject it.
function expectedResponse(Params, Method, Username, Password) {
  const HA1 = md5(`${Username}:${Params.realm}:${Password}`);
  const HA2 = md5(`${Method}:${Params.uri}`);
  if (Params.qop) {
    return md5(`${HA1}:${Params.nonce}:${Params.nc}:${Params.cnonce}:${Params.qop}:${HA2}`);
  }
  return md5(`${HA1}:${Params.nonce}:${HA2}`);
}

function makeResponse(Status, Headers, Body) {
  const Res = new EventEmitter();
  Res.statusCode = Status;
  Res.headers = Headers || {};
  setImmediate(() => {
    if (Body) Res.emit('data', Buffer.from(String(Body), 'utf8'));
    Res.emit('end');
  });
  return Res;
}

// Wrap a payload in the DWS envelope: {"data":{"result": ...}}
function envelope(Payload) {
  return JSON.stringify({ data: { result: Payload } });
}

/**
 * @param {object} options
 * @param {object} options.routes      path -> payload object, or { Status, Body } for a raw reply
 * @param {object} options.auth        { username, password } — when set, digest auth is required
 * @param {string} options.qop         digest qop to advertise ('auth' by default; '' for RFC 2069)
 * @param {string} options.algorithm   digest algorithm to advertise (default 'MD5')
 * @param {boolean} options.refuse     emit ECONNREFUSED instead of replying
 * @param {boolean} options.silent     never reply (drives the timeout path)
 * @param {boolean} options.redirectToHttps  answer plain HTTP with a 302 to HTTPS
 * @param {number} options.delayMs     delay each reply by this many ms (real
 *   timer) so a redirect + auth handshake accrues wall-clock time — used to
 *   prove the whole-probe timeout budget caps the total across every round trip.
 */
function makeBrightSignDws(options = {}) {
  const {
    routes = {},
    auth = null,
    qop = 'auth',
    algorithm = 'MD5',
    refuse = false,
    silent = false,
    redirectToHttps = false,
    delayMs = 0,
  } = options;

  const calls = [];

  const challenge = () => {
    const Parts = [`realm="${REALM}"`, `nonce="${NONCE}"`];
    if (algorithm) Parts.push(`algorithm=${algorithm}`);
    if (qop) Parts.push(`qop="${qop}"`);
    return `Digest ${Parts.join(', ')}`;
  };

  const serve = (Scheme, Opts, Req) => {
    const Headers = Opts.headers || {};
    calls.push({
      Scheme,
      Path: Opts.path,
      Hostname: Opts.hostname,
      Port: Opts.port,
      Authorization: Headers.Authorization || null,
      RejectUnauthorized: Opts.rejectUnauthorized,
    });

    if (refuse) {
      return Req.emit(
        'error',
        Object.assign(new Error(`connect ECONNREFUSED ${Opts.hostname}:${Opts.port}`), {
          code: 'ECONNREFUSED',
        })
      );
    }
    if (silent) return; // never answers — the method's kill timer must fire

    if (redirectToHttps && Scheme === 'http') {
      return Req.emit(
        'response',
        makeResponse(302, { location: `https://${Opts.hostname}${Opts.path}` }, '')
      );
    }

    if (auth) {
      const Provided = Headers.Authorization;
      if (!Provided) {
        return Req.emit(
          'response',
          makeResponse(401, { 'www-authenticate': challenge() }, 'Unauthorized')
        );
      }
      const Params = parseAuthParams(Provided);
      const Want = expectedResponse(Params, Opts.method || 'GET', auth.username, auth.password);
      if (Params.response !== Want || Params.username !== auth.username) {
        return Req.emit(
          'response',
          makeResponse(401, { 'www-authenticate': challenge() }, 'Unauthorized')
        );
      }
    }

    const Route = routes[Opts.path];
    if (Route === undefined) {
      return Req.emit('response', makeResponse(404, {}, 'Not Found'));
    }
    if (Route && typeof Route === 'object' && ('Status' in Route || 'Body' in Route)) {
      return Req.emit('response', makeResponse(Route.Status ?? 200, {}, Route.Body ?? ''));
    }
    return Req.emit('response', makeResponse(200, {}, envelope(Route)));
  };

  const makeLib = (Scheme) => ({
    request(Opts) {
      const Req = new EventEmitter();
      Req.end = () => {
        if (delayMs > 0) setTimeout(() => serve(Scheme, Opts, Req), delayMs);
        else setImmediate(() => serve(Scheme, Opts, Req));
      };
      Req.destroy = (Err) => {
        if (Err) setImmediate(() => Req.emit('error', Err));
      };
      return Req;
    },
  });

  return { http: makeLib('http'), https: makeLib('https'), calls };
}

// A realistic /api/v1/info payload, modelled on BrightSign's own captured
// example (an HD1024 on 8.5.33). Sub-objects use the {result} form.
const INFO_HEALTHY = {
  serial: 'TKD27R001940',
  upTime: '1 hours 49 minutes',
  upTimeSeconds: 6561,
  model: 'HD1024',
  FWVersion: '8.5.33',
  bootVersion: '8.0.152',
  family: 'pagani',
  isPlayer: true,
  power: { result: { battery: 'absent', source: 'AC', switch_mode: 'hard' } },
  poe: { result: { status: 'not_supported' } },
  networking: { result: { description: 'HD4', name: 'HD4-TKD27R001940' } },
  api_features: { video: true },
  connectionType: 'wlan0',
  bsnce: true,
};

// A realistic /api/v1/video/hdmi/output/0 payload.
const VIDEO_HEALTHY = {
  resolutions: { output: { result: { height: 1080, width: 1920 } } },
  attached: { result: true },
  status: {
    result: {
      audioFormat: 'PCM',
      eotf: 'SDR (GAMMA)',
      outputPowered: true,
      outputPresent: true,
      unstable: false,
    },
  },
  TxHdcpStatus: { result: { state: 'not-required' } },
  activeMode: {
    result: { modeName: '1920x1080x60p', width: 1920, height: 1080, frequency: 60 },
  },
  bestMode: { result: '1920x1080x60p' },
  powerSaveStatus: { result: false },
};

const INFO_PATH = '/api/v1/info';
const VIDEO_PATH = '/api/v1/video/hdmi/output/0';

module.exports = {
  makeBrightSignDws,
  INFO_HEALTHY,
  VIDEO_HEALTHY,
  INFO_PATH,
  VIDEO_PATH,
  envelope,
};
