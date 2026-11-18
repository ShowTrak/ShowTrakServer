// Serves the Web UI's text assets (HTML, JS, CSS, JSON, SVG, source maps)
// compressed, with cache headers that suit how each one changes.
//
// The Web UI is ~1.4 MB of text (the page, its bundle, the stylesheet and the
// vendor libraries) and was sent uncompressed to every browser and phone that
// opened it; brotli brings it to ~320 KB. Each file is compressed once, on its
// first request, off the main thread (node:zlib's async API runs on the libuv
// pool), and the result is kept in memory until the file changes on disk. No
// dependency: just node:zlib.
//
// Caching:
//   - The page itself, the service worker, the manifest, the Web UI bundle and
//     the stylesheet are `no-cache`: a browser revalidates them on every load
//     (a 304 when nothing changed), so a server upgrade takes effect at once.
//   - Vendor libraries (jQuery, Bootstrap, ...) never change within a release.
//     The served page asks for them with `?v=<server version>`, and a request
//     that carries the current version is cacheable for a year: the next
//     upgrade changes the URL. Without it (an older page, a dev run) they
//     revalidate like everything else.
//
// Anything this does not handle (images, fonts, audio, a missing file) falls
// through to express.static as before.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { promisify } from 'util';
import type { Request, Response, NextFunction } from 'express';

const Gzip = promisify(zlib.gzip);
const Brotli = promisify(zlib.brotliCompress);

const COMPRESSIBLE_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.map',
  '.svg',
  '.txt',
  '.webmanifest',
]);
// Below this a compressed body saves less than the encoding headers cost.
const MIN_COMPRESS_BYTES = 1024;
const VENDOR_PREFIX = '/vendors/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

interface PreparedAsset {
  MtimeMs: number;
  Size: number;
  Identity: Buffer;
  Gzip: Buffer | null;
  Brotli: Buffer | null;
  ETag: string;
}

interface StaticAssetOptions {
  // Appended to vendor URLs in the served page and required for the long-lived
  // cache header. Empty disables both.
  VersionTag: string;
}

// `"<hash>"`, with the encoding appended for a compressed variant: one URL
// served in several encodings needs a distinct validator for each.
function VariantETag(Base: string, Encoding: string | null): string {
  return Encoding ? `"${Base}-${Encoding}"` : `"${Base}"`;
}

function PickEncoding(Req: Request, Asset: PreparedAsset): 'br' | 'gzip' | null {
  const Accept = String(Req.headers['accept-encoding'] || '');
  if (Asset.Brotli && /\bbr\b/.test(Accept)) return 'br';
  if (Asset.Gzip && /\bgzip\b/.test(Accept)) return 'gzip';
  return null;
}

