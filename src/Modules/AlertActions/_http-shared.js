const http = require('http');
const https = require('https');

function requestJson({ Url, Method = 'POST', Headers = {}, Timeout = 5000, Body = null }) {
  return new Promise((resolve) => {
    let Parsed;
    try {
      Parsed = new URL(String(Url || '').trim());
    } catch {
      return resolve({ Success: false, StatusCode: 0, Error: 'Invalid URL' });
    }

    const IsHttps = Parsed.protocol === 'https:';
    if (!IsHttps && Parsed.protocol !== 'http:') {
      return resolve({ Success: false, StatusCode: 0, Error: 'Only http/https URLs are supported' });
    }

    const Transport = IsHttps ? https : http;
    const TimeoutMs = Number.isFinite(Number(Timeout)) ? Math.max(250, Number(Timeout)) : 5000;
    const MethodUpper = String(Method || 'POST').toUpperCase();

    const Payload = Body == null ? '' : JSON.stringify(Body);

    const Req = Transport.request(
      {
        hostname: Parsed.hostname,
        port: Parsed.port || (IsHttps ? 443 : 80),
        path: `${Parsed.pathname || '/'}${Parsed.search || ''}`,
        method: MethodUpper,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(Payload),
          ...Headers,
        },
      },
      (Res) => {
        const Chunks = [];
        Res.on('data', (Chunk) => Chunks.push(Chunk));
        Res.on('end', () => {
          const Text = Buffer.concat(Chunks).toString('utf8');
          const StatusCode = Res.statusCode || 0;
          resolve({
            Success: StatusCode >= 200 && StatusCode <= 299,
            StatusCode,
            BodyText: Text,
            Error: StatusCode >= 200 && StatusCode <= 299 ? null : `HTTP ${StatusCode}`,
          });
        });
      }
    );

    Req.setTimeout(TimeoutMs, () => {
      Req.destroy(new Error(`Request timed out after ${TimeoutMs}ms`));
    });

    Req.on('error', (Err) => {
      resolve({
        Success: false,
        StatusCode: 0,
        Error: Err && Err.message ? Err.message : String(Err),
      });
    });

    try {
      Req.write(Payload);
      Req.end();
    } catch (Err) {
      resolve({
        Success: false,
        StatusCode: 0,
        Error: Err && Err.message ? Err.message : String(Err),
      });
    }
  });
}

module.exports = {
  requestJson,
};
