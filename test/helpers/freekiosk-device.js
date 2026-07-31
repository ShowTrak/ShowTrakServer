// A mock FreeKiosk terminal: a real HTTP server on 127.0.0.1 that speaks the
// device's REST API closely enough to exercise the protocol client end to end.
//
// A real server rather than a stubbed `http` module, because several of the
// behaviours under test are transport behaviours — a stalled response hitting
// the kill timer, an image stream running past the size cap, a body whose
// declared Content-Length is a lie. None of those are meaningful against a fake
// module that resolves immediately.
const http = require('node:http');

/** A healthy /api/status payload with every documented sub-object populated. */
const STATUS_HEALTHY = Object.freeze({
  battery: {
    level: 87,
    charging: true,
    plugged: 'ac',
    temperature: 24.5,
    voltage: 4.32,
    health: 'good',
    technology: 'Li-ion',
  },
  screen: { on: true, brightness: 75, screensaverActive: false },
  audio: { volume: 40 },
  webview: { currentUrl: 'https://example.com/board', canGoBack: false, loading: false },
  device: {
    ip: '192.168.1.50',
    hostname: 'freekiosk',
    version: '1.2.11',
    isDeviceOwner: true,
    kioskMode: true,
    manufacturer: 'samsung',
    model: 'SM-T510',
    androidVersion: '11',
    apiLevel: 30,
    processor: 'exynos7904',
    deviceName: 'gta3xlwifi',
    product: 'gta3xlwifixx',
    uptime: 93600,
  },
  wifi: {
    ssid: 'Backstage',
    signalStrength: -52,
    signalLevel: 78,
    connected: true,
    linkSpeed: 217,
    frequency: 5180, // 5 GHz channel 36

    ipAddress: '192.168.1.50',
  },
  rotation: {
    enabled: false,
    urls: ['https://example.com/a', 'https://example.com/b'],
    interval: 30,
    currentIndex: 0,
  },
  sensors: { light: 150.5, proximity: 5, accelerometer: { x: 0.1, y: 0.2, z: 9.78 } },
  autoBrightness: { enabled: true, min: 10, max: 100, currentLightLevel: 150.5 },
  storage: { totalMB: 32000, availableMB: 15000, usedMB: 17000, usedPercent: 53 },
  memory: { totalMB: 4096, availableMB: 2048, usedMB: 2048, usedPercent: 50, lowMemory: false },
});

function envelope(data) {
  return JSON.stringify({ success: true, data, timestamp: 1704672000 });
}

function errorEnvelope(message) {
  return JSON.stringify({ success: false, error: message, timestamp: 1704672000 });
}

/**
 * startFreeKioskDevice(options) -> { port, url, close(), requests }
 *
 * options:
 *   status          object   payload for /api/status (default STATUS_HEALTHY)
 *   apiKey          string   when set, requests must carry a matching X-Api-Key
 *   allowControl    bool     false makes every control endpoint answer 403
 *   refuseCommands  bool     answer 200/success:true with executed:false — the
 *                            privilege-failure shape a device without Device
 *                            Owner really sends
 *   stall           bool     accept the request and never answer
 *   hangUp          bool     destroy the socket without answering — what a real
 *                            tablet does when a reboot tears the server down
 *                            mid-response
 *   imageBytes      number   size of the body /api/screenshot streams
 *   imageContentType string  content-type for capture endpoints
 *   omitLength      bool     answer chunked with no Content-Length at all, so
 *                            the only thing bounding the body is the client's
 *                            own running total
 *   cameraUnavailable bool   answer 503 + JSON on the capture endpoints
 *   statusCode      number   force this status on /api/status
 *   rawBody         string   force this body on /api/status (to test non-JSON)
 */
function startFreeKioskDevice(options = {}) {
  const requests = [];

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const entry = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body: null,
      };
      requests.push(entry);

      // Captured so a test can assert what was actually SENT, not merely that
      // something was. For a command whose body is derived server-side from a
      // terminal's stored configuration, the body is the whole behaviour.
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          try {
            entry.body = JSON.parse(raw || '{}');
          } catch {
            entry.body = raw;
          }
        });
      }

      if (options.stall) return; // Never answer; the client's timeout must fire.

      // A rebooting device kills the HTTP server mid-response. The client sees
      // ECONNRESET / "socket hang up", never a status line.
      if (options.hangUp) return req.socket.destroy();

      if (options.apiKey && req.headers['x-api-key'] !== options.apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(errorEnvelope('Invalid or missing API key'));
      }

      const isControl =
        url.pathname !== '/api/status' && !url.pathname.startsWith('/api/camera/list');
      const isCapture = url.pathname === '/api/screenshot' || url.pathname === '/api/camera/photo';

      if (isCapture) {
        if (options.cameraUnavailable) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(
            errorEnvelope('Camera not available. Check camera permission and hardware.')
          );
        }
        const size = options.imageBytes == null ? 128 : options.imageBytes;
        const headers = {
          'Content-Type': options.imageContentType || 'image/png',
        };
        // Setting a length lets the client reject early; omitting it forces
        // chunked encoding, where only the client's running total can stop it.
        if (!options.omitLength) headers['Content-Length'] = String(size);
        res.writeHead(200, headers);
        // Write in chunks so the client's per-chunk cap is what stops an
        // oversized body, not a single giant buffer.
        const chunk = Buffer.alloc(Math.min(size, 64 * 1024), 0x41);
        let written = 0;
        while (written < size) {
          const next = Math.min(chunk.length, size - written);
          res.write(chunk.subarray(0, next));
          written += next;
        }
        return res.end();
      }

      if (url.pathname === '/api/camera/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          envelope({
            executed: true,
            command: 'cameraList',
            cameras: [
              { id: '0', facing: 'back', maxWidth: 4032, maxHeight: 3024 },
              { id: '1', facing: 'front', maxWidth: 2560, maxHeight: 1920 },
            ],
          })
        );
      }

      if (url.pathname === '/api/status') {
        if (options.rawBody != null) {
          res.writeHead(options.statusCode || 200, { 'Content-Type': 'text/html' });
          return res.end(options.rawBody);
        }
        if (options.statusCode && options.statusCode !== 200) {
          res.writeHead(options.statusCode, { 'Content-Type': 'application/json' });
          return res.end(errorEnvelope('Endpoint not found'));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(envelope(options.status || STATUS_HEALTHY));
      }

      if (isControl && options.allowControl === false) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(errorEnvelope('Remote control is disabled'));
      }

      // The trap: HTTP 200 and success:true, with the real verdict in executed.
      if (options.refuseCommands) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          envelope({
            executed: false,
            command: url.pathname,
            error: 'Reboot requires Device Owner mode',
          })
        );
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(envelope({ executed: true, command: url.pathname }));
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          }),
      });
    });
  });
}

module.exports = { startFreeKioskDevice, STATUS_HEALTHY };
