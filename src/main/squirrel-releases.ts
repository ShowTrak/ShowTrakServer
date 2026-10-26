// Squirrel.Windows release helpers (main process).
//
// Electron's built-in Squirrel autoUpdater reports neither the incoming version
// on 'update-available' nor any download progress. Both can be recovered from
// the same feed Squirrel itself reads: the RELEASES manifest names each package
// with its version and byte size, and Squirrel streams the package straight
// into `<root>/packages/<file>` while downloading, so the partial file's size
// against the manifest size gives a real percentage.
const path = require('path');
const fs = require('fs');
import { CompareVersions as compareVersions } from '../Modules/Utils';

export interface SquirrelPackage {
  fileName: string;
  version: string;
  size: number;
}

// Squirrel package names end in `-<version>-full.nupkg` or `-<version>-delta.nupkg`.
const PACKAGE_NAME = /^.+?-(\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?)-(?:full|delta)\.nupkg$/i;

// Parse a RELEASES manifest ("<SHA1> <file> <size>" per line, optionally BOM-prefixed).
export function parseSquirrelReleases(text: string): SquirrelPackage[] {
  const packages: SquirrelPackage[] = [];
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  for (const line of lines) {
    const [, fileName = '', sizeRaw = ''] = line.trim().split(/\s+/);
    const size = Number(sizeRaw);
    const version = PACKAGE_NAME.exec(fileName)?.[1];
    if (!version || !Number.isFinite(size) || size <= 0) continue;
    packages.push({ fileName, version, size });
  }
  return packages;
}

// The packages (full and/or delta) belonging to the newest version in the manifest.
export function newestSquirrelPackages(packages: SquirrelPackage[]): SquirrelPackage[] {
  if (packages.length === 0) return [];
  const newest = packages.reduce((best, pkg) =>
    compareVersions(pkg.version, best.version) >= 0 ? pkg : best
  ).version;
  return packages.filter((pkg) => pkg.version === newest);
}

// Download percent (0-100) for the furthest-along package on disk, or null when
// none has been started yet.
export function readSquirrelDownloadPercent(
  rootDir: string,
  packages: SquirrelPackage[]
): number | null {
  let best: number | null = null;
  for (const pkg of packages) {
    try {
      const { size } = fs.statSync(path.join(rootDir, 'packages', pkg.fileName));
      const pct = Math.min(100, (size / pkg.size) * 100);
      if (best == null || pct > best) best = pct;
    } catch {
      /* intentional: the package file does not exist until Squirrel starts writing it */
    }
  }
  return best;
}
