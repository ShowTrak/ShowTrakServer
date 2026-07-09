import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { URL } from 'url';

import { CreateLogger } from '../Logger';
import { Manager as AppDataManager } from '../AppData';

const Logger = CreateLogger('UpdateManager');

// Raw shapes returned by the GitHub Releases API (only the fields we read).
interface GithubAsset {
  name?: string;
  size?: number;
  browser_download_url?: string;
  [key: string]: unknown;
}
interface GithubRelease {
  tag_name?: string;
  name?: string;
  published_at?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GithubAsset[];
  [key: string]: unknown;
}

// The locally-cached update manifest written to disk after a download.
interface UpdateManifestAsset {
  name: string;
  size: number;
}
interface UpdateManifest {
  version?: string;
  releasedAt?: string | null;
  downloadedAt?: string | null;
  assets: UpdateManifestAsset[];
}

// A release option surfaced to the operator when choosing a version to cache.
interface ReleaseOption {
  tag: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
}

// The public projection of a cached asset (served over the LAN feed).
interface PublicUpdateAsset {
  name: string;
  size: number;
  url: string;
}

interface UpdateStatus {
  Ready: boolean;
  ReleaseVersion: string | null;
  ReleasedAt: string | null;
  DownloadedAt: string | null;
  Assets: PublicUpdateAsset[];
  FeedPath: string;
}

interface DownloadProgress {
  percent: number;
  phase: string;
  message: string;
}
interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
}
interface DownloadResult {
  ReleaseVersion: string;
  FeedPath: string;
  AssetCount: number;
}

// Minimal Express surface used by RegisterRoutes (avoids a hard express dep).
interface ExpressRequest {
  params: Record<string, unknown>;
}
interface ExpressResponse {
  json(body: unknown): unknown;
  status(code: number): ExpressResponse;
  sendFile(filePath: string): unknown;
}
interface ExpressLike {
  get(
    routePath: string,
    handler: (req: ExpressRequest, res: ExpressResponse) => void | Promise<void>
  ): unknown;
}

interface UpdateManagerType {
  GetPublicFeedURLPath(): string;
  ListReleases(): Promise<ReleaseOption[]>;
  GetStatus(): Promise<UpdateStatus>;
  DownloadRelease(Tag?: unknown, Options?: DownloadOptions): Promise<DownloadResult>;
  DownloadLatestRelease(Options?: DownloadOptions): Promise<DownloadResult>;
  RegisterRoutes(expressApp: ExpressLike): void;
}

const GITHUB_RELEASE_API = 'https://api.github.com/repos/ShowTrak/ShowTrakClient/releases/latest';
const GITHUB_RELEASES_API =
  'https://api.github.com/repos/ShowTrak/ShowTrakClient/releases?per_page=25';
const GITHUB_RELEASE_BY_TAG_API =
  'https://api.github.com/repos/ShowTrak/ShowTrakClient/releases/tags/';
const PUBLIC_BASE_PATH = '/updates/client/latest';
const DOWNLOAD_TIMEOUT_MS = 45000;
const MINIMUM_LISTED_RELEASE = [3, 4, 0];

const UpdateCacheDirectory = path.join(AppDataManager.GetStorageDirectory(), 'ClientUpdateCache');
const ManifestPath = path.join(UpdateCacheDirectory, 'manifest.json');

const Manager = {} as UpdateManagerType;

function ensureCacheDirectory() {
  if (!fs.existsSync(UpdateCacheDirectory)) {
    fs.mkdirSync(UpdateCacheDirectory, { recursive: true });
  }
}

function normalizeAssetName(name: unknown): string {
  const base = path.basename(String(name || '').trim());
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readManifest(): UpdateManifest | null {
  ensureCacheDirectory();
  if (!fs.existsSync(ManifestPath)) return null;
  try {
    const raw = fs.readFileSync(ManifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.assets)) return null;
    return parsed;
  } catch (err) {
    Logger.warn('Failed to read update manifest:', err && (err as Error).message ? (err as Error).message : err);
    return null;
  }
}

function isManifestReady(manifest: UpdateManifest | null): boolean {
  if (!manifest || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    return false;
  }

  for (const asset of manifest.assets) {
    if (!asset || !asset.name) return false;
    const target = path.join(UpdateCacheDirectory, String(asset.name));
    if (!fs.existsSync(target)) return false;
  }

  return true;
}

function writeManifest(data: UpdateManifest) {
  ensureCacheDirectory();
  fs.writeFileSync(ManifestPath, JSON.stringify(data, null, 2), 'utf8');
}

function requestJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ShowTrakServer',
        },
      },
      (res: http.IncomingMessage) => {
        if (res.statusCode !== 200) {
          const msg = `GitHub API request failed: ${res.statusCode}`;
          res.resume();
          reject(new Error(msg));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Failed to parse GitHub response: ${(err as Error).message}`));
          }
        });
      }
    );

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('GitHub API request timed out'));
    });

    req.on('error', reject);
    req.end();
  });
}

interface DownloadFileOptions {
  onChunk?: (bytes: number) => void;
}

function downloadFile(
  fileUrl: string,
  destinationPath: string,
  options: DownloadFileOptions = {},
  redirectCount = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects while downloading update asset'));
      return;
    }

    ensureCacheDirectory();
    const tempPath = `${destinationPath}.tmp`;
    const file = fs.createWriteStream(tempPath);

    const req = https.get(
      fileUrl,
      {
        headers: {
          'User-Agent': 'ShowTrakServer',
          Accept: 'application/octet-stream',
        },
      },
      (res: http.IncomingMessage) => {
        const status = res.statusCode || 0;
        const redirectLocation = res.headers.location;
        if (status >= 300 && status < 400 && redirectLocation) {
          file.close(() => {
            try {
              fs.unlinkSync(tempPath);
            } catch {
              /* intentional: temp-file cleanup is best-effort; a leftover partial download is harmless */
            }
            const nextUrl = new URL(redirectLocation, fileUrl).toString();
            downloadFile(nextUrl, destinationPath, options, redirectCount + 1)
              .then(resolve)
              .catch(reject);
          });
          return;
        }

        if (status !== 200) {
          file.close(() => {
            try {
              fs.unlinkSync(tempPath);
            } catch {
              /* intentional: temp-file cleanup is best-effort; the download already failed */
            }
            reject(new Error(`Asset download failed (${status}) for ${fileUrl}`));
          });
          return;
        }

        if (typeof options.onChunk === 'function') {
          res.on('data', (chunk: Buffer) => {
            try {
              options.onChunk?.(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
            } catch {
              /* intentional: progress reporting must never interrupt the download stream */
            }
          });
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.rename(tempPath, destinationPath, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
        });
      }
    );

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('Asset download timed out'));
    });

    req.on('error', (err) => {
      try {
        file.close(() => {
          try {
            fs.unlinkSync(tempPath);
          } catch {
            /* intentional: temp-file cleanup is best-effort on request error */
          }
          reject(err);
        });
      } catch {
        reject(err);
      }
    });

    file.on('error', (err) => {
      try {
        file.close(() => {
          try {
            fs.unlinkSync(tempPath);
          } catch {
            /* intentional: temp-file cleanup is best-effort on file-write error */
          }
          reject(err);
        });
      } catch {
        reject(err);
      }
    });
  });
}

function buildPublicAssetList(manifest: UpdateManifest | null): PublicUpdateAsset[] {
  if (!manifest || !Array.isArray(manifest.assets)) return [];
  return manifest.assets.map((asset) => ({
    name: asset.name,
    size: Number(asset.size) || 0,
    url: `${PUBLIC_BASE_PATH}/${encodeURIComponent(asset.name)}`,
  }));
}

Manager.GetPublicFeedURLPath = () => `${PUBLIC_BASE_PATH}/`;

function normalizeReleaseOption(release: GithubRelease): ReleaseOption {
  return {
    tag: String(release && release.tag_name ? release.tag_name : '').trim(),
    name: String(release && release.name ? release.name : '').trim(),
    publishedAt: release && release.published_at ? release.published_at : null,
    prerelease: !!(release && release.prerelease),
  };
}

function parseSemverTag(tag: unknown): number[] | null {
  const value = String(tag || '').trim();
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeastMinimumRelease(tag: unknown): boolean {
  const parsed = parseSemverTag(tag);
  if (!parsed) return false;
  for (let i = 0; i < MINIMUM_LISTED_RELEASE.length; i++) {
    const current = parsed[i] || 0;
    const minimum = MINIMUM_LISTED_RELEASE[i] || 0;
    if (current > minimum) return true;
    if (current < minimum) return false;
  }
  return true;
}

Manager.ListReleases = async () => {
  const releases = await requestJson(GITHUB_RELEASES_API);
  if (!Array.isArray(releases)) return [];

  return releases
    .filter(
      (release: GithubRelease) =>
        release && !release.draft && release.tag_name && isAtLeastMinimumRelease(release.tag_name)
    )
    .map((release: GithubRelease) => normalizeReleaseOption(release));
};

async function getReleaseByTag(tag: unknown): Promise<unknown> {
  const safeTag = String(tag || '').trim();
  if (!safeTag) return requestJson(GITHUB_RELEASE_API);
  return requestJson(`${GITHUB_RELEASE_BY_TAG_API}${encodeURIComponent(safeTag)}`);
}

Manager.GetStatus = async () => {
  const manifest = readManifest();
  const ready = isManifestReady(manifest);
  if (!manifest) {
    return {
      Ready: false,
      ReleaseVersion: null,
      ReleasedAt: null,
      DownloadedAt: null,
      Assets: [],
      FeedPath: Manager.GetPublicFeedURLPath(),
    };
  }

  return {
    Ready: ready,
    ReleaseVersion: manifest.version || null,
    ReleasedAt: manifest.releasedAt || null,
    DownloadedAt: manifest.downloadedAt || null,
    Assets: buildPublicAssetList(manifest),
    FeedPath: Manager.GetPublicFeedURLPath(),
  };
};

Manager.DownloadRelease = async (Tag: unknown = null, Options: DownloadOptions = {}) => {
  ensureCacheDirectory();

  const reportProgress =
    Options && typeof Options.onProgress === 'function' ? Options.onProgress : null;
  const pushProgress = (percent: number, phase?: string, message?: string) => {
    if (!reportProgress) return;
    try {
      reportProgress({
        percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
        phase: phase || 'downloading',
        message: message || '',
      });
    } catch {
      /* intentional: progress reporting is best-effort and must not abort the download */
    }
  };

  pushProgress(0, 'preparing', 'Checking release metadata...');

  const release = (await getReleaseByTag(Tag)) as GithubRelease;
  const version = String(release.tag_name || release.name || '').trim();
  const assets: GithubAsset[] = Array.isArray(release.assets) ? release.assets : [];

  if (!version) throw new Error('GitHub release response missing version');
  if (assets.length === 0) throw new Error(`Release ${Tag || 'latest'} has no downloadable assets`);

  Logger.log('Downloading ShowTrakClient release for LAN updates', {
    version,
    assets: assets.length,
  });

  const downloadedAssets: UpdateManifestAsset[] = [];
  const totalBytes = assets.reduce((sum: number, asset: GithubAsset) => {
    const size = Number(asset && asset.size);
    if (!Number.isFinite(size) || size < 0) return sum;
    return sum + size;
  }, 0);
  let downloadedBytes = 0;

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const safeName = normalizeAssetName(asset && asset.name ? asset.name : `asset-${i}`);
    const downloadUrl =
      asset && asset.browser_download_url ? String(asset.browser_download_url) : '';
    if (!downloadUrl) continue;
    const destination = path.join(UpdateCacheDirectory, safeName);
    pushProgress(
      totalBytes > 0
        ? (downloadedBytes / totalBytes) * 100
        : (i / Math.max(assets.length, 1)) * 100,
      'downloading',
      `Downloading ${safeName} (${i + 1}/${assets.length})`
    );

    await downloadFile(downloadUrl, destination, {
      onChunk: (chunkSize: number) => {
        if (totalBytes <= 0) return;
        downloadedBytes += Number(chunkSize) || 0;
        pushProgress(
          (downloadedBytes / totalBytes) * 100,
          'downloading',
          `Downloading ${safeName} (${i + 1}/${assets.length})`
        );
      },
    });

    if (totalBytes <= 0) {
      pushProgress(
        ((i + 1) / Math.max(assets.length, 1)) * 100,
        'downloading',
        `Downloaded ${safeName} (${i + 1}/${assets.length})`
      );
    }

    let size = 0;
    try {
      size = fs.statSync(destination).size;
    } catch {
      /* intentional: size is metadata only; fall back to 0 if the stat fails */
    }

    downloadedAssets.push({
      name: safeName,
      size,
    });
  }

  if (downloadedAssets.length === 0) {
    throw new Error('No release assets were downloaded');
  }

  const keep = new Set(downloadedAssets.map((asset) => asset.name));
  const cacheFiles = fs.readdirSync(UpdateCacheDirectory);
  for (const fileName of cacheFiles) {
    if (fileName === path.basename(ManifestPath)) continue;
    if (keep.has(fileName)) continue;
    try {
      fs.unlinkSync(path.join(UpdateCacheDirectory, fileName));
    } catch {
      /* intentional: pruning stale cache files is best-effort; a leftover file is harmless */
    }
  }

  const manifest = {
    version,
    releasedAt: release.published_at || null,
    downloadedAt: new Date().toISOString(),
    assets: downloadedAssets,
  };

  writeManifest(manifest);
  pushProgress(100, 'complete', `Downloaded release ${version}`);

  return {
    ReleaseVersion: version,
    FeedPath: Manager.GetPublicFeedURLPath(),
    AssetCount: downloadedAssets.length,
  };
};

Manager.DownloadLatestRelease = async (Options: DownloadOptions = {}) => {
  return Manager.DownloadRelease(null, Options);
};

Manager.RegisterRoutes = (expressApp: ExpressLike) => {
  if (!expressApp || typeof expressApp.get !== 'function') {
    throw new Error('RegisterRoutes requires an express app instance');
  }

  expressApp.get(`${PUBLIC_BASE_PATH}/status`, async (_req: ExpressRequest, res: ExpressResponse) => {
    const status = await Manager.GetStatus();
    res.json(status);
  });

  expressApp.get(`${PUBLIC_BASE_PATH}/:fileName`, (req: ExpressRequest, res: ExpressResponse) => {
    const fileName = path.basename(String(req.params.fileName || ''));
    if (!fileName) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const manifest = readManifest();
    const allowed = new Set(
      (manifest && manifest.assets ? manifest.assets : []).map((a) => a.name)
    );
    if (!allowed.has(fileName)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const target = path.join(UpdateCacheDirectory, fileName);
    if (!fs.existsSync(target)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.sendFile(target);
  });
};

export { Manager };