// Point the page's vendor <script>/<link> URLs at the versioned form.
function VersionVendorUrls(Html: string, VersionTag: string): string {
  return Html.replace(
    /(\s(?:src|href)=")(\.?\/vendors\/[^"?#]+)(")/g,
    (_Match, Before: string, Url: string, After: string) =>
      `${Before}${Url}?v=${encodeURIComponent(VersionTag)}${After}`
  );
}

export function CreateWebUiAssetHandler(Root: string, { VersionTag }: StaticAssetOptions) {
  const ResolvedRoot = path.resolve(Root);
  const Prepared = new Map<string, Promise<PreparedAsset>>();

  async function Prepare(FilePath: string, MtimeMs: number, Size: number): Promise<PreparedAsset> {
    let Identity = await fs.promises.readFile(FilePath);
    if (VersionTag && path.basename(FilePath) === 'index.html') {
      Identity = Buffer.from(VersionVendorUrls(Identity.toString('utf8'), VersionTag), 'utf8');
    }
    const Compress = Identity.length >= MIN_COMPRESS_BYTES;
    const [GzipBody, BrotliBody] = Compress
      ? await Promise.all([
          Gzip(Identity, { level: 9 }),
          Brotli(Identity, {
            params: {
              // Quality 9 is within ~8% of the maximum (11) at a twentieth of
              // the time (17 ms vs 760 ms for the 600 KB bundle).
              [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
              [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Identity.length,
            },
          }),
        ])
      : [null, null];
    return {
      MtimeMs,
      Size,
      Identity,
      // Kept only when it actually saves bytes.
      Gzip: GzipBody && GzipBody.length < Identity.length ? GzipBody : null,
      Brotli: BrotliBody && BrotliBody.length < Identity.length ? BrotliBody : null,
      ETag: crypto.createHash('sha1').update(Identity).digest('base64url'),
    };
  }

  // The prepared asset for FilePath, rebuilt when the file on disk changes
  // (a dev rebuild); null when it is not a regular file.
  async function Load(FilePath: string): Promise<PreparedAsset | null> {
    let Stat: fs.Stats;
    try {
      Stat = await fs.promises.stat(FilePath);
    } catch {
      return null;
    }
    if (!Stat.isFile()) return null;
    const Cached = Prepared.get(FilePath);
    if (Cached) {
      const Asset = await Cached.catch(() => null);
      if (Asset && Asset.MtimeMs === Stat.mtimeMs && Asset.Size === Stat.size) return Asset;
    }
    const Pending = Prepare(FilePath, Stat.mtimeMs, Stat.size);
    Prepared.set(FilePath, Pending);
    try {
      return await Pending;
    } catch {
      Prepared.delete(FilePath);
      return null;
    }
  }

  function ResolveFile(RequestPath: string): string | null {
    let Decoded: string;
    try {
      Decoded = decodeURIComponent(RequestPath);
    } catch {
      return null;
    }
    if (Decoded.includes('\0')) return null;
    const Relative = Decoded === '/' || Decoded === '' ? 'index.html' : Decoded.replace(/^\/+/, '');
    // Dotfiles stay hidden, as express.static leaves them by default.
    if (Relative.split('/').some((Segment) => Segment.startsWith('.'))) return null;
    if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(Relative).toLowerCase())) return null;
    const FilePath = path.resolve(ResolvedRoot, Relative);
    if (FilePath !== ResolvedRoot && !FilePath.startsWith(ResolvedRoot + path.sep)) return null;
    return FilePath;
  }

  return async function WebUiAssetHandler(Req: Request, Res: Response, Next: NextFunction) {
    if (Req.method !== 'GET' && Req.method !== 'HEAD') return Next();
    const FilePath = ResolveFile(Req.path);
    if (!FilePath) return Next();
    let Asset: PreparedAsset | null;
    try {
      Asset = await Load(FilePath);
    } catch {
      Asset = null;
    }
    if (!Asset) return Next();

    const Encoding = PickEncoding(Req, Asset);
    const Body =
      Encoding === 'br' ? Asset.Brotli : Encoding === 'gzip' ? Asset.Gzip : Asset.Identity;
    const ETag = VariantETag(Asset.ETag, Encoding);
    const Versioned =
      !!VersionTag && Req.path.startsWith(VENDOR_PREFIX) && Req.query.v === VersionTag;

    Res.type(path.extname(FilePath));
    Res.setHeader('Cache-Control', Versioned ? IMMUTABLE : REVALIDATE);
    Res.setHeader('ETag', ETag);
    if (Asset.Gzip || Asset.Brotli) Res.setHeader('Vary', 'Accept-Encoding');
    if (Encoding) Res.setHeader('Content-Encoding', Encoding);

    const IfNoneMatch = String(Req.headers['if-none-match'] || '');
    if (
      IfNoneMatch &&
      IfNoneMatch.split(/\s*,\s*/).some((Tag) => Tag === ETag || Tag === `W/${ETag}`)
    ) {
      Res.status(304).end();
      return;
    }
    Res.setHeader('Content-Length', String(Body ? Body.length : 0));
    if (Req.method === 'HEAD') {
      Res.end();
      return;
    }
    Res.end(Body);
  };
}

export { VersionVendorUrls };
